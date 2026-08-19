// Poll-wake listener: GET /api/askbacks/await + the `listening` SSE state +
// the backgrounded await-askback CLI, all against a real spawned server.
//
// The hard invariants under test:
//  · the route is bearer-gated + Host-allowlisted like every /api route;
//  · it is READ-ONLY — resolving a poll never marks an ask-back delivered
//    (check_askbacks stays the only drain, ADR-0010);
//  · a park resolves on a real POST /api/askbacks, times out otherwise, and
//    the 9th concurrent waiter evicts the OLDEST with a timeout (cap 8);
//  · `listening` broadcasts fire on 0↔≥1 transitions and a newly-connected
//    SSE client receives the current state immediately;
//  · the CLI's stdout leads with a machine-parseable `WORKTABLE_LISTENER
//    status=… action=…` line and always exits 0; an unreachable server is
//    RETRIED within the budget, not treated as a fatal "do not re-arm".
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Anchor } from "../src/shared/artifacts.js";
import {
  bearer,
  httpRequest,
  openSse,
  repoRoot,
  spawnServer,
  toolJson,
  type HttpResult,
  type SseListener,
  type SpawnedServer,
} from "./helpers.js";

const cliEntry = join(repoRoot, "hooks", "await-askback.ts");

let server: SpawnedServer;
let artifactId: string;

function anchorFor(id: string): Anchor {
  return { artifact_id: id, version: 1, block_index: null, quote: "Await Doc" };
}

function postAskback(question: string): Promise<HttpResult> {
  return httpRequest({
    port: server.port,
    path: "/api/askbacks",
    method: "POST",
    headers: { ...bearer(server.token()), "Content-Type": "application/json" },
    body: JSON.stringify({ anchor: anchorFor(artifactId), question }),
  });
}

function getAwait(opts: {
  timeoutParam?: string;
  clientTimeoutMs?: number;
}): Promise<HttpResult> {
  const query =
    opts.timeoutParam === undefined ? "" : `?timeout_ms=${opts.timeoutParam}`;
  return httpRequest({
    port: server.port,
    path: `/api/askbacks/await${query}`,
    headers: bearer(server.token()),
    timeoutMs: opts.clientTimeoutMs ?? 5000,
  });
}

async function pendingCount(): Promise<number> {
  const res = await httpRequest({
    port: server.port,
    path: "/api/askbacks/pending",
    headers: bearer(server.token()),
  });
  return (JSON.parse(res.body) as { askbacks: unknown[] }).askbacks.length;
}

async function drainQueue(): Promise<void> {
  await server.client.callTool({ name: "check_askbacks", arguments: {} });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** All `listening` frames seen so far, in arrival order. */
function listeningFrames(sse: SseListener): Array<{ on: boolean }> {
  return sse.frames
    .filter((f) => f.event === "listening")
    .map((f) => f.data as { on: boolean });
}

/** Wait until at least `n` listening frames arrived (same-shaped events repeat,
 *  so waitFor's first-match semantics can't distinguish transitions). */
async function waitListeningCount(
  sse: SseListener,
  n: number,
  timeoutMs = 4000,
): Promise<Array<{ on: boolean }>> {
  const start = Date.now();
  while (listeningFrames(sse).length < n) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `only ${listeningFrames(sse).length}/${n} listening frames in ${timeoutMs}ms`,
      );
    }
    await sleep(25);
  }
  return listeningFrames(sse);
}

beforeAll(async () => {
  server = await spawnServer();
  const published = toolJson(
    await server.client.callTool({
      name: "publish_artifact",
      arguments: { type: "prose", title: "Await Doc", markdown: "select me" },
    }),
  );
  artifactId = published.artifact_id as string;
}, 30_000);

afterAll(async () => {
  await server?.close();
});

describe("GET /api/askbacks/await — auth", () => {
  test("401 without a token; 401 with a wrong token; 403 for a bad Host", async () => {
    const noAuth = await httpRequest({
      port: server.port,
      path: "/api/askbacks/await",
    });
    expect(noAuth.status).toBe(401);

    const wrong = await httpRequest({
      port: server.port,
      path: "/api/askbacks/await",
      headers: bearer("not-the-token"),
    });
    expect(wrong.status).toBe(401);

    const badHost = await httpRequest({
      port: server.port,
      path: "/api/askbacks/await",
      headers: { ...bearer(server.token()), Host: "evil.test" },
    });
    expect(badHost.status).toBe(403);
  });
});

describe("GET /api/askbacks/await — long-poll behavior", () => {
  test("pending ask-backs NOW → immediate {status:'ask'}; still undelivered after", async () => {
    await postAskback("already waiting");
    const started = Date.now();
    const res = await getAwait({});
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: "ask", pending: 1 });
    expect(Date.now() - started).toBeLessThan(1000); // did not park

    // READ-ONLY: the await never marked delivery — only check_askbacks drains.
    expect(await pendingCount()).toBe(1);
    await drainQueue();
    expect(await pendingCount()).toBe(0);
  });

  test("parks, then a real POST /api/askbacks resolves it; queue stays pending", async () => {
    const parked = getAwait({ clientTimeoutMs: 20_000 });
    await sleep(200); // let the poll reach the server and park
    await postAskback("wake the listener");
    const res = await parked;
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: "ask", pending: 1 });

    // The wake told the listener a question EXISTS; it did not deliver it.
    expect(await pendingCount()).toBe(1);
    await drainQueue();
  });

  test("timeout_ms clamps to the 5s floor and times out with {status:'timeout'}", async () => {
    const started = Date.now();
    const res = await getAwait({ timeoutParam: "1", clientTimeoutMs: 12_000 });
    const elapsed = Date.now() - started;
    expect(res.status).toBe(200);
    // canvas_open rides every timeout: no SSE client here → page closed.
    expect(JSON.parse(res.body)).toEqual({ status: "timeout", canvas_open: false });
    expect(elapsed).toBeGreaterThanOrEqual(4500); // clamped UP to 5000, not 1
    expect(elapsed).toBeLessThan(9000);
  }, 15_000);

  test("waiter cap 8: the 9th arrival resolves the OLDEST with a timeout", async () => {
    const polls: Array<Promise<HttpResult>> = [];
    for (let i = 0; i < 9; i++) {
      polls.push(getAwait({ clientTimeoutMs: 30_000 }));
      await sleep(80); // deterministic arrival (and park) order
    }
    // The 9th arrival evicted waiter #0 as a timeout, long before its window.
    const oldest = await polls[0]!;
    expect(oldest.status).toBe(200);
    expect(JSON.parse(oldest.body)).toEqual({ status: "timeout", canvas_open: false });

    // The other 8 are still parked; one enqueue wakes them ALL.
    await postAskback("wake everyone");
    const rest = await Promise.all(polls.slice(1));
    for (const res of rest) {
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ status: "ask", pending: 1 });
    }
    expect(await pendingCount()).toBe(1); // still read-only
    await drainQueue();
  }, 30_000);
});

describe("`listening` SSE state", () => {
  test("connect snapshot, 0→1 on park, ≥1→0 on wake; late joiners see the truth", async () => {
    const sse = await openSse(server.port, server.token());
    // Snapshot on connect: nothing is parked right now.
    const first = await sse.waitFor("listening");
    expect(first.data).toEqual({ on: false });

    // Arm a listener → 0→1 transition.
    const parked = getAwait({ clientTimeoutMs: 20_000 });
    let frames = await waitListeningCount(sse, 2);
    expect(frames[1]).toEqual({ on: true });

    // A client connecting WHILE parked gets an on:true snapshot immediately.
    const late = await openSse(server.port, server.token());
    const lateFirst = await late.waitFor("listening");
    expect(lateFirst.data).toEqual({ on: true });
    late.close();

    // The wake resolves the only waiter → ≥1→0 transition.
    await postAskback("transition to off");
    await parked;
    frames = await waitListeningCount(sse, 3);
    expect(frames[2]).toEqual({ on: false });

    sse.close();
    await drainQueue();
  }, 15_000);
});

describe("await-askback CLI (backgrounded Bash job)", () => {
  test("armed listener wakes on an ask-back: stdout says call check_askbacks, exit 0", async () => {
    const sse = await openSse(server.port, server.token());
    const child = spawn("bun", [cliEntry, "--timeout-ms", "30000"], {
      cwd: repoRoot, // workspace id derives from cwd — must match the server
      env: { ...(process.env as Record<string, string>), HOME: server.home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const exited = new Promise<number | null>((resolve) =>
      child.on("close", (code) => resolve(code)),
    );

    // The CLI's park is observable as the listening 0→1 transition.
    await waitListeningCount(sse, 2, 10_000);
    await postAskback("wake the CLI");

    expect(await exited).toBe(0);
    expect(stdout).toContain("WORKTABLE_LISTENER status=questions action=check");
    expect(stdout).toContain("1 canvas question(s) waiting");
    expect(stdout).toContain("call check_askbacks");
    expect(stdout).toContain("re-arm the listener");
    expect(stderr).toBe("");

    // Read-only end to end: the question is still pending for the tool drain.
    expect(await pendingCount()).toBe(1);
    await drainQueue();
    sse.close();
  }, 20_000);

  test("budget expiry with NO canvas tab open → the exit message says rest", async () => {
    const started = Date.now();
    const run = spawnSync(
      "bun",
      [cliEntry, "--timeout-ms", "5000", "--budget-ms", "11000"],
      {
        cwd: repoRoot,
        env: { ...(process.env as Record<string, string>), HOME: server.home },
        encoding: "utf8",
      },
    );
    const elapsed = Date.now() - started;
    expect(run.status).toBe(0);
    // Two full 5s windows fit; the ~1s remainder is under the poll floor.
    expect(elapsed).toBeGreaterThanOrEqual(9_500);
    // Reached a live server, just quiet → idle, and rest since the page closed.
    expect(run.stdout).toContain("WORKTABLE_LISTENER status=idle action=rest");
    expect(run.stdout).toContain("listened ~");
    // No SSE client was connected → the server reported the page closed.
    expect(run.stdout).toContain("canvas page is closed");
    expect(run.stdout).toContain("rest");
  }, 25_000);

  test("budget expiry WITH a canvas tab open → the exit message says re-arm", async () => {
    const sse = await openSse(server.port, server.token()); // "a tab is open"
    const run = spawnSync(
      "bun",
      [cliEntry, "--timeout-ms", "5000", "--budget-ms", "6000"],
      {
        cwd: repoRoot,
        env: { ...(process.env as Record<string, string>), HOME: server.home },
        encoding: "utf8",
      },
    );
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("WORKTABLE_LISTENER status=idle action=rearm");
    expect(run.stdout).toContain("IS still open");
    expect(run.stdout).toContain("RE-ARM");
    sse.close();
  }, 20_000);

  test("an ask in a LATER inner window still wakes; listening never flaps between windows", async () => {
    // The PREVIOUS test's arming ended inside the off-grace window; let it
    // lapse so this test's connect snapshot starts from a clean off.
    await sleep(2_600);
    const sse = await openSse(server.port, server.token());
    const snapshot = await sse.waitFor("listening"); // connect snapshot
    expect(snapshot.data).toEqual({ on: false });

    const child = spawn(
      "bun",
      [cliEntry, "--timeout-ms", "5000", "--budget-ms", "60000"],
      {
        cwd: repoRoot,
        env: { ...(process.env as Record<string, string>), HOME: server.home },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    const exited = new Promise<number | null>((resolve) =>
      child.on("close", (code) => resolve(code)),
    );

    await waitListeningCount(sse, 2, 10_000); // armed (on:true)
    await sleep(6_000); // cross into the SECOND inner window
    await postAskback("wake during window two");

    expect(await exited).toBe(0);
    expect(stdout).toContain("call check_askbacks");

    // One continuous session on the canvas: snapshot(off), armed(on), then off
    // ONLY at the wake — the 5s window boundary produced no flap (the server's
    // off-grace outlives the CLI's re-poll gap).
    const frames = await waitListeningCount(sse, 3, 10_000);
    expect(frames.map((f) => f.on)).toEqual([false, true, false]);

    expect(await pendingCount()).toBe(1);
    await drainQueue();
    sse.close();
  }, 30_000);

  test("server down (stale state files) → retries the budget, then status=unreachable", async () => {
    const doomed = await spawnServer();
    const home = doomed.home;
    await doomed.close(); // port + token files remain, nothing listens
    // A short collapsed budget (timeout with no --budget-ms) bounds the retry.
    const run = spawnSync(
      "bun",
      [cliEntry, "--timeout-ms", "5000", "--budget-ms", "6000"],
      {
        cwd: repoRoot,
        env: { ...(process.env as Record<string, string>), HOME: home },
        encoding: "utf8",
      },
    );
    expect(run.status).toBe(0);
    // Never reached a server across the budget → unreachable, and the action is
    // a live next step (retry), NOT the old dead-end "do not re-arm".
    expect(run.stdout).toContain(
      "WORKTABLE_LISTENER status=unreachable action=retry",
    );
    expect(run.stdout).toContain("no canvas server answered");
    expect(run.stdout).not.toContain("Do not re-arm");
    // It actually retried rather than giving up on the first refused poll.
    expect(run.stderr).toContain("listener poll failed");
  }, 20_000);

  test("a sustained outage logs the failure ONCE, not once per retry", async () => {
    const doomed = await spawnServer();
    const home = doomed.home;
    await doomed.close(); // state files remain; nothing listens → every poll fails
    // A budget long enough for several backoff retries (2s+4s+8s…).
    const run = spawnSync(
      "bun",
      [cliEntry, "--timeout-ms", "5000", "--budget-ms", "20000"],
      {
        cwd: repoRoot,
        env: { ...(process.env as Record<string, string>), HOME: home },
        encoding: "utf8",
      },
    );
    expect(run.status).toBe(0);
    // Multiple attempts happened, but only the FIRST failure is logged; the
    // 5-min heartbeat never fires inside a 20s budget.
    const failureLines = (run.stderr.match(/listener poll failed/g) ?? []).length;
    expect(failureLines).toBe(1);
    expect(run.stderr).not.toContain("still unreachable after");
    expect(run.stdout).toContain(
      "WORKTABLE_LISTENER status=unreachable action=retry",
    );
  }, 30_000);

  test("missing state files entirely → retries within budget, then status=unreachable", () => {
    const emptyHome = mkdtempSync(join(tmpdir(), "worktable-await-empty-"));
    const run = spawnSync(
      "bun",
      [cliEntry, "--timeout-ms", "5000", "--budget-ms", "6000"],
      {
        cwd: repoRoot,
        env: { ...(process.env as Record<string, string>), HOME: emptyHome },
        encoding: "utf8",
      },
    );
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(
      "WORKTABLE_LISTENER status=unreachable action=retry",
    );
    expect(run.stdout).not.toContain("Do not re-arm");
  }, 20_000);
});
