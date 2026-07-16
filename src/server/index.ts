// Canvas Server entry: one MCP stdio server that owns the local HTTP canvas
// service (ADR-0003). Log to stderr only — stdout is the MCP transport.
import { fileURLToPath } from "node:url";
import type {
  ArtifactContent,
  ArtifactEvent,
  Askback,
} from "../shared/artifacts.js";
import {
  AskbackQueue,
  AskbackValidationError,
  validateAskbackBody,
} from "./askbacks.js";
import {
  readJsonBody,
  sendJson,
  startCanvasHttpServer,
  type ApiRoute,
} from "./http.js";
import { connectStdio, createMcpServer, ToolInputError, type ToolSpec } from "./mcp.js";
import { sanitizeSvg } from "../sanitizer/index.js";
import { runGateSafe } from "../gate/index.js";
import { readGateMode, shouldEnforce } from "./config.js";
import { mintRepairToken, RepairRegistry } from "./repair.js";
import { CalibrationLedger, InvalidRulingError } from "./calibration.js";
import { openInBrowser } from "./open.js";
import {
  ASKBACK_RATE_LIMIT,
  ASKBACK_RATE_WINDOW_MS,
  RateLimiter,
} from "./rateLimit.js";
import { SseHub } from "./sse.js";
import {
  ArtifactStore,
  ArtifactTypeMismatchError,
  UnknownArtifactError,
} from "./store.js";
import {
  publishArtifactSchema,
  updateArtifactSchema,
  validateArtifactContent,
  validateUpdateInput,
  ValidationError,
} from "./validate.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";
import { openWorkspace } from "./workspace.js";

async function main(): Promise<void> {
  const workspace = openWorkspace();
  const canvasDistDir = fileURLToPath(
    new URL("../../dist/canvas", import.meta.url),
  );

  const store = new ArtifactStore(workspace.dir);
  const calibration = new CalibrationLedger(workspace.dir);
  // The gate mode is a human-only decision read once at startup (issue 12): no
  // MCP tool can change it, and a flip takes effect on the next restart.
  const gateMode = readGateMode(workspace.dir);
  const repairs = new RepairRegistry(workspace.dir);
  const sse = new SseHub();
  const askbacks = new AskbackQueue(workspace.dir);
  const askbackLimiter = new RateLimiter(
    ASKBACK_RATE_LIMIT,
    ASKBACK_RATE_WINDOW_MS,
  );

  // The canvas item shape shared by check_askbacks, the read-only /pending peek
  // (issue 13), and request_review resolutions (issue 14). Enriches the stored
  // ask-back with its artifact's current title.
  const enrichAskback = (a: Askback) => ({
    id: a.id,
    question: a.question,
    quote: a.anchor.quote,
    anchor: a.anchor,
    artifact_title: store.getMeta(a.anchor.artifact_id)?.title ?? null,
    created_at: a.created_at,
  });

  const apiRoutes: ApiRoute[] = [
    {
      method: "GET",
      template: "/api/artifacts",
      handler: ({ res }) => sendJson(res, 200, store.list()),
    },
    {
      method: "GET",
      template: "/api/artifacts/:id",
      handler: ({ res, params }) => {
        const meta = store.getMeta(params.id!);
        const content = meta && store.getVersion(meta.id, meta.latest);
        if (!meta || !content) {
          sendJson(res, 404, { error: "unknown artifact" });
          return;
        }
        sendJson(res, 200, { ...meta, content });
      },
    },
    {
      method: "GET",
      template: "/api/artifacts/:id/v/:n",
      handler: ({ res, params }) => {
        const content = store.getVersion(params.id!, Number(params.n));
        if (!content) {
          sendJson(res, 404, { error: "unknown artifact or version" });
          return;
        }
        sendJson(res, 200, content);
      },
    },
    {
      method: "GET",
      template: "/api/events",
      handler: ({ res }) => sse.attach(res),
    },
    // ── Calibration gallery (issue 11) ──────────────────────────────────
    // Every svg Version, its sanitized markup, and the gate findings recorded
    // for it — the calibration route renders these with overlay boxes.
    {
      method: "GET",
      template: "/api/calibration/gallery",
      handler: ({ res }) => {
        const items: Array<{
          artifact_id: string;
          version: number;
          title: string;
          svg: string;
          findings: unknown[];
        }> = [];
        for (const meta of store.list()) {
          if (meta.type !== "svg") continue;
          for (let v = meta.latest; v >= 1; v--) {
            const content = store.getVersion(meta.id, v);
            if (!content || content.type !== "svg") continue;
            items.push({
              artifact_id: meta.id,
              version: v,
              title: content.title,
              svg: content.svg,
              findings: store.getFindings(meta.id, v),
            });
          }
        }
        sendJson(res, 200, { items, summary: calibration.summary() });
      },
    },
    {
      method: "GET",
      template: "/api/calibration",
      handler: ({ res }) =>
        sendJson(res, 200, {
          summary: calibration.summary(),
          rulings: calibration.all(),
        }),
    },
    {
      method: "POST",
      template: "/api/calibration",
      handler: async ({ req, res }) => {
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          sendJson(res, 400, { error: String((err as Error).message) });
          return;
        }
        try {
          const ruling = calibration.append(body);
          sendJson(res, 201, { ruling, summary: calibration.summary() });
        } catch (err) {
          if (err instanceof InvalidRulingError) {
            sendJson(res, 400, { error: err.message });
            return;
          }
          throw err;
        }
      },
    },
    {
      // Read-only peek for the Claude Code hook (issue 13): returns pending
      // ask-backs WITHOUT marking them delivered, so the hook and check_askbacks
      // never race destructively. Delivery marking stays with check_askbacks.
      method: "GET",
      template: "/api/askbacks/pending",
      handler: ({ res }) =>
        sendJson(res, 200, { askbacks: askbacks.pending().map(enrichAskback) }),
    },
    {
      method: "POST",
      template: "/api/askbacks",
      handler: async ({ req, res }) => {
        // Rate limit the single write door (ADR-0010). Keyed by the
        // capability token, so rotation starts a fresh window.
        const decision = askbackLimiter.consume(workspace.token);
        if (!decision.allowed) {
          res.setHeader("Retry-After", String(decision.retryAfterSeconds));
          sendJson(res, 429, {
            error: `too many ask-backs; retry in ${decision.retryAfterSeconds}s`,
          });
          return;
        }
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          sendJson(res, 400, { error: String((err as Error).message) });
          return;
        }
        try {
          const validated = validateAskbackBody(body);
          const askback = askbacks.append(validated);
          sendJson(res, 201, { id: askback.id, state: askback.state });
        } catch (err) {
          if (err instanceof AskbackValidationError) {
            sendJson(res, 400, { error: err.message });
            return;
          }
          throw err;
        }
      },
    },
  ];

  const running = await startCanvasHttpServer({
    workspace,
    version: SERVER_VERSION,
    canvasDistDir,
    apiRoutes,
  });
  workspace.recordPort(running.port);

  const canvasUrl = () =>
    `http://127.0.0.1:${running.port}/?token=${workspace.token}`;

  const broadcastArtifactEvent = (event: ArtifactEvent) => {
    sse.broadcast("artifact", event);
  };

  // Issue 03: the FIRST publish of a server run auto-opens the canvas
  // (updates never do). openInBrowser is a no-op under VISUAL_CHAT_NO_OPEN=1.
  let hasAutoOpenedCanvas = false;
  const autoOpenCanvasOnFirstPublish = () => {
    if (hasAutoOpenedCanvas) return;
    hasAutoOpenedCanvas = true;
    openInBrowser(canvasUrl());
  };

  // Free-form SVG is sanitized on the publish path (issue 10): the sanitizer
  // (issue 09) is the single last boundary. On rejection the tool returns the
  // violations verbatim and NOTHING is stored — the agent can fix or decline.
  // On success we store ONLY the re-serialized output; the raw input is
  // discarded, never persisted.
  //
  // The Legibility Gate (issue 11) then runs over the SAME AST the sanitizer
  // just validated — never reparsing. It is REPORT-ONLY this milestone: the
  // findings are returned for storage but NEVER block or alter the publish.
  const prepareContent = (
    content: ArtifactContent,
  ): { content: ArtifactContent; findings: unknown[] } => {
    if (content.type !== "svg") return { content, findings: [] };
    const result = sanitizeSvg(content.svg);
    if (!result.ok) {
      const lines = result.violations
        .map((v) => `  · [${v.code}] ${v.path}: ${v.detail}`)
        .join("\n");
      throw new ToolInputError(
        `SVG rejected by the sanitizer — nothing was stored. Fix these and ` +
          `retry, or publish an "absence" artifact instead:\n${lines}`,
      );
    }
    // Fail-open: the gate NEVER decides whether the artifact publishes — not by
    // its findings, and not by throwing. A gate exception degrades to zero
    // findings and is logged to stderr (stdout is the MCP transport).
    const gate = runGateSafe(result.root);
    if (gate.error !== null) {
      console.error(
        `visual-chat: legibility gate errored (report-only, publishing ` +
          `anyway): ${gate.error}`,
      );
    }
    return { content: { ...content, svg: result.svg }, findings: gate.findings };
  };

  const mapErrors = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (err) {
      if (
        err instanceof ValidationError ||
        err instanceof UnknownArtifactError ||
        err instanceof ArtifactTypeMismatchError
      ) {
        throw new ToolInputError(err.message);
      }
      throw err;
    }
  };

  // ── Gate enforcement (issue 12, ADR-0007) ──────────────────────────────
  // Engaged ONLY when gateMode === "enforce" AND the gate produced real
  // findings (shouldEnforce). A gate crash yields zero findings via
  // runGateSafe, so enforcement never fires on an exception — the fail-open
  // invariant is structural. In report mode this whole block is skipped and
  // behaviour is byte-identical to issue 11.

  /** A compact, human-readable roll-up of the findings for an absence reason. */
  const summarizeFindings = (findings: readonly unknown[]): string =>
    findings
      .map((raw) => {
        const f = raw as {
          check?: string;
          message?: string;
          elements?: string[];
          bbox?: { x: number; y: number };
        };
        const els = f.elements?.length ? ` [${f.elements.join(", ")}]` : "";
        const at = f.bbox ? ` at (${f.bbox.x}, ${f.bbox.y})` : "";
        return `${f.check ?? "finding"}${els}${at}: ${f.message ?? ""}`;
      })
      .join("; ");

  /** The first-failure response: the verbatim coordinate findings plus a hint
   *  that instructs a bounded repair. NOTHING is stored. */
  const gateFailedResponse = (
    findings: unknown[],
    repairHint: string,
    repairToken?: string,
  ) => ({
    gate: "failed" as const,
    findings,
    repair_hint: repairHint,
    ...(repairToken ? { repair_token: repairToken } : {}),
  });

  /** Second failure in a repair context → publish an Honest Absence in place of
   *  the artifact. Title is preserved; the reason names the twice-failed gate
   *  and summarizes the findings. A first-class outcome, never an error. */
  const publishHonestAbsence = (title: string, findings: unknown[]) => {
    const reason = `Failed the legibility gate twice. ${summarizeFindings(findings)}`;
    const meta = store.publish({ type: "absence", title, reason });
    broadcastArtifactEvent({
      artifact_id: meta.id,
      version: 1,
      type: meta.type,
    });
    autoOpenCanvasOnFirstPublish();
    return {
      outcome: "honest_absence" as const,
      artifact_id: meta.id,
      version: 1,
      title,
      reason,
      message:
        "This SVG failed the legibility gate twice, so it was published as an " +
        "honest-absence artifact instead of rendered. Honest absence is a " +
        "first-class outcome, not an error — state the limitation and move on.",
    };
  };

  const tools: ToolSpec[] = [
    {
      name: "publish_artifact",
      description:
        "Publish a new visual artifact to the canvas. Component Artifacts are " +
        "structured data drawn by the trusted Component Vocabulary. Use type " +
        '"absence" to decline honestly (with the reason) instead of fabricating.',
      inputSchema: publishArtifactSchema as Record<string, unknown>,
      handler: (args) =>
        mapErrors(() => {
          // repair_token is transport-level, not artifact content: strip it
          // before content validation (which rejects unknown fields).
          const { repair_token, ...contentArgs } = args;
          const repairToken =
            typeof repair_token === "string" ? repair_token : undefined;
          const { content, findings } = prepareContent(
            validateArtifactContent(contentArgs),
          );

          if (shouldEnforce({ mode: gateMode, type: content.type, findings })) {
            // A resubmission under a KNOWN, still-live token is the second
            // failure of this repair round → convert to Honest Absence.
            if (repairToken !== undefined && repairs.has(`pub:${repairToken}`)) {
              const resp = publishHonestAbsence(content.title, findings);
              repairs.clear(`pub:${repairToken}`);
              return resp;
            }
            // First failure → open a repair context under a fresh provisional
            // token and hand back the coordinate findings. NOTHING is stored.
            const token = mintRepairToken();
            repairs.recordFailure(`pub:${token}`);
            return gateFailedResponse(
              findings,
              `The legibility gate found ${findings.length} problem(s). Fix ` +
                `ONLY the geometry named in these findings — do not restyle or ` +
                `re-author the rest — then call publish_artifact again with the ` +
                `corrected SVG and repair_token "${token}". One repair attempt ` +
                `remains; a second gate failure is published as an ` +
                `honest-absence artifact instead of rendered.`,
              token,
            );
          }

          const meta = store.publish(content);
          // Report-only mode and every clean/enforced-pass submission land here.
          // Store the gate's findings alongside the version; only free-form SVG
          // passes through the gate, so other types have none.
          if (content.type === "svg") {
            store.writeFindings(meta.id, 1, findings);
            // A passing submission clears the repair context it retried under.
            if (repairToken !== undefined) repairs.clear(`pub:${repairToken}`);
          }
          broadcastArtifactEvent({
            artifact_id: meta.id,
            version: 1,
            type: meta.type,
          });
          autoOpenCanvasOnFirstPublish();
          return { artifact_id: meta.id, version: 1, url: canvasUrl() };
        }),
    },
    {
      name: "update_artifact",
      description:
        "Replace an existing artifact's content in place. The artifact keeps " +
        "its identity; every prior version stays viewable, and ask-back anchors " +
        "bind to the version the human was reading.",
      inputSchema: updateArtifactSchema as Record<string, unknown>,
      handler: (args) =>
        mapErrors(() => {
          // An update's repair context keys on the artifact id, so repair_token
          // is unused here — strip it so content validation still passes.
          const { repair_token: _repairToken, ...rest } = args;
          const { artifactId, content: input } = validateUpdateInput(rest);
          const { content, findings } = prepareContent(input);

          if (shouldEnforce({ mode: gateMode, type: content.type, findings })) {
            const key = `upd:${artifactId}`;
            const { secondFailure } = repairs.recordFailure(key);
            if (secondFailure) {
              // Second failing update → Honest Absence. It is published as a
              // NEW absence artifact; the existing svg artifact keeps its last
              // good version (an artifact keeps one type for life, ADR-0006).
              const resp = publishHonestAbsence(content.title, findings);
              repairs.clear(key);
              return resp;
            }
            // First failure → coordinate findings back, nothing stored, no new
            // version. The agent resubmits the corrected update for the same id.
            return gateFailedResponse(
              findings,
              `The legibility gate found ${findings.length} problem(s). Fix ` +
                `ONLY the geometry named in these findings, then call ` +
                `update_artifact again for artifact ${artifactId}. One repair ` +
                `attempt remains; a second gate failure is published as an ` +
                `honest-absence artifact instead of rendered.`,
            );
          }

          // Type stability is enforced by the store itself (ADR-0006);
          // ArtifactTypeMismatchError surfaces as a friendly tool error.
          const meta = store.update(artifactId, content);
          // Updating an artifact re-runs the gate for the new version.
          if (content.type === "svg") {
            store.writeFindings(meta.id, meta.latest, findings);
            // A passing update clears any repair context for this artifact.
            repairs.clear(`upd:${artifactId}`);
          }
          broadcastArtifactEvent({
            artifact_id: meta.id,
            version: meta.latest,
            type: meta.type,
          });
          return { artifact_id: meta.id, version: meta.latest };
        }),
    },
    {
      name: "check_askbacks",
      description:
        "Pull the pending ask-backs the human sent from the canvas: each is a " +
        "question anchored to an artifact, version, and text span. Call this " +
        "at the start of every turn. Returned items are marked delivered.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      handler: () => {
        const drained = askbacks.drainPending();
        if (drained.length === 0) {
          return {
            askbacks: [],
            hint: "no pending questions from the canvas",
          };
        }
        return { askbacks: drained.map(enrichAskback) };
      },
    },
    {
      name: "open_canvas",
      description:
        "Open the workspace's canvas page in the default browser and return " +
        "its capability URL.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      handler: () => {
        const url = canvasUrl();
        openInBrowser(url);
        return { url };
      },
    },
    {
      name: "rotate_token",
      description:
        "Regenerate this workspace's capability token. The old canvas URL and " +
        "any saved bearer stop working immediately.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      handler: () => {
        workspace.rotateToken();
        return { rotated: true, url: canvasUrl() };
      },
    },
  ];

  const mcp = createMcpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    tools,
  });

  const shutdown = async () => {
    sse.close();
    await running.close().catch(() => {});
    process.exit(0);
  };
  // HTTP lifecycle is tied to the stdio transport: stdin closing means the
  // agent host is gone.
  process.stdin.on("end", () => void shutdown());
  process.stdin.on("close", () => void shutdown());
  mcp.onclose = () => void shutdown();

  await connectStdio(mcp);
  console.error(
    `${SERVER_NAME} ${SERVER_VERSION} — workspace ${workspace.id}, ` +
      `canvas on http://127.0.0.1:${running.port}`,
  );
}

main().catch((err: unknown) => {
  console.error(`visual-chat: fatal: ${String(err)}`);
  process.exit(1);
});
