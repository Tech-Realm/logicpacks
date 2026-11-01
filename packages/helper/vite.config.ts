import { defineConfig } from "vite-plus";

// One self-contained file: the installer downloads it and runs it with the user's own Node.
export default defineConfig({
  pack: {
    entry: { lp: "src/cli.ts" },
    outDir: "dist",
    format: "esm",
    platform: "node",
    target: "node18",
    clean: true,
    sourcemap: false,
    outputOptions: { codeSplitting: false },
    banner: { js: "#!/usr/bin/env node\n" },
  },
});
