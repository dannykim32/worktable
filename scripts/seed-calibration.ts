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

// ROUND 5 (2026-07-16): re-calibrating edge-straddle after the width fix (issue 18).
// The poke test now uses a conservative 0.45em/char width, so a label that visually
// FITS its box no longer manufactures a straddle. This set tests both directions: a
// clearly-overflowing label that MUST still flag, and the round-4 fits-fine label
// that must now be silent — plus regression guards.
//
// Each: a title the human sees + an SVG. "expect" is a note for the operator.
const SEEDS: Array<{ title: string; svg: string; expect: string }> = [
  {
    title: "A label that clearly overflows its box on both sides",
    expect: "edge-straddle SHOULD flag — text pokes ~50px past a narrow box, unmistakable",
    svg:
      S +
      '<rect x="180" y="76" width="40" height="32" fill="none" stroke="navy"/>' +
      '<text x="200" y="97" font-size="14" text-anchor="middle">Overflowing Wide Label</text></svg>',
  },
  {
    title: "The round-4 label you said fit fine",
    expect: "NO edge-straddle now — 0.45em width fits inside the box (was falsely flagged before)",
    svg:
      S +
      '<rect x="40" y="70" width="160" height="44" fill="none" stroke="navy"/>' +
      '<text x="100" y="97" font-size="13">label runs off right</text></svg>',
  },
  {
    title: "A label sitting on a connector arrow",
    expect: "NO edge-straddle — on-arrow label (issue-17 exclusion still holds)",
    svg:
      S +
      '<rect x="30" y="70" width="90" height="50" fill="none" stroke="navy"/>' +
      '<rect x="280" y="70" width="90" height="50" fill="none" stroke="navy"/>' +
      '<line x1="120" y1="95" x2="280" y2="95" stroke="navy" stroke-width="2"/>' +
      '<text x="200" y="90" font-size="12" text-anchor="middle">on the arrow</text></svg>',
  },
  {
    title: "Two labels stacked on top of each other",
    expect: "text-overlap (regression guard)",
    svg:
      S +
      '<text x="40" y="96" font-size="14">First label sits here</text>' +
      '<text x="40" y="102" font-size="14">Second label lands on it</text></svg>',
  },
  {
    title: "A node pushed off the right edge",
    expect: "clipped (regression guard)",
    svg: S + '<rect x="360" y="60" width="70" height="40" rx="4" fill="teal"/></svg>',
  },
  {
    title: "Clean two-step flow",
    expect: "no findings",
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
