import { readFileSync } from "node:fs";

// The STANDALONE bundle inlines the version at BUILD time: scripts/build-standalone.mjs
// passes `bun build --define VISUAL_CHAT_VERSION='"<pkg.version>"'`, so the shipped
// dist/ never reads package.json at runtime and runs from a dist-only copy with no
// package.json present (docs/install.md — the firewalled-transfer case).
//
// The dev / tsc path has no define, so this token stays undeclared there. `typeof`
// never throws on an undeclared identifier, so it falls back to reading package.json,
// which is always present in a dev checkout.
declare const VISUAL_CHAT_VERSION: string | undefined;

function resolveVersion(): string {
  if (typeof VISUAL_CHAT_VERSION !== "undefined") return VISUAL_CHAT_VERSION;
  const pkg = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  return pkg.version;
}

export const SERVER_NAME = "visual-chat";
export const SERVER_VERSION = resolveVersion();
