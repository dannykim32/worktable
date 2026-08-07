// Snapshot GitHub's repo-traffic API and merge it into a permanent daily series.
//
// GitHub only retains traffic (clones/views) for a rolling 14-day window and does
// NOT keep history. But each API response carries a per-day breakdown with stable
// timestamps, so if we snapshot at least once every 14 days and merge by date, we
// accumulate an unbounded time series. The window rolls; the stored file only grows.
//
// Merge rule: newer data wins for a given date. That is correct even for the
// current (partial) day — a later run sees that day completed and overwrites the
// partial count with the final one.
//
// Note on the numbers: daily `count` is additive (sum = accurate all-time total).
// `uniques` is NOT additive across days — GitHub gives no identity to dedup, so a
// true lifetime-unique is unrecoverable. `summary.json` therefore totals `count`
// only and leaves uniques as a per-window figure.
//
// Usage: node scripts/collect-traffic.mjs <data-dir>
//   env: GH_TOKEN (push-access token), REPO (owner/name)

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const dataDir = process.argv[2];
const token = process.env.GH_TOKEN;
const repo = process.env.REPO;

if (!dataDir) throw new Error("usage: collect-traffic.mjs <data-dir>");
if (!token) throw new Error("GH_TOKEN is required");
if (!repo) throw new Error("REPO (owner/name) is required");

async function fetchTraffic(kind) {
  const res = await fetch(`https://api.github.com/repos/${repo}/traffic/${kind}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "worktable-traffic-collector",
    },
  });
  const body = await res.text();
  if (!res.ok) {
    // Fail loudly. A 403 here almost always means the token lacks push access
    // to read traffic — add a PAT as the TRAFFIC_TOKEN secret (see the workflow).
    throw new Error(`GET /traffic/${kind} -> ${res.status}: ${body.slice(0, 300)}`);
  }
  return JSON.parse(body);
}

async function readSeries(file) {
  try {
    return JSON.parse(await readFile(join(dataDir, file), "utf8"));
  } catch {
    return []; // first run: no file yet
  }
}

// Merge daily entries keyed by timestamp; the freshly fetched value wins.
function merge(existing, fresh) {
  const byDate = new Map(existing.map((d) => [d.timestamp, d]));
  for (const d of fresh) byDate.set(d.timestamp, d);
  return [...byDate.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

async function collect(kind, arrayKey, file) {
  const payload = await fetchTraffic(kind);
  const merged = merge(await readSeries(file), payload[arrayKey] ?? []);
  await writeFile(join(dataDir, file), JSON.stringify(merged, null, 2) + "\n");
  return merged;
}

await mkdir(dataDir, { recursive: true });

const clones = await collect("clones", "clones", "clones.json");
const views = await collect("views", "views", "views.json");

const sum = (series, k) => series.reduce((n, d) => n + (d[k] ?? 0), 0);
const summary = {
  repo,
  // Set from the newest data point, not a wall clock — keeps output deterministic.
  updated: clones.at(-1)?.timestamp ?? views.at(-1)?.timestamp ?? null,
  days_recorded: new Set([...clones, ...views].map((d) => d.timestamp)).size,
  clones_total: sum(clones, "count"),
  views_total: sum(views, "count"),
  note: "totals are all-time (sum of daily counts); uniques are per-14-day-window only and not summable",
};
await writeFile(join(dataDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");

console.log(
  `traffic snapshot: ${summary.days_recorded} days recorded, ` +
    `${summary.clones_total} clones / ${summary.views_total} views all-time`,
);
