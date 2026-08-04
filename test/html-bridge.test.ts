// Issue 25 — free-form HTML hatch: PARENT-side bridge + structural iframe tests
// (happy-dom). These enforce the security invariants as tests, not aspirations:
//  · the rendered iframe is sandbox="allow-scripts" with NO allow-same-origin;
//  · the bridge accepts messages ONLY from its own iframe (event.source);
//  · the verb set is closed + schema-validated;
//  · the capability token never crosses the bridge (the parent only ever sends
//    {v:"port"}).
import { describe, expect, test } from "bun:test";
import type { Anchor } from "../src/shared/artifacts.js";
import { HtmlBridge, renderHtmlCard } from "../src/canvas/components/html.js";
import { makeDom } from "./dom.js";

interface AskbackCall {
  anchor: Anchor;
  question: string;
}

function fakeApi() {
  const calls: AskbackCall[] = [];
  return {
    calls,
    api: {
      postAskback: (body: { anchor: unknown; question: string }) => {
        calls.push({ anchor: body.anchor as Anchor, question: body.question });
        return Promise.resolve({ id: "ab_1", state: "pending" });
      },
    },
  };
}

describe("html iframe (structural)", () => {
  test('sandbox="allow-scripts" with NO allow-same-origin, src → frame origin', () => {
    const { document: doc, mount } = makeDom();
    const { api } = fakeApi();
    const handle = renderHtmlCard(mount, {
      api,
      frameOrigin: "http://127.0.0.1:8888",
      frameSlug: "a".repeat(32),
      artifactId: "a_0000000a",
      version: 2,
      title: "card",
    });
    const iframe = mount.querySelector("iframe") as HTMLIFrameElement;
    expect(iframe).not.toBeNull();
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(iframe.getAttribute("src")).toBe(
      "http://127.0.0.1:8888/f/" + "a".repeat(32),
    );
    handle.dispose();
    void doc;
  });
});

describe("html bridge auth + verb set", () => {
  function setup() {
    const { document: doc, mount } = makeDom();
    const { api, calls } = fakeApi();
    const iframe = doc.createElement("iframe");
    mount.appendChild(iframe);
    const resizes: number[] = [];
    const submitted: Array<{ id: string; anchor: Anchor; question: string }> = [];
    const bridge = new HtmlBridge({
      iframe,
      api,
      artifactId: "a_0000000b",
      version: 5,
      onResize: (px) => resizes.push(px),
      onAskbackSubmitted: (id, anchor, question) =>
        submitted.push({ id, anchor, question }),
    });
    return { doc, iframe, bridge, calls, resizes, submitted };
  }

  test("acceptsSource: only the iframe's own contentWindow", () => {
    const { iframe, bridge } = setup();
    expect(bridge.acceptsSource(iframe.contentWindow)).toBe(true);
    expect(bridge.acceptsSource({} as unknown as MessageEventSource)).toBe(false);
    expect(bridge.acceptsSource(null)).toBe(false);
  });

  test("valid askback → postAskback with a null-block whole-artifact anchor", () => {
    const { bridge, calls } = setup();
    bridge.handleFrameMessage({
      v: "askback",
      quote: "  selected words  ",
      question: "  what is this?  ",
    });
    expect(calls.length).toBe(1);
    expect(calls[0]!.question).toBe("what is this?");
    expect(calls[0]!.anchor).toEqual({
      artifact_id: "a_0000000b",
      version: 5,
      block_index: null,
      quote: "selected words",
    });
  });

  test("onAskbackSubmitted fires after the POST resolves", async () => {
    const { bridge, submitted } = setup();
    bridge.handleFrameMessage({ v: "askback", quote: "q", question: "why?" });
    await Promise.resolve();
    await Promise.resolve();
    expect(submitted.length).toBe(1);
    expect(submitted[0]!.id).toBe("ab_1");
    expect(submitted[0]!.question).toBe("why?");
  });

  test("out-of-set and malformed verbs are dropped", () => {
    const { bridge, calls, resizes } = setup();
    bridge.handleFrameMessage({ v: "evil", quote: "q", question: "x" });
    bridge.handleFrameMessage({ v: "askback", quote: 123, question: "x" });
    bridge.handleFrameMessage({ v: "askback", quote: "q", question: "   " });
    bridge.handleFrameMessage({ v: "resize", px: "500" });
    bridge.handleFrameMessage("not-an-object");
    bridge.handleFrameMessage(null);
    expect(calls.length).toBe(0);
    expect(resizes.length).toBe(0);
  });

  test("resize verb clamps the reported height", () => {
    const { bridge, resizes } = setup();
    bridge.handleFrameMessage({ v: "resize", px: 640 });
    bridge.handleFrameMessage({ v: "resize", px: 5 }); // below floor
    bridge.handleFrameMessage({ v: "resize", px: 999999 }); // above ceiling
    expect(resizes).toEqual([640, 80, 20000]);
  });
});

describe("bridge token canary + identity-gated port transfer", () => {
  test("port transfer happens ONLY on an identity-verified 'ready', and carries no token", () => {
    const { document: doc, mount } = makeDom();
    const { api } = fakeApi();
    const iframe = doc.createElement("iframe");
    mount.appendChild(iframe);
    const sent: unknown[][] = [];
    // Spy on the frame's postMessage — this is the ONLY thing the parent sends
    // the frame. It must never carry the capability token.
    (iframe.contentWindow as unknown as { postMessage: (...a: unknown[]) => void }).postMessage =
      (...args: unknown[]) => sent.push(args);

    const bridge = new HtmlBridge({
      iframe,
      api,
      artifactId: "a_0000000c",
      version: 1,
    });
    const onWindowMessage = (bridge as unknown as {
      onWindowMessage: (e: MessageEvent) => void;
    }).onWindowMessage;

    // Wrong source → no transfer.
    onWindowMessage({
      source: {} as MessageEventSource,
      data: { v: "ready" },
    } as MessageEvent);
    expect(sent.length).toBe(0);

    // Right source but wrong verb → no transfer.
    onWindowMessage({
      source: iframe.contentWindow,
      data: { v: "nope" },
    } as MessageEvent);
    expect(sent.length).toBe(0);

    // Correct identity + ready → exactly one transfer of {v:"port"}.
    onWindowMessage({
      source: iframe.contentWindow,
      data: { v: "ready" },
    } as MessageEvent);
    expect(sent.length).toBe(1);
    expect(sent[0]![0]).toEqual({ v: "port" });
    // Canary: nothing token-shaped anywhere in the payload.
    expect(JSON.stringify(sent[0]![0])).not.toContain("token");

    // Idempotent — a second ready does not re-transfer.
    onWindowMessage({
      source: iframe.contentWindow,
      data: { v: "ready" },
    } as MessageEvent);
    expect(sent.length).toBe(1);
    bridge.dispose();
  });
});
