import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: here,
  build: {
    outDir: fileURLToPath(new URL("../../dist/canvas", import.meta.url)),
    emptyOutDir: true,
  },
});
