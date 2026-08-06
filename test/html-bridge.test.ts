// Issue 25 + 27 — HTML hatch bridge: PARENT-side bridge + structural iframe
// tests (happy-dom). These enforce the security invariants as tests, not
// aspirations:
//  · the rendered iframe is sandbox="allow-scripts" with NO allow-same-origin;
//  · the bridge accepts messages ONLY from its own iframe (event.source);
//  · the verb set is CLOSED + schema-validated — frame→parent {resize, askstart,
//    focusEntry, openlink}; parent→frame {port, focusMarker} (issue 27);
//  · openlink re-validates the href INDEPENDENTLY of the frame's prelude checks
//    (string, ≤ 2048, URL-parseable, strictly http/https) and opens it with
//    noopener,noreferrer — anything else is dropped without a throw;
//  · the capability token never crosses the bridge (the parent only ever sends
//    {v:"port"} and {v:"focusMarker",markerId} — neither carries a token).
import { describe, expect, test } from "bun:test";
import { HtmlBridge, renderHtmlCard } from "../src/canvas/components/html.js";
import { makeDom } from "./dom.js";

describe("html iframe (structural)", () => {
  test('sandbox="allow-scripts" with NO allow-same-origin, src → frame origin', () => {
    const { document: doc, mount } = makeDom();
    const handle = renderHtmlCard(mount, {
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

describe("html bridge auth + verb set (issue 27)", () => {
  function setup() {
    const { document: doc, mount } = makeDom();
    const iframe = doc.createElement("iframe");
    mount.appendChild(iframe);
    const resizes: number[] = [];
    const askstarts: Array<{ quote: string; markerId: string }> = [];
    const focusEntries: string[] = [];
    // Spy on window.open — the ONLY effect a valid openlink may have.
    const opens: unknown[][] = [];
    (doc.defaultView as unknown as { open: (...a: unknown[]) => void }).open = (
      ...a: unknown[]
    ) => opens.push(a);
    const bridge = new HtmlBridge({
      iframe,
      artifactId: "a_0000000b",
      version: 5,
      onResize: (px) => resizes.push(px),
      onAskStart: (quote, markerId) => askstarts.push({ quote, markerId }),
      onFocusEntry: (markerId) => focusEntries.push(markerId),
    });
    return { doc, iframe, bridge, resizes, askstarts, focusEntries, opens };
  }

  test("acceptsSource: only the iframe's own contentWindow", () => {
    const { iframe, bridge } = setup();
    expect(bridge.acceptsSource(iframe.contentWindow)).toBe(true);
    expect(bridge.acceptsSource({} as unknown as MessageEventSource)).toBe(false);
    expect(bridge.acceptsSource(null)).toBe(false);
  });

  test("valid askstart → onAskStart with a trimmed quote + the frame markerId", () => {
    const { bridge, askstarts } = setup();
    bridge.handleFrameMessage({
      v: "askstart",
      quote: "  selected words  ",
      markerId: "m3",
    });
    expect(askstarts).toEqual([{ quote: "selected words", markerId: "m3" }]);
  });

  test("valid focusEntry → onFocusEntry with the markerId", () => {
    const { bridge, focusEntries } = setup();
    bridge.handleFrameMessage({ v: "focusEntry", markerId: "m7" });
    expect(focusEntries).toEqual(["m7"]);
  });

  test("out-of-set and malformed verbs are dropped", () => {
    const { bridge, resizes, askstarts, focusEntries, opens } = setup();
    bridge.handleFrameMessage({ v: "evil", quote: "q", markerId: "m1" });
    // The retired composer verb no longer exists → dropped.
    bridge.handleFrameMessage({ v: "askback", quote: "q", question: "x" });
    bridge.handleFrameMessage({ v: "askstart", quote: 123, markerId: "m1" });
    bridge.handleFrameMessage({ v: "askstart", quote: "q" }); // no markerId
    bridge.handleFrameMessage({ v: "askstart", quote: "   ", markerId: "m1" });
    bridge.handleFrameMessage({ v: "focusEntry", markerId: 123 });
    bridge.handleFrameMessage({ v: "focusEntry" });
    bridge.handleFrameMessage({ v: "resize", px: "500" });
    bridge.handleFrameMessage("not-an-object");
    bridge.handleFrameMessage(null);
    expect(askstarts.length).toBe(0);
    expect(focusEntries.length).toBe(0);
    expect(resizes.length).toBe(0);
    expect(opens.length).toBe(0);
  });

  test("resize verb clamps the reported height", () => {
    const { bridge, resizes } = setup();
    bridge.handleFrameMessage({ v: "resize", px: 640 });
    bridge.handleFrameMessage({ v: "resize", px: 5 }); // below floor
    bridge.handleFrameMessage({ v: "resize", px: 999999 }); // above ceiling
    expect(resizes).toEqual([640, 80, 20000]);
  });

  test("openlink: a valid https href opens in a new tab with noopener,noreferrer", () => {
    const { bridge, opens } = setup();
    bridge.handleFrameMessage({
      v: "openlink",
      href: "https://issues.example/browse/PROJ-123",
    });
    expect(opens).toEqual([
      ["https://issues.example/browse/PROJ-123", "_blank", "noopener,noreferrer"],
    ]);
    // Canary: nothing token-shaped reaches the opened destination's arguments.
    expect(JSON.stringify(opens)).not.toContain("token");
  });

  test("openlink: a valid http href also opens (http is on the allowlist)", () => {
    const { bridge, opens } = setup();
    bridge.handleFrameMessage({ v: "openlink", href: "http://127.0.0.1:9999/pr/7" });
    expect(opens).toEqual([
      ["http://127.0.0.1:9999/pr/7", "_blank", "noopener,noreferrer"],
    ]);
  });

  test("openlink: the parent re-validates independently — hostile/malformed hrefs never open and never throw", () => {
    const { bridge, opens } = setup();
    const hostile: unknown[] = [
      { v: "openlink", href: "javascript:alert(1)" },
      { v: "openlink", href: "data:text/html,<script>alert(1)</script>" },
      { v: "openlink", href: "file:///etc/passwd" },
      { v: "openlink", href: "https://evil.example/" + "a".repeat(5000) }, // oversized
      { v: "openlink", href: 12345 }, // non-string
      { v: "openlink", href: { toString: () => "https://evil.example/" } },
      { v: "openlink", href: "" },
      { v: "openlink", href: "/relative/path" },
      { v: "openlink", href: "#fragment" }, // fragments never cross the bridge
      { v: "openlink" }, // missing href
      { v: "open", href: "https://ok.example/" }, // unknown verb
    ];
    for (const msg of hostile) {
      expect(() => bridge.handleFrameMessage(msg)).not.toThrow();
    }
    expect(opens.length).toBe(0);
  });

  test("focusMarker (parent→frame) posts {v:'focusMarker',markerId} + no token", () => {
    const { bridge } = setup();
    const sent: unknown[] = [];
    (
      bridge as unknown as { channel: { port1: { postMessage(m: unknown): void } } }
    ).channel.port1.postMessage = (m: unknown) => sent.push(m);
    bridge.focusMarker("m9");
    expect(sent).toEqual([{ v: "focusMarker", markerId: "m9", scroll: true }]);
    // Canary: the parent→frame verb never carries the capability token.
    expect(JSON.stringify(sent[0])).not.toContain("token");
  });
});

describe("bridge token canary + identity-gated port transfer", () => {
  test("port transfer happens ONLY on an identity-verified 'ready', and carries no token", () => {
    const { document: doc, mount } = makeDom();
    const iframe = doc.createElement("iframe");
    mount.appendChild(iframe);
    const sent: unknown[][] = [];
    // Spy on the frame's postMessage — this is the ONLY thing the parent sends
    // the frame over the window channel. It must never carry the token.
    (iframe.contentWindow as unknown as { postMessage: (...a: unknown[]) => void }).postMessage =
      (...args: unknown[]) => sent.push(args);

    const bridge = new HtmlBridge({
      iframe,
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

  test("a post-navigation (second load) 'ready' gets NO port (Finding 2)", () => {
    const { document: doc, mount } = makeDom();
    const iframe = doc.createElement("iframe");
    mount.appendChild(iframe);
    const sent: unknown[][] = [];
    (iframe.contentWindow as unknown as { postMessage: (...a: unknown[]) => void }).postMessage =
      (...args: unknown[]) => sent.push(args);

    const bridge = new HtmlBridge({
      iframe,
      artifactId: "a_0000000d",
      version: 1,
    });
    bridge.start(); // registers the iframe 'load' counter

    // Simulate the frame navigating: two load events → a second generation.
    iframe.dispatchEvent(
      new (iframe.ownerDocument.defaultView as unknown as { Event: typeof Event }).Event("load"),
    );
    iframe.dispatchEvent(
      new (iframe.ownerDocument.defaultView as unknown as { Event: typeof Event }).Event("load"),
    );
    expect(bridge.hasNavigated()).toBe(true);

    // Even with the correct WindowProxy identity (which survives navigation),
    // the post-navigation document's 'ready' must be refused.
    const onWindowMessage = (bridge as unknown as {
      onWindowMessage: (e: MessageEvent) => void;
    }).onWindowMessage;
    onWindowMessage({
      source: iframe.contentWindow,
      data: { v: "ready" },
    } as MessageEvent);
    expect(sent.length).toBe(0);
    bridge.dispose();
  });

  test("first-generation 'ready' (single load) still transfers (positive control)", () => {
    const { document: doc, mount } = makeDom();
    const iframe = doc.createElement("iframe");
    mount.appendChild(iframe);
    const sent: unknown[][] = [];
    (iframe.contentWindow as unknown as { postMessage: (...a: unknown[]) => void }).postMessage =
      (...args: unknown[]) => sent.push(args);

    const bridge = new HtmlBridge({
      iframe,
      artifactId: "a_0000000e",
      version: 1,
    });
    bridge.start();
    iframe.dispatchEvent(
      new (iframe.ownerDocument.defaultView as unknown as { Event: typeof Event }).Event("load"),
    ); // first (trusted) load only
    expect(bridge.hasNavigated()).toBe(false);
    const onWindowMessage = (bridge as unknown as {
      onWindowMessage: (e: MessageEvent) => void;
    }).onWindowMessage;
    onWindowMessage({
      source: iframe.contentWindow,
      data: { v: "ready" },
    } as MessageEvent);
    expect(sent.length).toBe(1);
    expect(sent[0]![0]).toEqual({ v: "port" });
    bridge.dispose();
  });
});
