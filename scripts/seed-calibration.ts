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

// ROUND 6 (2026-07-16): confirm the 2-sided edge-straddle model (issue 19). Flag
// fires only when a label bursts its owning box on 2+ sides (box too small). This set
// probes both directions plus the reviewer's adversarial case (extreme 1-sided
// overhang with center barely inside — should stay clean per the owner's gestalt).
const SEEDS: Array<{ title: string; svg: string; expect: string }> = [
  {
    title: "Label bursts BOTH sides of a too-small box",
    expect: "edge-straddle SHOULD flag — box can't contain the label (left+right)",
    svg:
      S +
      '<rect x="150" y="80" width="70" height="30" fill="none" stroke="navy"/>' +
      '<text x="185" y="99" font-size="14" text-anchor="middle">Overflowing Wide Label</text></svg>',
  },
  {
    title: "Label with a small one-sided tail off the right",
    expect: "NO flag — one-sided tail, box still contains most of it (the round-4 'fine' case)",
    svg:
      S +
      '<rect x="40" y="70" width="160" height="44" fill="none" stroke="navy"/>' +
      '<text x="100" y="97" font-size="13">label runs off right</text></svg>',
  },
  {
    title: "Reviewer probe: label runs WAY off one side, center barely inside",
    expect: "NO flag by the 2-sided model — but rule by eye: does an extreme 1-sided overhang bother you?",
    svg:
      S +
      '<rect x="60" y="80" width="120" height="30" fill="none" stroke="navy"/>' +
      '<text x="118" y="99" font-size="13">this label runs far past the right edge</text></svg>',
  },
  {
    title: "Label sitting on a connector arrow",
    expect: "NO flag — on-arrow label, no owning box (issue-17 exclusion)",
    svg:
      S +
      '<rect x="30" y="70" width="90" height="50" fill="none" stroke="navy"/>' +
      '<rect x="280" y="70" width="90" height="50" fill="none" stroke="navy"/>' +
      '<line x1="120" y1="95" x2="280" y2="95" stroke="navy" stroke-width="2"/>' +
      '<text x="200" y="90" font-size="12" text-anchor="middle">on the arrow</text></svg>',
  },
  {
    title: "Label comfortably inside its box",
    expect: "NO flag — fully contained",
    svg:
      S +
      '<rect x="60" y="70" width="280" height="50" fill="none" stroke="navy"/>' +
      '<text x="200" y="100" font-size="14" text-anchor="middle">Contained Label</text></svg>',
  },
]

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
