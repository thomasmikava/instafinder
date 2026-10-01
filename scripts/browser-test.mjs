import { chromium } from "playwright";
import { build } from "esbuild";
import { mkdir, rm, writeFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const extension = resolve("dist");
await mkdir(".test-artifacts", { recursive: true });
await rm(".test-profile", { recursive: true, force: true });
await build({
  entryPoints: ["tests/browser-harness.ts"],
  bundle: true,
  format: "iife",
  outfile: "dist/verification.js",
  target: "chrome110",
});
let context;
let page;
const checks = [];
try {
  context = await chromium.launchPersistentContext(resolve(".test-profile"), {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
    viewport: { width: 1440, height: 1050 },
  });
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const id = new URL(worker.url()).host;
  const requests = [];
  await context.addCookies([
    {
      name: "csrftoken",
      value: "synthetic-test-cookie",
      url: "https://www.instagram.com/",
    },
  ]);
  const user = (id, username, name) => ({
    pk: id,
    username,
    full_name: name,
    profile_pic_url: "",
  });
  await context.route("https://www.instagram.com/**", async (route) => {
    const url = new URL(route.request().url());
    requests.push(url.pathname + url.search);
    let body;
    if (url.pathname.includes("web_profile_info")) {
      const username = url.searchParams.get("username");
      const p =
        username === "casey"
          ? user("104", "casey", "Casey Hall")
          : username === "avery"
            ? user("101", "avery", "Avery Stone")
            : user("100", "source", "Opening Night");
      body = {
        data: {
          user: {
            ...p,
            edge_followed_by: { count: 2 },
            edge_follow: { count: 2 },
            edge_owner_to_timeline_media: { count: 0 },
          },
        },
      };
    } else if (url.pathname.includes("/followers/"))
      body = {
        users: [
          user("101", "avery", "Avery Stone"),
          user("102", "taylor", "Taylor Reed"),
        ],
        more_available: false,
      };
    else if (url.pathname.includes("/following/"))
      body = {
        users: [
          user("101", "avery", "Avery Stone"),
          user("103", "nora", "Nora Fields"),
        ],
        more_available: false,
      };
    else throw new Error(`Unexpected mocked request ${url.pathname}`);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: {
        "Access-Control-Allow-Origin": route.request().headers().origin || "*",
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Headers": "*",
      },
      body: JSON.stringify(body),
    });
  });
  page = await context.newPage();
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") console.error("Browser:", message.text());
  });
  page.on("requestfailed", (request) =>
    console.error(
      "Failed request:",
      request.url(),
      request.failure()?.errorText,
    ),
  );
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`chrome-extension://${id}/app.html`);
  await page.getByRole("button", { name: "Create mission" }).click();
  await page.getByLabel("Mission name").fill("Opening night");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create mission", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Opening night", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Settings & backups" }).click();
  await page.getByLabel("Delay in seconds").fill("1");
  await page.getByRole("button", { name: "Save pace" }).click();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "Add source", exact: true }).click();
  await page
    .getByRole("heading", { name: "Add source", exact: true })
    .waitFor();
  assert.equal(await page.getByRole("radio").count(), 4);
  await page.screenshot({
    path: ".test-artifacts/add-source.png",
    fullPage: true,
  });
  await page.getByLabel("Username or Instagram URL").fill("@source");
  await page.getByRole("button", { name: "Look up account" }).click();
  await page.getByRole("button", { name: "Add source & collect" }).click();
  await page
    .getByRole("heading", { name: "Avery Stone", exact: true })
    .waitFor({ timeout: 30000 });
  await page.waitForFunction(
    () => !document.querySelector(".collection-banner"),
    { timeout: 30000 },
  );
  assert.equal(
    await page.locator(".score-badge, .table-score, .review-notes").count(),
    0,
  );
  assert.equal(
    await page
      .getByText(
        /connection points|Closer connections|prioritize people|Follows a source/,
      )
      .count(),
    0,
  );
  assert.equal(
    await page.getByRole("button", { name: "Add source", exact: true }).count(),
    1,
  );
  checks.push(
    "Mission creation and mocked Instagram collection produce three candidates, with a mutual follow ranked first.",
  );
  checks.push(
    "The main action adds a source; review and candidates expose no scores or ranking explanations.",
  );
  await page.screenshot({
    path: ".test-artifacts/review-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  assert.ok(
    (await page.locator(".decision-grid").boundingBox()).y +
      (await page.locator(".decision-grid").boundingBox()).height <=
      900,
    "Decision actions should fit a desktop viewport",
  );
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.keyboard.press("3");
  await page
    .getByRole("heading", { name: /Taylor Reed|Nora Fields/ })
    .waitFor();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page
    .getByRole("heading", { name: "Avery Stone", exact: true })
    .waitFor();
  await page.getByRole("button", { name: /Possible match/ }).click();
  await page.getByRole("tab", { name: /Candidates/ }).click();
  assert.equal(
    await page.getByRole("columnheader", { name: "Priority" }).count(),
    0,
  );
  assert.equal(await page.locator(".table-score").count(), 0);
  await page
    .getByRole("combobox", { name: "Filter candidates" })
    .selectOption("possible");
  await page
    .locator("tbody")
    .getByText("Avery Stone", { exact: true })
    .waitFor();
  await page.waitForFunction(
    () => document.querySelectorAll("tbody tr").length === 1,
  );
  assert.equal(await page.locator("tbody tr").count(), 1);
  await page.getByLabel("Decision for avery").selectOption("unreviewed");
  await page
    .getByRole("combobox", { name: "Filter candidates" })
    .selectOption("all");
  await page.getByLabel("Search candidates").fill("Avery");
  await page
    .locator("tbody")
    .getByText("Avery Stone", { exact: true })
    .waitFor();
  checks.push(
    "Keyboard decisions, undo, outcome filtering, clearing a decision, and candidate search work.",
  );
  await page.getByRole("button", { name: "Promote avery" }).click();
  await page.waitForFunction(
    () =>
      !document.querySelector("tbody")?.textContent?.includes("Avery Stone"),
  );
  await page.locator(".sources-panel summary").click();
  await page.getByLabel("Include sources as candidates").check();
  await page
    .locator("tbody")
    .getByText("Avery Stone", { exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Demote avery", exact: true })
    .first()
    .click();
  checks.push(
    "Promotion hides a source by default, source inclusion restores visibility, and demotion preserves the candidate.",
  );
  await page.getByLabel("Search candidates").fill("");
  await page.getByLabel("Include sources as candidates").uncheck();
  await page.locator(".sources-panel summary").click();
  await page.getByRole("tab", { name: "Review", exact: true }).click();
  await page
    .getByRole("heading", { name: "Taylor Reed", exact: true })
    .waitFor();
  const beforeReuse = requests.length;
  await page
    .getByRole("button", { name: "New mission", exact: true })
    .first()
    .click();
  await page.getByLabel("Mission name").fill("Second search");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create mission", exact: true })
    .click();
  await page.getByRole("button", { name: "Add source", exact: true }).click();
  await page.getByLabel("Username or Instagram URL").fill("source");
  await page.getByRole("button", { name: "Look up account" }).click();
  await page.getByRole("button", { name: "Use saved results" }).click();
  await page
    .getByRole("heading", { name: "Avery Stone", exact: true })
    .waitFor();
  assert.equal(requests.length, beforeReuse);
  checks.push(
    "Dated cached collection results can populate another mission without any Instagram request.",
  );
  await page.getByRole("button", { name: "Add source", exact: true }).click();
  await page.getByLabel("Username or Instagram URL").fill("casey");
  await page
    .getByRole("button", { name: "Add a single candidate instead" })
    .click();
  await page.getByRole("button", { name: "Look up account" }).click();
  await page.getByRole("button", { name: "Add this candidate" }).click();
  await page.getByRole("tab", { name: /Candidates/ }).click();
  await page.getByLabel("Search candidates").fill("casey");
  await page
    .locator("tbody")
    .getByText("Casey Hall", { exact: true })
    .waitFor();
  checks.push(
    "A single profile can be added without automatic source promotion.",
  );
  await page.getByLabel("Search candidates").fill("");
  await page.screenshot({
    path: ".test-artifacts/candidates-desktop.png",
    fullPage: true,
  });
  await page.addScriptTag({ url: `chrome-extension://${id}/verification.js` });
  const backup = await page.evaluate(async () => {
    const api = window.__testing;
    const original = await api.exportBackup();
    await api.restoreBackup(original);
    return {
      profiles: await api.db.profiles.count(),
      missions: await api.db.missions.count(),
      sources: await api.db.sources.count(),
    };
  });
  assert.equal(backup.missions, 2);
  assert.equal(backup.profiles, 5);
  checks.push(
    "Full-data backup and restore preserve two missions and shared profiles in real IndexedDB.",
  );
  // Deliberately write incompressible metadata to verify the actual extension storage quota, not a mock.
  const storage = await page.evaluate(async () => {
    const db = window.__testing.db;
    const encode = (bytes) => btoa(String.fromCharCode(...bytes));
    let totalBytes = 0;
    for (let offset = 0; offset < 100000; offset += 1000) {
      const rows = [];
      for (let i = offset; i < offset + 1000; i++) {
        const userName = `saved_${i}`;
        const row = {
          id: String(1000000 + i),
          userName,
          fullName: `Saved profile ${i}`,
          profileUrl: `https://www.instagram.com/${userName}/`,
          avatarUrl: `https://images.example.test/profile.jpg?signature=${encode(crypto.getRandomValues(new Uint8Array(640)))}`,
          updatedAt: Date.now(),
        };
        totalBytes += JSON.stringify(row).length;
        rows.push(row);
      }
      await db.profiles.bulkPut(rows);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const estimate = await navigator.storage.estimate();
    return {
      writtenBytes: totalBytes,
      reportedBytes: estimate.usage,
      profiles: await db.profiles.count(),
      unlimitedStorage: await chrome.permissions.contains({
        permissions: ["unlimitedStorage"],
      }),
    };
  });
  assert.ok(storage.writtenBytes > 50 * 1024 * 1024);
  assert.ok(storage.reportedBytes > 50 * 1024 * 1024, JSON.stringify(storage));
  assert.equal(storage.profiles, 100005);
  assert.equal(storage.unlimitedStorage, true);
  checks.push(
    `Real extension IndexedDB holds ${storage.profiles.toLocaleString()} profiles: ${(storage.reportedBytes / 1024 / 1024).toFixed(1)} MB reported, ${(storage.writtenBytes / 1024 / 1024).toFixed(1)} MB of serialized profile data.`,
  );
  await page.evaluate(async () => {
    const api = window.__testing;
    const mission = (await api.db.missions.toArray()).find(
      (m) => m.name === "Second search",
    );
    const profiles = (
      await api.db.profiles.bulkGet(
        Array.from({ length: 83 }, (_, i) => String(1000000 + i)),
      )
    ).map((p) => ({ ...p, avatarUrl: "" }));
    await api.applyObservation({ profiles, missionIds: [mission.id] });
  });
  await page.getByRole("tab", { name: /Candidates/ }).click();
  await page.waitForFunction(
    () => document.querySelectorAll("tbody tr").length === 40,
  );
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector(".pagination")?.textContent?.includes("41–80"),
  );
  assert.equal(await page.locator("tbody tr").count(), 40);
  checks.push(
    "A larger mission renders only 40 candidate rows at a time and supports indexed next-page navigation.",
  );
  await page.getByRole("tab", { name: "Review", exact: true }).click();
  await page
    .getByRole("heading", { name: "Avery Stone", exact: true })
    .waitFor();
  await page.getByRole("tab", { name: /Candidates/ }).click();
  await page
    .getByRole("button", { name: "Previous page", exact: true })
    .click();
  await page.waitForFunction(() =>
    document.querySelector(".pagination")?.textContent?.includes("1–40"),
  );
  await page.evaluate(async () => {
    const api = window.__testing;
    await api.applyObservation({
      posts: [
        { id: "900", ownerId: "100", url: "" },
        { id: "901", ownerId: "100", url: "" },
      ],
      comments: [
        { postId: "900", profileId: "102", ownerId: "100", lastSeenAt: 1 },
        { postId: "901", profileId: "102", ownerId: "100", lastSeenAt: 1 },
      ],
    });
  });
  await page.waitForFunction(() =>
    document.querySelector("tbody tr")?.textContent?.includes("Taylor Reed"),
  );
  await page.getByRole("tab", { name: "Review", exact: true }).click();
  await page
    .getByRole("heading", { name: "Avery Stone", exact: true })
    .waitFor();
  checks.push(
    "The pinned review card survives view switches even when another candidate gains a higher score.",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: ".test-artifacts/review-mobile.png",
    fullPage: true,
  });
  assert.equal(
    await page.getByRole("button", { name: "Settings & backups" }).isVisible(),
    true,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "New mission", exact: true })
      .first()
      .isVisible(),
    true,
  );
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth,
  );
  assert.equal(overflow, false);
  assert.deepEqual(errors, []);
  checks.push(
    "Desktop and mobile rendering have no uncaught browser errors or mobile page overflow.",
  );
  await writeFile(
    ".test-artifacts/browser-report.json",
    JSON.stringify({ checks, requests: requests.length, storage }, null, 2),
  );
  for (const check of checks) console.log(`PASS: ${check}`);
} catch (error) {
  if (page) {
    await page
      .screenshot({ path: ".test-artifacts/failure.png", fullPage: true })
      .catch(() => {});
    console.error((await page.locator("body").innerText()).slice(-5000));
  }
  throw error;
} finally {
  await context?.close();
  await unlink("dist/verification.js").catch(() => {});
  await rm(".test-profile", { recursive: true, force: true });
}
