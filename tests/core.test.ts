import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Database } from "../src/db";
import {
  applyObservation,
  candidatePage,
  createMission,
  decide,
  includeSources,
  reuseRun,
  setSource,
  deleteMission,
} from "../src/data";
import { exportBackup, restoreBackup, validateBackup } from "../src/backup";
import {
  CollectionError,
  Instagram,
  Pacer,
  commentsPage,
  listPage,
  mediaPage,
  normalizeProfile,
  parseInput,
  shortcodeId,
} from "../src/instagram";
import { Runner, nextCheckpoint } from "../src/runner";
import { collectionHistory, hideCollectionHistory } from "../src/history";
import type { Profile, Resolved, Run } from "../src/types";
const profile = (id: string, userName = `user${id}`): Profile => ({
  id,
  userName,
  fullName: `Person ${id}`,
  profileUrl: `https://www.instagram.com/${userName}/`,
  avatarUrl: "",
  updatedAt: Date.now(),
});
const database = () => new Database(`test-${crypto.randomUUID()}`);
const cp = {
  stage: "followers" as const,
  cursor: null,
  seenCursors: [],
  pageCount: 0,
  stageCount: 0,
};
async function setup() {
  const d = database();
  const m = await createMission("Search", d);
  await applyObservation(
    {
      profiles: [profile("1"), profile("2"), profile("3"), profile("4")],
      missionIds: [m.id],
    },
    d,
  );
  return { d, m };
}
test("clearing superseded incomplete history preserves observations, decisions, cached results and backups", async () => {
  const { d, m } = await setup();
  await setSource(m.id, "1", true, d);
  await applyObservation(
    { follows: [{ followerId: "2", followingId: "1", lastSeenAt: 1 }] },
    d,
  );
  await decide(m.id, "2", "possible", d);
  const old: Run = {
    id: "old",
    key: "profile:1:followers",
    sourceId: "1",
    targetLabel: "user1",
    mode: "followers",
    scope: "profile",
    method: "direct",
    status: "partial",
    createdAt: 1,
    updatedAt: 2,
    checkpoint: { ...cp },
  };
  await d.runs.bulkPut([
    old,
    {
      ...old,
      id: "new",
      method: "page",
      status: "completed",
      createdAt: 3,
      updatedAt: 4,
      completedAt: 4,
      checkpoint: { ...cp, stage: "done" },
    },
  ]);
  await d.results.put({ runId: old.id, kind: "followers", profileId: "2" });
  await d.runLinks.put({ runId: old.id, missionId: m.id });
  const before = await exportBackup(d);
  assert.equal(
    (await collectionHistory(0, d)).rows.find((r) => r.id === old.id)?.canHide,
    true,
  );
  await hideCollectionHistory(old.id, d);
  assert.deepEqual(
    (await collectionHistory(0, d)).rows.map((r) => r.id),
    ["new"],
  );
  assert.equal((await collectionHistory(0, d)).total, 1);
  const after = await exportBackup(d);
  assert.ok(
    after.tables.runs.find((r) => r.id === old.id)?.historyHiddenAt > 0,
  );
  for (const name of Object.keys(before.tables).filter(
    (name) => name !== "runs",
  ))
    assert.deepEqual(after.tables[name], before.tables[name]);
  const saved = await d.runs.get(old.id);
  const { historyHiddenAt, ...rest } = saved!;
  assert.deepEqual(rest, old);
  const restored = database();
  await restoreBackup(after, restored);
  assert.equal((await collectionHistory(0, restored)).total, 1);
  assert.equal(
    (await restored.candidates.get([m.id, "2"]))?.decision,
    "possible",
  );
  assert.equal((await restored.candidates.get([m.id, "2"]))?.score, 1);
  await restored.delete();
  await d.delete();
});
test("history clearing requires a newer completed collection of the exact source, action and scope", async () => {
  const d = database();
  const old: Run = {
    id: "old",
    key: "post:10:commenters",
    sourceId: "1",
    targetLabel: "user1",
    mode: "commenters",
    scope: "post",
    targetPostId: "10",
    status: "partial",
    createdAt: 1,
    updatedAt: 2,
    checkpoint: { ...cp, stage: "comments" },
  };
  const newer: Run = {
    ...old,
    id: "new",
    status: "completed",
    createdAt: 3,
    updatedAt: 4,
  };
  for (const change of [
    { status: "partial" },
    { updatedAt: 1 },
    { sourceId: "2" },
    { mode: "likers" },
    { scope: "profile" },
    { targetPostId: "11" },
  ]) {
    await d.runs.bulkPut([old, { ...newer, ...change } as Run]);
    assert.equal(
      (await collectionHistory(0, d)).rows.find((r) => r.id === old.id)
        ?.canHide,
      false,
    );
    await assert.rejects(
      hideCollectionHistory(old.id, d),
      /Only older unfinished/,
    );
  }
  await d.runs.put(newer);
  assert.equal(
    (await collectionHistory(0, d)).rows.find((r) => r.id === old.id)?.canHide,
    true,
  );
  await assert.rejects(
    hideCollectionHistory(newer.id, d),
    /Only older unfinished/,
  );
  await d.runs.update(old.id, { status: "running" });
  await assert.rejects(
    hideCollectionHistory(old.id, d),
    /Only older unfinished/,
  );
  await d.delete();
});
test("directional and mutual follows count once; duplicate observations and self follows do not inflate scores", async () => {
  const { d, m } = await setup();
  await setSource(m.id, "1", true, d);
  const observations = {
    follows: [
      { followerId: "2", followingId: "1", lastSeenAt: 1 },
      { followerId: "1", followingId: "2", lastSeenAt: 1 },
      { followerId: "1", followingId: "1", lastSeenAt: 1 },
    ],
  };
  await applyObservation(observations, d);
  await applyObservation(observations, d);
  assert.equal((await d.candidates.get([m.id, "2"]))!.score, 2);
  assert.equal(await d.follows.count(), 2);
  await d.delete();
});
test("comments add one per distinct post including replies, never imply follows, and ignore self comments", async () => {
  const { d, m } = await setup();
  await setSource(m.id, "1", true, d);
  const c = { postId: "10", profileId: "2", ownerId: "1", lastSeenAt: 1 };
  await applyObservation(
    {
      posts: [
        { id: "10", ownerId: "1", url: "" },
        { id: "11", ownerId: "1", url: "" },
      ],
      comments: [c, c, { ...c, postId: "11" }, { ...c, profileId: "1" }],
    },
    d,
  );
  assert.equal((await d.candidates.get([m.id, "2"]))!.score, 2);
  assert.equal((await d.candidates.get([m.id, "1"]))!.score, 0);
  assert.equal(await d.follows.count(), 0);
  await d.delete();
});
test("only each mission’s active sources count; promotion and demotion use old global facts", async () => {
  const { d, m } = await setup();
  const other = await createMission("Other", d);
  await applyObservation(
    {
      profiles: [profile("2")],
      missionIds: [other.id],
      follows: [
        { followerId: "2", followingId: "1", lastSeenAt: 1 },
        { followerId: "2", followingId: "3", lastSeenAt: 1 },
      ],
    },
    d,
  );
  await setSource(m.id, "1", true, d);
  await setSource(other.id, "3", true, d);
  assert.equal((await d.candidates.get([m.id, "2"]))!.score, 1);
  assert.equal((await d.candidates.get([other.id, "2"]))!.score, 1);
  await setSource(m.id, "3", true, d);
  assert.equal((await d.candidates.get([m.id, "2"]))!.score, 2);
  await setSource(m.id, "1", false, d);
  assert.equal((await d.candidates.get([m.id, "2"]))!.score, 1);
  await d.delete();
});
test("source visibility can change without losing decisions or membership", async () => {
  const { d, m } = await setup();
  await decide(m.id, "1", "possible", d);
  await setSource(m.id, "1", true, d);
  assert.equal((await d.candidates.get([m.id, "1"]))!.visible, 0);
  await includeSources(m.id, true, d);
  assert.equal((await d.candidates.get([m.id, "1"]))!.decision, "possible");
  assert.equal((await d.candidates.get([m.id, "1"]))!.visible, 1);
  await includeSources(m.id, false, d);
  await setSource(m.id, "1", false, d);
  assert.equal((await d.candidates.get([m.id, "1"]))!.visible, 1);
  await d.delete();
});
test("review priorities, tie ordering, decisions, search, filters and pagination", async () => {
  const { d, m } = await setup();
  await setSource(m.id, "1", true, d);
  await applyObservation(
    { follows: [{ followerId: "3", followingId: "1", lastSeenAt: 1 }] },
    d,
  );
  await d.candidates.update([m.id, "2"], { addedAt: 1 });
  await d.candidates.update([m.id, "4"], { addedAt: 2 });
  assert.deepEqual(
    (await candidatePage(m.id, "unreviewed", "", 0, 10, d)).rows.map(
      (r) => r.profileId,
    ),
    ["3", "2", "4"],
  );
  await decide(m.id, "3", "no", d);
  assert.equal(
    (await candidatePage(m.id, "unreviewed", "", 0, 1, d)).rows[0].profileId,
    "2",
  );
  assert.equal(
    (await candidatePage(m.id, "no", "person 3", 0, 40, d)).count,
    1,
  );
  await decide(m.id, "3", "unreviewed", d);
  assert.equal(
    (await candidatePage(m.id, "unreviewed", "", 1, 1, d)).rows[0].profileId,
    "2",
  );
  await d.delete();
});
test("metadata refresh and repeated addition preserve decisions independently across missions", async () => {
  const { d, m } = await setup();
  const n = await createMission("Another", d);
  await decide(m.id, "2", "unlikely", d);
  await applyObservation(
    {
      profiles: [{ ...profile("2", "renamed"), fullName: "New Name" }],
      missionIds: [m.id, n.id],
    },
    d,
  );
  assert.equal((await d.candidates.get([m.id, "2"]))!.decision, "unlikely");
  assert.equal((await d.candidates.get([n.id, "2"]))!.decision, "unreviewed");
  assert.equal(
    (await candidatePage(m.id, "all", "new name", 0, 40, d)).count,
    1,
  );
  await d.delete();
});
test("page writes and checkpoints roll back together on invalid relationships", async () => {
  const { d, m } = await setup();
  const r: Run = {
    id: "r",
    key: "k",
    sourceId: "1",
    targetLabel: "one",
    mode: "followers",
    scope: "profile",
    status: "running",
    checkpoint: cp,
    createdAt: 1,
    updatedAt: 1,
  };
  await assert.rejects(
    applyObservation(
      {
        profiles: [profile("9")],
        run: r,
        comments: [
          { postId: "missing", profileId: "9", ownerId: "1", lastSeenAt: 1 },
        ],
      },
      d,
    ),
  );
  assert.equal(await d.profiles.get("9"), undefined);
  assert.equal(await d.runs.get("r"), undefined);
  await d.delete();
});
test("backup roundtrip, derived score repair, running job recovery and invalid backup rollback", async () => {
  const { d, m } = await setup();
  await setSource(m.id, "1", true, d);
  await applyObservation(
    { follows: [{ followerId: "2", followingId: "1", lastSeenAt: 1 }] },
    d,
  );
  await decide(m.id, "2", "possible", d);
  const backup = await exportBackup(d);
  backup.tables.affinities[0].score = 999;
  backup.tables.candidates.find((c) => c.profileId === "2")!.score = 999;
  const target = database();
  await restoreBackup(backup, target);
  assert.equal((await target.candidates.get([m.id, "2"]))!.score, 1);
  assert.equal(
    (await target.candidates.get([m.id, "2"]))!.decision,
    "possible",
  );
  const invalid = structuredClone(backup);
  invalid.tables.candidates[0].profileId = "nonexistent";
  await assert.rejects(restoreBackup(invalid, target));
  assert.equal(await target.missions.count(), 1);
  assert.ok(!JSON.stringify(backup).includes("csrftoken"));
  await d.delete();
  await target.delete();
});
test("mission deletion removes unshared candidates but preserves other mission memberships, sources and decisions", async () => {
  const { d, m } = await setup();
  const other = await createMission("Other", d);
  await applyObservation(
    { profiles: [profile("2"), profile("9")], missionIds: [other.id] },
    d,
  );
  await setSource(other.id, "3", true, d);
  await setSource(other.id, "4", true, d);
  await setSource(other.id, "4", false, d);
  // The hidden bookkeeping row left by a demoted source is no longer active use.
  await decide(other.id, "2", "possible", d);
  await applyObservation(
    {
      follows: [
        { followerId: "2", followingId: "1", lastSeenAt: 1 },
        { followerId: "2", followingId: "3", lastSeenAt: 1 },
      ],
    },
    d,
  );
  await deleteMission(m.id, d);
  assert.deepEqual((await d.profiles.toArray()).map((p) => p.id).sort(), [
    "2",
    "3",
    "9",
  ]);
  assert.equal(await d.follows.count(), 1);
  assert.equal(await d.candidates.where("missionId").equals(m.id).count(), 0);
  assert.equal((await d.candidates.get([other.id, "2"]))!.decision, "possible");
  assert.equal((await d.candidates.get([other.id, "2"]))!.score, 1);
  assert.ok(await d.sources.get([other.id, "3"]));
  validateBackup(await exportBackup(d));
  await d.delete();
});
test("forced candidate deletion removes memberships and facts across missions, recomputes scores and invalidates cached results", async () => {
  const { d, m } = await setup();
  const other = await createMission("Other", d);
  await applyObservation(
    {
      profiles: [profile("1"), profile("2"), profile("9")],
      missionIds: [other.id],
    },
    d,
  );
  await setSource(other.id, "1", true, d);
  await setSource(other.id, "9", true, d);
  await decide(other.id, "2", "possible", d);
  await applyObservation(
    {
      follows: [
        { followerId: "9", followingId: "1", lastSeenAt: 1 },
        { followerId: "9", followingId: "2", lastSeenAt: 1 },
      ],
      posts: [
        { id: "10", ownerId: "1", url: "" },
        { id: "11", ownerId: "9", url: "" },
      ],
      comments: [
        { postId: "10", ownerId: "1", profileId: "9", lastSeenAt: 1 },
        { postId: "11", ownerId: "9", profileId: "2", lastSeenAt: 1 },
      ],
    },
    d,
  );
  const run = (id: string, sourceId: string): Run => ({
    id,
    sourceId,
    targetLabel: `user${sourceId}`,
    key: id,
    mode: "followers",
    scope: "profile",
    status: "completed",
    createdAt: 1,
    updatedAt: 1,
    completedAt: 1,
    checkpoint: { ...cp, stage: "done" },
  });
  await d.runs.bulkPut([
    run("removed", "1"),
    run("partial", "9"),
    run("untouched", "9"),
  ]);
  await d.runLinks.bulkPut([
    { runId: "removed", missionId: other.id },
    { runId: "partial", missionId: other.id },
  ]);
  await d.results.bulkPut([
    { runId: "removed", kind: "followers", profileId: "9" },
    { runId: "partial", kind: "followers", profileId: "2" },
    { runId: "partial", kind: "followers", profileId: "9" },
    { runId: "untouched", kind: "followers", profileId: "9" },
  ]);
  await d.runPosts.put({
    runId: "removed",
    postId: "10",
    done: 1,
    commentCount: 1,
  });
  await d.threads.put({
    runId: "removed",
    postId: "10",
    commentId: "20",
    cursor: null,
    seenCursors: [],
    done: 1,
  });
  await d.seenComments.put({ runId: "removed", postId: "10", commentId: "20" });
  assert.equal((await d.candidates.get([other.id, "9"]))!.score, 2);
  await deleteMission(m.id, d, true);
  assert.deepEqual(
    (await d.profiles.toArray()).map((p) => p.id),
    ["9"],
  );
  assert.equal(await d.candidates.count(), 1);
  assert.equal((await d.candidates.get([other.id, "9"]))!.score, 0);
  assert.equal(await d.sources.count(), 1);
  assert.equal(await d.follows.count(), 0);
  assert.equal(await d.comments.count(), 0);
  assert.equal(await d.affinities.count(), 0);
  assert.deepEqual(
    (await d.posts.toArray()).map((p) => p.id),
    ["11"],
  );
  assert.equal(await d.runs.get("removed"), undefined);
  assert.equal((await d.runs.get("partial"))!.status, "partial");
  assert.equal((await d.runs.get("partial"))!.checkpoint.stage, "done");
  assert.equal((await d.runs.get("partial"))!.completedAt, undefined);
  assert.equal((await d.runs.get("untouched"))!.status, "completed");
  assert.equal(await d.results.count(), 2);
  assert.equal(await d.runPosts.count(), 0);
  assert.equal(await d.threads.count(), 0);
  assert.equal(await d.seenComments.count(), 0);
  validateBackup(await exportBackup(d));
  await reuseRun("partial", other.id, d);
  assert.equal(await d.candidates.get([other.id, "2"]), undefined);
  const target = database();
  await restoreBackup(await exportBackup(d), target);
  assert.equal(await target.profiles.count(), 1);
  await target.delete();
  await d.delete();
});
test("mission deletion keeps excluded source-only data and unrelated profiles, but deletes included source candidates", async () => {
  const d = database();
  const excluded = await createMission("Excluded", d);
  const included = await createMission("Included", d);
  await applyObservation(
    { profiles: [profile("1"), profile("2"), profile("3")] },
    d,
  );
  await setSource(excluded.id, "1", true, d);
  await setSource(included.id, "2", true, d);
  await includeSources(included.id, true, d);
  await deleteMission(excluded.id, d, true);
  assert.ok(await d.profiles.get("1"));
  await deleteMission(included.id, d);
  assert.equal(await d.profiles.get("2"), undefined);
  assert.ok(await d.profiles.get("1"));
  assert.ok(await d.profiles.get("3"));
  assert.equal(await d.missions.count(), 0);
  await d.delete();
});
test("mission deletion is atomic and cannot race an active collection", async () => {
  const { d, m } = await setup();
  await d.runs.put({
    id: "running",
    key: "running",
    sourceId: "1",
    targetLabel: "user1",
    mode: "followers",
    scope: "profile",
    status: "running",
    createdAt: 1,
    updatedAt: 1,
    checkpoint: cp,
  });
  await assert.rejects(deleteMission(m.id, d, true), /Pause collection/);
  assert.equal(await d.profiles.count(), 4);
  assert.equal(await d.candidates.count(), 4);
  assert.ok(await d.missions.get(m.id));
  await d.runs.update("running", { status: "paused" });
  const clear = d.affinities.clear.bind(d.affinities);
  d.affinities.clear = async () => {
    throw new Error("Synthetic write failure");
  };
  await assert.rejects(deleteMission(m.id, d, true), /Synthetic write failure/);
  d.affinities.clear = clear;
  assert.equal(await d.profiles.count(), 4);
  assert.equal(await d.candidates.count(), 4);
  assert.ok(await d.missions.get(m.id));
  await d.delete();
});
test("username and profile/post/reel input parsing and lossless shortcode IDs", () => {
  assert.deepEqual(parseInput("@Alice.name"), {
    type: "profile",
    username: "alice.name",
  });
  assert.equal(parseInput("https://instagram.com/alice/?a=1").type, "profile");
  assert.equal(
    parseInput("https://www.instagram.com/reel/ABC_-/?igsh=x").type,
    "post",
  );
  for (const path of [
    "/beerrestaurant.cz/p/Dd0vnaQjEhM/",
    "/beerrestaurant.cz/p/Dd0vnaQjEhM/liked_by/",
  ]) {
    assert.deepEqual(
      parseInput(`https://www.instagram.com${path}?igsh=fixture#fragment`),
      {
        type: "post",
        shortcode: "Dd0vnaQjEhM",
        url: "https://www.instagram.com/p/Dd0vnaQjEhM/",
      },
    );
  }
  assert.deepEqual(
    parseInput("https://instagram.com/beerrestaurant.cz/reel/ABC_-/"),
    {
      type: "post",
      shortcode: "ABC_-",
      url: "https://www.instagram.com/reel/ABC_-/",
    },
  );
  assert.throws(() => parseInput("https://instagram.com.evil.test/name/"));
  assert.throws(() => parseInput("https://instagram.com/accounts/login/"));
  assert.throws(() => parseInput("http://instagram.com/alice/"));
  assert.throws(() => parseInput("https://instagram.com/accounts/p/BA/"));
  assert.throws(() => parseInput("https://instagram.com/beerrestaurant.cz/p/"));
  assert.equal(shortcodeId("BA"), "64");
  assert.ok(
    BigInt(shortcodeId("ZZZZZZZZZZZZ")) > BigInt(Number.MAX_SAFE_INTEGER),
  );
});
test("normalizers preserve string IDs and treat cursor and restrictions explicitly", () => {
  assert.equal(
    normalizeProfile({ pk: "12345678901234567890", username: "a" }).id,
    "12345678901234567890",
  );
  assert.throws(() => normalizeProfile({ username: "a" }));
  const p = listPage({
    users: [{ pk: "1", username: "a" }],
    next_max_id: "opaque",
    more_available: true,
  });
  assert.equal(p.next, "opaque");
  assert.equal(p.more, true);
  assert.ok(
    listPage({ users: [], should_limit_list_of_followers: true }).restricted,
  );
  const c = commentsPage({
    comments: [
      {
        pk: "10",
        user: { pk: "1", username: "a" },
        child_comment_count: 2,
        preview_child_comments: [
          { pk: "11", user: { pk: "2", username: "b" } },
        ],
      },
    ],
    has_more_comments: false,
  });
  assert.equal(c.items[0].replies[0].profile.id, "2");
  assert.equal(
    mediaPage(
      {
        items: [{ media: { pk: "10", user: { pk: "1" }, code: "BA" } }],
        paging_info: { more_available: false },
      },
      true,
    ).items[0].ownerId,
    "1",
  );
});
test("pagination detects repeated or missing cursors", () => {
  assert.throws(() =>
    nextCheckpoint(
      { ...cp, cursor: "same" },
      { items: [], next: "same", more: true },
    ),
  );
  assert.throws(() =>
    nextCheckpoint(cp, { items: [], next: null, more: true }),
  );
  assert.throws(() =>
    nextCheckpoint(
      { ...cp, seenCursors: ["old"] },
      { items: [], next: "old", more: true },
    ),
  );
  assert.equal(
    nextCheckpoint(cp, { items: [], next: "new", more: true }).cursor,
    "new",
  );
});
test("pacing applies saved delays between all requests, without a first-request delay", async () => {
  const d = database();
  let now = 100000;
  const sleeps: number[] = [];
  const p = new Pacer(
    d,
    async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    () => now,
  );
  await p.before();
  await p.before();
  assert.deepEqual(sleeps, [5000]);
  await d.settings.put({
    id: "preferences",
    delaySeconds: 10,
    lastRequestAt: now,
  });
  await p.before();
  assert.deepEqual(sleeps, [5000, 10000]);
  await d.delete();
});
test("request layer stops for challenge, permissions and rate limit; bounds retries and preserves large IDs", async () => {
  const d = database();
  await d.settings.put({ id: "preferences", delaySeconds: 1 });
  let now = 100000;
  const pacer = new Pacer(
    d,
    async (ms) => {
      now += ms;
    },
    () => now,
  );
  const cookie = async () => "not-persisted";
  const rate = new Instagram(
    pacer,
    async () =>
      new Response('{"message":"Please wait a few minutes"}', {
        status: 429,
        headers: { "Retry-After": "120" },
      }),
    cookie,
  );
  await assert.rejects(
    rate.request("/api/v1/test/"),
    (e) => e instanceof CollectionError && e.kind === "rate" && !!e.retryAt,
  );
  // Other error classifications use a fresh logical window; cooldown persistence is tested separately.
  await d.settings.update("preferences", { cooldownUntil: 0 });
  const login = new Instagram(
    pacer,
    async () =>
      new Response('{"message":"challenge_required"}', { status: 400 }),
    cookie,
  );
  await assert.rejects(
    login.request("/api/v1/test/"),
    (e) => e instanceof CollectionError && e.kind === "login",
  );
  const denied = new Instagram(
    pacer,
    async () => new Response("{}", { status: 403 }),
    cookie,
  );
  await assert.rejects(
    denied.request("/api/v1/test/"),
    (e) => e instanceof CollectionError && e.kind === "restricted",
  );
  let calls = 0;
  const retry = new Instagram(
    pacer,
    async () => {
      calls++;
      return new Response("{}", { status: 503 });
    },
    cookie,
    async () => {},
  );
  await assert.rejects(retry.request("/api/v1/test/"));
  assert.equal(calls, 3);
  const large = new Instagram(
    pacer,
    async () => new Response('{"pk":12345678901234567890}'),
    cookie,
  );
  assert.equal(
    (await large.request("/api/v1/test/")).pk,
    "12345678901234567890",
  );
  assert.ok(!JSON.stringify(await exportBackup(d)).includes("not-persisted"));
  await d.delete();
});
function prepared(mode: Resolved["mode"] = "both", post = false): Resolved {
  return {
    source: profile("100", "source"),
    input: post
      ? {
          type: "post",
          shortcode: "BA",
          url: "https://www.instagram.com/p/BA/",
        }
      : { type: "profile", username: "source" },
    mode,
    post: post
      ? { id: "64", ownerId: "100", url: "https://www.instagram.com/p/BA/" }
      : undefined,
    key: post ? "post:64:commenters" : `profile:100:${mode}`,
  };
}
async function runSetup(
  adapter: any,
  mode: Resolved["mode"] = "both",
  post = false,
) {
  const d = database();
  const m = await createMission("Collect", d);
  const p = prepared(mode, post);
  await applyObservation(
    { profiles: [p.source], posts: p.post ? [p.post] : [] },
    d,
  );
  const runner = new Runner(d, adapter);
  const r = await runner.create(p, m.id);
  return { d, m, r, runner };
}
test("both follows traverse all pages, save directions and reuse results without resetting decisions", async () => {
  const calls: string[] = [];
  const adapter = {
    follows: async (_id: string, kind: string, cursor: string | null) => {
      calls.push(`${kind}:${cursor}`);
      return kind === "following"
        ? { items: [profile("1")], next: null, more: false }
        : cursor
          ? { items: [profile("2")], next: null, more: false }
          : { items: [profile("1")], next: "page2", more: true };
    },
  };
  const { d, m, r, runner } = await runSetup(adapter);
  await runner.run(r.id);
  assert.equal((await d.runs.get(r.id))!.status, "completed");
  assert.deepEqual(calls, [
    "followers:null",
    "followers:page2",
    "following:null",
  ]);
  assert.equal((await d.candidates.get([m.id, "1"]))!.score, 2);
  await decide(m.id, "1", "possible", d);
  const other = await createMission("Reuse", d);
  await reuseRun(r.id, other.id, d);
  assert.equal((await d.candidates.get([other.id, "1"]))!.score, 2);
  assert.equal((await d.candidates.get([m.id, "1"]))!.decision, "possible");
  assert.equal(calls.length, 3);
  await d.delete();
});
test("comment collection includes paginated replies and counts unique posts rather than comments", async () => {
  const c = (
    id: string,
    user: string,
    replyCount = 0,
    replies: any[] = [],
  ) => ({ id, profile: profile(user), replyCount, replies });
  const calls: string[] = [];
  const adapter = {
    comments: async (_post: string, cursor: string | null) => {
      calls.push(`comments:${cursor}`);
      return cursor
        ? { items: [c("13", "1")], more: false, next: null }
        : { items: [c("10", "1", 2, [c("11", "2")])], more: true, next: "c2" };
    },
    replies: async (_post: string, _comment: string, cursor: string | null) => {
      calls.push(`replies:${cursor}`);
      return cursor
        ? { items: [c("12", "1")], more: false, next: null }
        : { items: [c("11", "2")], more: true, next: "r2" };
    },
  };
  const { d, m, r, runner } = await runSetup(adapter, "commenters", true);
  await runner.run(r.id);
  assert.equal((await d.runs.get(r.id))!.status, "completed");
  assert.deepEqual(calls, [
    "comments:null",
    "replies:null",
    "replies:r2",
    "comments:c2",
  ]);
  assert.equal((await d.candidates.get([m.id, "1"]))!.score, 1);
  assert.equal((await d.candidates.get([m.id, "2"]))!.score, 1);
  assert.equal(await d.follows.count(), 0);
  assert.equal(await d.seenComments.count(), 4);
  await d.delete();
});
test("profile commenter collection traverses feed and reels and deduplicates shared media", async () => {
  const post = { id: "10", ownerId: "100", url: "" };
  let media = 0;
  let comments = 0;
  const adapter = {
    media: async (_id: string, _cursor: string, channel: string) => {
      media++;
      return { items: [post], more: false, next: null };
    },
    comments: async () => {
      comments++;
      return { items: [], more: false, next: null };
    },
  };
  const { d, r, runner } = await runSetup(adapter, "commenters");
  await runner.run(r.id);
  assert.equal((await d.runs.get(r.id))!.status, "completed");
  assert.equal(media, 2);
  assert.equal(comments, 1);
  await d.delete();
});
test("interrupt, recover and resume use the persisted cursor without duplicating results", async () => {
  let failed = true;
  const cursors: (string | null)[] = [];
  const adapter = {
    follows: async (_id: string, _kind: string, cursor: string | null) => {
      cursors.push(cursor);
      if (cursor && failed) throw new CollectionError("Offline", "network");
      return {
        items: [profile(cursor ? "2" : "1")],
        next: cursor ? null : "saved",
        more: !cursor,
      };
    },
  };
  const { d, r, runner } = await runSetup(adapter, "followers");
  await runner.run(r.id);
  assert.equal((await d.runs.get(r.id))!.checkpoint.cursor, "saved");
  assert.equal((await d.runs.get(r.id))!.status, "partial");
  failed = false;
  await runner.run(r.id);
  assert.equal((await d.runs.get(r.id))!.status, "completed");
  assert.deepEqual(cursors, [null, "saved", "saved"]);
  assert.equal(await d.follows.count(), 2);
  await d.delete();
});
test("repeated cursor, restricted data and reported-count mismatch never become completed", async () => {
  for (const variant of ["repeat", "restricted", "short"]) {
    const adapter = {
      follows: async () => ({
        items: [profile("1")],
        next: variant === "repeat" ? "same" : null,
        more: variant === "repeat",
        restricted: variant === "restricted" ? "Restricted" : undefined,
        expected: variant === "short" ? 9 : undefined,
      }),
    };
    const { d, r, runner } = await runSetup(adapter, "followers");
    await runner.run(r.id);
    assert.equal((await d.runs.get(r.id))!.status, "partial");
    assert.equal(await d.follows.count(), 1);
    await d.delete();
  }
});
test("single-account addition is not an automatic source; cached resolution works without authentication", async () => {
  const { d, m, r, runner } = await runSetup(
    {
      profile: async () => {
        throw new Error("Unexpected request");
      },
    },
    "single",
  );
  assert.equal((await d.runs.get(r.id))!.status, "completed");
  assert.equal(await d.sources.count(), 0);
  assert.equal((await d.candidates.get([m.id, "100"]))!.visible, 1);
  const resolved = await runner.resolve("@source", "single");
  assert.equal(resolved.cached, true);
  await d.delete();
});
test("explicit pause retains progress and login/rate failures have recoverable states", async () => {
  for (const kind of ["login", "rate"] as const) {
    const { d, r, runner } = await runSetup(
      {
        follows: async () => {
          throw new CollectionError(
            "Needs attention",
            kind,
            kind === "rate" ? Date.now() + 60000 : undefined,
          );
        },
      },
      "followers",
    );
    await runner.run(r.id);
    assert.equal(
      (await d.runs.get(r.id))!.status,
      kind === "rate" ? "cooldown" : "paused",
    );
    if (kind === "rate") await assert.rejects(runner.run(r.id));
    await d.delete();
  }
  let runner!: Runner;
  const setup = await runSetup(
    {
      follows: async () => {
        runner.pause();
        throw new DOMException("Paused", "AbortError");
      },
    },
    "followers",
  );
  runner = setup.runner;
  await runner.run(setup.r.id);
  assert.equal((await setup.d.runs.get(setup.r.id))!.status, "paused");
  await setup.d.delete();
});

test("restoring a running job pauses it and rejects nested authentication fields before changing data", async () => {
  const { d, m } = await setup();
  await applyObservation(
    {
      run: {
        id: "restore-run",
        key: "profile:1:followers",
        sourceId: "1",
        targetLabel: "user1",
        mode: "followers",
        scope: "profile",
        status: "running",
        checkpoint: { ...cp, cursor: "saved", seenCursors: ["saved"] },
        createdAt: 1,
        updatedAt: 1,
      },
    },
    d,
  );
  const backup = await exportBackup(d);
  const target = database();
  await restoreBackup(backup, target);
  assert.equal((await target.runs.get("restore-run"))!.status, "paused");
  assert.equal(
    (await target.runs.get("restore-run"))!.checkpoint.cursor,
    "saved",
  );
  const invalid = structuredClone(backup);
  invalid.tables.runs[0].checkpoint.authToken = "not-allowed";
  await assert.rejects(restoreBackup(invalid, target));
  assert.equal(await target.missions.count(), 1);
  await d.delete();
  await target.delete();
});
test("startup recovery and fresh restart preserve historical results and decisions without multiplying scores", async () => {
  let second = false;
  const adapter = {
    follows: async () => ({
      items: second ? [profile("1"), profile("2")] : [profile("1")],
      more: false,
      next: null,
    }),
  };
  const { d, m, r, runner } = await runSetup(adapter, "followers");
  await d.runs.update(r.id, { status: "running" });
  await runner.recover();
  assert.equal((await d.runs.get(r.id))!.status, "paused");
  await runner.run(r.id);
  await decide(m.id, "1", "possible", d);
  second = true;
  const restart = await runner.create(prepared("followers"), m.id);
  await runner.run(restart.id);
  assert.notEqual(restart.id, r.id);
  assert.equal((await d.candidates.get([m.id, "1"]))!.score, 1);
  assert.equal((await d.candidates.get([m.id, "1"]))!.decision, "possible");
  assert.equal(await d.results.where("runId").equals(r.id).count(), 1);
  assert.equal(await d.results.where("runId").equals(restart.id).count(), 2);
  await d.delete();
});

const rawComment = (
  id: string,
  author = id,
  extra: Record<string, any> = {},
) => ({
  pk: id,
  user: { pk: author, username: `person${author}` },
  ...extra,
});
async function testInstagram(fetcher: any) {
  const d = database();
  let now = Date.now();
  const pacer = new Pacer(
    d,
    async (ms) => {
      now += ms;
    },
    () => now,
  );
  const instagram = new Instagram(
    pacer,
    fetcher,
    async () => "synthetic-csrf",
    async (ms) => {
      now += ms;
    },
  );
  return {
    d,
    instagram,
    pacer,
    advance: (time: number) => {
      now = time;
    },
  };
}
test("comment previews and all inline reply representations merge by ID; missing authors keep useful results partial", () => {
  const page = commentsPage({
    preview_comments: [
      rawComment("10", "1", {
        preview_child_comments: [rawComment("11", "2")],
      }),
    ],
    comments: [
      rawComment("10", "1", {
        child_comments: [rawComment("11", "2"), rawComment("12", "3")],
        edge_threaded_comments: {
          count: 3,
          edges: [{ node: rawComment("13", "4") }],
        },
      }),
      { pk: "deleted" },
    ],
    has_more_comments: false,
  });
  assert.equal(page.items.length, 2);
  assert.equal(page.items[1].profile, undefined);
  assert.deepEqual(
    page.items[0].replies.map((r) => r.id),
    ["11", "12", "13"],
  );
  assert.equal(page.items[0].replyCount, 3);
  assert.equal(page.warnings?.length, 1);
});
test("head and tail comment cursors are distinct and queued instead of dropping one branch", () => {
  const page = commentsPage({
    comments: [],
    has_more_comments: true,
    next_max_id: "tail",
    has_more_headload_comments: true,
    next_min_id: "head",
  });
  assert.equal(page.next, "max:tail");
  assert.equal(
    commentsPage({
      comments: [],
      has_more_comments: true,
      next_max_id: "",
      max_id: "alternate",
    }).next,
    "max:alternate",
  );
  assert.equal(
    commentsPage({
      comments: [],
      has_more_headload_comments: true,
      next_min_id: "",
      min_id: "alternate",
    }).next,
    "min:alternate",
  );
  assert.deepEqual(page.pendingCursors, ["min:head"]);
  const next = nextCheckpoint(cp, page);
  assert.equal(next.cursor, "max:tail");
  const head = nextCheckpoint(next, { items: [], more: false, next: null });
  assert.equal(head.cursor, "min:head");
  assert.equal(head.branchStart, true);
  assert.equal(
    nextCheckpoint(head, { items: [], more: false, next: null }).cursor,
    null,
  );
  assert.equal(
    commentsPage({
      comments: [],
      has_more_comments: false,
      has_more_headload_comments: true,
      next_min_id: "older",
    }).next,
    "min:older",
  );
  assert.equal(
    commentsPage(
      {
        child_comments: [],
        has_more_head_child_comments: true,
        next_min_id: "older",
      },
      true,
    ).next,
    "min:older",
  );
});
test("comments and replies send the correct min/max parameter, including legacy saved cursors", async () => {
  const urls: URL[] = [];
  const { d, instagram } = await testInstagram(async (input: string) => {
    const url = new URL(input);
    urls.push(url);
    return new Response(
      JSON.stringify(
        url.pathname.endsWith("child_comments/")
          ? { child_comments: [] }
          : { comments: [] },
      ),
    );
  });
  await instagram.comments("64", "max:tail");
  await instagram.comments("64", "min:head");
  await instagram.comments("64", "legacy");
  await instagram.replies("64", "10", "min:head");
  await instagram.replies("64", "10", "legacy");
  assert.deepEqual(
    urls.map((u) => [
      u.searchParams.get("max_id"),
      u.searchParams.get("min_id"),
    ]),
    [
      ["tail", null],
      [null, "head"],
      [null, "legacy"],
      [null, "head"],
      ["legacy", null],
    ],
  );
  await d.delete();
});
test("follow compatibility fallback uses the alternate host and still paces both requests", async () => {
  const calls: { url: URL; headers: Headers; time: number }[] = [];
  let api: Awaited<ReturnType<typeof testInstagram>>;
  api = await testInstagram(async (input: string, init: RequestInit) => {
    const url = new URL(input);
    calls.push({
      url,
      headers: new Headers(init.headers),
      time: (await api.d.settings.get("preferences"))!.lastRequestAt!,
    });
    return url.hostname === "www.instagram.com"
      ? new Response('{"message":"Not found"}', { status: 404 })
      : new Response(
          JSON.stringify({
            users: [{ pk: "1", username: "one" }],
            more_available: false,
          }),
        );
  });
  const page = await api.instagram.follows("100", "followers", null);
  assert.equal(page.items[0].id, "1");
  assert.deepEqual(
    calls.map((c) => c.url.hostname),
    ["www.instagram.com", "i.instagram.com"],
  );
  assert.equal(calls[0].url.searchParams.get("max_id"), "0");
  assert.ok(calls[1].time - calls[0].time >= 5000);
  assert.equal(calls[0].headers.get("x-asbd-id"), "198387");
  assert.equal(calls[0].headers.get("x-csrftoken"), "synthetic-csrf");
  await api.d.delete();
});
test("fallback never retries login challenges, permission denials or rate limits through another host", async () => {
  for (const [status, body, kind] of [
    [401, "{}", "login"],
    [403, "{}", "restricted"],
    [429, "{}", "rate"],
    [400, '{"message":"challenge_required"}', "login"],
  ] as const) {
    let calls = 0;
    const { d, instagram } = await testInstagram(async () => {
      calls++;
      return new Response(body, { status });
    });
    await assert.rejects(
      instagram.follows("100", "followers", null),
      (e) => e instanceof CollectionError && e.kind === kind,
    );
    assert.equal(calls, 1);
    await d.delete();
  }
});
test("profile lookup can fall back to username feed and prefers high-resolution images without inventing counts", async () => {
  const calls: string[] = [];
  const { d, instagram } = await testInstagram(async (input: string) => {
    calls.push(new URL(input).pathname);
    return input.includes("web_profile_info")
      ? new Response("{}", { status: 404 })
      : new Response(
          JSON.stringify({
            user: {
              pk: "12345678901234567890",
              username: "person",
              profile_pic_url: "low",
              hd_profile_pic_url_info: { url: "high" },
            },
            items: [],
          }),
        );
  });
  const p = await instagram.profile("person");
  assert.equal(p.id, "12345678901234567890");
  assert.equal(p.avatarUrl, "high");
  assert.equal(p.followerCount, undefined);
  assert.equal(calls.length, 2);
  assert.equal(calls[1], "/api/v1/feed/user/person/username/");
  await d.delete();
});
test("numeric follow offsets require explicit continuation and a full page; terminal/restricted/opaque cursors never invent offsets", () => {
  const users = Array.from({ length: 50 }, (_, i) => ({
    pk: String(i + 1),
    username: `person${i}`,
  }));
  assert.equal(listPage({ users, has_more: true }).next, "50");
  assert.equal(listPage({ users, has_more: true }, "50").next, "100");
  assert.equal(listPage({ users, has_more: false }).next, null);
  assert.equal(listPage({ users, has_more: true }, "opaque").next, null);
  assert.equal(
    listPage({ users, has_more: true, should_limit_list_of_followers: true })
      .next,
    null,
  );
  assert.equal(
    listPage({ users: users.slice(0, 2), has_more: true }).next,
    null,
  );
  assert.ok(listPage({ should_limit_list_of_followers: true }).restricted);
});
test("rotating follow cursors with identical pages stop after saving the page instead of looping", async () => {
  let calls = 0;
  const { d, r, runner } = await runSetup(
    {
      follows: async () => ({
        items: [profile("1")],
        next: `cursor-${++calls}`,
        more: true,
      }),
    },
    "followers",
  );
  await runner.run(r.id);
  assert.equal(calls, 2);
  assert.equal((await d.runs.get(r.id))!.status, "partial");
  assert.equal(await d.follows.count(), 1);
  await d.delete();
});
test("queued comment branches survive backup and explicit resume, including an overlapping first head page", async () => {
  let failed = true;
  const calls: (string | null)[] = [];
  const adapter = {
    comments: async (_post: string, cursor: string | null) => {
      calls.push(cursor);
      if (cursor === "max:tail" && failed)
        throw new CollectionError("Offline", "network");
      if (!cursor)
        return commentsPage({
          comments: [rawComment("10", "1")],
          has_more_comments: true,
          next_max_id: "tail",
          has_more_headload_comments: true,
          next_min_id: "head",
        });
      if (cursor === "max:tail")
        return commentsPage({
          comments: [rawComment("11", "2")],
          has_more_comments: false,
        });
      if (cursor === "min:head")
        return commentsPage({
          comments: [rawComment("10", "1")],
          has_more_comments: false,
          has_more_headload_comments: true,
          next_min_id: "head2",
        });
      return commentsPage({
        comments: [rawComment("12", "3")],
        has_more_comments: false,
      });
    },
  };
  const { d, r, runner } = await runSetup(adapter, "commenters", true);
  await runner.run(r.id);
  assert.deepEqual((await d.runs.get(r.id))!.checkpoint.pendingCursors, [
    "min:head",
  ]);
  const backup = await exportBackup(d);
  await restoreBackup(backup, d);
  failed = false;
  await runner.run(r.id);
  assert.equal((await d.runs.get(r.id))!.status, "completed");
  assert.deepEqual(calls, [
    null,
    "max:tail",
    "max:tail",
    "min:head",
    "min:head2",
  ]);
  assert.equal(await d.seenComments.count(), 3);
  await d.delete();
});
test("an exhausted reply endpoint with fewer replies than reported stays partial even without a post count", async () => {
  const { d, r, runner } = await runSetup(
    {
      comments: async () =>
        commentsPage({
          comments: [
            rawComment("10", "1", {
              child_comment_count: 5,
              preview_child_comments: [rawComment("11", "2")],
            }),
          ],
          has_more_comments: false,
        }),
      replies: async () =>
        commentsPage(
          {
            child_comments: [rawComment("11", "2"), rawComment("12", "3")],
            has_more_tail_child_comments: false,
          },
          true,
        ),
    },
    "commenters",
    true,
  );
  await runner.run(r.id);
  const saved = (await d.runs.get(r.id))!;
  assert.equal(saved.status, "partial");
  assert.match(saved.reason!, /2 of 5 reported replies/);
  assert.equal(await d.comments.count(), 3);
  await d.delete();
});
test("an unavailable media endpoint does not discard saved posts or prevent collecting their commenters", async () => {
  const post = { id: "10", ownerId: "100", url: "" };
  const { d, r, runner } = await runSetup(
    {
      media: async (_id: string, _cursor: string, channel: string) => {
        if (channel === "reels")
          throw new CollectionError("Endpoint changed", "schema");
        return { items: [post], next: null, more: false };
      },
      comments: async () =>
        commentsPage({
          comments: [rawComment("10", "1")],
          has_more_comments: false,
        }),
    },
    "commenters",
  );
  await runner.run(r.id);
  assert.equal((await d.runs.get(r.id))!.status, "partial");
  assert.equal((await d.runPosts.get([r.id, "10"]))!.done, 1);
  assert.equal(await d.comments.count(), 1);
  await d.delete();
});
test("media login/access/cooldown decisions still stop the job without continuing to comments", async () => {
  for (const kind of ["login", "restricted", "rate"] as const) {
    let comments = 0;
    const { d, r, runner } = await runSetup(
      {
        media: async () => {
          throw new CollectionError(
            "Stop",
            kind,
            kind === "rate" ? Date.now() + 60000 : undefined,
          );
        },
        comments: async () => {
          comments++;
          return commentsPage({ comments: [] });
        },
      },
      "commenters",
    );
    await runner.run(r.id);
    assert.equal(comments, 0);
    assert.equal(
      (await d.runs.get(r.id))!.status,
      kind === "login" ? "paused" : kind === "rate" ? "cooldown" : "partial",
    );
    await d.delete();
  }
});
test("a failure in the second follow stage is partial, not failed, with the first stage preserved", async () => {
  const { d, r, runner } = await runSetup({
    follows: async (_id: string, kind: string) => {
      if (kind === "following")
        throw new CollectionError("Unavailable", "network");
      return { items: [profile("1")], next: null, more: false };
    },
  });
  await runner.run(r.id);
  assert.equal((await d.runs.get(r.id))!.status, "partial");
  assert.equal(await d.results.where("runId").equals(r.id).count(), 1);
  assert.equal((await d.runs.get(r.id))!.checkpoint.stage, "following");
  await d.delete();
});
test("rate-limit cooldown applies to fresh lookups, survives reload and restore, and resumes only when expired", async () => {
  let requests = 0;
  const { d, instagram, advance } = await testInstagram(async () => {
    requests++;
    return requests === 1
      ? new Response("{}", { status: 429, headers: { "Retry-After": "120" } })
      : new Response('{"ok":true}');
  });
  const oldBackup = await exportBackup(d);
  await assert.rejects(
    instagram.request("/api/v1/test/"),
    (e) =>
      e instanceof CollectionError &&
      e.kind === "rate" &&
      e.message === "Instagram requested a cooldown." &&
      !!e.retryAt,
  );
  const until = (await d.settings.get("preferences"))!.cooldownUntil!;
  assert.ok(until > Date.now());
  await assert.rejects(
    instagram.profile("person"),
    (e) =>
      e instanceof CollectionError &&
      e.kind === "rate" &&
      e.retryAt === until &&
      e.message.includes("No new request was sent"),
  );
  assert.equal(requests, 1);
  await restoreBackup(oldBackup, d);
  assert.equal((await d.settings.get("preferences"))!.cooldownUntil, until);
  const fresh = new Instagram(
    new Pacer(d),
    async () => {
      requests++;
      return new Response("{}");
    },
    async () => "synthetic",
  );
  await assert.rejects(
    fresh.request("/api/v1/test/"),
    (e) => e instanceof CollectionError && e.kind === "rate",
  );
  assert.equal(requests, 1);
  advance(until + 1);
  assert.equal((await instagram.request("/api/v1/test/")).ok, true);
  assert.equal(requests, 2);
  await d.delete();
});

test("merging duplicate reply trees retains descendants present in only one preview representation", () => {
  const page = commentsPage({
    preview_comments: [
      rawComment("10", "1", {
        preview_child_comments: [
          rawComment("11", "2", { child_comments: [rawComment("12", "3")] }),
        ],
      }),
    ],
    comments: [
      rawComment("10", "1", { child_comments: [rawComment("11", "2")] }),
    ],
  });
  assert.equal(page.items[0].replies[0].replies[0].id, "12");
});
test("pause during cookie lookup does not start another network request", async () => {
  const d = database();
  let requests = 0;
  const controller = new AbortController();
  const instagram = new Instagram(
    new Pacer(d),
    async () => {
      requests++;
      return new Response("{}");
    },
    async () => {
      controller.abort();
      return "synthetic";
    },
  );
  await assert.rejects(
    instagram.request("/api/v1/test/", controller.signal),
    (e) => e instanceof DOMException && e.name === "AbortError",
  );
  assert.equal(requests, 0);
  await d.delete();
});

test("available reply authors survive an unavailable parent author and still receive reply pagination", async () => {
  let replyRequests = 0;
  const { d, r, runner } = await runSetup(
    {
      comments: async () =>
        commentsPage({
          comments: [
            {
              pk: "10",
              child_comment_count: 3,
              preview_child_comments: [rawComment("11", "1")],
            },
          ],
          has_more_comments: false,
        }),
      replies: async () => {
        replyRequests++;
        return commentsPage(
          {
            child_comments: [
              rawComment("11", "1"),
              rawComment("12", "2"),
              rawComment("13", "3"),
            ],
            has_more_tail_child_comments: false,
          },
          true,
        );
      },
    },
    "commenters",
    true,
  );
  await runner.run(r.id);
  assert.equal(replyRequests, 1);
  assert.equal(await d.comments.count(), 3);
  assert.equal(await d.results.where("runId").equals(r.id).count(), 3);
  assert.equal((await d.runs.get(r.id))!.status, "partial");
  assert.match(
    (await d.runs.get(r.id))!.reason!,
    /authors or IDs were unavailable/,
  );
  await d.delete();
});
