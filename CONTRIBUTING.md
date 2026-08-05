# Contributing to Worktable

Thanks for looking. This is a small, opinionated project - a quick read of the shape
below will save us both time.

## Build and test

```sh
bun install
bun run build      # tsc (server, canvas, hooks) + vite build + hook bundle
bun test           # bun's test runner
```

Bun is the dev/test toolchain; the built server runs on Node 20+. `bun run dev`
starts the canvas in Vite for UI work.

## Ground rules

- **Read `CONTEXT.md` first.** It's the glossary. Use those exact terms in code,
  tests, and prose - shared language keeps the codebase legible.
- **Security is structural, not filtered.** Model output is untrusted. Prefer
  impossible-by-construction (frame isolation, schema-validated structured intent)
  over sanitize-and-hope. The security modules (`src/server/frameGuard.ts`, the frame
  server) carry **zero runtime dependencies** - keep it that way. Any new dependency
  anywhere needs a real justification.
- **Model-influenced strings reach the DOM via `textContent` / `createElement` only**
  - never `innerHTML`. This is enforced by tests (XSS canaries); don't route around
  it.
- **Invariants are test-enforced.** Permissions (via `fs.stat`), 401/403 over real
  HTTP, and the frame boundary all have tests. If you touch a boundary, the
  adversarial fixtures come with it.
- **Truth over decoration.** An artifact may abstract, but never tell an untrue
  story. Honest absence is a valid outcome.

## Architectural decisions

Non-trivial decisions live in `docs/adr/` as numbered records with the context, the
choice, and the alternatives that were rejected. If you're changing something an ADR
covers, update or supersede it in the same change. New ADR for a new hard-to-reverse
decision; skip it for the routine stuff.

## Commits and PRs

- One logical change per commit. Present-tense summary; explain the *why* in the body
  when it isn't obvious.
- Run `bun test` and `bun run build` before opening a PR.
- If your change touches the running state, update the Status section in
  `docs/STATUS.md`.
