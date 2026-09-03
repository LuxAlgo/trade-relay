import { defineConfig } from "tsup";

// node:sqlite is still experimental, so esbuild's builtin list doesn't know
// it and would rewrite the import to a bogus "sqlite" package. Keep it
// external verbatim.
const external = ["node:sqlite"];

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
    target: "node22",
    // import.meta.url locates the bundled Vela file next to the build output;
    // the shim gives the CommonJS build the same answer.
    shims: true,
    external,
  },
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    sourcemap: true,
    target: "node22",
    banner: { js: "#!/usr/bin/env node" },
    external,
  },
]);
