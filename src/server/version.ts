import { readFileSync } from "node:fs";

const pkg = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { name: string; version: string };

export const SERVER_NAME = "visual-chat";
export const SERVER_VERSION = pkg.version;
