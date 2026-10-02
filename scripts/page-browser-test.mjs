import { chromium } from "playwright";
import { build } from "esbuild";
import { mkdir, rm, writeFile, unlink, cp } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const lateScripts = process.env.INSTA_TEST_LATE_SCRIPTS === "1";
const extension = resolve(lateScripts ? ".test-page-extension" : "dist"),
  profileDir = resolve(
    lateScripts ? ".test-page-profile-late" : ".test-page-profile",
  );
await mkdir(".test-artifacts", { recursive: true });
await rm(profileDir, { recursive: true, force: true });
await build({
  entryPoints: ["tests/browser-harness.ts"],
  bundle: true,
  format: "iife",
  outfile: "dist/page-verification.js",
  target: "chrome110",
});
if (lateScripts) {
  await rm(extension, { recursive: true, force: true });
  await cp("dist", extension, { recursive: true });
  const { readFile } = await import("node:fs/promises");
  const manifest = JSON.parse(
    await readFile(resolve(extension, "manifest.json"), "utf8"),
  );
  manifest.content_scripts = [];
  await writeFile(
    resolve(extension, "manifest.json"),
    JSON.stringify(manifest),
  );
}
const user = (id, name = `person${id}`) => ({
  pk: id,
  username: name,
  full_name: `Person ${id}`,
  profile_pic_url:
    id === "2"
      ? "https://scontent-test.cdninstagram.com/person2.png?signature=fixture"
      : id === "3"
        ? "https://scontent-test.fbcdn.net/person3.png?signature=fixture"
        : "",
});
const pageHtml = (
  pathname,
) => `<!doctype html><html><head><title>Instagram fixture</title></head><body>
<style>body{font:16px system-ui}a,button{margin:10px}main{height:1500px}[role=dialog]{position:fixed;top:40px;left:40px;background:white;border:1px solid;padding:20px}.scroll{height:200px;overflow-y:auto;width:300px}</style>
<nav style="visibility:hidden"><a href="/source/followers/" data-list="followers" style="display:contents"><span class="native-trigger">Followers</span></a><button aria-label="Relationship status" onclick="window.badFollowClicked=true">Following</button><button data-list="following" aria-label="Following"><span>12</span> <span class="native-trigger">Following</span></button><a href="/source/reels/" id="reels">Reels</a></nav>
<main><a href="/p/BA/" data-post="64">Post one</a><a href="/reel/BB/" data-post="65">Post two</a></main>
${pathname.startsWith("/source/") || /^\/(p|reel)\//.test(pathname) ? `<script type="application/json">${JSON.stringify(pathname.startsWith("/source/") ? { data: { user: { ...user("173560420", "source"), media_count: 2, edge_owner_to_timeline_media: { count: 2, edges: [{ node: { pk: "64", code: "BA", user: user("173560420", "source"), comment_count: 2, like_count: 3 } }], page_info: { has_next_page: false } } } } } : { data: { shortcode_media: { pk: pathname.startsWith("/reel/") ? "65" : "64", code: pathname.startsWith("/reel/") ? "BB" : "BA", product_type: pathname.startsWith("/reel/") ? "clips" : "feed", user: user("173560420", "source"), comment_count: 2, like_count: pathname.startsWith("/reel/") ? 1 : 3, edge_media_to_parent_comment: { edges: [{ node: { pk: "10", user: user("2"), child_comment_count: 1 } }], page_info: { has_next_page: false } } } } })}</script>` : ""}
<script>
const initialPath=${JSON.stringify(pathname)};
window.received=[];window.nativeCalls=0; if(initialPath.startsWith("/unsupported/")) document.querySelector("nav").remove();setTimeout(()=>{if(document.querySelector('nav'))document.querySelector('nav').style.visibility='visible';},2600);
function addUsers(data,box){window.received.push(JSON.stringify(data));for(const u of data.users || []){const el=document.createElement('p');el.textContent=u.username;el.style.height='110px';box.append(el);}}
let currentList;
async function list(kind){currentList=kind;document.querySelector('[role=dialog]')?.remove();const dialog=document.createElement('section');dialog.setAttribute('role','dialog');dialog.innerHTML='<h2>'+kind+'</h2><button aria-label="Close">Close</button><div class="scroll"></div>';document.body.append(dialog);dialog.querySelector('button').onclick=()=>dialog.remove();const box=dialog.querySelector('.scroll');let fetching=false,more=true;
const first=await fetch('/api/v1/friendships/173560420/'+kind+'/?count=12');const data=await first.json();addUsers(data,box);more=data.has_more;let next=data.next_max_id;
box.addEventListener('scroll',()=>{if(fetching||!more)return;fetching=true;window.nativeCalls++;const xhr=new XMLHttpRequest();xhr.open('GET','/api/v1/friendships/173560420/'+kind+'/?count=12&max_id='+next);xhr.onload=()=>{const data=JSON.parse(xhr.responseText);window.xhrBody=xhr.responseText;addUsers(data,box);more=data.has_more;next=data.next_max_id;fetching=false;};xhr.send();});}
document.querySelectorAll('[data-list]').forEach(a=>a.querySelector('.native-trigger').onclick=e=>{e.preventDefault();void list(a.dataset.list);});
async function info(){await (await fetch('/api/v1/users/web_profile_info/?username=source')).json();}
async function feed(){await (await fetch('/api/v1/feed/user/173560420/')).json();}
if(document.getElementById('reels'))document.getElementById('reels').onclick=async e=>{e.preventDefault();history.pushState({},'', '/source/reels/');await (await fetch('/api/v1/clips/user/',{method:'POST',body:'target_user_id=173560420'})).json();};
async function post(id){document.querySelector('[role=dialog]')?.remove();history.pushState({},'',id==='64'?'/p/BA/':'/reel/BB/');const dialog=document.createElement('section');dialog.setAttribute('role','dialog');dialog.innerHTML='<h2>Post '+id+'</h2><button aria-label="Close">Close</button><button id="reply">View replies</button><a id="likes" href="/p/'+(id==='64'?'BA':'BB')+'/liked_by/">3 likes</a><div class="scroll"><div style="height:500px">Comments</div></div>';document.body.append(dialog);dialog.querySelector('[aria-label=Close]').onclick=()=>{dialog.remove();history.pushState({},'','/source/reels/');};dialog.querySelector('#likes').onclick=e=>{e.preventDefault();void likes(id);};dialog.querySelector('#reply').onclick=async()=>{await (await fetch('/api/v1/media/'+id+'/comments/10/child_comments/')).json();dialog.querySelector('#reply').remove();};await(await fetch('/api/v1/media/'+id+'/info/')).json();await(await fetch('/api/v1/media/'+id+'/comments/')).json();}
async function likes(id){const dialog=document.createElement('section');dialog.setAttribute('role','dialog');dialog.innerHTML='<h2>Likes</h2><button aria-label="Close">Close</button><div class="scroll"></div>';document.body.append(dialog);dialog.querySelector('button').onclick=()=>dialog.remove();const box=dialog.querySelector('.scroll');const data=await(await fetch('/api/v1/media/'+id+'/likers/?count=12')).json();addUsers(data,box);let more=data.has_more;box.addEventListener('scroll',async()=>{if(!more)return;more=false;const next=await(await fetch('/api/v1/media/'+id+'/likers/?count=12&max_id=24')).json();addUsers(next,box);});}
document.querySelectorAll('[data-post]').forEach(a=>a.onclick=e=>{e.preventDefault();void post(a.dataset.post);});
// Initial native requests may start before the async content-script bootstrap finishes.
setTimeout(()=>{if(initialPath.startsWith('/p/'))void post('64');else if(initialPath.startsWith('/reel/'))void post('65');else if(initialPath.startsWith('/source/')){void info();void feed();}},0);
</script></body></html>`;
let context, app;
let failMode = "";
const errors = [],
  requests = [],
  checks = [];
try {
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
  const imageRequests = [];
  await context.route(
    /^https:\/\/scontent-test\.(cdninstagram\.com|fbcdn\.net)\//,
    async (route) => {
      imageRequests.push({
        url: route.request().url(),
        headers: route.request().headers(),
      });
      await route.fulfill({
        contentType: "image/png",
        headers: { "Cross-Origin-Resource-Policy": "same-origin" },
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
          "base64",
        ),
      });
    },
  );
  await context.route(/^https:\/\/(www|i)\.instagram\.com\//, async (route) => {
    const url = new URL(route.request().url());
    requests.push({
      path: url.pathname + url.search,
      type: route.request().resourceType(),
      at: Date.now(),
    });
    if (route.request().isNavigationRequest()) {
      await route.fulfill({
        contentType: "text/html",
        body: pageHtml(url.pathname),
      });
      return;
    }
    let body;
    if (url.pathname.includes("web_profile_info"))
      body = {
        data: { user: { ...user("173560420", "source"), media_count: 2 } },
      };
    else if (url.pathname.includes("friendships")) {
      if (failMode === "rate") {
        await route.fulfill({
          status: 429,
          contentType: "application/json",
          headers: { "Retry-After": "60" },
          body: '{"message":"Please wait"}',
        });
        return;
      }
      if (failMode === "stall" && url.searchParams.has("max_id")) {
        await route.fulfill({
          contentType: "application/json",
          body: '{"users":[],"has_more":true,"next_max_id":"24"}',
        });
        return;
      }
      if (url.searchParams.has("max_id"))
        body = { users: [user("4")], has_more: false, status: "ok" };
      else
        body = {
          users: [user("2"), user("3")],
          has_more: url.pathname.includes("following"),
          next_max_id: url.pathname.includes("following") ? "12" : null,
          follow_ranking_token: "PRIVATE-FIXTURE-TOKEN",
          status: "ok",
        };
    } else if (url.pathname.includes("feed/user"))
      body = {
        items: [
          {
            pk: "64",
            code: "BA",
            user: user("173560420", "source"),
            comment_count: 2,
            like_count: url.pathname.includes("/65/") ? 1 : 3,
          },
        ],
        more_available: false,
      };
    else if (url.pathname.includes("clips/user"))
      body = {
        items: [
          {
            media: {
              pk: "65",
              code: "BB",
              product_type: "clips",
              user: user("173560420", "source"),
              comment_count: 2,
              like_count: 1,
            },
          },
        ],
        paging_info: { more_available: false },
      };
    else if (/\/media\/\d+\/info/.test(url.pathname)) {
      const media = url.pathname.split("/")[4];
      body = {
        items: [
          {
            pk: media,
            code: media === "64" ? "BA" : "BB",
            product_type: media === "64" ? "feed" : "clips",
            user: user("173560420", "source"),
            comment_count: 2,
            like_count: url.pathname.includes("/65/") ? 1 : 3,
          },
        ],
      };
    } else if (url.pathname.includes("/likers/")) {
      const reel = url.pathname.includes("/65/");
      body = reel
        ? { users: [user("3")], has_more: false, user_count: 1 }
        : url.searchParams.has("max_id")
          ? { users: [user("4")], has_more: false, user_count: 3 }
          : {
              users: [user("2"), user("3")],
              has_more: true,
              next_max_id: "24",
              user_count: 3,
            };
    } else if (url.pathname.includes("child_comments"))
      body = {
        child_comments: [{ pk: "11", user: user("3") }],
        has_more_tail_child_comments: false,
      };
    else if (url.pathname.includes("comments"))
      body = {
        comments: [{ pk: "10", user: user("2"), child_comment_count: 1 }],
        has_more_comments: false,
        has_more_headload_comments: false,
      };
    else throw new Error(`Unexpected native fixture request: ${url}`);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  const check = (text) => {
    checks.push(text);
    console.log(`PASS: ${text}`);
  };
  const regular = await context.newPage();
  await regular.goto("https://www.instagram.com/unrelated/");
  app = await context.newPage();
  app.on("pageerror", (e) => errors.push(e.message));
  const appUrl = `chrome-extension://${id}/app.html`;
  const attach = async () =>
    app.addScriptTag({ url: `chrome-extension://${id}/page-verification.js` });
  await app.goto(appUrl);
  await app.getByRole("button", { name: "Skip", exact: true }).click();
  await attach();
  await app.evaluate(async () =>
    window.__testing.db.settings.put({
      id: "preferences",
      delaySeconds: 5,
      pageDelaySeconds: 1.5,
      cooldownUntil: Date.now() + 600000,
    }),
  );
  const waitState = async (fn, arg, options = {}) => {
    const end = Date.now() + (options.timeout || 30000);
    while (Date.now() < end) {
      if (await app.evaluate(fn, arg)) return;
      await app.waitForTimeout(80);
    }
    throw new Error("Timed out waiting for extension state.");
  };
  let ig, currentJob;
  const openPopup = async (target) => {
    const popup = await context.newPage();
    await target.bringToFront();
    await popup.goto(`chrome-extension://${id}/popup.html`);
    await popup
      .getByRole("button", { name: "Open InstaFinder", exact: true })
      .waitFor();
    await popup
      .getByText("Loading…", { exact: true })
      .waitFor({ state: "hidden" });
    return popup;
  };
  const latest = () =>
    app.evaluate(async () => {
      const d = window.__testing.db;
      return d.transaction(
        "r",
        d.runs,
        d.pendingPageJobs,
        async () =>
          [
            ...(await d.runs.toArray()),
            ...(await d.pendingPageJobs.toArray()),
          ].sort((a, b) => b.createdAt - a.createdAt)[0],
      );
    });
  const idle = () =>
    waitState(
      async () =>
        !(await chrome.runtime.sendMessage({ type: "collector-state" })).busy,
      {},
      { timeout: 10000 },
    );
  const finish = async () => {
    await waitState(
      async (job) => {
        const d = window.__testing.db;
        const state = await d.transaction(
          "r",
          d.runs,
          d.pendingPageJobs,
          async () =>
            (await d.runs.get(job)) || (await d.pendingPageJobs.get(job)),
        );
        return !!state && state.status !== "running";
      },
      currentJob,
      { timeout: 45000 },
    );
    await idle();
  };
  const launch = async (value, mode, mission) => {
    await idle();
    if (!ig || ig.isClosed()) {
      ig = await context.newPage();
      ig.on("pageerror", (e) => errors.push(e.message));
    }
    const url = value.startsWith("https:")
      ? value
      : `https://www.instagram.com/${value}/`;
    await ig.goto(url);
    await ig.waitForTimeout(100);
    await ig.evaluate(() => {
      window.documentMarker = crypto.randomUUID();
    });
    const marker = await ig.evaluate(() => window.documentMarker);
    const nativeNavigations = requests.filter(
      (r) => r.type === "document",
    ).length;
    const popup = await openPopup(ig);
    if (mission)
      await popup.getByLabel("Mission", { exact: true }).selectOption(mission);
    await popup.getByRole("button", { name: mode, exact: true }).click();
    await ig
      .getByLabel("Automatic", { exact: true })
      .waitFor({ timeout: 10000 });
    currentJob = (await latest()).id;
    assert.equal(
      await ig.evaluate(() => window.documentMarker),
      marker,
      "Popup start must keep the existing document",
    );
    assert.equal(
      requests.filter((r) => r.type === "document").length,
      nativeNavigations,
      "Popup start must not navigate or reload",
    );
    if (!popup.isClosed()) await popup.close();
    return currentJob;
  };
  let popup = await openPopup(regular);
  await popup
    .getByText("Create a mission in InstaFinder to start collecting.", {
      exact: true,
    })
    .waitFor();
  assert.equal(await popup.locator(".choices").count(), 0);
  await popup.close();
  await app
    .getByRole("button", { name: "New mission", exact: true })
    .first()
    .click();
  await app.getByLabel("Mission name").fill("Page workflow");
  await app
    .getByRole("dialog")
    .getByRole("button", { name: "Create mission", exact: true })
    .click();
  const primary = await app.evaluate(
    async () => (await window.__testing.db.missions.toArray())[0].id,
  );
  assert.equal(
    await worker.evaluate(
      () => chrome.runtime.getManifest().action.default_popup,
    ),
    "popup.html",
  );
  await app.getByRole("button", { name: "Add source", exact: true }).click();
  assert.equal(
    await app.getByLabel("Collection method", { exact: true }).count(),
    0,
  );
  assert.equal(
    await app
      .getByRole("button", { name: "Collect in Instagram", exact: true })
      .count(),
    0,
  );
  await app
    .getByRole("button", { name: "Look up account", exact: true })
    .waitFor();
  await app.getByRole("button", { name: "Cancel", exact: true }).click();
  check(
    "Toolbar action declares a popup; empty workspaces offer Open InstaFinder, while main Add source contains only direct collection.",
  );

  await launch("source", "Following");
  assert.equal(await app.locator(".collection-banner").count(), 0);
  await finish();
  const finishedOverlay = ig.locator("#instafinder-collection");
  await finishedOverlay
    .getByText("Collection complete", { exact: true })
    .waitFor();
  await finishedOverlay
    .getByText("3 profiles saved.", { exact: true })
    .waitFor();
  assert.equal(
    await finishedOverlay.getByLabel("Automatic", { exact: true }).count(),
    0,
  );
  await ig.waitForTimeout(1100);
  await finishedOverlay
    .getByText("Collection complete", { exact: true })
    .waitFor();
  await finishedOverlay
    .getByRole("button", { name: "Open InstaFinder", exact: true })
    .click();
  await app.waitForURL(new RegExp(`mission=${primary}`));
  await finishedOverlay
    .getByRole("button", { name: "Dismiss", exact: true })
    .click();
  await finishedOverlay.waitFor({ state: "detached" });
  check(
    "Successful collection leaves a persistent, dismissible completion notice with the saved count and an Open InstaFinder action; capture controls are removed.",
  );
  let data = await app.evaluate(async () => ({
    run: (await window.__testing.db.runs.toArray())[0],
    follows: await window.__testing.db.follows.toArray(),
    profiles: await window.__testing.db.profiles.toArray(),
    sources: await window.__testing.db.sources.toArray(),
  }));
  assert.equal(data.run.status, "completed");
  assert.equal(data.run.method, "page");
  assert.equal(data.follows.length, 3);
  assert.ok(data.follows.every((f) => f.followerId === "173560420"));
  assert.equal(
    await ig.evaluate(() => JSON.parse(window.xhrBody).users[0].pk),
    "4",
  );
  assert.equal(await ig.evaluate(() => !!window.badFollowClicked), false);
  const followingPages = requests.filter(
    (r) => r.path.includes("/following/") && r.type !== "document",
  );
  assert.ok(followingPages[1].at - followingPages[0].at >= 1400);
  assert.ok(followingPages[1].at - followingPages[0].at < 3000);
  assert.ok(
    !JSON.stringify(
      await app.evaluate(() => window.__testing.exportBackup()),
    ).includes("PRIVATE-FIXTURE-TOKEN"),
  );
  await waitState(() => {
    const img = document.querySelector(".avatar-large img");
    return img && img.src.startsWith("blob:") && img.naturalWidth > 0;
  });
  await app.getByRole("tab", { name: /Candidates/ }).click();
  await waitState(
    () =>
      [...document.querySelectorAll(".list-panel tbody img")].filter(
        (img) => img.naturalWidth > 0,
      ).length >= 2,
  );
  assert.ok(imageRequests.some((r) => r.url.includes("fbcdn.net")));
  assert.ok(
    imageRequests.every((r) => !r.headers.cookie && !r.headers.referer),
  );
  await app.getByLabel("Decision for person2").selectOption("possible");
  check(
    "Popup collection keeps running after the popup closes, opens delayed nested Following controls, captures unchanged fetch/XHR pages and renders CDN photos without credentials.",
  );
  popup = await openPopup(ig);
  assert.equal(await popup.getByLabel("Mission", { exact: true }).count(), 0);
  assert.ok(
    !(await popup.locator("body").innerText()).includes("Page workflow"),
  );
  await popup.screenshot({
    path: ".test-artifacts/toolbar-popup-one-mission.png",
  });
  await popup.close();
  check(
    "One mission is automatically selected and its name/selector are hidden in the popup; page jobs have no main-app banner.",
  );

  const addedAt = data.sources[0].addedAt;
  await launch("source", "Followers");
  await finish();
  assert.equal(
    await app.evaluate(() => window.__testing.db.sources.count()),
    1,
  );
  assert.equal(
    await app.evaluate(
      async () => (await window.__testing.db.sources.toArray())[0].addedAt,
    ),
    addedAt,
  );
  assert.equal(
    await app.evaluate(
      async (id) => (await window.__testing.db.candidates.get([id, "2"])).score,
      primary,
    ),
    2,
  );
  assert.equal(
    await app.evaluate(
      async (id) =>
        (await window.__testing.db.candidates.get([id, "2"])).decision,
      primary,
    ),
    "possible",
  );
  check(
    "Followers opens display:contents links, preserves the existing source and decisions, and mutual following contributes both directions once.",
  );
  await launch("https://www.instagram.com/p/BA/", "Commenters");
  await finish();
  assert.equal((await latest()).status, "completed");
  assert.equal(
    await app.evaluate(() => window.__testing.db.comments.count()),
    2,
  );
  await launch("source", "Commenters");
  // Force the next queued reel to leave the virtualized grid, so the normal
  // controller navigates to a new document rather than clicking a SPA link.
  await ig.locator('[data-post="65"]').evaluate((el) => el.remove());
  await ig.waitForURL("**/reel/BB/");
  await ig.getByLabel("Automatic", { exact: true }).waitFor();
  await ig.getByRole("button", { name: "Pause", exact: true }).click();
  await finish();
  const commentEpoch = (await latest()).pageEpoch;
  const postMarker = await ig.evaluate(
    () => (window.postResumeMarker = crypto.randomUUID()),
  );
  const postNavCount = requests.filter((r) => r.type === "document").length;
  await ig
    .locator("#instafinder-collection")
    .getByRole("button", { name: "Resume", exact: true })
    .click();
  await ig.getByLabel("Automatic", { exact: true }).waitFor();
  await finish();
  assert.equal((await latest()).pageEpoch, commentEpoch);
  assert.equal(await ig.evaluate(() => window.postResumeMarker), postMarker);
  assert.equal(
    requests.filter((r) => r.type === "document").length,
    postNavCount,
  );
  check(
    "Overlay Resume works after the collector navigates to a new post/reel document, retaining reply progress and the verified post owner without a reload.",
  );
  assert.equal((await latest()).status, "completed");
  assert.equal(
    await app.evaluate(() => window.__testing.db.comments.count()),
    4,
  );
  check(
    "Post and profile commenter collection verify owners and collect native paginated replies across feed and reels.",
  );

  await launch("https://www.instagram.com/p/BA/", "Likers");
  await finish();
  assert.equal((await latest()).status, "completed");
  assert.equal(await app.evaluate(() => window.__testing.db.likes.count()), 3);
  assert.ok(
    requests.some(
      (r) => r.path.includes("/likers/") && r.path.includes("max_id=24"),
    ),
  );
  const beforeLikes = await app.evaluate(() =>
    window.__testing.db.follows.count(),
  );
  await launch("source", "Likers");
  await finish();
  assert.equal((await latest()).status, "completed");
  assert.equal(await app.evaluate(() => window.__testing.db.likes.count()), 4);
  assert.equal(
    await app.evaluate(() => window.__testing.db.follows.count()),
    beforeLikes,
  );
  assert.equal(
    await app.evaluate(
      async (id) => (await window.__testing.db.candidates.get([id, "3"])).score,
      primary,
    ),
    6,
  );
  assert.equal(
    await app.evaluate(
      async (id) =>
        (await window.__testing.db.candidates.get([id, "2"])).decision,
      primary,
    ),
    "possible",
  );
  check(
    "Likers uses native likes dialogs and observed cursors; repeated post/profile collection adds one point per distinct source post without follow facts or decision resets.",
  );
  await ig.goto("https://www.instagram.com/reel/BB/");
  popup = await openPopup(ig);
  assert.equal(
    await popup.getByRole("button", { name: "Followers", exact: true }).count(),
    0,
  );
  assert.equal(
    await popup.getByRole("button", { name: "Following", exact: true }).count(),
    0,
  );
  await popup.getByRole("button", { name: "Likers", exact: true }).waitFor();
  await popup.screenshot({ path: ".test-artifacts/toolbar-popup-post.png" });
  await popup.close();
  check(
    "Post/reel popups offer only Commenters and Likers, with Open InstaFinder always available.",
  );

  await launch("source", "Following");
  await ig.getByLabel("Automatic", { exact: true }).uncheck();
  await ig.evaluate(() => {
    document.documentElement.style.colorScheme = "dark";
    document.body.style.background = "#0c1012";
  });
  failMode = "rate";
  await ig.getByRole("link", { name: "Followers", exact: true }).click();
  await ig
    .locator("#instafinder-collection")
    .getByText(
      "This is Followers; it is not being saved. Close it and open Following.",
      { exact: true },
    )
    .waitFor();
  assert.equal((await latest()).status, "running");
  assert.equal(
    await app.evaluate(
      async (id) =>
        window.__testing.db.results.where("runId").equals(id).count(),
      currentJob,
    ),
    0,
  );
  const colors = await ig
    .locator("#instafinder-collection")
    .evaluate((host) =>
      ["pause", "finish"].map(
        (id) => getComputedStyle(host.shadowRoot.getElementById(id)).color,
      ),
    );
  assert.deepEqual(colors, ["rgb(32, 55, 46)", "rgb(255, 255, 255)"]);
  await ig.screenshot({ path: ".test-artifacts/page-overlay-dark-site.png" });
  await ig.getByRole("button", { name: "Close", exact: true }).click();
  failMode = "";
  await ig.getByRole("button", { name: "Following", exact: true }).click();
  await waitState(
    async (id) =>
      (await window.__testing.db.results.where("runId").equals(id).count()) ===
      2,
    currentJob,
  );
  await ig.reload();
  await finish();
  assert.equal((await latest()).status, "paused");
  popup = await openPopup(ig);
  await popup
    .getByRole("button", { name: "Resume Following", exact: true })
    .click();
  await ig.locator("#instafinder-collection").waitFor();
  if (!popup.isClosed()) await popup.close();
  await ig.getByLabel("Automatic", { exact: true }).check();
  await finish();
  assert.equal(
    await app.evaluate(() => window.__testing.db.follows.count()),
    5,
  );
  check(
    "Manual capture ignores the wrong list and its 429, stays readable on a dark host, pauses on Instagram reload and resumes explicitly from the popup without duplicates.",
  );

  await ig.goto("https://www.instagram.com/source/");
  await ig.getByRole("button", { name: "Following", exact: true }).click();
  await ig.locator(".scroll p").first().waitFor();
  const openListMarker = await ig.evaluate(
    () => (window.existingListMarker = crypto.randomUUID()),
  );
  popup = await openPopup(ig);
  await popup.getByRole("button", { name: "Following", exact: true }).click();
  await ig.getByLabel("Automatic", { exact: true }).waitFor();
  currentJob = (await latest()).id;
  if (!popup.isClosed()) await popup.close();
  await finish();
  assert.equal((await latest()).status, "completed");
  assert.equal(
    await ig.evaluate(() => window.existingListMarker),
    openListMarker,
  );
  check(
    "Starting with a list already open reopens that list through its controls to capture page one, without replacing the Instagram document.",
  );

  const other = await app.evaluate(
    async () => (await window.__testing.createMission("Other mission")).id,
  );
  await ig.goto("https://www.instagram.com/source/");
  popup = await openPopup(ig);
  await popup.getByLabel("Mission", { exact: true }).selectOption(other);
  await popup.screenshot({
    path: ".test-artifacts/toolbar-popup-missions.png",
  });
  await popup
    .getByRole("button", { name: "Open InstaFinder", exact: true })
    .click();
  if (!popup.isClosed()) await popup.close();
  await app
    .getByRole("heading", { name: "Other mission", exact: true })
    .waitFor();
  await launch("source", "Following", other);
  await finish();
  assert.equal(
    await app.evaluate(
      async (id) =>
        (await window.__testing.db.candidates.get([id, "2"])).decision,
      other,
    ),
    "unreviewed",
  );
  assert.equal(
    await app.evaluate(
      async (id) => (await window.__testing.db.candidates.get([id, "3"])).score,
      other,
    ),
    6,
  );
  check(
    "Multiple missions expose a selector, Open InstaFinder selects that mission in the existing app tab, and collection keeps decisions isolated while using saved global observations.",
  );
  const beforeCache = requests.length;
  await app.getByRole("button", { name: "Add source", exact: true }).click();
  await app.getByLabel("Username or Instagram URL").fill("source");
  await app.getByRole("radio", { name: "Following", exact: true }).check();
  await app
    .getByRole("button", { name: "Look up account", exact: true })
    .click();
  await app
    .getByRole("button", { name: "Use saved results", exact: true })
    .click();
  assert.equal(requests.length, beforeCache);
  check(
    "Direct-only Add source can reuse a completed page-mode collection without an Instagram request.",
  );

  await launch("unsupported", "Following", other);
  await ig.getByLabel("Automatic", { exact: true }).uncheck();
  const unresolved = currentJob;
  await app.reload();
  await attach();
  assert.equal((await latest()).status, "running");
  assert.equal(await app.locator(".collection-banner").count(), 0);
  await app.close();
  await ig.waitForTimeout(35000);
  popup = await openPopup(ig);
  await popup.getByText("Collection is running.", { exact: true }).waitFor();
  await popup
    .getByRole("button", { name: "Open InstaFinder", exact: true })
    .click();
  if (!popup.isClosed()) await popup.close();
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    app = context.pages().find((p) => p.url().startsWith(appUrl));
    if (app) break;
    await ig.waitForTimeout(50);
  }
  await app.locator(".app-shell").waitFor();
  await attach();
  assert.equal((await latest()).id, unresolved);
  assert.equal((await latest()).status, "running");
  await ig.getByRole("button", { name: "Pause", exact: true }).click();
  await finish();
  check(
    "Page collection survives main-app reload/closure and over 30 seconds of manual idle time; Open InstaFinder recreates the app without interrupting the job.",
  );
  popup = await openPopup(ig);
  await popup
    .getByRole("button", { name: "Resume Following", exact: true })
    .click();
  await ig.locator("#instafinder-collection").waitFor();
  if (!popup.isClosed()) await popup.close();
  await ig
    .getByRole("button", { name: "Finish with saved results", exact: true })
    .click();
  await finish();
  assert.equal((await latest()).status, "partial");
  await ig
    .locator("#instafinder-collection")
    .getByText("Saved partial results", { exact: true })
    .waitFor();
  assert.equal(
    await ig.getByText("Collection complete", { exact: true }).count(),
    0,
  );
  check(
    "Popup resume preserves an unresolved job, and Finish with saved results records partial coverage.",
  );
  await launch("unsupported", "Following", other);
  await ig.getByLabel("Automatic", { exact: true }).uncheck();
  await ig.close();
  await finish();
  assert.equal((await latest()).status, "paused");
  assert.equal(regular.url(), "https://www.instagram.com/unrelated/");
  check(
    "Closing the selected Instagram tab pauses its collection and leaves unrelated tabs untouched.",
  );
  failMode = "stall";
  await launch("source", "Following", other);
  await finish();
  assert.equal((await latest()).status, "paused");
  assert.match((await latest()).reason, /three attempts/);
  await ig
    .locator("#instafinder-collection")
    .getByText("Collection paused", { exact: true })
    .waitFor();
  failMode = "";
  const stalled = await latest();
  const beforeResume = await ig.evaluate(() => ({
    marker: window.documentMarker,
    scroll: document.querySelector(".scroll").scrollTop,
  }));
  const firstPages = requests.filter(
    (r) => r.path.includes("/following/") && !r.path.includes("max_id"),
  ).length;
  await ig
    .locator("#instafinder-collection")
    .getByRole("button", { name: "Resume", exact: true })
    .click();
  await ig.getByLabel("Automatic", { exact: true }).waitFor();
  await finish();
  assert.equal((await latest()).status, "completed");
  assert.equal(
    (await latest()).pageEpoch,
    stalled.pageEpoch,
    "Continue the observed traversal epoch",
  );
  assert.equal(
    await ig.evaluate(() => window.documentMarker),
    beforeResume.marker,
  );
  assert.equal(
    requests.filter(
      (r) => r.path.includes("/following/") && !r.path.includes("max_id"),
    ).length,
    firstPages,
    "Resume must not reopen or replay the first page",
  );
  check(
    "Overlay Resume reconnects in the same document and list, continues the observed cursor chain and finishes without reloading, refetching page one or resetting decisions.",
  );
  check(
    "Automatic traversal stops after three attempts without progress and retains its checkpoint.",
  );
  failMode = "rate";
  await launch("source", "Following", other);
  await finish();
  assert.equal((await latest()).status, "cooldown");
  await ig
    .locator("#instafinder-collection")
    .getByText("Collection stopped", { exact: true })
    .waitFor();
  await ig
    .locator("#instafinder-collection")
    .getByText(/Resume after/)
    .waitFor();
  const timing = await app.evaluate(() =>
    window.__testing.db.settings.get("preferences"),
  );
  assert.ok(timing.pageCooldownUntil > Date.now());
  assert.equal(
    await ig
      .locator("#instafinder-collection")
      .getByRole("button", { name: "Resume", exact: true })
      .isDisabled(),
    true,
  );
  assert.ok(timing.cooldownUntil > Date.now());
  failMode = "";
  check(
    "Native 429 stops page collection and persists its independent cooldown; direct mode is never used as a fallback.",
  );
  const restored = await app.evaluate(async () => {
    const api = window.__testing,
      backup = await api.exportBackup();
    await api.restoreBackup(backup);
    return {
      version: backup.version,
      likes: await api.db.likes.count(),
      receipts: await api.db.pageReceipts.count(),
    };
  });
  assert.equal(restored.version, 3);
  assert.equal(restored.likes, 4);
  assert.ok(restored.receipts > 0);
  check(
    "Version-three full backups round-trip likers, page jobs, pagination receipts and cooldowns in real extension IndexedDB.",
  );
  await app.setViewportSize({ width: 390, height: 844 });
  await app
    .getByRole("button", { name: "Settings & backups", exact: true })
    .click();
  assert.equal(
    await app.getByLabel("Default collection method", { exact: true }).count(),
    0,
  );
  assert.equal(
    await app.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
  );
  await app.screenshot({
    path: ".test-artifacts/page-mode-mobile-settings.png",
    fullPage: true,
  });
  check(
    "Page action and direct request delays remain independently adjustable, with no redundant method selector or mobile overflow.",
  );
  assert.deepEqual(errors, []);
  await writeFile(
    `.test-artifacts/page-browser${lateScripts ? "-late" : ""}-report.json`,
    JSON.stringify({ checks, requests: requests.length }, null, 2),
  );
} catch (e) {
  if (app) {
    await app
      .screenshot({
        path: ".test-artifacts/page-mode-failure.png",
        fullPage: true,
      })
      .catch(() => {});
    console.error(
      (
        await app
          .locator("body")
          .innerText()
          .catch(() => "<app closed>")
      ).slice(-5000),
    );
    console.error(
      await app
        .evaluate(async () => ({
          runs: await window.__testing?.db.runs.toArray(),
          pending: await window.__testing?.db.pendingPageJobs.toArray(),
        }))
        .catch(() => {}),
    );
  }
  throw e;
} finally {
  await context?.close();
  await unlink("dist/page-verification.js").catch(() => {});
  await rm(profileDir, { recursive: true, force: true });
  if (lateScripts) await rm(extension, { recursive: true, force: true });
}
