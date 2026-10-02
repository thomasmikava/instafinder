import { chromium } from "playwright";
import { build } from "esbuild";
import { mkdtemp, rm, unlink, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
const profileDir = await mkdtemp(join(tmpdir(), "instafinder-parallel-"));
const bundle = resolve("dist/parallel-verification.js");
let context, app;
const checks = [],
  errors = [],
  requests = [];
let rate = false;
const user = (id, username = `person${id}`) => ({
  pk: id,
  username,
  full_name: username,
  profile_pic_url: "",
});
const source = (name) => user(name === "sourceb" ? "555" : "173560420", name);
const html = (path) => {
  const isPost = path.startsWith("/p/");
  const name = isPost ? "sourcea" : path.split("/")[1];
  const owner = source(name);
  const data =
    name === "unresolved"
      ? {}
      : isPost
        ? {
            data: {
              shortcode_media: {
                pk: "64",
                code: "BA",
                user: owner,
                like_count: 10,
                comment_count: 0,
              },
            },
          }
        : {
            data: {
              user: {
                ...owner,
                follower_count: 3,
                following_count: 3,
                media_count: 0,
              },
            },
          };
  return `<!doctype html><html><head><title>Instagram fixture</title></head><body>
<style>body{font:16px system-ui}button,a{margin:8px}main{height:1600px}[role=dialog]{position:fixed;left:20px;top:20px;background:white;border:1px solid;padding:20px}.scroll{width:300px;height:180px;overflow-y:auto}.person{height:110px}</style>
<script type="application/json">${JSON.stringify(data)}</script>
${isPost ? `<article><div class="actions"><span><div data-visualcompletion="ignore-dynamic"><div role="button" tabindex="0" id="heart"><div><span><svg aria-label="Like" role="img"><title>Like</title></svg></span></div></div></div></span><span role="button" tabindex="0" id="likes-count">10</span><span><div role="button" tabindex="0" id="comment"><svg aria-label="Comment" role="img"><title>Comment</title></svg></div></span><span role="button" tabindex="0" id="comments-count">1</span><div role="button" id="share"><svg aria-label="Share"><title>Share</title></svg></div></div></article>` : `<nav><a href="/${name}/followers/" id="followers">3 Followers</a><button id="following" aria-label="Following">3 Following</button></nav>`}
<main></main><script>
window.documentMarker=crypto.randomUUID();window.badClicks=[];window.nativePages=[];
const ownerId=${JSON.stringify(owner.pk)};
function users(data,box){window.nativePages.push(data);for(const user of data.users||[]){const p=document.createElement('p');p.className='person';p.textContent=user.username;box.append(p);}}
async function openList(kind){document.querySelector('[role=dialog]')?.remove();const dialog=document.createElement('section');dialog.setAttribute('role','dialog');dialog.innerHTML='<h2>'+kind+'</h2><button aria-label="Close">Close</button><div class="scroll"></div>';document.body.append(dialog);dialog.querySelector('button').onclick=()=>dialog.remove();const box=dialog.querySelector('.scroll');const base=kind==='Likes'?'/api/v1/media/64/likers/':'/api/v1/friendships/'+ownerId+'/'+kind.toLowerCase()+'/';let busy=false;const first=await(await fetch(base+'?count=12')).json();users(first,box);let more=first.has_more,next=first.next_max_id;box.onscroll=async()=>{if(busy||!more)return;busy=true;const data=await(await fetch(base+'?count=12&max_id='+next)).json();users(data,box);more=data.has_more;next=data.next_max_id;busy=false;};}
if(document.querySelector('#followers')){document.querySelector('#followers').onclick=e=>{e.preventDefault();void openList('Followers');};document.querySelector('#following').onclick=()=>void openList('Following');}
if(document.querySelector('#likes-count')){document.querySelector('#likes-count').onclick=()=>void openList('Likes');for(const id of ['heart','comment','comments-count','share'])document.getElementById(id).onclick=()=>window.badClicks.push(id);}
</script></body></html>`;
};
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
    requests.push(url.pathname + url.search);
    if (route.request().resourceType() === "document")
      return route.fulfill({
        contentType: "text/html",
        body: html(url.pathname),
      });
    if (rate && url.pathname.includes("/friendships/555/"))
      return route.fulfill({
        status: 429,
        headers: { "Retry-After": "60" },
        contentType: "application/json",
        body: '{"message":"Please wait"}',
      });
    const next = url.searchParams.has("max_id");
    if (next) await new Promise((resolve) => setTimeout(resolve, 1200));
    const likes = url.pathname.includes("/likers/");
    const ids = likes
      ? next
        ? [7, 8, 9, 10, 11]
        : [2, 3, 4, 5, 6]
      : next
        ? [4]
        : [2, 3];
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        users: ids.map((id) => user(String(id))),
        has_more: !next,
        ...(next ? {} : { next_max_id: likes ? "24" : "17" }),
      }),
    });
  });
  app = await context.newPage();
  app.on("pageerror", (e) => errors.push(e.message));
  await app.goto(`chrome-extension://${id}/app.html`);
  await app.getByRole("button", { name: "Skip", exact: true }).click();
  const attach = () =>
    app.addScriptTag({
      url: `chrome-extension://${id}/parallel-verification.js`,
    });
  await attach();
  const missions = await app.evaluate(async () => {
    const api = window.__testing;
    const a = await api.createMission("Find Alex"),
      b = await api.createMission("Find Sam");
    await api.db.settings.put({
      id: "preferences",
      delaySeconds: 5,
      pageDelaySeconds: 0.5,
    });
    return [a.id, b.id];
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
  const wait = async (predicate, label = "state") => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    throw new Error(`Timed out waiting for ${label}`);
  };
  const settled = (job) =>
    wait(
      async () =>
        (await state(job))?.status !== "running" &&
        !(await request({ type: "collector-state" })).jobs.some(
          (item) => item.id === job,
        ),
      "job settlement",
    );
  const newTab = async (name) => {
    const tab = await context.newPage();
    tab.on("pageerror", (e) => errors.push(e.message));
    await tab.goto(
      name.startsWith("/")
        ? `https://www.instagram.com${name}`
        : `https://www.instagram.com/${name}/`,
    );
    return tab;
  };
  const launch = async (tab, mode, mission = missions[0], manual = false) => {
    await tab.bringToFront();
    const current = await request({ type: "popup-context" });
    const response = await request({
      type: "popup-start",
      tabId: current.tabId,
      input: current.input,
      missionId: mission,
      mode,
    });
    assert.ok(!response.error, response.error);
    await tab.getByLabel("Automatic", { exact: true }).waitFor();
    if (manual) {
      await tab.getByLabel("Automatic", { exact: true }).uncheck();
      await wait(
        async () => (await state(response.id))?.pageAutomatic === false,
        "manual mode",
      );
      await tab.locator(`#${mode}`).click();
      await wait(
        async () =>
          (await app.evaluate(
            (job) =>
              window.__testing.db.results.where("runId").equals(job).count(),
            response.id,
          )) >= 2,
        "first list page",
      );
    }
    return { id: response.id, tabId: current.tabId, input: current.input };
  };
  const check = (label) => {
    checks.push(label);
    console.log(`PASS: ${label}`);
  };
  let a = await newTab("sourcea"),
    b = await newTab("sourceb");
  let ja = await launch(a, "following"),
    jb = await launch(b, "followers");
  assert.equal((await request({ type: "collector-state" })).jobs.length, 2);
  await b.bringToFront();
  await Promise.all([settled(ja.id), settled(jb.id)]);
  assert.equal((await state(ja.id)).status, "completed");
  assert.equal((await state(jb.id)).status, "completed");
  let facts = await app.evaluate(
    async (mission) => ({
      follows: await window.__testing.db.follows.count(),
      candidate: await window.__testing.db.candidates.get([mission, "2"]),
    }),
    missions[0],
  );
  assert.equal(facts.follows, 6);
  assert.equal(facts.candidate.score, 2);
  assert.ok(requests.some((url) => url.includes("max_id=17")));
  await app.evaluate(
    (mission) =>
      window.__testing.db.candidates.update([mission, "2"], {
        decision: "possible",
      }),
    missions[0],
  );
  check(
    "Two different sources collect automatically at once, including a background tab; native cursors and directional facts remain isolated.",
  );
  await a.reload();
  await b.goto("https://www.instagram.com/sourcea/");
  ja = await launch(a, "following", missions[0]);
  jb = await launch(b, "following", missions[1]);
  assert.equal((await request({ type: "collector-state" })).jobs.length, 2);
  await Promise.all([settled(ja.id), settled(jb.id)]);
  facts = await app.evaluate(
    async (missions) => ({
      follows: await window.__testing.db.follows.count(),
      candidates: await Promise.all(
        missions.map((m) => window.__testing.db.candidates.get([m, "2"])),
      ),
    }),
    missions,
  );
  assert.equal(facts.follows, 6);
  assert.equal(facts.candidates[0].score, 2);
  assert.equal(facts.candidates[0].decision, "possible");
  assert.equal(facts.candidates[1].score, 1);
  assert.equal(facts.candidates[1].decision, "unreviewed");
  for (const job of [ja, jb])
    assert.equal(
      await app.evaluate(
        (id) =>
          window.__testing.db.pageReceipts.where("runId").equals(id).count(),
        job.id,
      ),
      2,
    );
  check(
    "Two tabs collecting the same source and action have independent runs/receipts while facts, ranking and mission decisions stay deduplicated.",
  );
  await a.reload();
  await b.reload();
  ja = await launch(a, "followers", missions[0]);
  jb = await launch(b, "following", missions[1]);
  await Promise.all([settled(ja.id), settled(jb.id)]);
  const mutual = await app.evaluate(
    async (missions) => ({
      follows: await window.__testing.db.follows.count(),
      candidates: await Promise.all(
        missions.map((mission) =>
          window.__testing.db.candidates.get([mission, "2"]),
        ),
      ),
    }),
    missions,
  );
  assert.equal(mutual.follows, 9);
  assert.equal(mutual.candidates[0].score, 3);
  assert.equal(mutual.candidates[1].score, 2);
  assert.equal(mutual.candidates[0].decision, "possible");
  check(
    "Different actions on the same source run in separate tabs, preserve decisions and add both follow directions exactly once.",
  );
  await a.reload();
  await b.goto("https://www.instagram.com/sourceb/");
  ja = await launch(a, "followers", missions[0], true);
  jb = await launch(b, "following", missions[0], true);
  const markerB = await b.evaluate(() => window.documentMarker);
  const beforeDirect = requests.length;
  const directError = await app.evaluate(async () => {
    try {
      await window.__testing.runner.resolve("sourcea", "followers");
      return "";
    } catch (error) {
      return error.message;
    }
  });
  assert.match(directError, /collecting/);
  assert.equal(requests.length, beforeDirect);
  const duplicate = await request({ type: "collector-resume", id: ja.id });
  assert.match(duplicate.error, /already running/);
  const beforeCount = await app.evaluate(() =>
    window.__testing.db.pendingPageJobs.count(),
  );
  const sameTab = await request({
    type: "popup-start",
    tabId: ja.tabId,
    input: ja.input,
    missionId: missions[0],
    mode: "following",
  });
  assert.match(sameTab.error, /already collecting/);
  assert.equal(
    await app.evaluate(() => window.__testing.db.pendingPageJobs.count()),
    beforeCount,
  );
  const freeTab = await newTab("sourcea");
  const freePopup = await context.newPage();
  await freeTab.bringToFront();
  await freePopup.goto(`chrome-extension://${id}/popup.html`);
  await wait(
    () =>
      freePopup
        .getByRole("button", { name: "Followers", exact: true })
        .isEnabled(),
    "free-tab popup initialization",
  );
  assert.equal(
    await freePopup
      .getByRole("button", { name: "Followers", exact: true })
      .isEnabled(),
    true,
  );
  const freeContext = await request({ type: "popup-context" });
  const duplicateElsewhere = await request({
    type: "collector-resume",
    id: ja.id,
    tabId: freeContext.tabId,
  });
  assert.match(duplicateElsewhere.error, /already running/);
  await freePopup.close();
  await freeTab.close();
  const popup = await context.newPage();
  await a.bringToFront();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.getByRole("button", { name: "Pause", exact: true }).click();
  await settled(ja.id);
  assert.equal((await state(jb.id)).status, "running");
  await popup.close();
  const markerA = await a.evaluate(() => window.documentMarker),
    epochA = (await state(ja.id)).pageEpoch;
  await a
    .locator("#instafinder-collection")
    .getByRole("button", { name: "Resume", exact: true })
    .click();
  await a.getByLabel("Automatic", { exact: true }).waitFor();
  assert.equal((await state(ja.id)).pageEpoch, epochA);
  assert.equal(await a.evaluate(() => window.documentMarker), markerA);
  assert.equal((await state(jb.id)).status, "running");
  check(
    "Popup Pause and in-place overlay Resume affect only their tab; duplicate run resumes and a second collector in the same tab are rejected.",
  );
  await app.reload();
  await attach();
  assert.equal((await state(ja.id)).status, "running");
  assert.equal((await state(jb.id)).status, "running");
  await a.reload();
  await settled(ja.id);
  assert.equal((await state(jb.id)).status, "running");
  const resumed = await request({
    type: "collector-resume",
    id: ja.id,
    tabId: ja.tabId,
  });
  assert.ok(!resumed.error, resumed.error);
  await a.getByLabel("Automatic", { exact: true }).waitFor();
  assert.equal(await b.evaluate(() => window.documentMarker), markerB);
  await a.close();
  await settled(ja.id);
  assert.equal((await state(jb.id)).status, "running");
  await app
    .getByRole("button", { name: "Collection history", exact: true })
    .click();
  const dialog = app.getByRole("dialog");
  const rowA = dialog
    .locator(".history-row")
    .filter({ hasText: "@sourcea" })
    .filter({ hasText: "followers" })
    .first();
  assert.equal(
    await rowA.getByRole("button", { name: "Resume", exact: true }).isEnabled(),
    true,
  );
  await rowA.getByRole("button", { name: "Resume", exact: true }).click();
  await wait(
    async () =>
      (await request({ type: "collector-state" })).jobs.some(
        (job) => job.id === ja.id,
      ),
    "history resume",
  );
  const reopened = context
    .pages()
    .find(
      (tab) =>
        !tab.isClosed() &&
        tab.url().startsWith("https://www.instagram.com/sourcea/"),
    );
  await wait(
    () =>
      !!context
        .pages()
        .find(
          (tab) =>
            !tab.isClosed() &&
            tab.url().startsWith("https://www.instagram.com/sourcea/"),
        ),
    "reopened Instagram tab",
  );
  a =
    reopened ||
    context
      .pages()
      .find(
        (tab) =>
          !tab.isClosed() &&
          tab.url().startsWith("https://www.instagram.com/sourcea/"),
      );
  await a.getByLabel("Automatic", { exact: true }).waitFor();
  assert.equal((await state(jb.id)).status, "running");
  const rowB = dialog
    .locator(".history-row")
    .filter({ hasText: "@sourceb" })
    .filter({ hasText: "following" })
    .first();
  await rowB.getByRole("button", { name: "Pause", exact: true }).click();
  await settled(jb.id);
  assert.equal((await state(ja.id)).status, "running");
  await a.close();
  await settled(ja.id);
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  check(
    "Main-app reload, Instagram reload/closure and history Pause/Resume preserve other tabs' jobs and documents.",
  );
  const pendingTab = await newTab("unresolved");
  const pendingJob = await launch(pendingTab, "followers", missions[0]);
  await pendingTab.getByLabel("Automatic", { exact: true }).uncheck();
  await wait(
    async () => (await state(pendingJob.id))?.automatic === false,
    "pending manual mode",
  );
  await b.reload();
  jb = await launch(b, "following", missions[0], true);
  await app
    .getByRole("button", { name: "Collection history", exact: true })
    .click();
  const pendingRow = app
    .getByRole("dialog")
    .locator(".history-row")
    .filter({ hasText: "@unresolved" });
  await pendingRow.getByRole("button", { name: "Pause", exact: true }).click();
  await settled(pendingJob.id);
  assert.equal((await state(jb.id)).status, "running");
  assert.equal(
    await pendingRow
      .getByRole("button", { name: "Resume", exact: true })
      .isEnabled(),
    true,
  );
  await pendingRow.getByRole("button", { name: "Resume", exact: true }).click();
  await wait(
    async () => (await state(pendingJob.id))?.status === "running",
    "pending resume",
  );
  await pendingTab.getByLabel("Automatic", { exact: true }).waitFor();
  await pendingTab.close();
  await settled(pendingJob.id);
  await b
    .locator("#instafinder-collection")
    .getByRole("button", { name: "Finish with saved results", exact: true })
    .click();
  await settled(jb.id);
  assert.equal((await state(jb.id)).status, "partial");
  await app
    .getByRole("dialog")
    .getByRole("button", { name: "Close dialog" })
    .click();
  check(
    "Unidentified pending jobs can pause and resume from history while another tab runs; partial finish stays local to its job.",
  );
  a = await newTab("sourcea");
  await b.reload();
  ja = await launch(a, "followers", missions[0], true);
  jb = await launch(b, "following", missions[0], true);
  rate = true;
  await b.evaluate(() =>
    fetch("/api/v1/friendships/555/following/?count=12&max_id=17").then((r) =>
      r.text(),
    ),
  );
  await Promise.all([settled(ja.id), settled(jb.id)]);
  assert.equal((await state(ja.id)).status, "cooldown");
  assert.equal((await state(jb.id)).status, "cooldown");
  assert.equal((await state(ja.id)).retryAt, (await state(jb.id)).retryAt);
  for (const tab of [a, b])
    assert.equal(
      await tab
        .locator("#instafinder-collection")
        .getByRole("button", { name: "Resume", exact: true })
        .isDisabled(),
      true,
    );
  const blocked = await request({
    type: "collector-resume",
    id: ja.id,
    tabId: ja.tabId,
  });
  assert.match(blocked.error, /cooling down/);
  rate = false;
  await app.evaluate(() =>
    window.__testing.db.settings.update("preferences", {
      pageCooldownUntil: 0,
    }),
  );
  check(
    "A native 429 stops every active page job with the same durable cooldown, disables Resume and rejects early restarts.",
  );
  const post = await newTab("/p/BA/");
  const liked = await launch(post, "likers", missions[0]);
  await settled(liked.id);
  assert.equal((await state(liked.id)).status, "completed");
  assert.equal(await app.evaluate(() => window.__testing.db.likes.count()), 10);
  assert.deepEqual(await post.evaluate(() => window.badClicks), []);
  await post
    .locator("#instafinder-collection")
    .getByText("Collection complete", { exact: true })
    .waitFor();
  await mkdir(".test-artifacts", { recursive: true });
  await post.screenshot({
    path: ".test-artifacts/numeric-likes.png",
    fullPage: true,
  });
  check(
    "The supplied nested heart/number layout opens the likers dialog via 10, captures both pages, and never clicks Like, Comment, its count or Share.",
  );
  await post.reload();
  await post
    .locator('svg[aria-label="Like"]')
    .evaluate((svg) => svg.setAttribute("aria-label", "Unlike"));
  const likedAgain = await launch(post, "likers", missions[1]);
  await settled(likedAgain.id);
  assert.equal((await state(likedAgain.id)).status, "completed");
  assert.equal(await app.evaluate(() => window.__testing.db.likes.count()), 10);
  assert.deepEqual(await post.evaluate(() => window.badClicks), []);
  check(
    "An already-liked heart labeled Unlike also resolves its count without clicking the heart or multiplying like facts.",
  );
  await post.reload();
  await post.locator("#likes-count").evaluate((el) => el.remove());
  const missing = await launch(post, "likers", missions[0]);
  await post
    .getByText(
      "Couldn’t find the likes count. Open it manually to capture likers.",
      { exact: true },
    )
    .waitFor();
  assert.equal(
    await post.getByLabel("Automatic", { exact: true }).isChecked(),
    false,
  );
  assert.deepEqual(await post.evaluate(() => window.badClicks), []);
  await post
    .locator("#instafinder-collection")
    .getByRole("button", { name: "Finish with saved results", exact: true })
    .click();
  await settled(missing.id);
  assert.equal((await state(missing.id)).status, "partial");
  check(
    "A missing likes counter switches to manual capture instead of clicking the nearby comment count or heart.",
  );
  assert.deepEqual(errors, []);
  await writeFile(
    ".test-artifacts/parallel-browser-report.json",
    JSON.stringify({ checks, requests: requests.length }, null, 2),
  );
} catch (error) {
  if (app && !app.isClosed()) {
    await mkdir(".test-artifacts", { recursive: true });
    await app
      .screenshot({
        path: ".test-artifacts/parallel-failure.png",
        fullPage: true,
      })
      .catch(() => {});
    console.error(
      await app
        .evaluate(async () => ({
          runs: await window.__testing?.db.runs.toArray(),
          pending: await window.__testing?.db.pendingPageJobs.toArray(),
        }))
        .catch(() => {}),
    );
  }
  throw error;
} finally {
  await context?.close();
  await unlink(bundle).catch(() => {});
  await rm(profileDir, { recursive: true, force: true });
}
