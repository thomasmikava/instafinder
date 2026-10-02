import "fake-indexeddb/auto";
import Dexie from "dexie";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Database } from "../src/db";
import {
  applyObservation,
  createMission,
  decide,
  deleteMission,
  reuseRun,
  setSource,
} from "../src/data";
import { exportBackup, restoreBackup, validateBackup } from "../src/backup";
import { PageStore } from "../src/page-store";
import {
  normalizeNative,
  requestInfo,
  nativeRequestMatches,
  parseNative,
} from "../src/page-adapters";
import { instagramTabInput, sameInput } from "../src/popup-context";
import type { Capture, PageBinding } from "../src/page-protocol";
import type { Profile } from "../src/types";
import nativeLikers from "./fixtures/native-likers.json";
import { cleanCapture } from "../src/page-protocol";
import { shortcodeId } from "../src/instagram";
import { samePostPath } from "../src/instagram-url";
const profile = (id: string, userName = `person${id}`): Profile => ({
  id,
  userName,
  fullName: userName,
  profileUrl: `https://www.instagram.com/${userName}/`,
  avatarUrl: "",
  updatedAt: 1,
});
const source = profile("1", "source");
const post = {
  id: "64",
  ownerId: "1",
  url: "https://www.instagram.com/p/BA/",
  likeCount: 2,
};
const frame = (
  kind: Capture["kind"],
  extras: Partial<Capture> = {},
): Capture => ({
  kind,
  profiles: [],
  posts: [],
  comments: [],
  requestCursor: "",
  nextCursors: [],
  terminal: false,
  warnings: [],
  ...extras,
});
test("the supplied liker format retains ten string-ID/Unicode profiles, verifies the precise post ID and excludes private response fields", () => {
  const url = "https://www.instagram.com/p/Dd0vnaQjEhM/";
  const id = "3996028185825003596";
  assert.equal(shortcodeId("Dd0vnaQjEhM"), id);
  const binding: PageBinding = {
    jobId: "fixture",
    input: { type: "post", shortcode: "Dd0vnaQjEhM", url },
    mode: "likers",
  };
  const request = requestInfo(
    `https://www.instagram.com/api/v1/media/${id}/likers/`,
  );
  const posts = new Map<string, any>();
  assert.deepEqual(normalizeNative(request, nativeLikers, binding, posts), []);
  const deferred = cleanCapture(
    normalizeNative(request, nativeLikers, binding, posts, true)[0],
  )!;
  assert.equal(deferred.profiles.length, 10);
  assert.equal(deferred.profiles[0].id, "700000001");
  assert.equal(deferred.profiles[0].fullName, "სახელი 🌿");
  assert.equal(deferred.terminal, true);
  assert.deepEqual(deferred.nextCursors, []);
  assert.deepEqual(deferred.posts, []);
  assert.equal(deferred.source, undefined);
  assert.doesNotMatch(
    JSON.stringify(deferred),
    /friendship_status|ranking_token|PRIVATE-FIXTURE-TOKEN|strong_id__/,
  );
  assert.equal(
    nativeRequestMatches(
      requestInfo("https://www.instagram.com/api/v1/media/64/likers/"),
      binding,
    ),
    false,
  );
  let hydration: any = {
    pk_id: id,
    pk: Number(id),
    id: "opaque-relay-id",
    code: "Dd0vnaQjEhM",
    user: { pk_id: "1", username: "source" },
    like_count: 10,
  };
  for (let i = 0; i < 25; i++) hydration = { wrapper: [hydration] };
  const metadata = normalizeNative(
    requestInfo("https://www.instagram.com/graphql/query/"),
    hydration,
    binding,
    posts,
  ).find((f) => f.kind === "media-info")!;
  assert.equal(metadata.posts[0].id, id);
  assert.equal(metadata.posts[0].ownerId, "1");
  const captured = normalizeNative(request, nativeLikers, binding, posts).find(
    (f) => f.kind === "likes",
  )!;
  assert.equal(captured.profiles.length, 10);
  assert.equal(captured.posts[0].id, id);
  assert.equal(
    normalizeNative(
      request,
      { ...nativeLikers, user_count: 11 },
      binding,
      posts,
    ).find((f) => f.kind === "likes")!.terminal,
    false,
  );
  const badMetadata = {
    items: [
      {
        pk_id: "64",
        code: "Dd0vnaQjEhM",
        user: { pk: "1", username: "source" },
      },
    ],
  };
  assert.deepEqual(
    normalizeNative(
      requestInfo("https://www.instagram.com/graphql/query/"),
      badMetadata,
      binding,
    ),
    [],
  );
});
test("concurrent page saves for the same and different sources preserve mission decisions, deduplicate facts and keep receipts independent", async () => {
  const d = new Database(`parallel-${crypto.randomUUID()}`),
    a = await createMission("A", d),
    b = await createMission("B", d),
    store = new PageStore(d);
  await applyObservation(
    {
      profiles: [source, profile("2"), profile("5", "other")],
      missionIds: [a.id, b.id],
    },
    d,
  );
  await decide(a.id, "2", "possible", d);
  const jobs = await Promise.all([
    store.create("source", "following", a.id),
    store.create("source", "following", b.id),
    store.create("other", "followers", a.id),
    store.create(post.url, "likers", b.id),
  ]);
  await Promise.all(jobs.map((job) => store.begin(job.id)));
  await Promise.all([
    store.accept(
      jobs[0].id,
      frame("following", {
        source,
        targetId: "1",
        profiles: [profile("2")],
        terminal: true,
      }),
    ),
    store.accept(
      jobs[1].id,
      frame("following", {
        source,
        targetId: "1",
        profiles: [profile("2")],
        terminal: true,
      }),
    ),
    store.accept(
      jobs[2].id,
      frame("followers", {
        source: profile("5", "other"),
        targetId: "5",
        profiles: [profile("2")],
        terminal: true,
      }),
    ),
    store.accept(jobs[3].id, frame("media-info", { source, posts: [post] })),
  ]);
  await store.accept(
    jobs[3].id,
    frame("likes", {
      source,
      targetId: "64",
      posts: [post],
      profiles: [profile("2"), profile("3")],
      terminal: true,
    }),
  );
  assert.equal(await d.follows.count(), 2);
  assert.equal(await d.likes.count(), 2);
  assert.equal((await d.candidates.get([a.id, "2"]))?.score, 3);
  assert.equal((await d.candidates.get([b.id, "2"]))?.score, 2);
  assert.equal((await d.candidates.get([a.id, "2"]))?.decision, "possible");
  assert.equal((await d.candidates.get([b.id, "2"]))?.decision, "unreviewed");
  for (const job of jobs) {
    assert.equal((await d.runs.get(job.id))?.status, "completed");
    assert.equal(await d.pageReceipts.where("runId").equals(job.id).count(), 1);
  }
  await d.delete();
});
test("likers contribute once per distinct source post, independently of comments and follow direction; mission decisions remain isolated", async () => {
  const d = new Database(`likes-${crypto.randomUUID()}`),
    a = await createMission("A", d),
    b = await createMission("B", d);
  await applyObservation(
    {
      profiles: [source, profile("2")],
      posts: [
        post,
        { ...post, id: "65", url: "https://www.instagram.com/reel/BB/" },
      ],
      missionIds: [a.id, b.id],
    },
    d,
  );
  await setSource(a.id, "1", true, d);
  await decide(a.id, "2", "possible", d);
  const likes = [64, 65].map((id) => ({
    postId: String(id),
    profileId: "2",
    ownerId: "1",
    lastSeenAt: 1,
  }));
  await applyObservation(
    {
      likes: [...likes, ...likes],
      comments: [{ ...likes[0] }],
      follows: [
        { followerId: "1", followingId: "2", lastSeenAt: 1 },
        { followerId: "2", followingId: "1", lastSeenAt: 1 },
      ],
    },
    d,
  );
  assert.equal(await d.likes.count(), 2);
  assert.equal((await d.candidates.get([a.id, "2"]))!.score, 5);
  assert.equal((await d.candidates.get([a.id, "2"]))!.decision, "possible");
  assert.equal((await d.candidates.get([b.id, "2"]))!.score, 0);
  await setSource(b.id, "1", true, d);
  assert.equal((await d.candidates.get([b.id, "2"]))!.score, 5);
  assert.equal((await d.candidates.get([b.id, "2"]))!.decision, "unreviewed");
  await setSource(a.id, "1", false, d);
  assert.equal((await d.candidates.get([a.id, "2"]))!.score, 0);
  await d.delete();
});
test("post liker checkpoints resume from the beginning, deduplicate pages and observations, preserve decisions and reuse saved results", async () => {
  const d = new Database(`likes-${crypto.randomUUID()}`),
    m = await createMission("A", d),
    store = new PageStore(d);
  const job = await store.create(post.url, "likers", m.id);
  await store.begin(job.id);
  assert.equal((await store.goal(job.id)).stage, "likes");
  await store.accept(job.id, frame("media-info", { source, posts: [post] }));
  assert.equal((await d.runs.get(job.id))!.key, "post:64:likers");
  assert.equal(
    (await d.candidates.get([m.id, source.id]))!.base,
    false,
    "owner metadata remains source-only",
  );
  const first = frame("likes", {
    targetId: "64",
    posts: [post],
    profiles: [profile("2")],
    nextCursors: ["24"],
  });
  await store.accept(job.id, first);
  await decide(m.id, "2", "possible", d);
  assert.equal(
    await store.accept(
      job.id,
      frame("comments", { targetId: "64", posts: [post] }),
    ),
    false,
  );
  await store.stop(job.id);
  await store.begin(job.id);
  await store.accept(job.id, first);
  await store.accept(
    job.id,
    frame("likes", {
      targetId: "64",
      posts: [post],
      profiles: [profile("2"), profile("3")],
      requestCursor: "24",
      terminal: true,
    }),
  );
  assert.equal((await d.runs.get(job.id))!.status, "completed");
  assert.equal(await d.likes.count(), 2);
  assert.equal((await d.candidates.get([m.id, "2"]))!.score, 1);
  assert.equal((await d.candidates.get([m.id, "2"]))!.decision, "possible");
  const other = await createMission("B", d);
  await reuseRun(job.id, other.id, d);
  assert.equal((await d.candidates.get([other.id, "2"]))!.score, 1);
  assert.equal(
    (await d.candidates.get([other.id, "2"]))!.decision,
    "unreviewed",
  );
  await d.delete();
});
test("native liker normalization verifies owners, observes REST/GraphQL cursors, rejects other scopes and does not assume completion", () => {
  const binding: PageBinding = {
    jobId: "test",
    input: { type: "post", shortcode: "BA", url: post.url },
    mode: "likers",
    sourceId: "1",
    postId: "64",
  };
  const posts = new Map([[post.id, post]]);
  const req = requestInfo(
    "https://www.instagram.com/api/v1/media/64/likers/?max_id=12",
  );
  const rawUser = { pk: "2", username: "person2", full_name: "სახელი 🌿" };
  const result = normalizeNative(
    req,
    { users: [rawUser], has_more: true, next_max_id: "24" },
    binding,
    posts,
  ).find((f) => f.kind === "likes")!;
  assert.equal(result.requestCursor, "12");
  assert.deepEqual(result.nextCursors, ["24"]);
  assert.equal(result.terminal, false);
  assert.equal(result.profiles[0].fullName, "სახელი 🌿");
  assert.equal(
    normalizeNative(req, { users: [rawUser] }, binding, posts).find(
      (f) => f.kind === "likes",
    )!.terminal,
    false,
  );
  assert.equal(
    normalizeNative(
      req,
      { users: [rawUser], user_count: 1 },
      binding,
      posts,
    ).find((f) => f.kind === "likes")!.terminal,
    true,
  );
  assert.equal(
    nativeRequestMatches(req, { ...binding, mode: "commenters" }),
    false,
  );
  assert.equal(
    nativeRequestMatches(
      requestInfo("https://www.instagram.com/api/v1/media/64/comments/"),
      binding,
    ),
    false,
  );
  assert.deepEqual(
    normalizeNative(
      req,
      { users: [rawUser], has_more: false },
      binding,
      new Map(),
    ),
    [],
  );
  const gql = normalizeNative(
    requestInfo(
      "https://www.instagram.com/graphql/query/?variables=" +
        encodeURIComponent(JSON.stringify({ media_id: "64", after: "cursor" })),
    ),
    {
      data: {
        edge_liked_by: {
          edges: [{ node: rawUser }],
          page_info: { has_next_page: false },
        },
      },
    },
    binding,
    posts,
  ).find((f) => f.kind === "likes")!;
  assert.equal(gql.requestCursor, "after:cursor");
  assert.equal(gql.terminal, true);
  assert.equal(gql.profiles[0].id, "2");
});
test("profile liker traversal requires feed, reels and every post; count shortfalls remain partial", async () => {
  const d = new Database(`likes-${crypto.randomUUID()}`),
    m = await createMission("A", d),
    store = new PageStore(d);
  const job = await store.create("source", "likers", m.id);
  await store.begin(job.id);
  await store.accept(
    job.id,
    frame("feed", { source, targetId: "1", posts: [post], terminal: true }),
  );
  assert.equal((await store.goal(job.id)).channel, "reels");
  await store.accept(
    job.id,
    frame("reels", {
      source,
      targetId: "1",
      posts: [
        {
          ...post,
          id: "65",
          url: "https://www.instagram.com/reel/BB/",
          likeCount: 0,
        },
      ],
      terminal: true,
    }),
  );
  assert.equal((await store.goal(job.id)).stage, "likes");
  await store.accept(
    job.id,
    frame("likes", {
      targetId: "64",
      posts: [post],
      profiles: [profile("2")],
      terminal: true,
    }),
  );
  assert.equal((await d.runs.get(job.id))!.status, "partial");
  assert.match((await d.runs.get(job.id))!.reason!, /fewer likers/);
  await d.delete();
});
test("post likers ignore unavailable items in unrelated profile feed/reel connections and complete the selected post", async () => {
  const d = new Database(`post-scope-${crypto.randomUUID()}`),
    m = await createMission("A", d),
    store = new PageStore(d);
  await applyObservation(
    { profiles: [source], posts: [{ ...post, likeCount: 10 }] },
    d,
  );
  const job = await store.create(post.url, "likers", m.id);
  await store.begin(job.id);
  await store.identifySaved(job.id);
  const binding = await store.binding(job.id);
  const known = new Map([[post.id, { ...post, likeCount: 10 }]]);
  const raw = {
    data: {
      user: {
        pk: "1",
        username: "source",
        edge_owner_to_timeline_media: {
          edges: [
            {
              node: {
                id: "opaque-relay-id",
                shortcode: "BB",
                owner: { pk: "1", username: "source" },
              },
            },
          ],
          page_info: { has_next_page: false },
        },
      },
    },
  };
  const metadata = normalizeNative(
    requestInfo("https://www.instagram.com/graphql/query/"),
    raw,
    binding,
    known,
  );
  assert.equal(
    metadata.some((f) => f.kind === "feed" || f.kind === "reels"),
    false,
  );
  for (const value of metadata) await store.accept(job.id, value);
  for (const kind of ["feed", "reels"] as const) {
    assert.equal(
      await store.accept(
        job.id,
        frame(kind, {
          source,
          targetId: "1",
          terminal: true,
          warnings: [
            "Some collection items were unavailable. Saved results are partial.",
          ],
        }),
      ),
      false,
    );
  }
  await store.accept(
    job.id,
    normalizeNative(
      requestInfo("https://www.instagram.com/api/v1/media/64/likers/"),
      nativeLikers,
      binding,
      known,
    ).find((f) => f.kind === "likes")!,
  );
  assert.equal((await d.runs.get(job.id))!.status, "completed");
  assert.deepEqual((await d.runs.get(job.id))!.warnings, []);
  assert.equal(await d.results.where("runId").equals(job.id).count(), 10);
  assert.equal(await d.pageReceipts.where("runId").equals(job.id).count(), 1);
  // An actual profile traversal still has to account for its unavailable feed items.
  const profileJob = await store.create("source", "likers", m.id);
  await store.begin(profileJob.id);
  const profileFrames = normalizeNative(
    requestInfo("https://www.instagram.com/graphql/query/"),
    raw,
    await store.binding(profileJob.id),
  );
  const feed = profileFrames.find((f) => f.kind === "feed")!;
  assert.ok(feed.warnings.length);
  assert.equal(await store.accept(profileJob.id, feed), true);
  assert.ok((await d.runs.get(profileJob.id))!.warnings!.length);
  // Missing profiles in the requested liker list must still be reported.
  const incomplete = await store.create(post.url, "likers", m.id);
  await store.begin(incomplete.id);
  await store.identifySaved(incomplete.id);
  const missingLiker = normalizeNative(
    requestInfo("https://www.instagram.com/api/v1/media/64/likers/"),
    {
      users: [nativeLikers.users[0], { username: "unavailable_liker" }],
      has_more: false,
    },
    await store.binding(incomplete.id),
    known,
  ).find((f) => f.kind === "likes")!;
  await store.accept(incomplete.id, missingLiker);
  assert.equal((await d.runs.get(incomplete.id))!.status, "partial");
  assert.ok(
    (await d.runs.get(incomplete.id))!.warnings!.includes(
      "Some liker profiles were unavailable.",
    ),
  );
  await d.delete();
});
test("version-three backups retain likes and ranking, read both legacy versions, and deletion removes like facts", async () => {
  const d = new Database(`likes-${crypto.randomUUID()}`),
    m = await createMission("A", d);
  await applyObservation(
    {
      profiles: [source, profile("2")],
      posts: [post],
      likes: [{ postId: "64", ownerId: "1", profileId: "2", lastSeenAt: 1 }],
      missionIds: [m.id],
    },
    d,
  );
  await setSource(m.id, "1", true, d);
  const backup = await exportBackup(d);
  assert.equal(backup.version, 3);
  const restored = new Database(`restore-${crypto.randomUUID()}`);
  await restoreBackup(backup, restored);
  assert.equal(await restored.likes.count(), 1);
  assert.equal((await restored.candidates.get([m.id, "2"]))!.score, 1);
  const invalid = structuredClone(backup);
  invalid.tables.likes[0].ownerId = "999";
  assert.throws(() => validateBackup(invalid), /reference/);
  for (const version of [1, 2] as const) {
    const legacy = structuredClone(backup);
    legacy.version = version;
    delete legacy.tables.likes;
    await restoreBackup(legacy, restored);
    assert.equal(await restored.likes.count(), 0);
    assert.equal((await restored.candidates.get([m.id, "2"]))!.score, 0);
  }
  await deleteMission(m.id, d, true);
  assert.equal(await d.likes.count(), 0);
  await d.delete();
  await restored.delete();
});
test("toolbar context recognizes current profile lists/reels and post dialogs, rejects feed/login and unrelated tabs", () => {
  assert.deepEqual(
    instagramTabInput("https://www.instagram.com/source/followers/"),
    { type: "profile", username: "source" },
  );
  assert.deepEqual(
    instagramTabInput("https://www.instagram.com/source/reels/"),
    { type: "profile", username: "source" },
  );
  assert.ok(
    sameInput(
      instagramTabInput(post.url)!,
      instagramTabInput("https://www.instagram.com/p/BA/liked_by/")!,
    ),
  );
  for (const path of [
    "/beerrestaurant.cz/p/Dd0vnaQjEhM/",
    "/beerrestaurant.cz/reel/Dd0vnaQjEhM/",
    "/beerrestaurant.cz/p/Dd0vnaQjEhM/liked_by/",
  ]) {
    const input = instagramTabInput(
      `https://www.instagram.com${path}?igsh=fixture#marker`,
    )!;
    assert.equal(input.type, "post");
    assert.ok(
      sameInput(
        input,
        instagramTabInput("https://www.instagram.com/p/Dd0vnaQjEhM/")!,
      ),
    );
    assert.ok(samePostPath(path, "/p/Dd0vnaQjEhM/"));
  }
  assert.equal(
    samePostPath("/beerrestaurant.cz/p/Dd0vnaQjEhM/", "/p/Dd0vnaQjEhMa/"),
    false,
  );
  assert.equal(samePostPath("/beerrestaurant.cz/", "/p/Dd0vnaQjEhM/"), false);
  assert.equal(
    samePostPath("/accounts/p/Dd0vnaQjEhM/", "/p/Dd0vnaQjEhM/"),
    false,
  );
  for (const url of [
    "https://www.instagram.com/",
    "https://www.instagram.com/accounts/login/",
    "https://example.test/source/",
    "https://www.instagram.com/explore/",
  ])
    assert.equal(instagramTabInput(url), undefined);
});

test("likers resolve a pending post from lossless native media info before any source ID is known", async () => {
  const d = new Database(`startup-${crypto.randomUUID()}`),
    m = await createMission("A", d),
    store = new PageStore(d);
  const job = await store.create(post.url, "likers", m.id);
  await store.begin(job.id);
  const binding = await store.binding(job.id);
  const frames = normalizeNative(
    requestInfo("https://www.instagram.com/api/v1/media/64/info/"),
    parseNative(
      JSON.stringify({
        items: [
          {
            pk: "64",
            code: "BA",
            user: { pk: "1", username: "source" },
            like_count: 2,
          },
        ],
      }),
    ),
    binding,
  );
  for (const item of frames) await store.accept(job.id, item);
  assert.equal((await store.binding(job.id)).sourceId, "1");
  assert.equal((await store.goal(job.id)).stage, "likes");
  assert.equal(await d.pendingPageJobs.count(), 0);
  assert.equal(await d.sources.count(), 1);
  assert.equal((await d.candidates.get([m.id, source.id]))!.base, false);
  assert.equal((await d.candidates.get([m.id, source.id]))!.visible, 0);
  await d.delete();
});
test("existing version-two page jobs, receipts and decisions survive the liker-store migration", async () => {
  const name = `migration-likes-${crypto.randomUUID()}`;
  const reference = new Database(name);
  const schema = Object.fromEntries(
    reference.tables
      .filter((t) => t.name !== "likes")
      .map((t) => [
        t.name,
        [t.schema.primKey.src, ...t.schema.indexes.map((i) => i.src)].join(","),
      ]),
  );
  reference.close();
  const old = new Dexie(name);
  old.version(2).stores(schema);
  await old.table("profiles").put(source);
  await old.table("candidates").put({
    missionId: "m",
    profileId: "1",
    decision: "possible",
    score: 0,
    sortScore: 0,
    visible: 1,
    addedAt: 1,
    base: 1,
  });
  await old.table("pendingPageJobs").put({
    id: "job",
    missionId: "m",
    input: { type: "profile", username: "source" },
    mode: "followers",
    status: "paused",
    automatic: true,
    createdAt: 1,
    updatedAt: 1,
  });
  await old.table("pageReceipts").put({
    id: "receipt",
    runId: "job",
    epoch: "epoch",
    kind: "followers",
    targetId: "1",
    requestCursor: "",
    nextCursors: [],
    terminal: true,
  });
  old.close();
  const upgraded = new Database(name);
  assert.equal(await upgraded.likes.count(), 0);
  assert.equal(
    (await upgraded.candidates.get(["m", "1"]))!.decision,
    "possible",
  );
  assert.equal(await upgraded.pendingPageJobs.count(), 1);
  assert.equal(await upgraded.pageReceipts.count(), 1);
  await upgraded.delete();
});

test("in-place resume retains the traversal epoch and earlier receipts while collecting later pages", async () => {
  const d = new Database(`continue-${crypto.randomUUID()}`),
    m = await createMission("A", d),
    store = new PageStore(d);
  const job = await store.create("source", "following", m.id);
  await store.begin(job.id);
  await store.accept(
    job.id,
    frame("following", {
      source,
      targetId: "1",
      profiles: [profile("2")],
      nextCursors: ["24"],
    }),
  );
  await decide(m.id, "2", "possible", d);
  const epoch = (await d.runs.get(job.id))!.pageEpoch;
  await store.stop(job.id);
  await store.begin(job.id, true);
  assert.equal((await d.runs.get(job.id))!.pageEpoch, epoch);
  await store.accept(
    job.id,
    frame("following", {
      source,
      targetId: "1",
      profiles: [profile("3")],
      requestCursor: "24",
      terminal: true,
    }),
  );
  assert.equal((await d.runs.get(job.id))!.status, "completed");
  assert.equal(await d.pageReceipts.count(), 2);
  assert.equal(await d.follows.count(), 2);
  assert.equal((await d.candidates.get([m.id, "2"]))!.decision, "possible");
  await d.delete();
});
test("a cached username cannot override the source ID observed in a native follow list", async () => {
  const d = new Database(`known-${crypto.randomUUID()}`),
    m = await createMission("A", d),
    store = new PageStore(d);
  await applyObservation({ profiles: [source] }, d);
  const job = await store.create("source", "followers", m.id);
  await store.begin(job.id);
  await store.identifySaved(job.id);
  assert.equal((await store.binding(job.id)).sourceId, undefined);
  const current = profile("99", "source");
  await store.accept(
    job.id,
    frame("followers", {
      source: current,
      targetId: "99",
      profiles: [profile("2")],
      terminal: true,
    }),
  );
  assert.equal((await store.binding(job.id)).sourceId, "99");
  assert.equal((await d.follows.toArray())[0].followingId, "99");
  assert.equal((await d.candidates.get([m.id, "99"]))!.base, false);
  await d.delete();
});
