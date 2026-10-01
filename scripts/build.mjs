import * as esbuild from "esbuild";
import { cp, mkdir } from "node:fs/promises";
await mkdir("dist", { recursive: true });
await cp("public", "dist", { recursive: true });
const options = {
  entryPoints: { app: "src/main.tsx", background: "src/background.ts" },
  bundle: true,
  outdir: "dist",
  format: "esm",
  target: ["chrome110"],
  sourcemap: true,
  minify: !process.argv.includes("--watch"),
  logLevel: "info",
};
if (process.argv.includes("--watch")) {
  const context = await esbuild.context(options);
  await context.watch();
  console.log("Watching src/. Reload the unpacked extension after changes.");
} else await esbuild.build(options);
