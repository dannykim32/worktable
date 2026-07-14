# Every browser-facing endpoint requires a per-workspace capability token

The prior project's rule ("browser endpoints may be unauthenticated if anything
running as the user is a strictly easier door") is explicitly superseded: the
ask-back queue is a write channel into a tool-wielding agent, and an unauthenticated
localhost POST is reachable by any webpage via no-preflight cross-origin requests —
a drive-by prompt-injection door, not a strictly-easier one. Reads are sensitive too,
since artifacts carry source code and business data. Therefore one random
per-workspace capability token (persisted 0600, embedded in the URL the server
opens/prints, sent as a bearer by page JS) gates reads, ask-back writes, and the
event stream, alongside the retained 127.0.0.1 bind and Host-header allowlist.
Per-workspace rather than per-session so an open tab survives agent restarts;
rotation is available on demand. Split postures (open reads, tokened writes) were
rejected because two rules invite drift. The agent-side stdio transport carries no
token — the parent-child pipe is its trust boundary.
