import { readFileSync } from "node:fs";

// The STANDALONE bundle inlines the version at BUILD time: scripts/build-standalone.mjs
// passes `bun build --define PURVIEW_VERSION='"<pkg.version>"'`, so the shipped
// dist/ never reads package.json at runtime and runs from a dist-only copy with no
// package.json present (docs/install.md — the firewalled-transfer case).
//
// The dev / tsc path has no define, so this token stays undeclared there. `typeof`
// never throws on an undeclared identifier, so it falls back to reading package.json,
// which is always present in a dev checkout.
declare const PURVIEW_VERSION: string | undefined;

function resolveVersion(): string {
  if (typeof PURVIEW_VERSION !== "undefined") return PURVIEW_VERSION;
  const pkg = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  return pkg.version;
}

export const SERVER_NAME = "purview";
export const SERVER_VERSION = resolveVersion();
