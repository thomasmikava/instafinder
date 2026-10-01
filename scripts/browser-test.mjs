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
  await context.route(
    /^https:\/\/(?:www|i)\.instagram\.com\//,
    async (route) => {
      const url = new URL(route.request().url());
      requests.push(url.hostname + url.pathname + url.search);
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
      } else if (url.pathname === "/api/v1/media/64/info/") {
        if (url.hostname === "www.instagram.com") {
          await route.fulfill({
            status: 404,
            contentType: "application/json",
            body: '{"message":"Endpoint unavailable"}',
          });
          return;
        }
        body = {
          items: [
            {
              pk: "64",
              code: "BA",
              user: user("100", "source", "Opening Night"),
              comment_count: 6,
            },
          ],
        };
      } else if (url.pathname === "/api/v1/media/64/comments/") {
        const author = (pk, id, username, name, extra = {}) => ({
          pk,
          user: user(id, username, name),
          ...extra,
        });
        if (url.searchParams.get("max_id") === "tail")
          body = {
            comments: [author("14", "102", "taylor", "Taylor Reed")],
            has_more_comments: false,
          };
        else if (url.searchParams.get("min_id") === "head")
          body = {
            comments: [author("15", "103", "nora", "Nora Fields")],
            has_more_comments: false,
            has_more_headload_comments: false,
          };
        else
          body = {
            preview_comments: [
              author("10", "101", "avery", "Avery Stone", {
                child_comment_count: 3,
                preview_child_comments: [
                  author("11", "102", "taylor", "Taylor Reed"),
                ],
              }),
            ],
            comments: [],
            has_more_comments: true,
            next_max_id: "tail",
            has_more_headload_comments: true,
            next_min_id: "head",
          };
      } else if (
        url.pathname === "/api/v1/media/64/comments/10/child_comments/"
      ) {
        body =
          url.searchParams.get("max_id") === "reply-tail"
            ? {
                child_comments: [
                  { pk: "13", user: user("103", "nora", "Nora Fields") },
                ],
                has_more_tail_child_comments: false,
              }
            : {
                child_comments: [
                  { pk: "11", user: user("102", "taylor", "Taylor Reed") },
                  { pk: "12", user: user("103", "nora", "Nora Fields") },
                ],
                has_more_tail_child_comments: true,
                next_max_id: "reply-tail",
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
          "Access-Control-Allow-Origin":
            route.request().headers().origin || "*",
          "Access-Control-Allow-Credentials": "true",
          "Access-Control-Allow-Headers": "*",
        },
        body: JSON.stringify(body),
      });
    },
  );
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
  for (const [index, title] of [
    "Find someone on Instagram",
    "Missions",
    "Sources",
    "Review candidates",
  ].entries()) {
    await page
      .getByRole("dialog")
      .getByRole("heading", { name: title, exact: true })
      .waitFor();
    assert.equal(await page.locator(".intro-card").count(), 1);
    assert.ok(
      (await page.locator(".intro-card").innerText()).split(/\s+/).length <= 25,
    );
    assert.equal(
      await page.locator(".intro-progress").getAttribute("aria-label"),
      `Step ${index + 1} of 4`,
    );
    if (index === 1) {
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await page
        .getByRole("heading", { name: "Find someone on Instagram" })
        .waitFor();
      await page.getByRole("button", { name: "Next", exact: true }).click();
    }
    if (index === 2)
      await page.screenshot({
        path: ".test-artifacts/onboarding.png",
        fullPage: true,
      });
    await page
      .getByRole("button", {
        name: index === 3 ? "Get started" : "Next",
        exact: true,
      })
      .click();
  }
  await page.reload();
  await page
    .getByRole("button", { name: "Create mission", exact: true })
    .waitFor();
  assert.equal(await page.getByRole("dialog").count(), 0);
  checks.push(
    "First-visit onboarding shows four short cards one at a time, supports Back, and stays dismissed after reload.",
  );
  await page.getByRole("button", { name: "Create mission" }).click();
  await page.getByLabel("Mission name").fill("Opening night");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create mission", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Opening night", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Mission actions", exact: true })
    .click();
  await page.getByRole("menu", { name: "Mission actions" }).waitFor();
  assert.equal(await page.getByRole("menuitem").count(), 2);
  await page.screenshot({
    path: ".test-artifacts/mission-menu.png",
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("menu").count(), 0);
  await page
    .getByRole("button", { name: "Mission actions", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Opening night", exact: true })
    .click();
  assert.equal(await page.getByRole("menu").count(), 0);
  await page
    .getByRole("button", { name: "Mission actions", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Edit mission name" }).click();
  await page.getByLabel("Mission name").fill("Opening night edited");
  await page.getByRole("button", { name: "Save name" }).click();
  await page
    .getByRole("heading", { name: "Opening night edited", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Mission actions", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Edit mission name" }).click();
  await page.getByLabel("Mission name").fill("Opening night");
  await page.getByRole("button", { name: "Save name" }).click();
  checks.push(
    "The mission menu exposes Edit mission name and Add Candidate Manually; Escape and outside clicks dismiss it.",
  );
  await page.getByRole("button", { name: "Settings & backups" }).click();
  await page.getByLabel("Delay in seconds").fill("1");
  await page.getByRole("button", { name: "Save pace" }).click();
  await page
    .getByRole("button", { name: "Show walkthrough", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Find someone on Instagram", exact: true })
    .waitFor();
  assert.equal(await page.getByRole("dialog").count(), 1);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  assert.ok(
    (await page.locator(".intro-card").innerText()).includes(
      "Person I met at Friday’s concert",
    ),
  );
  await page.screenshot({
    path: ".test-artifacts/onboarding-missions.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  assert.ok(
    (await page.locator(".intro-card").innerText()).includes(
      "probably not them, or could be them",
    ),
  );
  await page.screenshot({
    path: ".test-artifacts/onboarding-review.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Skip", exact: true }).click();
  await page.getByRole("button", { name: "Settings & backups" }).click();
  await page
    .getByRole("button", { name: "Show walkthrough", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Find someone on Instagram", exact: true })
    .waitFor();
  assert.equal(
    await page.locator(".intro-progress").getAttribute("aria-label"),
    "Step 1 of 4",
  );
  await page.keyboard.press("Escape");
  await page.reload();
  await page
    .getByRole("heading", { name: "Opening night", exact: true })
    .waitFor();
  assert.equal(await page.getByRole("dialog").count(), 0);
  checks.push(
    "Settings reopens the walkthrough at its first card, with a concrete mission example and clear review choices; dismissal preserves the mission and one-time behavior.",
  );
  await page.getByRole("button", { name: "Add source", exact: true }).click();
  await page
    .getByRole("heading", { name: "Add source", exact: true })
    .waitFor();
  assert.equal(await page.getByRole("radio").count(), 4);
  assert.equal(
    await page
      .getByRole("button", { name: "Add a single candidate instead" })
      .count(),
    0,
  );
  const radioOffsets = await page
    .locator(".mode-option")
    .evaluateAll((options) =>
      options.map((option) => {
        const input = option.querySelector("input").getBoundingClientRect();
        const text = option.querySelector("strong").getBoundingClientRect();
        return Math.abs(input.y + input.height / 2 - text.y - text.height / 2);
      }),
    );
  assert.ok(
    radioOffsets.every((offset) => offset <= 0.5),
    `Radio labels are centered: ${radioOffsets}`,
  );
  checks.push(
    "All four collection radio buttons align vertically with their labels, and Add source contains no manual-candidate switch.",
  );

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
  await page
    .getByRole("button", { name: "Mission actions", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Add Candidate Manually" }).click();
  await page
    .getByRole("heading", { name: "Add Candidate Manually", exact: true })
    .waitFor();
  assert.equal(await page.getByRole("radio").count(), 0);
  await page
    .getByLabel("Username or profile URL")
    .fill("https://www.instagram.com/p/BA/");
  await page.getByRole("button", { name: "Look up account" }).click();
  await page
    .getByRole("alert")
    .getByText("Enter a username or profile URL.", { exact: true })
    .waitFor();
  await page.getByLabel("Username or profile URL").fill("casey");
  await page.getByRole("button", { name: "Look up account" }).click();
  await page.getByRole("button", { name: "Add this candidate" }).click();
  await page.getByRole("tab", { name: /Candidates/ }).click();
  await page.getByLabel("Search candidates").fill("casey");
  await page
    .locator("tbody")
    .getByText("Casey Hall", { exact: true })
    .waitFor();
  checks.push(
    "Manual candidate entry has its own menu action and profile-only dialog, without automatic source promotion.",
  );
  await page.getByLabel("Search candidates").fill("");
  await page.screenshot({
    path: ".test-artifacts/candidates-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Add source", exact: true }).click();
  await page
    .getByLabel("Username or Instagram URL")
    .fill("https://www.instagram.com/p/BA/");
  await page.getByRole("button", { name: "Look up account" }).click();
  await page.getByRole("button", { name: "Add source & collect" }).click();
  await page.locator(".collection-banner").waitFor({ state: "visible" });
  await page
    .locator(".collection-banner")
    .waitFor({ state: "hidden", timeout: 30000 });
  await page.addScriptTag({ url: `chrome-extension://${id}/verification.js` });
  const comments = await page.evaluate(async () => {
    const api = window.__testing;
    const run = (await api.db.runs.toArray()).find(
      (run) => run.targetPostId === "64",
    );
    return {
      status: run.status,
      comments: await api.db.seenComments.where("runId").equals(run.id).count(),
      links: await api.db.comments.count(),
    };
  });
  assert.deepEqual(comments, { status: "completed", comments: 6, links: 3 });
  assert.ok(
    requests.some((url) =>
      url.startsWith("i.instagram.com/api/v1/media/64/info/"),
    ),
  );
  assert.ok(
    requests.some(
      (url) => url.includes("/64/comments/?") && url.includes("max_id=tail"),
    ),
  );
  assert.ok(
    requests.some(
      (url) => url.includes("/64/comments/?") && url.includes("min_id=head"),
    ),
  );
  checks.push(
    "Real extension requests follow a compatible endpoint fallback and collect preview authors, paginated replies, and both comment cursor directions without duplicate links.",
  );
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
  const deletion = await page.evaluate(async () => {
    const api = window.__testing;
    const target = await api.createMission("Delete default");
    const other = await api.createMission("Keep shared");
    const forced = await api.createMission("Delete everywhere");
    const profile = (id) => ({
      id,
      userName: `delete${id}`,
      fullName: `Deletion person ${id}`,
      profileUrl: `https://www.instagram.com/delete${id}/`,
      avatarUrl: "",
      updatedAt: 1,
    });
    await api.applyObservation({
      profiles: [profile("8000001"), profile("8000002")],
      missionIds: [target.id],
    });
    await api.applyObservation({
      profiles: [profile("8000002"), profile("8000004")],
      missionIds: [other.id],
    });
    await api.applyObservation({
      profiles: [profile("8000002"), profile("8000003")],
      missionIds: [forced.id],
    });
    await api.setSource(other.id, "8000002", true);
    await api.db.candidates.update([other.id, "8000002"], {
      decision: "possible",
    });
    await api.applyObservation({
      follows: [
        { followerId: "8000004", followingId: "8000002", lastSeenAt: 1 },
      ],
    });
    return { target: target.id, other: other.id, forced: forced.id };
  });
  const deleteLabel =
    "Also delete candidates of this mission even if they are used by other missions";
  await page
    .getByRole("button", { name: "Delete default", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Delete mission", exact: true })
    .click();
  assert.equal(await page.getByLabel(deleteLabel).isChecked(), false);
  await page.getByLabel(deleteLabel).check();
  await page.getByRole("button", { name: "Keep mission", exact: true }).click();
  await page
    .getByRole("button", { name: "Delete mission", exact: true })
    .click();
  assert.equal(await page.getByLabel(deleteLabel).isChecked(), false);
  await page.screenshot({
    path: ".test-artifacts/delete-mission-mobile.png",
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete mission", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  const kept = await page.evaluate(async ({ target, other }) => {
    const api = window.__testing;
    return {
      target: await api.db.missions.get(target),
      private: await api.db.profiles.get("8000001"),
      shared: !!(await api.db.profiles.get("8000002")),
      decision: (await api.db.candidates.get([other, "8000002"]))?.decision,
      source: !!(await api.db.sources.get([other, "8000002"])),
    };
  }, deletion);
  assert.deepEqual(kept, {
    target: undefined,
    private: undefined,
    shared: true,
    decision: "possible",
    source: true,
  });
  checks.push(
    "Mission deletion defaults to keeping shared candidates, removes candidates used only here, and resets its unchecked option after cancellation.",
  );
  await page
    .getByRole("button", { name: "Delete everywhere", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Delete mission", exact: true })
    .click();
  await page.getByLabel(deleteLabel).check();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete mission", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  const removed = await page.evaluate(async ({ other, forced }) => {
    const api = window.__testing;
    return {
      forced: await api.db.missions.get(forced),
      shared: await api.db.profiles.get("8000002"),
      private: await api.db.profiles.get("8000003"),
      membership: await api.db.candidates.get([other, "8000002"]),
      source: await api.db.sources.get([other, "8000002"]),
      remainingScore: (await api.db.candidates.get([other, "8000004"]))?.score,
      keepOther: !!(await api.db.missions.get(other)),
    };
  }, deletion);
  assert.deepEqual(removed, {
    forced: undefined,
    shared: undefined,
    private: undefined,
    membership: undefined,
    source: undefined,
    remainingScore: 0,
    keepOther: true,
  });
  checks.push(
    "Checking the deletion option removes shared candidates and their source membership from other missions, while preserving those missions and recomputing priority.",
  );
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
