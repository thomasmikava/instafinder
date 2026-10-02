import { chromium } from "playwright";
import { build } from "esbuild";
import {
  readFile,
  writeFile,
  mkdir,
  mkdtemp,
  rm,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";

// Marketing assets only. All accounts, relationships and decisions are fictitious.
// This uses the built extension in an isolated profile, never a personal login.
const destination = resolve("store/assets");
const reviewCardPath = resolve(".test-artifacts/store-review-card.png");
const portrait = await readFile("store/demo/alex.png");
const icon = await readFile("public/icons/128.png");
const dataUri = (buffer, type = "image/png") =>
  `data:${type};base64,${buffer.toString("base64")}`;
const profileDir = await mkdtemp(join(tmpdir(), "instafinder-store-"));
const harness = resolve("dist/store-verification.js");
let context;
await mkdir(destination, { recursive: true });
await mkdir(".test-artifacts", { recursive: true });
const avatar = (index) => {
  const palettes = [
    ["#d8e4de", "#b57d57", "#302b28", "#617d6a"],
    ["#e8ded8", "#e5b393", "#60392c", "#b56e56"],
    ["#dbe3ed", "#d6a178", "#292d37", "#567a9b"],
    ["#e8e1d3", "#edc7aa", "#684a32", "#817a58"],
  ];
  const [bg, skin, hair, shirt] = palettes[index % palettes.length];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><rect width="128" height="128" fill="${bg}"/><path d="M15 128v-17c0-28 24-42 49-42s49 14 49 42v17" fill="${shirt}"/><path d="M54 64h20v24H54" fill="${skin}"/><ellipse cx="64" cy="47" rx="24" ry="30" fill="${skin}"/><path d="M39 45V31c2-28 49-29 51 1v16L76 29 39 43" fill="${hair}"/><path d="M56 61q8 6 16 0" fill="none" stroke="#9e6550" stroke-width="2"/><circle cx="54" cy="48" r="2" fill="#40322a"/><circle cx="74" cy="48" r="2" fill="#40322a"/></svg>`;
};
try {
  await build({
    entryPoints: ["tests/browser-harness.ts"],
    bundle: true,
    format: "iife",
    outfile: harness,
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
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
  });
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const id = new URL(worker.url()).host;
  const avatarBuffers = new Map();
  const drawing = await context.newPage();
  await drawing.setViewportSize({ width: 128, height: 128 });
  for (let index = 0; index < 10; index++) {
    await drawing.setContent(`<style>body{margin:0}</style>${avatar(index)}`);
    avatarBuffers.set(index, await drawing.screenshot({ type: "png" }));
  }
  await drawing.close();
  await context.route(/^https:\/\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "scontent-demo.cdninstagram.com") {
      if (url.pathname === "/alex.png")
        return route.fulfill({
          contentType: "image/png",
          body: portrait,
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      const index = Number(url.pathname.match(/\d+/)?.[0] || 0);
      return route.fulfill({
        contentType: "image/png",
        body: avatarBuffers.get(index),
      });
    }
    // No Instagram, CDN or other internet request may leave this demo profile.
    await route.abort();
  });
  const app = await context.newPage();
  const errors = [];
  app.on("pageerror", (error) => errors.push(error.message));
  await app.goto(`chrome-extension://${id}/app.html`);
  await app.getByRole("button", { name: "Skip", exact: true }).click();
  await app.addScriptTag({
    url: `chrome-extension://${id}/store-verification.js`,
  });
  await app.evaluate(async () => {
    const { db, createMission, applyObservation, setSource } = window.__testing;
    const mission = await createMission("Find Alex from Friday’s event");
    await createMission("Person I met at the meetup");
    const now = Date.now();
    const candidates = [
      ["Alex Rivera", "demo_alex_rivera", "unreviewed"],
      ["Maya Brooks", "demo_maya_brooks", "possible"],
      ["Jordan Lee", "demo_jordan_lee", "no"],
      ["Sam Ellis", "demo_sam_ellis", "possible"],
      ["Riley Chen", "demo_riley_chen", "unreviewed"],
      ["Taylor Reed", "demo_taylor_reed", "unlikely"],
      ["Casey Blake", "demo_casey_blake", "no"],
      ["Robin Hayes", "demo_robin_hayes", "possible"],
    ];
    const profiles = candidates.map(([fullName, userName], i) => ({
      id: String(700000001 + i),
      userName,
      fullName,
      profileUrl: `https://www.instagram.com/${userName}/`,
      avatarUrl: `https://scontent-demo.cdninstagram.com/${i === 0 ? "alex.png" : `person${i}.svg`}`,
      updatedAt: now,
    }));
    const sources = [
      ["700000100", "demo_friday_venue", "Friday Venue"],
      ["700000101", "demo_event_host", "Event Host"],
    ].map(([id, userName, fullName], i) => ({
      id,
      userName,
      fullName,
      profileUrl: `https://www.instagram.com/${userName}/`,
      avatarUrl: `https://scontent-demo.cdninstagram.com/source${i}.svg`,
      updatedAt: now,
    }));
    const follow = (followerId, followingId) => ({
      followerId,
      followingId,
      lastSeenAt: now,
    });
    const posts = ["700000200", "700000201"].map((id, i) => ({
      id,
      ownerId: sources[0].id,
      url: `https://www.instagram.com/p/DEMOP0${i}/`,
    }));
    const link = (profileId, i = 0) => ({
      profileId,
      postId: posts[i].id,
      ownerId: sources[0].id,
      lastSeenAt: now,
    });
    await applyObservation({
      profiles: [...profiles, ...sources],
      missionIds: [mission.id],
      posts,
      follows: [
        follow(profiles[0].id, sources[0].id),
        follow(sources[0].id, profiles[0].id),
        follow(profiles[0].id, sources[1].id),
        ...profiles.slice(1, 8).map((p) => follow(p.id, sources[0].id)),
        follow(sources[1].id, profiles[1].id),
        follow(sources[1].id, profiles[4].id),
      ],
      comments: [
        link(profiles[0].id, 1),
        link(profiles[1].id),
        link(profiles[2].id),
        link(profiles[3].id),
        link(profiles[4].id),
      ],
      likes: [link(profiles[0].id), link(profiles[7].id)],
    });
    for (const source of sources) await setSource(mission.id, source.id, true);
    for (const [i, [, , decision]] of candidates.entries())
      if (decision !== "unreviewed")
        await db.candidates.update([mission.id, profiles[i].id], {
          decision,
          decisionAt: now,
        });
    localStorage.setItem("selectedMission", mission.id);
    localStorage.setItem("instafinderIntroSeen", "1");
  });
  await app.reload();
  await app.evaluate(
    () =>
      new Promise((resolve, reject) => {
        chrome.tabs.getCurrent((tab) => {
          chrome.tabs.setZoom(tab.id, 0.85, () => {
            if (chrome.runtime.lastError)
              reject(new Error(chrome.runtime.lastError.message));
            else resolve();
          });
        });
      }),
  );
  await app
    .getByRole("heading", { name: "Alex Rivera", exact: true })
    .waitFor();
  await app.locator(".avatar-large img").evaluate(async (img) => {
    await img.decode();
  });
  await app.evaluate(() => document.fonts.ready);
  await app.screenshot({
    path: join(destination, "screenshot-01-review-1280x800.png"),
  });
  const card = await app.locator(".review-card").boundingBox();
  await app.screenshot({
    path: reviewCardPath,
    clip: {
      x: card.x * 0.85,
      y: card.y * 0.85,
      width: card.width * 0.85,
      height: card.height * 0.85,
    },
  });
  const decision = await app
    .getByRole("button", { name: /Possible match/ })
    .boundingBox();
  assert.ok(
    (decision.y + decision.height) * 0.85 <= 800,
    "Review actions must be visible",
  );
  await app.getByRole("tab", { name: /Candidates/ }).click();
  await app.getByText("Maya Brooks", { exact: true }).waitFor();
  await app.locator(".list-panel tbody img").evaluateAll(async (images) => {
    await Promise.all(images.map((img) => img.decode()));
  });
  await app.screenshot({
    path: join(destination, "screenshot-02-candidates-1280x800.png"),
  });
  await app
    .getByLabel("Filter candidates", { exact: true })
    .selectOption("possible");
  await app.getByText("3 people", { exact: true }).waitFor();
  await app.screenshot({
    path: join(destination, "screenshot-03-matches-1280x800.png"),
  });
  await app.locator(".sources-panel summary").click();
  await app.getByText("@demo_friday_venue", { exact: true }).waitFor();
  await app.locator(".source-row img").first().waitFor();
  await app.locator(".source-row img").evaluateAll(async (images) => {
    await Promise.all(images.map((img) => img.decode()));
  });
  await app.screenshot({
    path: join(destination, "screenshot-04-sources-1280x800.png"),
  });
  assert.deepEqual(errors, []);

  const review = dataUri(await readFile(reviewCardPath));
  const brand = dataUri(icon);
  const photo = dataUri(portrait);
  const promo = await context.newPage();
  for (const [width, height, name] of [
    [440, 280, "promo-small-440x280.png"],
    [1400, 560, "promo-marquee-1400x560.png"],
  ]) {
    const large = width > 500;
    await promo.setViewportSize({ width, height });
    await promo.setContent(`<!doctype html><html><head><style>
*{box-sizing:border-box}body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:#123d32;color:#f4f6e9;font-family:Arial,sans-serif}
.glow{position:absolute;width:680px;height:680px;border-radius:50%;background:radial-gradient(circle,#2d6c55 0%,#153f3400 66%);right:-160px;top:-200px}
.orbit{position:absolute;right:${large ? "50px" : "-115px"};top:${large ? "-20px" : "-138px"};width:${large ? "625px" : "430px"};height:${large ? "625px" : "430px"};border:1px solid #aed3b327;border-radius:50%}.orbit:after{content:'';position:absolute;inset:45px;border:1px solid #aed3b327;border-radius:50%}
.brand{position:absolute;display:flex;align-items:center;gap:${large ? 14 : 9}px;left:${large ? 74 : 24}px;top:${large ? 55 : 24}px;font-size:${large ? 29 : 24}px;font-weight:700;letter-spacing:-.8px}.brand img{width:${large ? 48 : 38}px;height:${large ? 48 : 38}px}
h1{position:absolute;left:76px;top:138px;font-size:68px;line-height:1.06;font-weight:600;letter-spacing:-3.8px;margin:0;width:600px}.sub{position:absolute;left:78px;top:316px;font-size:22px;line-height:1.5;color:#c2d6c6;max-width:470px}.pill{position:absolute;left:78px;bottom:65px;padding:13px 20px;border-radius:50px;color:#e6edcf;border:1px solid #7fa78980;font-size:15px;letter-spacing:.2px}
.card{position:absolute;right:${large ? "181px" : "65px"};top:${large ? "43px" : "81px"};width:${large ? "315px" : "100px"};border-radius:${large ? "20px" : "13px"};box-shadow:0 28px 60px #001a2066;transform:rotate(5deg);overflow:hidden;border:1px solid #dce9d76e;background:#f6f8ef}
.card img{width:100%;display:block}.mini{position:absolute;background:#e9efd9;border-radius:12px;width:93px;height:102px;top:128px;right:187px;transform:rotate(-12deg);padding:11px;box-shadow:0 12px 24px #001b2855}.mini .person{width:41px;height:41px;border-radius:50%;background:#96b59d;margin:0 auto 11px;position:relative;overflow:hidden}.mini .person:before{content:'';position:absolute;background:#d9ad89;width:18px;height:21px;border-radius:50%;top:7px;left:12px}.mini .person:after{content:'';position:absolute;background:#3c6c55;width:34px;height:30px;border-radius:50%;top:25px;left:4px}.line{height:5px;border-radius:9px;background:#b8c8a5;width:62px;margin:6px auto}.line.short{width:38px}
.check{position:absolute;right:${large ? "130px" : "43px"};top:${large ? "340px" : "190px"};width:${large ? "83px" : "41px"};height:${large ? "83px" : "41px"};border:5px solid #143f34;border-radius:50%;background:#cfe5ae;display:grid;place-items:center;color:#1d5438;font-weight:500;font-size:${large ? "45px" : "24px"};box-shadow:0 6px 24px #071f2755}
.dot{position:absolute;right:${large ? "75px" : "30px"};top:${large ? "112px" : "130px"};width:${large ? "15px" : "9px"};height:${large ? "15px" : "9px"};border-radius:50%;background:#cce4b0}.caption{position:absolute;left:27px;bottom:23px;font-size:13px;color:#d8e3ca}
</style></head><body><div class="glow"></div><div class="orbit"></div><div class="dot"></div><div class="brand"><img src="${brand}" alt="">InstaFinder</div>${large ? '<h1>Find someone<br>on Instagram.</h1><div class="sub">Collect connected profiles.<br>Review one person at a time.</div><div class="pill">Your search. Your browser.</div>' : '<div class="mini"><div class="person"></div><div class="line"></div><div class="line short"></div></div><div class="caption">Find someone on Instagram.</div>'}<div class="card"><img src="${large ? review : photo}" alt=""></div><div class="check">✓</div></body></html>`);
    await promo.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all([...document.images].map((img) => img.decode()));
    });
    await promo.screenshot({ path: join(destination, name) });
  }
  await writeFile(
    join(destination, "validation.json"),
    JSON.stringify(
      {
        screenshots:
          "Production extension, isolated Chromium profile, 85% Chrome zoom, 1280×800; all accounts and relationships are fictitious.",
        portrait:
          "Fictional image generated with the built-in image generation tool.",
        icon: "Same 128px PNG icon as the uploaded extension package.",
        promotions:
          "Existing icon and real review card rendered through code-native HTML/CSS branding artwork.",
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    "Created four real extension screenshots, two promotional images and the matching icon.",
  );
} finally {
  await context?.close();
  await unlink(harness).catch(() => {});
  await rm(profileDir, { recursive: true, force: true });
}
