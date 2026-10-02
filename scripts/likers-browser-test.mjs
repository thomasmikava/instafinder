import { chromium } from "playwright";
import { build } from "esbuild";
import {
  mkdtemp,
  rm,
  unlink,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
const fixture = JSON.parse(
  await readFile("tests/fixtures/native-likers.json", "utf8"),
);
const postId = "3996028185825003596",
  code = "Dd0vnaQjEhM";
const postUrl = `https://www.instagram.com/p/${code}/`;
const metadata = {
  pk_id: postId,
  pk: Number(postId),
  id: "opaque-relay-id",
  code,
  user: { pk_id: "1", username: "fixture_source", full_name: "Fixture source" },
  like_count: 10,
};
let deepMetadata = metadata;
for (let i = 0; i < 25; i++) deepMetadata = { wrapper: [deepMetadata] };
let scenario = "deep",
  context,
  app;
const profileDir = await mkdtemp(join(tmpdir(), "instafinder-likers-"));
const bundle = resolve("dist/likers-verification.js");
const checks = [],
  errors = [],
  requests = [];
function html() {
  const hydrate = [
    "deep",
    "preopened",
    "namespaced",
    "namespaced-reel",
    "scope-warning",
  ].includes(scenario);
  const data =
    scenario === "scope-warning"
      ? {
          selectedPost: deepMetadata,
          ownerTimeline: {
            pk_id: "1",
            username: "fixture_source",
            edge_owner_to_timeline_media: {
              edges: [
                {
                  node: {
                    id: "opaque-unavailable-post",
                    code: "BB",
                    user: metadata.user,
                  },
                },
              ],
              page_info: { has_next_page: false },
            },
          },
        }
      : deepMetadata;
  return `<!doctype html><html><head><title>Instagram liker fixture</title></head><body>
<style>body{font:16px system-ui}main{height:1600px}[role=dialog]{position:fixed;left:20px;top:20px;padding:20px;background:white}.scroll{width:300px;height:180px;overflow-y:auto}.person{height:110px}</style>
${hydrate ? `<script type="application/json">${JSON.stringify(data)}</script>` : ""}
<article><div><span><div role="button" id="heart"><svg aria-label="Like"></svg></div></span><span role="button" tabindex="0" id="likes-count">10</span><span><div role="button" id="comment"><svg aria-label="Comment"></svg></div></span><span role="button" id="comment-count">1</span><div role="button" id="share"><svg aria-label="Share"></svg></div></div></article><main></main>
<script>
window.documentMarker=crypto.randomUUID();window.received=[];window.badClicks=[];window.openCount=0;
const scenario=${JSON.stringify(scenario)};
window.openLikes=async()=>{window.openCount++;document.querySelector('[role=dialog]')?.remove();const dialog=document.createElement('section');dialog.setAttribute('role','dialog');dialog.innerHTML='<h2>Likes</h2><button aria-label="Close">Close</button><div class="scroll"></div>';document.body.append(dialog);dialog.querySelector('button').onclick=()=>dialog.remove();
const data=await(await fetch('/api/v1/media/${postId}/likers/')).json();window.received.push(data);for(const u of data.users){const row=document.createElement('p');row.className='person';row.textContent=u.username;dialog.querySelector('.scroll').append(row);}
if(scenario==='delayed-fetch')setTimeout(()=>void fetch('/api/v1/media/${postId}/info/').then(r=>r.json()).then(d=>window.originalMetadata=d),900);
if(scenario==='delayed-xhr')setTimeout(()=>{const xhr=new XMLHttpRequest();xhr.open('GET','/api/v1/media/${postId}/info/');xhr.responseType='json';xhr.onload=()=>window.originalMetadata=xhr.response;xhr.send();},900);
};
document.getElementById('likes-count').onclick=()=>void window.openLikes();for(const id of ['heart','comment','comment-count','share'])document.getElementById(id).onclick=()=>window.badClicks.push(id);
</script></body></html>`;
}
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
  await context.route("https://www.instagram.com/**", async (route) => {
    const url = new URL(route.request().url());
    requests.push(url.pathname);
    if (route.request().resourceType() === "document")
      return route.fulfill({ contentType: "text/html", body: html() });
    if (url.pathname === `/api/v1/media/${postId}/info/`)
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ items: [metadata] }),
      });
    if (url.pathname === `/api/v1/media/${postId}/likers/`)
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(fixture),
      });
    return route.fulfill({
      status: 429,
      headers: { "Retry-After": "60" },
      contentType: "application/json",
      body: '{"message":"unrelated fixture"}',
    });
  });
  app = await context.newPage();
  app.on("pageerror", (e) => errors.push(e.message));
  await app.goto(`chrome-extension://${id}/app.html`);
  await app.getByRole("button", { name: "Skip", exact: true }).click();
  await app.addScriptTag({
    url: `chrome-extension://${id}/likers-verification.js`,
  });
  const mission = await app.evaluate(async () => {
    const m = await window.__testing.createMission("Find Alex");
    await window.__testing.db.settings.put({
      id: "preferences",
      delaySeconds: 5,
      pageDelaySeconds: 0.5,
    });
    return m.id;
  });
  const request = (message) =>
    app.evaluate((message) => chrome.runtime.sendMessage(message), message);
  const state = (job) =>
    app.evaluate(
      async (job) =>
        (await window.__testing.db.runs.get(job)) ||
        (await window.__testing.db.pendingPageJobs.get(job)),
      job,
    );
  async function wait(predicate, label) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((r) => setTimeout(r, 60));
    }
    throw new Error(`Timed out: ${label}`);
  }
  const settled = (job) =>
    wait(
      async () =>
        (await state(job))?.status !== "running" &&
        !(await request({ type: "collector-state" })).jobs.some(
          (j) => j.id === job,
        ),
      "settlement",
    );
  const check = (label) => {
    checks.push(label);
    console.log("PASS: " + label);
  };
  async function newTab(kind) {
    await app.evaluate(async (mission) => {
      const api = window.__testing;
      await api.db.transaction("rw", api.db.tables, async () => {
        for (const table of api.db.tables)
          if (!["missions", "settings"].includes(table.name))
            await table.clear();
      });
      await api.applyObservation({
        profiles: [
          {
            id: "700000001",
            userName: "fixture_liker1",
            fullName: "Fixture",
            profileUrl: "https://www.instagram.com/fixture_liker1/",
            avatarUrl: "",
            updatedAt: 1,
          },
        ],
        missionIds: [mission],
      });
      await api.db.candidates.update([mission, "700000001"], {
        decision: "possible",
      });
    }, mission);
    if (kind === "scope-warning")
      await app.evaluate(
        async ({ postId, postUrl }) => {
          await window.__testing.applyObservation({
            profiles: [
              {
                id: "1",
                userName: "fixture_source",
                fullName: "Fixture source",
                avatarUrl: "",
                profileUrl: "https://www.instagram.com/fixture_source/",
                updatedAt: 1,
              },
            ],
            posts: [{ id: postId, ownerId: "1", url: postUrl, likeCount: 10 }],
          });
        },
        { postId, postUrl },
      );
    scenario = kind;
    const tab = await context.newPage();
    tab.on("pageerror", (e) => errors.push(e.message));
    await tab.goto(
      kind === "namespaced"
        ? `https://www.instagram.com/beerrestaurant.cz/p/${code}/`
        : kind === "namespaced-reel"
          ? `https://www.instagram.com/beerrestaurant.cz/reel/${code}/`
          : postUrl,
    );
    return tab;
  }
  async function launch(tab) {
    await tab.bringToFront();
    const ctx = await request({ type: "popup-context" });
    const job = await request({
      type: "popup-start",
      tabId: ctx.tabId,
      input: ctx.input,
      missionId: mission,
      mode: "likers",
    });
    assert.ok(!job.error, job.error);
    return { ...job, tabId: ctx.tabId };
  }
  async function verify(tab, job) {
    await settled(job.id);
    assert.equal((await state(job.id)).status, "completed");
    const data = await app.evaluate(
      async ({ job, mission }) => ({
        results: await window.__testing.db.results
          .where("runId")
          .equals(job)
          .count(),
        likes: await window.__testing.db.likes.toArray(),
        candidate: await window.__testing.db.candidates.get([
          mission,
          "700000001",
        ]),
        posts: await window.__testing.db.posts.toArray(),
      }),
      { job: job.id, mission },
    );
    assert.equal(data.results, 10);
    assert.equal(data.likes.length, 10);
    assert.ok(
      data.likes.every((l) => l.postId === postId && l.ownerId === "1"),
    );
    assert.equal(data.candidate.score, 1);
    assert.equal(data.candidate.decision, "possible");
    assert.equal(data.posts[0].id, postId);
    assert.deepEqual(await tab.evaluate(() => window.badClicks), []);
    await tab
      .locator("#instafinder-collection")
      .getByText("Collection complete", { exact: true })
      .waitFor();
    assert.deepEqual(
      await tab.evaluate(() => window.received[window.received.length - 1]),
      fixture,
    );
    assert.doesNotMatch(
      JSON.stringify(await app.evaluate(() => window.__testing.exportBackup())),
      /PRIVATE-FIXTURE-TOKEN|ranking_token|friendship_status|opaque-relay-id|strong_id__/,
    );
  }
  let tab = await newTab("deep"),
    job = await launch(tab);
  await verify(tab, job);
  check(
    "A deeply nested real-size post ID with exact pk_id and rounded numeric pk captures all ten likers and shows completion.",
  );
  await app.evaluate(
    (m) =>
      window.__testing.db.candidates.update([m, "700000001"], {
        decision: "possible",
      }),
    mission,
  );
  await tab.close();
  tab = await newTab("scope-warning");
  job = await launch(tab);
  await verify(tab, job);
  assert.deepEqual((await state(job.id)).warnings, []);
  assert.equal(
    await app.evaluate(
      (job) =>
        window.__testing.db.pageReceipts
          .where("runId")
          .equals(job)
          .filter((r) => ["feed", "reels"].includes(r.kind))
          .count(),
      job.id,
    ),
    0,
  );
  check(
    "Unavailable posts in the owner's unrelated timeline do not contaminate a selected-post liker collection; all ten profiles finish as completed.",
  );
  await tab.close();
  for (const kind of ["namespaced", "namespaced-reel"]) {
    tab = await newTab(kind);
    const beforeUrl = tab.url(),
      beforeDocument = await tab.evaluate(() => window.documentMarker);
    const popup = await context.newPage();
    await tab.bringToFront();
    await popup.goto(`chrome-extension://${id}/popup.html`);
    await popup.getByRole("button", { name: "Likers", exact: true }).waitFor();
    assert.equal(
      await popup
        .getByRole("button", { name: "Followers", exact: true })
        .count(),
      0,
    );
    assert.equal(
      await popup
        .getByRole("button", { name: "Following", exact: true })
        .count(),
      0,
    );
    await popup.close();
    job = await launch(tab);
    await verify(tab, job);
    assert.equal(tab.url(), beforeUrl);
    assert.equal(
      await tab.evaluate(() => window.documentMarker),
      beforeDocument,
    );
    check(
      `The toolbar recognizes a username-prefixed ${kind === "namespaced" ? "post" : "reel"}, offers post actions and collects in place without navigation.`,
    );
    await tab.close();
  }
  for (const kind of ["delayed-fetch", "delayed-xhr"]) {
    tab = await newTab(kind);
    job = await launch(tab);
    await verify(tab, job);
    assert.equal(
      await tab.evaluate(() => window.originalMetadata.items[0].pk_id),
      postId,
    );
    assert.equal(
      await app.evaluate(
        (m) =>
          window.__testing.db.candidates
            .get([m, "700000001"])
            .then((c) => c.decision),
        mission,
      ),
      "possible",
    );
    check(
      `Likers arriving before ${kind === "delayed-fetch" ? "fetch" : "JSON XHR"} post metadata are retained, associated and saved once; original responses and decisions stay intact.`,
    );
    await tab.close();
  }
  tab = await newTab("preopened");
  await tab.evaluate(() => window.openLikes());
  const marker = await tab.evaluate(() => window.documentMarker);
  job = await launch(tab);
  await verify(tab, job);
  assert.equal(await tab.evaluate(() => window.documentMarker), marker);
  assert.equal(await tab.evaluate(() => window.openCount), 2);
  check(
    "A likes dialog opened before collection is closed and reopened through normal controls without reloading, so its first response is captured.",
  );
  await tab.close();
  tab = await newTab("missing");
  job = await launch(tab);
  await settled(job.id);
  assert.equal((await state(job.id)).status, "paused");
  assert.match((await state(job.id)).reason, /verify this post and its owner/);
  assert.equal(
    await app.evaluate(
      (j) => window.__testing.db.results.where("runId").equals(j).count(),
      job.id,
    ),
    0,
  );
  const before = await tab.evaluate(() => window.documentMarker);
  await tab.evaluate((data) => {
    const script = document.createElement("script");
    script.type = "application/json";
    script.textContent = JSON.stringify(data);
    document.body.append(script);
  }, deepMetadata);
  await tab
    .locator("#instafinder-collection")
    .getByRole("button", { name: "Resume", exact: true })
    .click();
  await verify(tab, job);
  assert.equal(await tab.evaluate(() => window.documentMarker), before);
  assert.equal(await tab.evaluate(() => window.openCount), 2);
  check(
    "Missing owner metadata saves no unverified profiles and gives a specific pause reason; overlay Resume recaptures an empty likes list without reloading.",
  );
  await tab.close();
  tab = await newTab("missing");
  job = await launch(tab);
  await tab.getByLabel("Automatic", { exact: true }).uncheck();
  await tab.evaluate(async () => {
    await (await fetch("/api/v1/media/64/likers/")).text();
    const script = document.createElement("script");
    script.type = "application/json";
    script.textContent = JSON.stringify({
      items: [
        {
          pk_id: "64",
          code: "Dd0vnaQjEhM",
          user: { pk_id: "99", username: "unrelated" },
        },
      ],
    });
    document.body.append(script);
  });
  await wait(
    async () => (await state(job.id))?.automatic === false,
    "manual pending mode",
  );
  assert.equal((await state(job.id)).status, "running");
  assert.equal(
    await app.evaluate(
      (j) => window.__testing.db.results.where("runId").equals(j).count(),
      job.id,
    ),
    0,
  );
  await tab
    .locator("#instafinder-collection")
    .getByRole("button", { name: "Pause", exact: true })
    .click();
  await settled(job.id);
  check(
    "Unrelated liker requests and mismatched post metadata are rejected before ownership is known, including unrelated 429s.",
  );
  await tab.close();
  const backup = await app.evaluate(() => window.__testing.exportBackup());
  assert.doesNotMatch(
    JSON.stringify(backup),
    /PRIVATE-FIXTURE-TOKEN|ranking_token|friendship_status|opaque-relay-id|strong_id__/,
  );
  assert.equal(
    await app.evaluate(() => window.__testing.db.follows.count()),
    0,
  );
  assert.deepEqual(errors, []);
  check(
    "Backups contain normalized liker/post facts only; ranking tokens, friendship status and raw payloads are excluded and likes imply no follows.",
  );
  await mkdir(".test-artifacts", { recursive: true });
  await writeFile(
    ".test-artifacts/likers-browser-report.json",
    JSON.stringify({ checks, requests: requests.length }, null, 2),
  );
} catch (error) {
  if (app && !app.isClosed())
    console.error(
      await app
        .evaluate(async () => ({
          runs: await window.__testing?.db.runs.toArray(),
          pending: await window.__testing?.db.pendingPageJobs.toArray(),
        }))
        .catch(() => {}),
    );
  throw error;
} finally {
  await context?.close();
  await unlink(bundle).catch(() => {});
  await rm(profileDir, { recursive: true, force: true });
}
