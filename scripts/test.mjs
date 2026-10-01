import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
await mkdir(".test-build", { recursive: true });
await build({
  entryPoints: ["tests/core.test.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: ".test-build/core.test.mjs",
  packages: "external",
  sourcemap: "inline",
});
const result = spawnSync(
  process.execPath,
  ["--test", ".test-build/core.test.mjs"],
  { stdio: "inherit" },
);
process.exitCode = result.status ?? 1;
