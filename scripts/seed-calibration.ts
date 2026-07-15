// Calibration seed (M4): publishes a curated set of free-form SVG artifacts to
// the current workspace over MCP — one clean SVG plus one deliberately tripping
// each legibility check (text-overlap, edge-straddle, clipped, sub-legible) and
// one mixed case. Each is sanitizer-valid but legibility-flawed, so the gate
// computes real findings for the human to rule in /calibration.
//
// Writes to the SAME workspace as a running server (workspace = hash of cwd),
// so after seeding, reload the calibration gallery to see the findings.
//
// Run: bun run build && bun scripts/seed-calibration.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const distEntry = join(repoRoot, "dist", "server", "index.js");
const S = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200">';

// ROUND 2 (2026-07-15): re-calibrating the display-scale-aware sub-legible check
// (issue 16). Includes the exact "small but fine" cases the owner already ruled
// legible — they should now produce ZERO sub-legible findings — plus genuinely
// render-illegible cases (small font in a WIDE viewBox that renders ~3px) that
// SHOULD still flag, and one each of the trusted checks as a regression guard.
//
// Each: a title the human sees + an SVG. "expect" is a note for the operator —
// the gate decides what actually fires. `vb` picks the viewBox (wide viewBoxes
// shrink the on-screen render, so small fonts there really are illegible).
const W = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 400">'; // wide → 0.52× display
const B = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1672 400">'; // 0.50× display (boundary)
const SEEDS: Array<{ title: string; svg: string; expect: string }> = [
  {
    title: "The 6px caption you ruled fine (normal-width diagram)",
    expect: "NO sub-legible now — renders ~12.5px after display scale",
    svg: S + '<text x="40" y="110" font-size="6">a small but perfectly readable caption</text></svg>',
  },
  {
    title: "A 7px note in a normal-width diagram",
    expect: "NO sub-legible now — renders ~14.6px",
    svg: S + '<text x="40" y="110" font-size="7">small note, still legible on screen</text></svg>',
  },
  {
    title: "Dense schematic: 6px labels in a very wide diagram",
    expect: "sub-legible — renders ~3px, genuinely unreadable",
    svg:
      W +
      '<rect x="40" y="120" width="300" height="120" fill="none" stroke="navy"/>' +
      '<text x="60" y="185" font-size="6">this label is far too small to read at render size</text></svg>',
  },
  {
    title: "Just under the line: 16px in a wide diagram",
    expect: "sub-legible — renders exactly ~8px (floor is 9px)",
    svg: B + '<text x="60" y="200" font-size="16">right at the boundary of legibility</text></svg>',
  },
  {
    title: "Two labels stacked on top of each other",
    expect: "text-overlap (regression guard — was 100%)",
    svg:
      S +
      '<text x="40" y="96" font-size="14">First label sits here</text>' +
      '<text x="40" y="102" font-size="14">Second label lands on it</text></svg>',
  },
  {
    title: "A node pushed off the right edge",
    expect: "clipped (regression guard — was 100%)",
    svg: S + '<rect x="360" y="60" width="70" height="40" rx="4" fill="teal"/></svg>',
  },
  {
    title: "Clean two-step flow",
    expect: "no findings — false-positive check",
    svg:
      S +
      '<rect x="40" y="70" width="120" height="50" rx="6" fill="none" stroke="navy"/>' +
      '<text x="100" y="100" font-size="14" text-anchor="middle">Collect</text>' +
      '<rect x="240" y="70" width="120" height="50" rx="6" fill="none" stroke="navy"/>' +
      '<text x="300" y="100" font-size="14" text-anchor="middle">Render</text>' +
      '<line x1="160" y1="95" x2="240" y2="95" stroke="navy" stroke-width="2"/></svg>',
  },
];

function toolJson(result: unknown): Record<string, unknown> {
  const r = result as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  if (r.isError) throw new Error(`tool error: ${r.content[0]?.text}`);
  return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
}

async function main(): Promise<void> {
  const useDist = existsSync(distEntry);
  const transport = new StdioClientTransport({
    command: useDist ? "node" : "bun",
    args: [useDist ? distEntry : join(repoRoot, "src", "server", "index.ts")],
    cwd: repoRoot,
    // Don't pop a browser tab; a server may already be open on the canvas.
    env: { ...(process.env as Record<string, string>), VISUAL_CHAT_NO_OPEN: "1" },
    stderr: "inherit",
  });
  const client = new Client({ name: "visual-chat-calibration-seed", version: "0.1.0" });
  await client.connect(transport);

  for (const seed of SEEDS) {
    const res = toolJson(
      await client.callTool({
        name: "publish_artifact",
        arguments: { type: "svg", title: seed.title, svg: seed.svg },
      }),
    );
    console.log(`published ${res.artifact_id}  "${seed.title}"  (expect: ${seed.expect})`);
  }

  console.log(
    `\nSeeded ${SEEDS.length} SVG artifacts. Reload the calibration gallery ` +
      `(/calibration?token=…) to rule the findings.`,
  );
  await client.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
