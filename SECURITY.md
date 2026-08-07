# Security Policy

Worktable renders model-authored HTML into a browser. That surface is the center
of the threat model, so security reports get taken seriously and triaged quickly.

## Reporting a vulnerability

Please report privately — **do not open a public issue**.

Use GitHub's private advisory form:
**https://github.com/dannykim32/worktable/security/advisories/new**

Include the version or commit SHA, a description of the issue, and a proof of
concept if you have one. Expect an acknowledgement within a few days.

## What's in scope

The boundaries that matter most, and what would count as a break:

- **Frame isolation.** Model HTML is served from a *second* `127.0.0.1` origin
  into a `sandbox="allow-scripts"` iframe that is never `allow-same-origin`,
  under a header CSP whose `script-src` is a per-response nonce the model never
  sees. Running script in the parent origin, reading the capability token from
  inside the frame, or escaping the sandbox is in scope.
- **Egress boundary.** The ingest guard rejects any artifact that could phone
  home without a click (`<meta http-equiv>`, external `<link>`, etc.) — it
  rejects the whole artifact rather than silently stripping it. A payload that
  reaches the browser and makes a network request is in scope.
- **Local server.** The canvas binds `127.0.0.1` with a Host allowlist
  (DNS-rebinding defense) and a capability token scoped to the parent origin.
  Auth bypass, token leakage, or a rebinding that reaches the server is in scope.

## Out of scope

- Anything that requires code already running as the user — that is a strictly
  easier attack than anything Worktable adds.
- Denial of service from a local client against the local server.

## Supported versions

Worktable is pre-1.0. Security fixes land on `main` and the latest release.
Please reproduce against `main` before reporting.
