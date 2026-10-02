import { chromium } from "playwright";
import { build } from "esbuild";
import { mkdtemp, rm, unlink, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
const code = "DLu_fkMszQQ";
const alphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const postId = [...code]
  .reduce((n, c) => n * 64n + BigInt(alphabet.indexOf(c)), 0n)
  .toString();
const postUrl = `https://www.instagram.com/p/${code}/`;
const user = (id) => ({
  pk_id: String(id),
  username: `fixture_person${id}`,
  full_name: `Fixture ${id}`,
});
const parent = (id, owner, extra = {}) => ({
  pk_id: id,
  id: "opaque-comment-id",
  user: user(owner),
  ...extra,
});
const metadata = {
  pk_id: postId,
  code,
  user: user("1"),
  comment_count: 4,
  edge_media_to_parent_comment: {
    edges: [{ node: parent("10", "2") }],
    page_info: { has_next_page: false },
  },
};
let scenario = "inline",
  context,
  app;
const checks = [],
  errors = [],
  requests = [];
const profileDir = await mkdtemp(join(tmpdir(), "instafinder-comments-"));
const bundle = resolve("dist/comments-verification.js");
function html() {
  const supported = scenario !== "unsupported";
  const isModal = scenario === "modal";
  return `<!doctype html><html><head><title>Comments fixture</title></head><body>
<style>body{font:16px system-ui}main{height:2300px}article{position:relative;display:flex}.media{width:400px;height:220px;overflow:auto}.media div{height:2800px}.comments{width:300px;height:180px;overflow:auto}.comment{height:130px}[role=dialog]{position:fixed;left:20px;top:20px;background:white;padding:20px}</style>
${scenario !== "late-metadata" ? `<script type="application/json">${JSON.stringify(metadata)}</script>` : ""}
<main><${isModal ? 'section role="dialog"' : "article"}><div class="media"><div>Large unrelated media scroll area</div></div><div class="side"><h2>Post</h2>${supported ? '<ul class="comments" aria-label="Comments"><li class="comment" style="height:280px"><a href="/fixture_person2/">fixture_person2</a><time datetime="2026-01-01">1d</time></li></ul>' : ""}
${["load-text", "load-icon", "late-metadata"].includes(scenario) ? (scenario === "load-icon" ? '<div role="button" id="load"><svg aria-label="Load more comments"></svg></div>' : '<button id="load">View all 4 comments</button>') : ""}
</div></${isModal ? "section" : "article"}></main>
<script>
window.documentMarker=crypto.randomUUID();window.original=[];window.replyLoads=0;window.nativePages=0;
const scenario=${JSON.stringify(scenario)},postId=${JSON.stringify(postId)};
const box=document.querySelector('.comments');let busy=false,loaded=false;
function render(rows){for(const c of rows){const li=document.createElement('li');li.className='comment';li.innerHTML='<a href="/'+c.user.username+'/">'+c.user.username+'</a><time datetime="2026-01-01">1d</time>';if(c.child_comment_count) {const button=document.createElement('button');button.id='replies';button.textContent='View replies (2)';let page=0;button.onclick=async()=>{const xhr=new XMLHttpRequest();xhr.open('GET','/api/v1/media/'+postId+'/comments/11/child_comments/'+(page?'?max_id=reply24':''));xhr.onload=()=>{const d=JSON.parse(xhr.responseText);window.original.push(d);window.replyLoads++;render(d.child_comments);if(++page===2)button.remove();else button.textContent='View more replies';};xhr.send();};li.append(button);}box.append(li);}}
async function load(){if(busy||loaded)return;busy=true;window.nativePages++;const data=await(await fetch('/api/v1/media/'+postId+'/comments/')).json();window.original.push(data);render(data.comments);loaded=true;busy=false;document.getElementById('load')?.remove();if(scenario==='late-metadata')setTimeout(()=>void fetch('/api/v1/media/'+postId+'/info/').then(r=>r.json()),700);}
if(box)box.onscroll=()=>void load();if(document.getElementById('load'))document.getElementById('load').onclick=()=>void load();
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
    requests.push(url.pathname + url.search);
    if (route.request().resourceType() === "document")
      return route.fulfill({ contentType: "text/html", body: html() });
    let body;
    if (url.pathname.endsWith("/info/")) body = { items: [metadata] };
    else if (url.pathname.endsWith("/child_comments/"))
      body = {
        child_comments: [
          parent(
            url.searchParams.has("max_id") ? "13" : "12",
            url.searchParams.has("max_id") ? "5" : "4",
          ),
        ],
        has_more_tail_child_comments: !url.searchParams.has("max_id"),
        ...(url.searchParams.has("max_id") ? {} : { next_max_id: "reply24" }),
      };
    else if (url.pathname === `/api/v1/media/${postId}/comments/`)
      body = {
        comments: [
          parent("10", "2"),
          parent("11", "3", { child_comment_count: 2 }),
        ],
        has_more_comments: false,
      };
    else
      return route.fulfill({
        status: 404,
        body: "{}",
        contentType: "application/json",
      });
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  app = await context.newPage();
  app.on("pageerror", (e) => errors.push(e.message));
  await app.goto(`chrome-extension://${id}/app.html`);
  await app.getByRole("button", { name: "Skip", exact: true }).click();
  await app.addScriptTag({
    url: `chrome-extension://${id}/comments-verification.js`,
  });
  const mission = await app.evaluate(async () => {
    const m = await window.__testing.createMission("Find Alex");
    await window.__testing.db.settings.put({
      id: "preferences",
      pageDelaySeconds: 0.5,
      delaySeconds: 5,
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
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((r) => setTimeout(r, 60));
    }
    throw new Error("Timed out: " + label);
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
  for (const kind of [
    "inline",
    "modal",
    "load-text",
    "load-icon",
    "late-metadata",
    "unsupported",
  ]) {
    scenario = kind;
    await app.evaluate(async () => {
      const api = window.__testing;
      await api.db.transaction("rw", api.db.tables, async () => {
        for (const table of api.db.tables)
          if (!["missions", "settings"].includes(table.name))
            await table.clear();
      });
    });
    const tab = await context.newPage();
    tab.on("pageerror", (e) => errors.push(e.message));
    await tab.goto(postUrl);
    const marker = await tab.evaluate(() => window.documentMarker);
    await tab.bringToFront();
    const ctx = await request({ type: "popup-context" });
    const job = await request({
      type: "popup-start",
      tabId: ctx.tabId,
      input: ctx.input,
      missionId: mission,
      mode: "commenters",
    });
    assert.ok(!job.error, job.error);
    if (kind === "unsupported") {
      await tab
        .getByText(
          "Couldn’t find the comments pane. Open all comments and expand replies manually; capture remains active.",
          { exact: true },
        )
        .waitFor();
      assert.equal(
        await tab.getByLabel("Automatic", { exact: true }).isChecked(),
        false,
      );
      assert.equal((await state(job.id)).status, "running");
      await tab
        .locator("#instafinder-collection")
        .getByRole("button", { name: "Finish with saved results", exact: true })
        .click();
      await settled(job.id);
      assert.equal((await state(job.id)).status, "partial");
      check(
        "An unsupported non-scrollable comments layout switches to manual capture, saves its preview and never claims completion.",
      );
    } else {
      await settled(job.id);
      assert.equal((await state(job.id)).status, "completed");
      const data = await app.evaluate(
        async ({ job, mission }) => ({
          comments: await window.__testing.db.comments.count(),
          results: await window.__testing.db.results
            .where("runId")
            .equals(job)
            .count(),
          follows: await window.__testing.db.follows.count(),
          candidates: await window.__testing.db.candidates
            .where("missionId")
            .equals(mission)
            .filter((c) => c.visible === 1)
            .toArray(),
        }),
        { job: job.id, mission },
      );
      assert.equal(data.comments, 4);
      assert.equal(data.results, 4);
      assert.equal(data.follows, 0);
      assert.equal(data.candidates.length, 4);
      assert.ok(data.candidates.every((c) => c.score === 1));
      assert.equal(await tab.evaluate(() => window.replyLoads), 2);
      assert.equal(await tab.evaluate(() => window.nativePages), 1);
      await tab
        .locator("#instafinder-collection")
        .getByText("Collection complete", { exact: true })
        .waitFor();
      check(
        `${kind}: a one-comment hydration preview does not end collection; four distinct authors, including two paginated replies, are captured through normal controls.`,
      );
    }
    assert.equal(await tab.evaluate(() => window.scrollY), 0);
    assert.equal(await tab.locator(".media").evaluate((el) => el.scrollTop), 0);
    assert.equal(await tab.evaluate(() => window.documentMarker), marker);
    assert.equal(tab.url(), postUrl);
    await tab.close();
  }
  assert.deepEqual(errors, []);
  assert.ok(requests.some((r) => r.endsWith("max_id=reply24")));
  await mkdir(".test-artifacts", { recursive: true });
  await writeFile(
    ".test-artifacts/comments-browser-report.json",
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
