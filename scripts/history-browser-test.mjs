import { chromium } from "playwright";
import { build } from "esbuild";
import { mkdtemp, rm, unlink, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";

const profileDir = await mkdtemp(join(tmpdir(), "instafinder-history-"));
const bundle = resolve("dist/history-verification.js");
let context;
try {
  await build({
    entryPoints: ["tests/browser-harness.ts"],
    bundle: true,
    format: "iife",
    outfile: bundle,
    target: "chrome110",
  });
  const extension = resolve("dist");
  context = await chromium.launchPersistentContext(profileDir, {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
    viewport: { width: 1200, height: 900 },
  });
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`chrome-extension://${id}/app.html`);
  await page.getByRole("button", { name: "Skip", exact: true }).click();
  const attach = () =>
    page.addScriptTag({
      url: `chrome-extension://${id}/history-verification.js`,
    });
  await attach();
  const before = await page.evaluate(async () => {
    const { db, createMission, applyObservation, setSource, exportBackup } =
      window.__testing;
    const mission = await createMission("Find Alex");
    await applyObservation({
      profiles: ["1", "2"].map((id) => ({
        id,
        userName: `user${id}`,
        fullName: `Person ${id}`,
        profileUrl: `https://www.instagram.com/user${id}/`,
        avatarUrl: "",
        updatedAt: 1,
      })),
      missionIds: [mission.id],
      follows: [{ followerId: "2", followingId: "1", lastSeenAt: 1 }],
    });
    await setSource(mission.id, "1", true);
    await db.candidates.update([mission.id, "2"], {
      decision: "possible",
      decisionAt: 1,
    });
    const old = {
      id: "old",
      key: "profile:1:followers",
      sourceId: "1",
      targetLabel: "user1",
      mode: "followers",
      scope: "profile",
      status: "partial",
      method: "direct",
      createdAt: 1,
      updatedAt: 1,
      checkpoint: {
        stage: "followers",
        cursor: null,
        seenCursors: [],
        pageCount: 1,
        stageCount: 1,
      },
    };
    await db.runs.bulkPut([
      old,
      {
        ...old,
        id: "new",
        status: "completed",
        method: "page",
        createdAt: 100,
        updatedAt: 100,
        completedAt: 100,
        checkpoint: { ...old.checkpoint, stage: "done" },
      },
      ...Array.from({ length: 19 }, (_, i) => ({
        ...old,
        id: `filler${i}`,
        key: "profile:1:following",
        mode: "following",
        status: "completed",
        createdAt: i + 2,
        updatedAt: i + 2,
        completedAt: i + 2,
        checkpoint: { ...old.checkpoint, stage: "done" },
      })),
    ]);
    await db.results.put({ runId: "old", kind: "followers", profileId: "2" });
    await db.runLinks.put({ runId: "old", missionId: mission.id });
    return exportBackup();
  });
  await page
    .getByRole("button", { name: "Collection history", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("21 collections", { exact: true }).waitFor();
  assert.equal(
    await dialog.getByRole("button", { name: /Clear .* from history/ }).count(),
    0,
  );
  await dialog.getByRole("button", { name: "Next history page" }).click();
  await dialog.getByText("Page 2", { exact: true }).waitFor();
  const clear = dialog.getByRole("button", {
    name: "Clear followers for @user1 from history",
    exact: true,
  });
  await clear.waitFor();
  await mkdir(".test-artifacts", { recursive: true });
  await page.screenshot({
    path: ".test-artifacts/history-clear.png",
    fullPage: true,
  });
  await clear.click();
  await dialog.getByText("20 collections", { exact: true }).waitFor();
  await dialog.getByText("Page 1", { exact: true }).waitFor();
  assert.equal(
    await dialog
      .getByRole("button", { name: "Next history page" })
      .isDisabled(),
    true,
  );
  const after = await page.evaluate(() => window.__testing.exportBackup());
  const old = after.tables.runs.find((run) => run.id === "old");
  assert.ok(old.historyHiddenAt > 0);
  const { historyHiddenAt, ...retained } = old;
  assert.deepEqual(
    retained,
    before.tables.runs.find((run) => run.id === "old"),
  );
  for (const name of Object.keys(before.tables).filter(
    (name) => name !== "runs",
  ))
    assert.deepEqual(after.tables[name], before.tables[name]);
  await page.reload();
  await attach();
  await page
    .getByRole("button", { name: "Collection history", exact: true })
    .click();
  await dialog.getByText("20 collections", { exact: true }).waitFor();
  assert.equal(
    await dialog.getByRole("button", { name: /Clear .* from history/ }).count(),
    0,
  );
  assert.deepEqual(errors, []);
  const result = {
    passed: true,
    checks: [
      "An older partial collection covered by a newer completed collection can be cleared across history pages.",
      "Clearing updates pagination, survives reload, and preserves every saved fact, decision, result and checkpoint.",
    ],
  };
  await writeFile(
    ".test-artifacts/history-browser-report.json",
    JSON.stringify(result, null, 2),
  );
  for (const check of result.checks) console.log(`PASS: ${check}`);
} finally {
  await context?.close();
  await unlink(bundle).catch(() => {});
  await rm(profileDir, { recursive: true, force: true });
}
