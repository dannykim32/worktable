# Artifacts are stable identities with versioned in-place updates

An artifact keeps one stable ID for its lifetime; update_artifact replaces content
atomically but every prior version is retained, and the canvas shows the latest with
access to history. Chosen over overwrite-in-place (ask-back anchors would dangle
against content the human never saw) and over an append-only gallery (stale
near-duplicates, no stable identity for "the current diagram"). Anchors therefore
bind to artifact + version, so the agent always knows exactly what the human was
looking at; the legibility-gate repair round is just another version; and visible
revision history doubles as an honesty affordance. No partial or streaming renders —
one tool call carries the full new content, so the canvas never displays a half-true
artifact.
