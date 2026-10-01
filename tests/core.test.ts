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
import { exportBackup, restoreBackup } from "../src/backup";
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
test("mission deletion preserves shared profiles, edges and history", async () => {
  const { d, m } = await setup();
  await applyObservation(
    { follows: [{ followerId: "2", followingId: "1", lastSeenAt: 1 }] },
    d,
  );
  await deleteMission(m.id, d);
  assert.equal(await d.profiles.count(), 4);
  assert.equal(await d.follows.count(), 1);
  assert.equal(await d.candidates.count(), 0);
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
  assert.throws(() => parseInput("https://instagram.com.evil.test/name/"));
  assert.throws(() => parseInput("https://instagram.com/accounts/login/"));
  assert.throws(() => parseInput("http://instagram.com/alice/"));
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
