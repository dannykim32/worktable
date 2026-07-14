// Canvas Server entry stub (issue 01). Real MCP + HTTP wiring lands in issue 02.
// stdout is reserved for the MCP transport; version banner goes to stderr.
import { readFileSync } from "node:fs";

const pkg = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { name: string; version: string };

console.error(`${pkg.name} ${pkg.version}`);
process.exit(0);
