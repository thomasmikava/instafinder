import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import Dexie from "dexie";
import { Database, preferences } from "../src/db";
import { createMission, decide, deleteMission, reuseRun } from "../src/data";
import { exportBackup, restoreBackup, validateBackup } from "../src/backup";
import { PageStore, covered } from "../src/page-store";
import {
  cleanCapture,
  type Capture,
  type PageBinding,
} from "../src/page-protocol";
import {
  nativeFailure,
  nativeRequestMatches,
  normalizeNative,
  parseNative,
  requestInfo,
} from "../src/page-adapters";
import { Runner } from "../src/runner";
import type { Mode, PageReceipt, Profile } from "../src/types";
const user = (id: string, name = `user${id}`) => ({
  pk: id,
  username: name,
  full_name: `Person ${id}`,
  profile_pic_url: "https://images.example.test/photo.jpg",
});
const profile = (id: string, name = `user${id}`): Profile => ({
  id,
  userName: name,
  fullName: name,
  profileUrl: `https://www.instagram.com/${name}/`,
  avatarUrl: "",
  updatedAt: 1,
});
const binding: PageBinding = {
  jobId: "test",
  input: { type: "profile", username: "source" },
  mode: "following",
};
const empty = (kind: Capture["kind"]): Capture => ({
  kind,
  profiles: [],
  posts: [],
  comments: [],
  requestCursor: "",
  nextCursors: [],
  terminal: false,
  warnings: [],
});
const follow = (
  kind: "followers" | "following",
  ids: string[],
  requestCursor = "",
  next?: string,
): Capture => ({
  ...empty(kind),
  source: profile("173560420", "source"),
  targetId: "173560420",
  profiles: ids.map((id) => profile(id)),
  requestCursor,
  nextCursors: next ? [next] : [],
  terminal: !next,
});
async function setup(mode: Mode = "following", value = "source") {
  const d = new Database(`page-${crypto.randomUUID()}`),
    m = await createMission("Page mission", d),
    store = new PageStore(d);
  const job = await store.create(value, mode, m.id);
  await store.begin(job.id);
  return { d, m, store, job };
}
test("native 12-account fixture retains IDs and Unicode, reads observed cursors, excludes tokens and fbid_v2", () => {
  const raw = {
    users: Array.from({ length: 12 }, (_, i) => ({
      ...user(String(9975754562n + BigInt(i))),
      fbid_v2: "17841409916876969",
      full_name: i === 0 ? "გიორგი 🌿" : "Test",
    })),
    page_size: 12,
    next_max_id: "24",
    has_more: true,
    follow_ranking_token: "DO-NOT-STORE",
    status: "ok",
  };
  const [frame] = normalizeNative(
    requestInfo(
      "https://www.instagram.com/api/v1/friendships/173560420/following/?count=12&max_id=12",
    ),
    raw,
    binding,
  );
  assert.equal(frame.profiles.length, 12);
  assert.equal(frame.profiles[0].id, "9975754562");
  assert.equal(frame.profiles[0].fullName, "გიორგი 🌿");
  assert.equal(frame.requestCursor, "12");
  assert.deepEqual(frame.nextCursors, ["24"]);
  assert.equal(frame.terminal, false);
  assert.ok(!JSON.stringify(frame).includes("DO-NOT-STORE"));
  assert.ok(!JSON.stringify(frame).includes("fbid_v2"));
  const noCursor = normalizeNative(
    requestInfo(
      "https://www.instagram.com/api/v1/friendships/173560420/following/?count=12",
    ),
    { ...raw, next_max_id: null },
    binding,
  )[0];
  assert.deepEqual(noCursor.nextCursors, []);
  assert.equal(noCursor.terminal, false);
  assert.equal(
    parseNative('{"pk":99999999999999999999}').pk.toString(),
    "99999999999999999999",
  );
});
test("wrong follow list is rejected before source identification and cannot add candidates or cooldowns", async () => {
  for (const mode of ["followers", "following"] as const) {
    const other = mode === "followers" ? "following" : "followers";
    const { d, m, store, job } = await setup(mode);
    const requested = { ...binding, mode };
    const wrongRequest = requestInfo(
      `https://www.instagram.com/api/v1/friendships/173560420/${other}/`,
    );
    assert.equal(nativeRequestMatches(wrongRequest, requested), false);
    assert.equal(
      normalizeNative(
        wrongRequest,
        { users: [user("2")], has_more: false },
        requested,
      ).length,
      0,
    );
    assert.equal(await store.accept(job.id, follow(other, ["2"])), false);
    assert.equal(await d.runs.count(), 0);
    assert.equal(await d.profiles.count(), 0);
    assert.equal(await d.sources.count(), 0);
    assert.equal((await d.pendingPageJobs.get(job.id))!.status, "running");
    await store.accept(job.id, follow(mode, ["3"], "", "12"));
    assert.equal(await store.accept(job.id, follow(other, ["2"])), false);
    assert.equal(await d.results.count(), 1);
    assert.equal(await d.pageReceipts.count(), 1);
    assert.equal(await d.candidates.get([m.id, "2"]), undefined);
    const facts = await d.follows.toArray();
    assert.equal(facts.length, 1);
    assert.deepEqual(
      [facts[0].followerId, facts[0].followingId],
      mode === "followers" ? ["3", "173560420"] : ["173560420", "3"],
    );
    await d.delete();
  }
});
test("pending job becomes source/run with first page atomically; resume retraverses, deduplicates and preserves decisions", async () => {
  const { d, m, store, job } = await setup();
  assert.equal(await d.runs.count(), 0);
  await store.accept(job.id, follow("following", ["2", "3"], "", "12"));
  assert.equal(await d.pendingPageJobs.count(), 0);
  assert.ok(await d.sources.get([m.id, "173560420"]));
  assert.equal((await d.runs.get(job.id))!.method, "page");
  await decide(m.id, "2", "possible", d);
  await store.stop(job.id);
  await store.begin(job.id);
  await store.accept(job.id, follow("following", ["2", "3"], "", "12"));
  assert.equal((await d.runs.get(job.id))!.status, "running");
  await store.accept(job.id, follow("following", ["3", "4"], "12"));
  assert.equal((await d.runs.get(job.id))!.status, "completed");
  assert.equal(await d.follows.count(), 3);
  assert.equal(await d.results.count(), 3);
  assert.equal((await d.candidates.get([m.id, "2"]))!.decision, "possible");
  assert.equal((await d.candidates.get([m.id, "2"]))!.score, 1);
  const other = await createMission("Other", d);
  await reuseRun(job.id, other.id, d);
  assert.equal(
    (await d.candidates.get([other.id, "2"]))!.decision,
    "unreviewed",
  );
  await d.delete();
});
test("out-of-order pages need initial coverage; mutual lists use two directional points", async () => {
  const { d, m, store, job } = await setup("both");
  await store.accept(job.id, follow("followers", ["2"], "12"));
  assert.equal((await d.runs.get(job.id))!.checkpoint.stage, "followers");
  await store.accept(job.id, follow("followers", ["2"], "", "12"));
  assert.equal((await d.runs.get(job.id))!.checkpoint.stage, "following");
  await store.accept(job.id, follow("following", ["2"]));
  assert.equal((await d.runs.get(job.id))!.status, "completed");
  assert.equal((await d.candidates.get([m.id, "2"]))!.score, 2);
  await d.delete();
});
test("repeated cursor and hidden/restricted data never become complete", async () => {
  const { d, store, job } = await setup();
  await store.accept(job.id, follow("following", ["2"], "", ""));
  // A separate job explicitly repeats a non-empty cursor.
  const second = await store.create("source", "following", job.missionId);
  await store.begin(second.id);
  await store.accept(second.id, follow("following", ["2"], "", "12"));
  await store.accept(second.id, follow("following", ["3"], "12", "12"));
  assert.equal((await d.runs.get(second.id))!.status, "partial");
  const frame = normalizeNative(
    requestInfo(
      "https://www.instagram.com/api/v1/friendships/173560420/following/",
    ),
    { users: [], has_more: false, hidden_following_account_count: 4 },
    binding,
  )[0];
  assert.ok(frame.restriction);
  await d.delete();
});
test("post commenters and paginated replies deduplicate authors, require all branches and never imply follows", async () => {
  const { d, m, store, job } = await setup(
    "commenters",
    "https://www.instagram.com/p/BA/",
  );
  const post = {
    id: "64",
    ownerId: "173560420",
    url: "https://www.instagram.com/p/BA/",
    commentCount: 4,
  };
  await store.accept(job.id, {
    ...empty("media-info"),
    source: profile("173560420", "source"),
    posts: [post],
  });
  const parent = {
    id: "10",
    profile: profile("2"),
    replyCount: 2,
    replies: [{ id: "11", profile: profile("3"), replyCount: 0, replies: [] }],
  };
  await store.accept(job.id, {
    ...empty("comments"),
    targetId: "64",
    posts: [post],
    comments: [parent],
    nextCursors: ["max:tail", "min:head"],
  });
  await store.accept(job.id, {
    ...empty("comments"),
    targetId: "64",
    posts: [post],
    requestCursor: "max:tail",
    terminal: true,
  });
  assert.equal((await d.runs.get(job.id))!.status, "running");
  await store.accept(job.id, {
    ...empty("replies"),
    targetId: "64",
    parentId: "10",
    posts: [post],
    comments: [{ id: "12", profile: profile("3"), replyCount: 0, replies: [] }],
    terminal: true,
  });
  await store.accept(job.id, {
    ...empty("comments"),
    targetId: "64",
    posts: [post],
    requestCursor: "min:head",
    comments: [{ id: "13", profile: profile("2"), replyCount: 0, replies: [] }],
    terminal: true,
  });
  assert.equal((await d.runs.get(job.id))!.status, "completed");
  assert.equal(await d.comments.count(), 2);
  assert.equal(await d.follows.count(), 0);
  assert.equal((await d.candidates.get([m.id, "2"]))!.score, 1);
  assert.equal((await d.threads.toArray())[0].fetchedCount, 2);
  await d.delete();
});
test("profile commenters traverse feed/reels and score per distinct post", async () => {
  const { d, m, store, job } = await setup("commenters");
  const source = profile("173560420", "source");
  const posts = [
    { id: "64", ownerId: source.id, url: "https://www.instagram.com/p/BA/" },
    { id: "65", ownerId: source.id, url: "https://www.instagram.com/reel/BB/" },
  ];
  await store.accept(job.id, { ...empty("profile"), source });
  await store.accept(job.id, {
    ...empty("feed"),
    targetId: source.id,
    posts: [posts[0]],
    terminal: true,
  });
  assert.equal((await d.runs.get(job.id))!.checkpoint.channel, "reels");
  await store.accept(job.id, {
    ...empty("reels"),
    targetId: source.id,
    posts,
    terminal: true,
  });
  assert.equal(await d.runPosts.count(), 2);
  for (const p of posts)
    await store.accept(job.id, {
      ...empty("comments"),
      targetId: p.id,
      posts: [p],
      comments: [
        { id: `${p.id}1`, profile: profile("2"), replyCount: 0, replies: [] },
      ],
      terminal: true,
    });
  assert.equal((await d.runs.get(job.id))!.status, "completed");
  assert.equal((await d.candidates.get([m.id, "2"]))!.score, 2);
  await d.delete();
});
test("single native profile remains candidate-only; mismatched source and unsupported bodies do not identify a source", async () => {
  const { d, m, store, job } = await setup("single");
  await store.accept(job.id, {
    ...empty("profile"),
    source: profile("1", "wrong"),
  });
  assert.equal(await d.runs.count(), 0);
  await store.accept(job.id, {
    ...empty("profile"),
    source: profile("173560420", "source"),
  });
  assert.equal((await d.runs.get(job.id))!.status, "completed");
  assert.equal(await d.sources.count(), 0);
  assert.ok(await d.candidates.get([m.id, "173560420"]));
  await d.delete();
  assert.equal(
    normalizeNative(
      requestInfo("https://www.instagram.com/api/v1/feed/recommended/"),
      { users: [user("1")] },
      binding,
    ).length,
    0,
  );
  const clean = cleanCapture({
    ...empty("profile"),
    cookie: "secret",
    source: { ...profile("1"), token: "secret" },
  })!;
  assert.ok(!JSON.stringify(clean).includes("secret"));
});
test("page cooldown is separate from direct mode and native errors stop pending jobs", async () => {
  const { d, store, job } = await setup();
  await d.settings.put({
    id: "preferences",
    delaySeconds: 5,
    cooldownUntil: Date.now() + 600000,
  });
  await store.stop(job.id);
  await store.begin(job.id);
  const f = nativeFailure(429, {}, "60")!;
  await store.accept(job.id, f);
  assert.equal((await d.pendingPageJobs.get(job.id))!.status, "cooldown");
  assert.ok((await preferences(d)).pageCooldownUntil! > Date.now());
  await assert.rejects(store.begin(job.id), /cooling down/);
  assert.equal(nativeFailure(401, {}, null)!.failure, "login");
  assert.equal(nativeFailure(403, {}, null)!.failure, "restricted");
  assert.equal(nativeFailure(503, {}, null)!.failure, "network");
  await d.delete();
});
test("page receipt coverage rejects gaps and cycles", () => {
  const r = (requestCursor: string, nextCursors: string[], terminal = false) =>
    ({ requestCursor, nextCursors, terminal }) as PageReceipt;
  assert.equal(covered([r("", ["12"]), r("24", [], true)]), false);
  assert.equal(covered([r("", ["12"]), r("12", [], true)]), true);
  assert.equal(
    covered([r("", ["12"]), r("12", ["24"]), r("24", ["12"])]),
    false,
  );
});
test("native REST and structural GraphQL handle media owners, branches and replies without guessed query IDs", () => {
  const b: PageBinding = {
    ...binding,
    mode: "commenters",
    sourceId: "173560420",
    postId: "64",
  };
  const posts = new Map();
  const info = normalizeNative(
    requestInfo("https://www.instagram.com/api/v1/media/64/info/"),
    {
      items: [
        {
          pk: "64",
          code: "BA",
          user: user("173560420", "source"),
          comment_count: 3,
        },
      ],
    },
    b,
    posts,
  );
  assert.equal(info.at(-1)!.posts[0].id, "64");
  const comments = normalizeNative(
    requestInfo("https://www.instagram.com/api/v1/media/64/comments/?min_id=x"),
    {
      comments: [{ pk: "1", user: user("2"), child_comment_count: 1 }],
      has_more_comments: true,
      next_max_id: "tail",
      has_more_headload_comments: true,
      next_min_id: "head",
    },
    b,
    posts,
  )[0];
  assert.equal(comments.requestCursor, "min:x");
  assert.deepEqual(comments.nextCursors, ["max:tail", "min:head"]);
  const gql = normalizeNative(
    requestInfo(
      "https://www.instagram.com/graphql/query/",
      new URLSearchParams({
        variables: JSON.stringify({ media_id: "64", after: "" }),
      }),
    ),
    {
      data: {
        edge_media_to_parent_comment: {
          edges: [{ node: { id: "2", owner: user("3") } }],
          page_info: { has_next_page: false },
        },
      },
    },
    b,
    posts,
  ).find((f) => f.kind === "comments")!;
  assert.equal(gql.requestCursor, "");
  assert.equal(gql.terminal, true);
  assert.equal(gql.comments[0].profile!.id, "3");
  assert.equal(
    requestInfo(
      "https://www.instagram.com/api/v1/clips/user/",
      "target_user_id=173560420&max_id=next",
    ).variables!.target_user_id,
    "173560420",
  );
});
test("version-three backups preserve new jobs, pause restores, accept v1, protect both cooldowns and reject malformed new data", async () => {
  const { d, store, job } = await setup();
  await store.accept(job.id, follow("following", ["2"], "", "12"));
  const pending = await store.create("another", "followers", job.missionId);
  await store.begin(pending.id);
  await d.settings.put({
    id: "preferences",
    delaySeconds: 5,
    pageDelaySeconds: 2.5,
  });
  const backup = await exportBackup(d);
  assert.equal(backup.version, 3);
  const restored = new Database(`restore-${crypto.randomUUID()}`);
  await restored.settings.put({
    id: "preferences",
    delaySeconds: 5,
    pageCooldownUntil: Date.now() + 60000,
  });
  await restoreBackup(backup, restored);
  assert.equal((await restored.runs.get(job.id))!.status, "paused");
  assert.equal(
    (await restored.pendingPageJobs.get(pending.id))!.status,
    "paused",
  );
  assert.equal(await restored.pageReceipts.count(), 1);
  assert.equal((await preferences(restored)).pageDelaySeconds, 2.5);
  const badPace = structuredClone(backup);
  badPace.tables.settings[0].pageDelaySeconds = 0;
  assert.throws(() => validateBackup(badPace), /delay/);
  assert.ok((await preferences(restored)).pageCooldownUntil! > Date.now());
  const invalid = structuredClone(backup);
  invalid.tables.pageReceipts[0].nextCursors = [123];
  assert.throws(() => validateBackup(invalid), /receipt/);
  const legacy = structuredClone(backup);
  legacy.version = 1;
  delete legacy.tables.settings[0].pageDelaySeconds;
  delete legacy.tables.pendingPageJobs;
  delete legacy.tables.pageReceipts;
  delete legacy.tables.runs[0].method;
  await restoreBackup(legacy, restored);
  assert.equal(await restored.pendingPageJobs.count(), 0);
  assert.equal((await preferences(restored)).pageDelaySeconds, 1.5);
  assert.equal((await restored.runs.get(job.id))!.method, "direct");
  await d.delete();
  await restored.delete();
});
test("mission deletion removes pending jobs and invalidated receipts, and rejects collection races", async () => {
  const { d, m, store, job } = await setup();
  await assert.rejects(deleteMission(m.id, d), /Pause/);
  await store.stop(job.id);
  await deleteMission(m.id, d);
  assert.equal(await d.pendingPageJobs.count(), 0);
  await d.delete();
  const second = await setup();
  await second.store.accept(second.job.id, follow("following", ["2"]));
  await deleteMission(second.m.id, second.d);
  assert.equal(await second.d.pageReceipts.count(), 0);
  await second.d.delete();
});
test("startup recovery pauses pending page jobs without running collection automatically", async () => {
  const { d, job } = await setup();
  await new Runner(d).recover();
  assert.equal((await d.pendingPageJobs.get(job.id))!.status, "paused");
  await d.delete();
});
test("version-one IndexedDB migrates legacy runs as direct while new preferences default to page", async () => {
  const name = `migration-${crypto.randomUUID()}`;
  const old = new Dexie(name);
  old.version(1).stores({ runs: "id, key, updatedAt, status", settings: "id" });
  await old.table("runs").put({ id: "legacy", status: "paused" });
  old.close();
  const upgraded = new Database(name);
  await upgraded.open();
  assert.equal((await upgraded.runs.get("legacy"))!.method, "direct");
  assert.equal((await preferences(upgraded)).collectionMethod, "page");
  await upgraded.delete();
});
test("page data and receipt rollback together if saving candidate membership fails", async () => {
  const { d, m, store, job } = await setup();
  await store.accept(job.id, follow("following", ["2"], "", "12"));
  const fail = () => {
    throw new Error("simulated write failure");
  };
  d.candidates.hook("creating", fail);
  await assert.rejects(
    store.accept(job.id, follow("following", ["3"], "12")),
    /simulated/,
  );
  d.candidates.hook("creating").unsubscribe(fail);
  assert.equal(await d.pageReceipts.count(), 1);
  assert.equal(await d.follows.count(), 1);
  assert.equal(await d.profiles.get("3"), undefined);
  assert.equal((await d.runs.get(job.id))!.status, "running");
  await store.accept(job.id, follow("following", ["3"], "12"));
  assert.equal((await d.runs.get(job.id))!.status, "completed");
  assert.ok(await d.candidates.get([m.id, "3"]));
  await d.delete();
});
test("very long cursor chains are iterative, and cyclic native pages stop with partial results", async () => {
  const trail = Array.from({ length: 12000 }, (_, i) => ({
    requestCursor: i === 0 ? "" : String(i),
    nextCursors: i === 11999 ? [] : [String(i + 1)],
    terminal: i === 11999,
  })) as PageReceipt[];
  assert.equal(covered(trail), true);
  const { d, store, job } = await setup();
  await store.accept(job.id, follow("following", ["2"], "", "12"));
  await store.accept(job.id, follow("following", ["3"], "12", "24"));
  await store.accept(job.id, follow("following", ["4"], "24", "12"));
  assert.equal((await d.runs.get(job.id))!.status, "partial");
  await d.delete();
});
test("reply pages arriving before parent metadata survive and complete only after root coverage", async () => {
  const { d, store, job } = await setup(
    "commenters",
    "https://www.instagram.com/p/BA/",
  );
  const post = {
    id: "64",
    ownerId: "173560420",
    url: "https://www.instagram.com/p/BA/",
    commentCount: 2,
  };
  await store.accept(job.id, {
    ...empty("media-info"),
    source: profile("173560420", "source"),
    posts: [post],
  });
  await store.accept(job.id, {
    ...empty("replies"),
    targetId: "64",
    parentId: "10",
    posts: [post],
    comments: [{ id: "11", profile: profile("3"), replyCount: 0, replies: [] }],
    terminal: true,
  });
  assert.equal((await d.runs.get(job.id))!.status, "running");
  await store.accept(job.id, {
    ...empty("comments"),
    targetId: "64",
    posts: [post],
    comments: [{ id: "10", profile: profile("2"), replyCount: 1, replies: [] }],
    terminal: true,
  });
  assert.equal((await d.runs.get(job.id))!.status, "completed");
  await d.delete();
});
test("missing authors, missing pagination and reply shortfalls stay partial or unfinished", async () => {
  const { d, store, job } = await setup(
    "commenters",
    "https://www.instagram.com/p/BA/",
  );
  const post = {
    id: "64",
    ownerId: "173560420",
    url: "https://www.instagram.com/p/BA/",
  };
  await store.accept(job.id, {
    ...empty("media-info"),
    source: profile("173560420", "source"),
    posts: [post],
  });
  await store.accept(job.id, {
    ...empty("comments"),
    targetId: "64",
    posts: [post],
    comments: [{ id: "10", profile: profile("2"), replyCount: 2, replies: [] }],
    terminal: true,
  });
  await store.accept(job.id, {
    ...empty("replies"),
    targetId: "64",
    parentId: "10",
    posts: [post],
    comments: [{ id: "11", profile: profile("3"), replyCount: 0, replies: [] }],
    terminal: true,
  });
  assert.equal((await d.runs.get(job.id))!.status, "partial");
  await d.delete();
  const frame = normalizeNative(
    requestInfo(
      "https://www.instagram.com/api/v1/friendships/173560420/following/",
    ),
    {
      users: [{ pk: 99999999999999999999, username: "large" }],
      has_more: false,
    },
    binding,
  )[0];
  assert.equal(frame.profiles.length, 0);
  assert.ok(frame.warnings.length);
});
test("overlapping parent previews retain all reply IDs without unnecessary pagination", async () => {
  const { d, store, job } = await setup(
    "commenters",
    "https://www.instagram.com/p/BA/",
  );
  const post = {
    id: "64",
    ownerId: "173560420",
    url: "https://www.instagram.com/p/BA/",
    commentCount: 3,
  };
  await store.accept(job.id, {
    ...empty("media-info"),
    source: profile("173560420", "source"),
    posts: [post],
  });
  const parent = { id: "10", profile: profile("2"), replyCount: 2 };
  await store.accept(job.id, {
    ...empty("comments"),
    targetId: "64",
    posts: [post],
    comments: [
      {
        ...parent,
        replies: [
          { id: "11", profile: profile("3"), replyCount: 0, replies: [] },
        ],
      },
      {
        ...parent,
        replies: [
          { id: "12", profile: profile("4"), replyCount: 0, replies: [] },
        ],
      },
    ],
    terminal: true,
  });
  assert.equal((await d.runs.get(job.id))!.status, "completed");
  assert.equal((await d.threads.toArray())[0].fetchedCount, 2);
  await d.delete();
});
test("explicit native terminal flags ignore stale cursors; unsupported media owners warn instead of completing silently", () => {
  const request = requestInfo(
    "https://www.instagram.com/api/v1/friendships/173560420/following/",
  );
  const frame = normalizeNative(
    request,
    { users: [user("2")], has_more: false, next_max_id: "stale" },
    binding,
  )[0];
  assert.equal(frame.terminal, true);
  assert.deepEqual(frame.nextCursors, []);
  const b = { ...binding, mode: "commenters" as const, sourceId: "173560420" };
  const media = normalizeNative(
    requestInfo("https://www.instagram.com/api/v1/feed/user/173560420/"),
    {
      items: [{ pk: "64", code: "BA", user: user("99", "other") }],
      more_available: false,
    },
    b,
  ).find((f) => f.kind === "feed")!;
  assert.equal(media.posts.length, 0);
  assert.ok(media.warnings.length);
});
test("a short structured comment preview saves observations without terminal coverage or overwriting a later full page", async () => {
  const { d, m, store, job } = await setup(
    "commenters",
    "https://www.instagram.com/p/BA/",
  );
  const current = await store.binding(job.id),
    posts = new Map();
  const rawComment = (id: string, author: string, replies = 0) => ({
    pk_id: id,
    id: "opaque-comment-id",
    user: user(author),
    child_comment_count: replies,
  });
  const hydration = {
    data: {
      shortcode_media: {
        pk_id: "64",
        code: "BA",
        user: user("1", "source"),
        edge_media_preview_comment: { count: 4 },
        edge_media_to_parent_comment: {
          edges: [{ node: rawComment("10", "2") }],
          page_info: { has_next_page: false },
        },
      },
    },
  };
  const frames = normalizeNative(
    { url: "https://www.instagram.com/graphql/query/", structured: true },
    hydration,
    current,
    posts,
  );
  const preview = frames.find((f) => f.kind === "comments")!;
  assert.equal(preview.preview, true);
  assert.equal(preview.terminal, false);
  for (const f of frames) await store.accept(job.id, f);
  assert.equal((await d.runs.get(job.id))!.status, "running");
  assert.equal(await d.results.where("runId").equals(job.id).count(), 1);
  assert.equal(await d.pageReceipts.count(), 0);
  await decide(m.id, "2", "possible", d);
  const binding = await store.binding(job.id);
  const full = normalizeNative(
    requestInfo("https://www.instagram.com/api/v1/media/64/comments/"),
    {
      comments: [rawComment("10", "2"), rawComment("11", "3", 2)],
      has_more_comments: false,
    },
    binding,
    posts,
  ).find((f) => f.kind === "comments")!;
  await store.accept(job.id, full);
  await store.accept(job.id, preview);
  assert.equal((await d.pageReceipts.toArray())[0].terminal, true);
  assert.equal((await d.runs.get(job.id))!.status, "running");
  await store.accept(job.id, {
    ...empty("replies"),
    targetId: "64",
    parentId: "11",
    posts: [posts.get("64")],
    terminal: true,
    comments: [
      { id: "12", profile: profile("4"), replyCount: 0, replies: [] },
      { id: "13", profile: profile("5"), replyCount: 0, replies: [] },
    ],
  });
  assert.equal((await d.runs.get(job.id))!.status, "completed");
  assert.equal(await d.results.where("runId").equals(job.id).count(), 4);
  assert.equal((await d.candidates.get([m.id, "2"]))!.decision, "possible");
  assert.equal((await d.candidates.get([m.id, "2"]))!.score, 1);
  const unknown = structuredClone(hydration);
  delete (unknown.data.shortcode_media as any).edge_media_preview_comment;
  assert.equal(
    normalizeNative(
      { url: "https://www.instagram.com/graphql/query/", structured: true },
      unknown,
      current,
    ).find((f) => f.kind === "comments")!.preview,
    true,
  );
  await d.delete();
});
test("comments and replies arriving before post metadata are normalized for deferred capture with exact string IDs", () => {
  const binding: PageBinding = {
    jobId: "pending",
    input: {
      type: "post",
      shortcode: "BA",
      url: "https://www.instagram.com/p/BA/",
    },
    mode: "commenters",
  };
  const rawComment = {
    pk_id: "18000000000000001",
    pk: 18000000000000001,
    id: "opaque",
    user: user("2"),
  };
  for (const path of ["comments/", "comments/10/child_comments/"]) {
    const req = requestInfo(
      `https://www.instagram.com/api/v1/media/64/${path}`,
    );
    const raw = {
      comments: [rawComment],
      child_comments: [rawComment],
      has_more_comments: false,
      has_more_tail_child_comments: false,
    };
    assert.deepEqual(normalizeNative(req, raw, binding), []);
    const frame = normalizeNative(req, raw, binding, new Map(), true)[0];
    assert.equal(frame.comments[0].id, "18000000000000001");
    assert.equal(frame.targetId, "64");
    assert.deepEqual(frame.posts, []);
    assert.equal(frame.source, undefined);
    assert.equal(frame.terminal, true);
  }
  assert.deepEqual(
    normalizeNative(
      requestInfo("https://www.instagram.com/api/v1/media/65/comments/"),
      { comments: [rawComment] },
      binding,
      new Map(),
      true,
    ),
    [],
  );
});
