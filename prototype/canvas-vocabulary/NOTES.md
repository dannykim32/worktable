# PROTOTYPE NOTES — canvas vocabulary

**Question:** does Document + Dashboard + Compare cover the v1 jobs, and should
diagrams be free-form model-authored SVG or a structured auto-layout component?

**How to judge:** `open PROTOTYPE-canvas-mock.html` — flip variants with ←/→ or the
bottom bar (`?variant=A|B|C`).

- A — free-form SVG owns diagrams (in gallery context)
- B — structured Diagram component (engine-owned layered layout)
- C — both side-by-side

Things to look at:
- Document/Dashboard/Compare: does anything you'd actually ask an agent for have
  no home in these three?
- Diagram A vs B: the free-form version carries in-place idioms (trust-boundary
  box, warning pinned to its edge, node size = importance, numbered flow); the
  structured version is guaranteed-tidy but its annotations are exiled to
  footnotes. Which tells the story better?
- Select text in the Document artifact to feel the ask-back affordance.

**Verdict (2026-07-14):** Document + Dashboard + Compare cover the jobs; free-form
SVG owns diagrams, contingent on the legibility gate (no overlapping text, no
unreadable density). Recorded as ADR-0007. This directory is now deletable —
kept temporarily as a seed for the pilot gallery.
