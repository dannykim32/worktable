# 12 — Gate enforcement + bounded repair round

Status: done
Type: task
Milestone: M5
Blocked by: 11

## Context

ADR-0007 failure path: ONE bounded repair round with the gate's exact findings;
second failure = honest absence. Enforcement is gated behind calibration sign-off —
a human decision, never automatic.

## Implementation Details

**Activation:** `<dir>/config.json` gains `"gate": "report" | "enforce"` (default
`report`). Flipped manually by the human (documented in docs/setup.md: review
/calibration precision first). A `set_gate_mode` MCP tool is NOT provided — the agent
must not be able to grant itself or remove enforcement (one-way trust decision).

**Enforce path on svg publish/update:**
1. Findings present → tool returns `{ gate: "failed", findings: […verbatim…],
   repair_hint }` and nothing is stored. The response instructs: fix ONLY the listed
   geometry; one repair attempt remains.
2. Server tracks attempts keyed by (artifact_id or provisional publish token): a
   second failing submission within the same repair context → server converts the
   submission to an `absence` artifact: title preserved, reason = "Failed the
   legibility gate twice" + findings summary. Tool response says exactly that.
3. A passing submission clears the repair context.

## Acceptance Criteria

1. In `report` mode behavior is identical to issue 11 (regression suite).
2. In `enforce`: failing SVG → findings returned verbatim, nothing stored.
3. Resubmission that fixes findings → publishes normally; context cleared.
4. Second failing resubmission → absence artifact exists with findings summary; tool
   response labels it honest absence, not an error.
5. Repair context survives server restart (persisted), expires after 1h.
6. No MCP tool can change gate mode (attempted tool call list asserted in test).

## Testing Plan

| Layer | What | Count |
|-------|------|-------|
| Integration | the 4-step enforce flow, restart persistence, expiry | +6 |

## Effort

~4h.

## Out of Scope

Auto-flip based on precision thresholds (human decides), gate changes to components.

## Precondition (calibration round 1, 2026-07-15)
BLOCKED until issue 16 lands AND the owner re-calibrates the sub-legible check to
acceptable precision. Round 1 (docs/qa/calibration-round-1.md): overlap/straddle/
clipped scored 100% and are ready to enforce; sub-legible scored 0% (judges SVG-space
font, not rendered px) and must be fixed (issue 16) + re-ruled first. Do not enforce
any check before the owner signs off on the re-calibration.

## Precondition SATISFIED (calibration round 2, 2026-07-15)
Owner re-calibrated the fixed sub-legible check (docs/qa/calibration-round-2.md):
all four checks now at 100% precision / trustworthy. Enforcement is UNBLOCKED —
enforce all four checks. The 9px floor is confirmed well-placed (owner ruled the
~8px case borderline-illegible), so no threshold change.

## Comments

Implemented 2026-07-14. All six acceptance criteria pass; `bun test` green
(224 pass, +14 over the 210 baseline). `tsc` clean.

**What shipped**
- `src/server/config.ts` — `readGateMode(<stateDir>/config.json)` → `"report"`
  (default) | `"enforce"`; anything malformed/unknown degrades to `report`. Read
  ONCE at startup (a flip applies on restart). Also `shouldEnforce(...)`, the
  single predicate that arms the enforcement branch: `enforce && svg &&
  findings.length > 0`. Because `runGateSafe` degrades a gate THROW to zero
  findings, a crash can never satisfy it — the fail-open invariant is
  structural, and unit-tested directly.
- `src/server/repair.ts` — `RepairRegistry`, persisted to
  `<stateDir>/repair-contexts.json`, keyed per repair context, 1h TTL, injectable
  clock. `mintRepairToken()` is the provisional publish token.
- `src/server/index.ts` — enforcement wired into both `publish_artifact` and
  `update_artifact`. Publish contexts key on the echoed `repair_token`; update
  contexts key on `artifact_id`. First failure → `{ gate:"failed", findings,
  repair_hint, repair_token? }`, nothing stored. Second failure → a NEW
  `absence` artifact (`reason = "Failed the legibility gate twice." + findings
  summary`), response labelled `outcome:"honest_absence"`. A pass clears the
  context. Report mode is byte-identical to issue 11 (skips the whole block and
  never writes `repair-contexts.json`).
- `repair_token` added as an optional field on the svg schema variant
  (validate.ts) and stripped in the handlers before content validation.

**Security invariant (AC6)**: no MCP tool can set the gate mode — the tool set is
closed and enforcement is armed only by a human editing config.json. Tested:
smuggling `gate`/`mode`/`config` args into every tool (and a bogus
`set_gate_mode` call) never creates config.json.

**Judgment calls**
- An `update` that fails the gate twice publishes a SEPARATE absence artifact;
  the original svg artifact keeps its last good version. Converting the svg
  artifact itself to absence would violate one-type-for-life (ADR-0006).
- (Follow-up, fix(review)) The publish/update `inputSchema` was a bare
  top-level `oneOf` with no `type:"object"`, so `client.listTools()` failed
  against the server (a spec-compliant host could enumerate no tools — latent
  since M1). Fixed by wrapping as `{ type:"object", oneOf:[…] }`; each branch
  is already `type:"object"`, and the hand-validator stays authoritative. The
  security test now enumerates the REAL tools via `listTools()` and a regression
  test asserts `listTools()` returns exactly the five-tool closed set.
- Repair-context keying uses the spec's "provisional publish token" for
  publishes (the agent echoes it) and the artifact_id for updates.

## Known minor (non-blocking, from M5 review 2026-07-15)
- Repair contexts can accumulate within the 1h TTL window: a first-failure publish
  without an echoed repair_token mints a fresh context each time, and purge only
  runs on has()/recordFailure(), so abandoned entries linger past 1h until the next
  op (O(n) atomic-rewrite amplification). Self-inflicted under the local
  single-agent trust model. Future hardening: opportunistic purge-on-load + a
  per-workspace context cap.
- Cosmetic: repair_token is advertised only on the svg schema branch; a strict host
  would reject document+repair_token that the server harmlessly strips pre-validate.
