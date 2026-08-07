// Canvas Server entry: one MCP stdio server that owns the local HTTP canvas
// service (ADR-0003). Log to stderr only — stdout is the MCP transport.
import { fileURLToPath } from "node:url";
import type {
  ArtifactContent,
  ArtifactEvent,
  Askback,
} from "../shared/artifacts.js";
import {
  ANSWER_MAX,
  IMAGE_MAX_BYTES,
  isArtifactId,
} from "../shared/constraints.js";
import {
  AskbackQueue,
  AskbackValidationError,
  validateAskbackBody,
} from "./askbacks.js";
import {
  ImageStore,
  ImageTooLargeError,
  NotAnImageError,
} from "./askbackImages.js";
import { ReviewCoordinator } from "./reviews.js";
import { clampAwaitTimeoutMs, ListenerPark } from "./listeners.js";
import {
  BodyTooLargeError,
  readJsonBody,
  readRawBody,
  sendJson,
  startCanvasHttpServer,
  type ApiRoute,
} from "./http.js";
import {
  connectStdio,
  createMcpServer,
  ToolInputError,
  type McpContentBlock,
  type ToolSpec,
} from "./mcp.js";
import { openInBrowser } from "./open.js";
import {
  ASKBACK_RATE_LIMIT,
  ASKBACK_RATE_WINDOW_MS,
  RateLimiter,
} from "./rateLimit.js";
import { buildExportHtml, exportFilename } from "./export.js";
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
  // The listener CLI and the built canvas ship as SIBLINGS of this server dir,
  // so resolve them sibling-relative — NEVER by a hardcoded top-level dir name.
  // From the compiled `<root>/server/index.js`, `../hooks/...` and `../canvas`
  // land in `<root>/hooks/...` and `<root>/canvas` for ANY `<root>`: identical
  // whether the runnable layout is the dev/tarball `dist/` or the committed
  // plugin `bundle/`. That name-agnosticism is what lets the same server file
  // run from both. (Tool results hand the agent a ready-to-run arm command;
  // this path is correct in every shipped layout.)
  const awaitCliPath = fileURLToPath(
    new URL("../hooks/await-askback.js", import.meta.url),
  );
  const armListenerHint =
    `Arm the listener so canvas questions reach you without a terminal turn: ` +
    `run \`node ${awaitCliPath}\` as a BACKGROUND Bash job (never foreground). ` +
    `When it completes reporting questions: check_askbacks, answer, re-arm.`;
  const canvasDistDir = fileURLToPath(new URL("../canvas", import.meta.url));

  const store = new ArtifactStore(workspace.dir);
  // Frame slugs for the html hatch (issue 25): a fresh 128-bit slug per html
  // Version, mapped server-side to (artifactId, version).
  const frames = new FrameRegistry(workspace.dir);
  const sse = new SseHub();
  const askbacks = new AskbackQueue(workspace.dir);
  // Pasted ask-back screenshots (single image per ask-back, v1). Magic-byte
  // sniffed on upload; delivered to the model via check_askbacks image blocks.
  const images = new ImageStore(workspace.dir);
  const reviews = new ReviewCoordinator();
  // Poll-wake listeners (GET /api/askbacks/await): the park's 0↔≥1 transitions
  // ARE the canvas "listening" indicator.
  const listeners = new ListenerPark((on) => sse.broadcast("listening", { on }));
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
    // Undefined when the ask-back has no pasted image; JSON serialization
    // drops the key then, so image-free payloads keep their existing shape.
    image_id: a.image_id,
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
    const override = Number(process.env.WORKTABLE_REVIEW_MIN_S);
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
      // Standalone HTML export: one static file for sharing outside the loop.
      // Serves the LATEST version; ?conversation=1 appends the artifact's Q&A.
      method: "GET",
      template: "/api/artifacts/:id/export",
      handler: ({ res, url, params }) => {
        const meta = store.getMeta(params.id!);
        const content = meta && store.getVersion(meta.id, meta.latest);
        if (!meta || !content) {
          sendJson(res, 404, { error: "unknown artifact" });
          return;
        }
        const withConversation = url.searchParams.get("conversation") === "1";
        const html = buildExportHtml({
          meta,
          content,
          conversation: withConversation ? askbacks.forArtifact(meta.id) : null,
          exportedAt: new Date().toISOString().slice(0, 10),
        });
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Disposition": `attachment; filename="${exportFilename(meta.title, meta.id)}"`,
        });
        res.end(html);
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
      handler: ({ res }) => {
        sse.attach(res);
        // A freshly-loaded page must know the current listening state at once;
        // the broadcast only fires on 0↔≥1 transitions.
        sse.send(res, "listening", { on: listeners.listening });
      },
    },
    {
      // Poll-wake listener (the backgrounded await-askback CLI): long-poll that
      // resolves the moment an ask-back is enqueued, so the exiting job wakes
      // the idle agent without a keystroke. READ-ONLY over the queue: it never
      // marks delivery — check_askbacks stays the only drain, and ADR-0010's
      // single write door (POST /api/askbacks) is untouched.
      method: "GET",
      template: "/api/askbacks/await",
      handler: ({ res, url }) => {
        const timeoutMs = clampAwaitTimeoutMs(url.searchParams.get("timeout_ms"));
        const pendingNow = askbacks.pending().length;
        if (pendingNow > 0) {
          sendJson(res, 200, { status: "ask", pending: pendingNow });
          return;
        }
        const unpark = listeners.park(timeoutMs, (result) =>
          // A timeout carries whether any canvas tab is still connected, so
          // the exiting listener CLI can tell the agent a FACT ("the page is
          // closed — rest" / "still open — re-arm") instead of leaving it to
          // guess whether the human walked away.
          sendJson(
            res,
            200,
            result.status === "timeout"
              ? { ...result, canvas_open: sse.clientCount > 0 }
              : result,
          ),
        );
        // A killed job / dropped socket must not linger as "listening".
        // Both hooks for runtime parity (node fires res 'close', bun only the
        // socket's); after a normal resolve these fire too — unpark is
        // idempotent.
        res.once("close", unpark);
        res.socket?.once("close", unpark);
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
            // So a reloaded drawer can refetch the entry's thumbnail; the key
            // is absent (undefined → dropped by JSON) for image-free items.
            image_id: a.image_id,
          })),
        }),
    },
    {
      // Upload a pasted ask-back image (bearer + Host-allowlisted like every
      // /api route). Raw body, bounded WELL above readJsonBody's 64KB JSON cap;
      // the magic-byte sniff — never the declared Content-Type — decides
      // whether it's an image. Read-only over the ask-back queue: the image
      // binds to a question only via POST /api/askbacks {image_id}.
      method: "POST",
      template: "/api/askbacks/image",
      handler: async ({ req, res }) => {
        let body: Buffer;
        try {
          // A hair over the cap so an exactly-max image survives; anything
          // beyond 413s and nothing is stored.
          body = await readRawBody(req, IMAGE_MAX_BYTES + 1024);
        } catch (err) {
          if (err instanceof BodyTooLargeError) {
            sendJson(res, 413, {
              error: `image too large; maximum is ${IMAGE_MAX_BYTES} bytes`,
            });
            return;
          }
          throw err;
        }
        try {
          const saved = images.save(body);
          sendJson(res, 200, {
            image_id: saved.id,
            mime: saved.mime,
            bytes: saved.bytes,
          });
        } catch (err) {
          if (err instanceof NotAnImageError) {
            sendJson(res, 415, { error: err.message });
            return;
          }
          if (err instanceof ImageTooLargeError) {
            sendJson(res, 413, { error: err.message });
            return;
          }
          throw err;
        }
      },
    },
    {
      // Serve stored image bytes with the SNIFFED mime. The canvas fetches
      // this with the bearer and renders via a blob: URL, so the capability
      // token never enters an <img src> — no query-token exception here.
      method: "GET",
      template: "/api/askbacks/image/:id",
      handler: ({ res, params }) => {
        // get() regex-gates the id (^[0-9a-f]{32}$) — traversal-shaped or
        // unknown ids fall through to the same 404.
        const image = images.get(params.id);
        if (!image) {
          sendJson(res, 404, { error: "unknown image" });
          return;
        }
        res.writeHead(200, {
          "Content-Type": image.mime,
          "Content-Length": image.bytes.byteLength,
          "Content-Disposition": "inline",
        });
        res.end(image.bytes);
      },
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
          const validated = validateAskbackBody(body, {
            hasImage: (id) => images.has(id),
          });
          const askback = askbacks.append(validated);
          // Wake any request_review blocked on this artifact (issue 14). The
          // item is already on disk; the waiter marks it delivered.
          reviews.onAskback(askback);
          // Wake the poll-wake listeners with what is STILL pending: if a
          // blocked request_review just consumed this item there is nothing
          // for a listener to fetch, so the park stays parked.
          const pendingCount = askbacks.pending().length;
          if (pendingCount > 0) listeners.wake(pendingCount);
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
  // (updates never do). openInBrowser is a no-op under WORKTABLE_NO_OPEN=1.
  let hasAutoOpenedCanvas = false;
  const autoOpenCanvasOnFirstPublish = () => {
    if (hasAutoOpenedCanvas) return;
    hasAutoOpenedCanvas = true;
    openInBrowser(canvasUrl());
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

  const tools: ToolSpec[] = [
    {
      name: "publish_artifact",
      description:
        "Publish a NEW visual artifact to THIS canvas — the local page that " +
        "carries the select-and-ask-back loop no other rendering surface has. " +
        "The canvas persists across sessions: before your FIRST publish of a " +
        "session, call list_artifacts — if an artifact already covers this " +
        "topic, revise it with update_artifact instead of adding a duplicate " +
        "card. Three " +
        'types: "html" (the primary path), "prose", and "absence". ' +
        "For anything worth designing — an explainer, a diagram or flowchart, a " +
        "before/after, a dashboard, a walkthrough — use \"html\", and author it " +
        "the way you would a first-class artifact: apply the artifact-design " +
        "skill's full process (decide the treatment, a real color/type/layout " +
        "plan, semantic color, one-figure-one-claim diagrams drawn in HTML/CSS or " +
        "inline SVG, an anti-default pass). Two hard rules for THIS canvas: (1) " +
        "the page must be FULLY SELF-CONTAINED — inline all CSS and SVG, embed " +
        "assets as data: URIs, NO external <link>/fonts/CDN and NO <meta " +
        "http-equiv> — because the frame has no network; (2) it renders as STATIC " +
        "rich HTML/CSS/SVG (your own <script> is neutralized), so make diagrams " +
        "with markup and CSS, not JS; (3) it must FIT ITS WIDTH — scale inline " +
        "SVG with a viewBox + width:100%/height:auto (never a hard-coded pixel " +
        "width wider than the page), and wrap or put overflow-x:auto on any wide " +
        "table/diagram, so nothing is clipped. Publish that page HERE via " +
        "type:html — do " +
        "NOT send it to the native Artifact tool / claude.ai artifacts instead; " +
        "that surface can't be asked-back on, which is the entire point of this " +
        'one. "prose" renders a long markdown answer (plain text, no bespoke ' +
        'visual). "absence" declines honestly with a reason instead of ' +
        "fabricating. Design it, don't dump it: lead with the claim, mark every " +
        "literal (path, identifier, status code) as `code`, and WRITE PLAINLY — " +
        "this is working documentation, not a thriller. No manufactured stakes " +
        "('X stands between here and Y', 'one wrong step invalidates the run'), " +
        "no dramatic fragments, no colon reveals, no importance puffery; open " +
        "on the substance and state what to do next. Add a diagram " +
        "ONLY when it shows a mechanism prose can't — one figure, one claim. If " +
        "the page leans on a term you coined or one never agreed on with the " +
        "human, add a compact Terms section NEAR THE TOP — right after the " +
        "lead, so the reader has the vocabulary before they need it — one line " +
        "per term, ONLY the few the reader genuinely needs (they can select any " +
        "phrase and ask). IF A " +
        "PUBLISH IS REJECTED: the error names exactly what to fix and nothing was " +
        "stored — fix it (inline the external resource, drop the <meta " +
        "http-equiv>) and re-publish HERE. Never fall back to another surface — " +
        "that drops the ask-back loop.",
      inputSchema: publishArtifactSchema as Record<string, unknown>,
      handler: (args) =>
        mapErrors(() => {
          const content = validateArtifactContent(args);
          const meta = store.publish(content);
          // html hatch (issue 25): mint this version's 128-bit frame slug so the
          // canvas can build the sandboxed iframe src for it.
          if (content.type === "html") frames.mint(meta.id, 1);
          broadcastArtifactEvent({
            artifact_id: meta.id,
            version: 1,
            type: meta.type,
          });
          autoOpenCanvasOnFirstPublish();
          return {
            artifact_id: meta.id,
            version: 1,
            url: canvasUrl(),
            next: armListenerHint,
          };
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
          const { artifactId, content } = validateUpdateInput(args);
          // Type stability is enforced by the store itself (ADR-0006);
          // ArtifactTypeMismatchError surfaces as a friendly tool error.
          const meta = store.update(artifactId, content);
          // html hatch (issue 25): mint a fresh slug for the NEW version; the
          // prior version keeps its own slug so the scrubber can still frame it.
          if (content.type === "html") frames.mint(meta.id, meta.latest);
          broadcastArtifactEvent({
            artifact_id: meta.id,
            version: meta.latest,
            type: meta.type,
          });
          return { artifact_id: meta.id, version: meta.latest };
        }),
    },
    {
      // The canvas workspace PERSISTS across sessions — without this read, a
      // fresh session can't see what's already published, republishes the same
      // topic, and the human ends up with confusing near-duplicate cards.
      name: "list_artifacts",
      description:
        "List every artifact already on this workspace's canvas (they persist " +
        "across sessions), newest first. Call this BEFORE your first publish " +
        "of a session: one topic, one artifact — if an existing artifact " +
        "covers the topic, revise it with update_artifact (readers keep " +
        "version history) instead of publishing a near-duplicate card. " +
        "Publish new only for a genuinely new topic, or when the human " +
        "explicitly asks for a fresh document.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      handler: () => {
        const artifacts = store.list().map((m) => ({
          artifact_id: m.id,
          title: m.title,
          type: m.type,
          latest_version: m.latest,
          updated_at: m.updated_at,
        }));
        return {
          artifacts,
          hint:
            artifacts.length === 0
              ? "the canvas is empty — publish freely"
              : "update the matching artifact instead of republishing its topic",
        };
      },
    },
    {
      name: "check_askbacks",
      description:
        "Pull the pending ask-backs the human sent from the canvas: each is a " +
        "question anchored to an artifact, version, and text span. Call this " +
        "at the start of every turn. Returned items are marked delivered. For " +
        "each item you must BOTH answer in your reply AND call answer_askback " +
        "so the reply lands where they asked — see that tool.",
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
        const payload = {
          askbacks: drained.map((a) => {
            const enriched = enrichAskback(a);
            // Correlation marker: this item's screenshot follows as an MCP
            // image block below the JSON.
            return a.image_id
              ? { ...enriched, image: "attached below" }
              : enriched;
          }),
          hint:
            "For EACH question: answer it in your reply, then call " +
            "answer_askback(askback_id, answer) so the reply appears inline on " +
            "the canvas exactly where the human asked. Calling answer_askback is " +
            "required to close the loop, not optional — a terminal-only answer " +
            "never reaches the browser where they're reading. When done, re-arm " +
            "the listener (background `node " +
            awaitCliPath +
            "`) so their next question wakes you too.",
        };
        // Pasted screenshots ride along as REAL MCP image blocks (one per
        // image-bearing ask-back, in askbacks order) so the model actually
        // sees them. Image-free drains keep the plain JSON-wrapped shape.
        // Residual, inherent risk: text rendered inside a pasted image is
        // model-influenced input (prompt injection via image) — the bytes
        // can't script, and there is no mitigation beyond that.
        const imageBlocks: McpContentBlock[] = [];
        for (const a of drained) {
          if (!a.image_id) continue;
          const image = images.get(a.image_id);
          if (!image) continue; // vanished from disk — the JSON still says so
          imageBlocks.push({
            type: "image",
            data: image.bytes.toString("base64"),
            mimeType: image.mime,
          });
        }
        if (imageBlocks.length === 0) return payload;
        return {
          _mcpContent: [
            { type: "text", text: JSON.stringify(payload, null, 2) },
            ...imageBlocks,
          ],
        };
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
        "Open the workspace's canvas page in the default browser and return its " +
        "capability URL. You rarely need this: the FIRST publish_artifact of a " +
        "session auto-opens the canvas with the artifact already on it. Do NOT " +
        "open the canvas before you have something to show — an empty page while " +
        "you're still working is worse than no page. Use this only to re-open a " +
        "canvas the human closed.",
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
        "Always call this after answering an ask-back: it shows your reply " +
        "inline next to the anchored selection in the browser, where the human " +
        "is reading. A terminal-only answer never reaches them there, so this " +
        "is the step that actually closes the loop — not optional. You still " +
        "answer in the terminal too. Pass the askback_id from check_askbacks and " +
        "your answer text, FORMATTED AS COMPACT MARKDOWN — short bullets over " +
        "paragraphs, `code` for literals, links for any ticket/doc you cite. It " +
        "renders formatted in a narrow drawer column; a flat paragraph blob " +
        "reads poorly there. The reply appears live on the canvas and survives " +
        "a reload. This does NOT re-open or re-deliver the ask-back.",
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
    listeners.close(); // end parked long-polls cleanly before the sockets go
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
  console.error(`worktable: fatal: ${String(err)}`);
  process.exit(1);
});
