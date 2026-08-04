import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: here,
  build: {
    outDir: fileURLToPath(new URL("../../dist/canvas", import.meta.url)),
    emptyOutDir: true,
    // Each HTML entry must compile to a SINGLE self-contained JS file. The
    // capability model injects the token into HTML-referenced asset URLs
    // (http.ts), but a cross-chunk ESM `import "./shared.js"` carries no token
    // and would 401 — so no shared chunks. Disabling the module-preload helper
    // removes any chunk entries would otherwise share.
    modulePreload: false,
    rollupOptions: {
      // Single entry point: the artifact canvas (issue 26 retired the separate
      // legibility calibration gallery along with the gate).
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
      },
    },
  },
});
