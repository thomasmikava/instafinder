import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
await mkdir(".test-build", { recursive: true });
await build({
  entryPoints: [
    "tests/core.test.ts",
    "tests/page.test.ts",
    "tests/avatars.test.ts",
    "tests/likes.test.ts",
  ],
  bundle: true,
  platform: "node",
  format: "esm",
  outdir: ".test-build",
  outExtension: { ".js": ".mjs" },
  packages: "external",
  sourcemap: "inline",
});
const result = spawnSync(
  process.execPath,
  [
    "--test",
    ".test-build/core.test.mjs",
    ".test-build/page.test.mjs",
    ".test-build/avatars.test.mjs",
    ".test-build/likes.test.mjs",
  ],
  { stdio: "inherit" },
);
process.exitCode = result.status ?? 1;
