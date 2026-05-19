import { buildSync } from "esbuild";

buildSync({
  entryPoints: ["src/cli/index.ts"],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  outfile: "out/cli/index.js",
  external: ["electron"]
});

console.log("✓ CLI built → out/cli/index.js");
