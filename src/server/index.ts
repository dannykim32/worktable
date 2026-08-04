// Canvas Server entry: one MCP stdio server that owns the local HTTP canvas
// service (ADR-0003). Log to stderr only — stdout is the MCP transport.
import { fileURLToPath } from "node:url";
import type {
  ArtifactContent,
  ArtifactEvent,
  Askback,
} from "../shared/artifacts.js";
import { ANSWER_MAX, isArtifactId } from "../shared/constraints.js";
import {
  AskbackQueue,
  AskbackValidationError,
  validateAskbackBody,
} from "./askbacks.js";
import { ReviewCoordinator } from "./reviews.js";
import {
  readJsonBody,
  sendJson,
  startCanvasHttpServer,
  type ApiRoute,
} from "./http.js";
import { connectStdio, createMcpServer, ToolInputError, type ToolSpec } from "./mcp.js";
import { sanitizeSvg } from "../sanitizer/index.js";
import { runGateSafe } from "../gate/index.js";
import {
  resolveGateMode,
  shouldEnforce,
  validateSettingsBody,
  writeGateSetting,
  SettingsValidationError,
} from "./config.js";
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
import { FrameRegistry } from "./frames.js";
import { startFrameHttpServer } from "./frameHttp.js";
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
  // Frame slugs for the html hatch (issue 25): a fresh 128-bit slug per html
  // Version, mapped server-side to (artifactId, version).
  const frames = new FrameRegistry(workspace.dir);
  const calibration = new CalibrationLedger(workspace.dir);
  // The gate mode is a human-only decision (issue 12 / ADR-0011): no MCP tool
  // can change it. It is resolved PER PUBLISH now (workspace override > user
  // default > "report"), so a flip via the token-gated settings panel takes
  // effect on the very next artifact with NO restart.
  const currentGateMode = () => resolveGateMode(workspace.dir).mode;
  const repairs = new RepairRegistry(workspace.dir);
  const sse = new SseHub();
  const askbacks = new AskbackQueue(workspace.dir);
  const reviews = new ReviewCoordinator();
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
    kind: a.kind ?? "question",
    created_at: a.created_at,
  });

  // The parent-canvas view of an artifact's content. For the html hatch (issue
  // 25) the raw `html` body is REPLACED by the version's frame slug: the model's
  // HTML travels ONLY to the frame-serving origin, never to the parent canvas
  // JS, and the canvas builds the iframe src from `frameSlug`. All other types
  // pass through unchanged.
  const clientContent = (
    content: ArtifactContent,
    artifactId: string,
    version: number,
  ): ArtifactContent => {
    if (content.type !== "html") return content;
    const frameSlug = frames.slugFor(artifactId, version) ?? undefined;
    return { type: "html", title: content.title, frameSlug };
  };

  // Block a request_review call until an ask-back anchored to `artifactId`
  // arrives or `ms` elapses. Resolves with the ask-back (marked delivered) or
  // null on timeout. No busy-spin: a single waiter + a single unref'd timer,
  // both torn down on whichever fires first.
  const awaitReviewFeedback = (
    artifactId: string,
    ms: number,
  ): Promise<Askback | null> => {
    const alreadyQueued = askbacks.pendingForArtifact(artifactId)[0];
    if (alreadyQueued) {
      askbacks.markDelivered(alreadyQueued.id);
      return Promise.resolve(alreadyQueued);
    }
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout;
      const waiter = reviews.register(artifactId, (a) => {
        clearTimeout(timer);
        // Mark delivered synchronously (still inside the POST handler stack)
        // so a concurrent check_askbacks can never also drain this item.
        askbacks.markDelivered(a.id);
        resolve(a);
      });
      timer = setTimeout(() => {
        reviews.unregister(waiter);
        resolve(null);
      }, ms);
      timer.unref?.();
    });
  };

  // request_review timeout floor: 30s in production. A test seam lets the
  // suite exercise the timeout path in ~1s without a 30s wall.
  const reviewTimeoutFloor = (): number => {
    const override = Number(process.env.VISUAL_CHAT_REVIEW_MIN_S);
    return Number.isFinite(override) && override > 0 ? override : 30;
  };

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
        sendJson(res, 200, {
          ...meta,
          content: clientContent(content, meta.id, meta.latest),
        });
      },
    },
    {
      method: "GET",
      template: "/api/artifacts/:id/v/:n",
      handler: ({ res, params }) => {
        const version = Number(params.n);
        const content = store.getVersion(params.id!, version);
        if (!content) {
          sendJson(res, 404, { error: "unknown artifact or version" });
          return;
        }
        sendJson(res, 200, clientContent(content, params.id!, version));
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
      // Answered ask-backs for this workspace (issue 22): the canvas loads
      // these on boot so the inline replies survive a reload. Bearer-gated like
      // every /api route (http.ts 401s without the token); read-only — reading
      // never touches delivered state.
      method: "GET",
      template: "/api/askbacks/answered",
      handler: ({ res }) =>
        sendJson(res, 200, {
          askbacks: askbacks.answered().map((a) => ({
            id: a.id,
            anchor: a.anchor,
            question: a.question,
            answer: a.answer,
          })),
        }),
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
          // Wake any request_review blocked on this artifact (issue 14). The
          // item is already on disk; the waiter marks it delivered.
          reviews.onAskback(askback);
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
    // ── Gate mode settings (issue 20, ADR-0011) ─────────────────────────
    // The HUMAN's surface for the gate mode. Bearer-gated like every /api
    // route (the http.ts middleware 401s without the token), so this write
    // path is reachable ONLY via the capability token, NEVER via any MCP tool.
    // The agent's tool set stays closed; no tool can arm or disarm enforcement.
    {
      method: "GET",
      template: "/api/settings",
      handler: ({ res }) => {
        const { mode, source } = resolveGateMode(workspace.dir);
        sendJson(res, 200, { gate: { effective: mode, source } });
      },
    },
    {
      method: "POST",
      template: "/api/settings",
      handler: async ({ req, res }) => {
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          sendJson(res, 400, { error: String((err as Error).message) });
          return;
        }
        try {
          const update = validateSettingsBody(body);
          const { mode, source } = writeGateSetting(workspace.dir, update);
          sendJson(res, 200, { gate: { effective: mode, source } });
        } catch (err) {
          if (err instanceof SettingsValidationError) {
            sendJson(res, 400, { error: err.message });
            return;
          }
          throw err;
        }
      },
    },
  ];

  // The frame-origin server (issue 25) binds a disjoint port range; its port is
  // known only after it binds, so the canvas CSP names the frame origin through
  // this getter (resolved lazily, per request).
  let framePort = -1;
  const frameOrigin = (): string | null =>
    framePort > 0 ? `http://127.0.0.1:${framePort}` : null;

  const running = await startCanvasHttpServer({
    workspace,
    version: SERVER_VERSION,
    canvasDistDir,
    apiRoutes,
    frameOrigin,
  });
  workspace.recordPort(running.port);

  // Second listener: serves ONLY html-artifact documents at token-free
  // `/f/<slug>` routes, on its own origin, isolated from the capability token.
  const frameServer = await startFrameHttpServer({
    store,
    frames,
    canvasOrigin: () => `http://127.0.0.1:${running.port}`,
  });
  framePort = frameServer.port;
  workspace.recordFramePort(framePort);

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

          if (
            shouldEnforce({
              mode: currentGateMode(),
              type: content.type,
              findings,
            })
          ) {
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
          // html hatch (issue 25): mint this version's 128-bit frame slug so the
          // canvas can build the sandboxed iframe src for it.
          if (content.type === "html") frames.mint(meta.id, 1);
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

          if (
            shouldEnforce({
              mode: currentGateMode(),
              type: content.type,
              findings,
            })
          ) {
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
          // html hatch (issue 25): mint a fresh slug for the NEW version; the
          // prior version keeps its own slug so the scrubber can still frame it.
          if (content.type === "html") frames.mint(meta.id, meta.latest);
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
      name: "request_review",
      description:
        "Block awaiting the human's review of ONE artifact on the canvas — call " +
        "it only when their feedback on a visual is the explicit next step. " +
        'Before calling, tell them in your text: "review on the canvas — ' +
        'waiting there." A banner appears on that artifact with an approve ' +
        "button. Returns the human's anchored feedback (same shape as " +
        "check_askbacks), or { approved: true } if they click approve, or " +
        "{ timed_out: true } after timeout_s (default 180, clamped 30–600) — a " +
        "normal result, not an error: the feedback is not lost, it simply " +
        "arrives via check_askbacks next turn. Esc interrupts the call safely; " +
        "the queue keeps any feedback for the next check_askbacks.",
      inputSchema: {
        type: "object",
        properties: {
          artifact_id: {
            type: "string",
            description: "The artifact to wait for review on.",
          },
          timeout_s: {
            type: "number",
            description: "Seconds to block; clamped to [30, 600]. Default 180.",
          },
        },
        required: ["artifact_id"],
        additionalProperties: false,
      },
      handler: async (args) => {
        const artifactId = args.artifact_id;
        if (!isArtifactId(artifactId)) {
          throw new ToolInputError("artifact_id must be a valid artifact id");
        }
        if (!store.getMeta(artifactId)) {
          throw new ToolInputError(`unknown artifact ${artifactId}`);
        }
        const requested =
          typeof args.timeout_s === "number" ? args.timeout_s : 180;
        const timeoutS = Math.min(
          600,
          Math.max(reviewTimeoutFloor(), requested),
        );
        // Tell the canvas to show the review banner on this artifact.
        sse.broadcast("review_requested", { artifact_id: artifactId });
        try {
          const matched = await awaitReviewFeedback(artifactId, timeoutS * 1000);
          if (!matched) {
            return {
              timed_out: true,
              hint: "feedback will arrive via check_askbacks",
            };
          }
          if (matched.kind === "approval") return { approved: true };
          return { askback: enrichAskback(matched) };
        } finally {
          // Clear the banner on BOTH resolution and timeout.
          sse.broadcast("review_resolved", { artifact_id: artifactId });
        }
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
    {
      name: "answer_askback",
      description:
        "Answer a specific ask-back the human sent from the canvas, so your " +
        "reply also shows inline next to the anchored selection in the browser. " +
        "You still answer in the terminal; this is the extra step that closes " +
        "the loop where they asked. Pass the askback_id from check_askbacks and " +
        "your answer text. The reply appears live on the canvas and survives a " +
        "reload. This does NOT re-open or re-deliver the ask-back.",
      inputSchema: {
        type: "object",
        properties: {
          askback_id: {
            type: "string",
            description: "The id of the ask-back to answer (from check_askbacks).",
          },
          answer: {
            type: "string",
            description: "Your answer, shown inline as the agent's reply.",
          },
        },
        required: ["askback_id", "answer"],
        additionalProperties: false,
      },
      handler: (args) => {
        const askbackId = args.askback_id;
        if (typeof askbackId !== "string" || askbackId.length === 0) {
          throw new ToolInputError("askback_id must be a non-empty string");
        }
        const answer = args.answer;
        if (typeof answer !== "string" || answer.trim().length === 0) {
          throw new ToolInputError("answer must be a non-empty string");
        }
        if (answer.length > ANSWER_MAX) {
          throw new ToolInputError(
            `answer is ${answer.length} chars; maximum is ${ANSWER_MAX}`,
          );
        }
        // Unknown id → nothing is stored (answer() writes only on a match).
        const updated = askbacks.answer(askbackId, answer);
        if (!updated) {
          throw new ToolInputError(`unknown ask-back ${askbackId}`);
        }
        // Agent→browser, same direction as artifact pushes — not a new
        // browser→agent channel, so ADR-0010 is intact. The canvas fetches the
        // answer text via GET /api/askbacks/answered on this signal.
        sse.broadcast("askback_answered", {
          askback_id: updated.id,
          artifact_id: updated.anchor.artifact_id,
          version: updated.anchor.version,
        });
        return {
          id: updated.id,
          anchor: updated.anchor,
          question: updated.question,
          state: updated.state,
          answer: updated.answer,
        };
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
    await frameServer.close().catch(() => {});
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
      `canvas on http://127.0.0.1:${running.port}, ` +
      `frame origin on http://127.0.0.1:${framePort}`,
  );
}

main().catch((err: unknown) => {
  console.error(`visual-chat: fatal: ${String(err)}`);
  process.exit(1);
});
