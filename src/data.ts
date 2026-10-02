import Dexie from "dexie";
import { Database, db } from "./db";
import type {
  Affinity,
  Candidate,
  Decision,
  Mission,
  Observation,
  Profile,
} from "./types";
export const uid = () => crypto.randomUUID();
const searchText = (p?: Profile) =>
  `${p?.userName || ""} ${p?.fullName || ""}`.toLowerCase();
const pair = (a: string, b: string) => JSON.stringify([a, b]);
export async function createMission(name: string, database = db) {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Give your mission a name.");
  const mission: Mission = {
    id: uid(),
    name: trimmed,
    includeSources: false,
    createdAt: Date.now(),
  };
  await database.missions.add(mission);
  return mission;
}
async function addMembers(
  missionId: string,
  ids: string[],
  base: boolean,
  database: Database,
) {
  const mission = await database.missions.get(missionId);
  if (!mission) throw new Error("This mission no longer exists.");
  const sources = await database.sources
    .where("missionId")
    .equals(missionId)
    .toArray();
  const sourceSet = new Set(sources.map((s) => s.profileId));
  for (const id of new Set(ids)) {
    const old = await database.candidates.get([missionId, id]);
    const profile = await database.profiles.get(id);
    if (!profile) continue;
    const weights = await database.affinities.bulkGet(
      [...sourceSet].map((source) => [source, id] as [string, string]),
    );
    const score = weights.reduce((sum, row) => sum + (row?.score || 0), 0);
    const row: Candidate = {
      missionId,
      profileId: id,
      base: base || !!old?.base,
      addedAt: old?.addedAt || Date.now(),
      decision: old?.decision || "unreviewed",
      decisionAt: old?.decisionAt,
      score,
      sortScore: -score,
      visible:
        (base || old?.base || sourceSet.has(id)) &&
        (!sourceSet.has(id) || mission.includeSources)
          ? 1
          : 0,
      search: searchText(profile),
    };
    await database.candidates.put(row);
  }
}
export async function rebuildMission(missionId: string, database = db) {
  const mission = await database.missions.get(missionId);
  if (!mission) return;
  const sources = await database.sources
    .where("missionId")
    .equals(missionId)
    .toArray();
  const sourceSet = new Set(sources.map((s) => s.profileId));
  await addMembers(missionId, [...sourceSet], false, database);
  const totals = new Map<string, number>();
  if (sources.length)
    for (const a of await database.affinities
      .where("sourceId")
      .anyOf([...sourceSet])
      .toArray())
      totals.set(a.profileId, (totals.get(a.profileId) || 0) + a.score);
  const candidates = await database.candidates
    .where("missionId")
    .equals(missionId)
    .toArray();
  await database.candidates.bulkPut(
    candidates.map((c) => {
      const score = totals.get(c.profileId) || 0;
      return {
        ...c,
        score,
        sortScore: -score,
        visible:
          (c.base || sourceSet.has(c.profileId)) &&
          (!sourceSet.has(c.profileId) || mission.includeSources)
            ? 1
            : 0,
      };
    }),
  );
}
export async function setSource(
  missionId: string,
  profileId: string,
  active: boolean,
  database = db,
) {
  await database.transaction(
    "rw",
    [
      database.missions,
      database.sources,
      database.candidates,
      database.profiles,
      database.affinities,
    ],
    async () => {
      if (active) {
        if (!(await database.profiles.get(profileId)))
          throw new Error("Profile not found.");
        await database.sources.put({
          missionId,
          profileId,
          addedAt: Date.now(),
        });
      } else await database.sources.delete([missionId, profileId]);
      await rebuildMission(missionId, database);
    },
  );
}
export async function includeSources(
  missionId: string,
  include: boolean,
  database = db,
) {
  await database.transaction(
    "rw",
    [
      database.missions,
      database.sources,
      database.candidates,
      database.profiles,
      database.affinities,
    ],
    async () => {
      await database.missions.update(missionId, { includeSources: include });
      await rebuildMission(missionId, database);
    },
  );
}
export async function decide(
  missionId: string,
  profileId: string,
  decision: Decision,
  database = db,
) {
  await database.candidates.update([missionId, profileId], {
    decision,
    decisionAt: decision === "unreviewed" ? undefined : Date.now(),
  });
}
export async function applyObservation(
  observation: Observation,
  database = db,
) {
  await database.transaction("rw", database.tables, async () => {
    const profiles = [
      ...new Map((observation.profiles || []).map((p) => [p.id, p])).values(),
    ];
    for (const p of profiles) {
      if (!p.id) throw new Error("Instagram returned a profile without an ID.");
      const old = await database.profiles.get(p.id);
      await database.profiles.put({
        ...old,
        ...p,
        avatarUrl: p.avatarUrl || old?.avatarUrl || "",
        fullName: p.fullName || old?.fullName || "",
      });
      await database.candidates
        .where("profileId")
        .equals(p.id)
        .modify({ search: searchText({ ...old, ...p }) });
    }
    if (observation.posts?.length)
      await database.posts.bulkPut(observation.posts);
    const deltas = new Map<string, Affinity>();
    const delta = (sourceId: string, profileId: string) => {
      if (sourceId === profileId) return;
      const k = pair(sourceId, profileId);
      const old = deltas.get(k);
      deltas.set(k, { sourceId, profileId, score: (old?.score || 0) + 1 });
    };
    for (const f of observation.follows || []) {
      if (f.followerId === f.followingId) continue;
      if (!(await database.follows.get([f.followerId, f.followingId]))) {
        delta(f.followerId, f.followingId);
        delta(f.followingId, f.followerId);
      }
      await database.follows.put(f);
    }
    for (const [table, items] of [
      [database.comments, observation.comments || []],
      [database.likes, observation.likes || []],
    ] as const)
      for (const c of items) {
        const post = await database.posts.get(c.postId);
        if (!post || post.ownerId !== c.ownerId)
          throw new Error("Comment owner does not match its post.");
        if (!(await table.get([c.postId, c.profileId])))
          delta(c.ownerId, c.profileId);
        await table.put(c);
      }
    for (const a of deltas.values()) {
      const old = await database.affinities.get([a.sourceId, a.profileId]);
      await database.affinities.put({
        ...a,
        score: (old?.score || 0) + a.score,
      });
      for (const s of await database.sources
        .where("profileId")
        .equals(a.sourceId)
        .toArray()) {
        const c = await database.candidates.get([s.missionId, a.profileId]);
        if (c)
          await database.candidates.update([s.missionId, a.profileId], {
            score: c.score + a.score,
            sortScore: -(c.score + a.score),
          });
      }
    }
    if (observation.run) await database.runs.put(observation.run);
    if (observation.results?.length)
      await database.results.bulkPut(observation.results);
    if (observation.runPosts?.length)
      await database.runPosts.bulkPut(observation.runPosts);
    if (observation.threads?.length)
      await database.threads.bulkPut(observation.threads);
    if (observation.seenComments?.length)
      await database.seenComments.bulkPut(observation.seenComments);
    let missions = observation.missionIds || [];
    if (observation.run)
      missions = [
        ...new Set([
          ...missions,
          ...(
            await database.runLinks
              .where("runId")
              .equals(observation.run.id)
              .toArray()
          ).map((l) => l.missionId),
        ]),
      ];
    const memberIds =
      observation.results?.map((r) => r.profileId) || profiles.map((p) => p.id);
    for (const missionId of missions)
      await addMembers(missionId, memberIds, true, database);
  });
}
export async function reuseRun(
  runId: string,
  missionId: string,
  database = db,
) {
  await database.transaction("rw", database.tables, async () => {
    const run = await database.runs.get(runId);
    if (!run) throw new Error("Collection not found.");
    if (
      run.mode !== "single" &&
      !(await database.sources.get([missionId, run.sourceId]))
    )
      await database.sources.put({
        missionId,
        profileId: run.sourceId,
        addedAt: Date.now(),
      });
    await database.runLinks.put({ runId, missionId });
    await addMembers(
      missionId,
      (await database.results.where("runId").equals(runId).toArray()).map(
        (r) => r.profileId,
      ),
      true,
      database,
    );
    await rebuildMission(missionId, database);
  });
}
export async function candidatePage(
  missionId: string,
  decision: Decision | "all",
  search = "",
  page = 0,
  limit = 40,
  database = db,
) {
  const index =
    decision === "all"
      ? "[missionId+visible+sortScore+addedAt+profileId]"
      : "[missionId+visible+decision+sortScore+addedAt+profileId]";
  const prefix: (string | number)[] =
    decision === "all" ? [missionId, 1] : [missionId, 1, decision];
  const collection = () => {
    const rows = database.candidates
      .where(index)
      .between([...prefix, Dexie.minKey], [...prefix, Dexie.maxKey]);
    return search.trim()
      ? rows.filter((c) => c.search.includes(search.toLowerCase().trim()))
      : rows;
  };
  const [count, rows] = await Promise.all([
    collection().count(),
    collection()
      .offset(page * limit)
      .limit(limit)
      .toArray(),
  ]);
  const profiles = await database.profiles.bulkGet(
    rows.map((c) => c.profileId),
  );
  return {
    count,
    rows: rows
      .map((c, i) => ({ ...c, profile: profiles[i]! }))
      .filter((c) => c.profile),
  };
}
/** Rebuild derived weights after removing observations or restoring a backup. */
export async function rebuildAffinities(database = db) {
  const weights = new Map<string, Affinity>();
  const add = (sourceId: string, profileId: string) => {
    if (sourceId === profileId) return;
    const key = pair(sourceId, profileId);
    weights.set(key, {
      sourceId,
      profileId,
      score: (weights.get(key)?.score || 0) + 1,
    });
  };
  for (const f of await database.follows.toArray()) {
    add(f.followerId, f.followingId);
    add(f.followingId, f.followerId);
  }
  for (const c of [
    ...(await database.comments.toArray()),
    ...(await database.likes.toArray()),
  ])
    add(c.ownerId, c.profileId);
  await database.affinities.clear();
  if (weights.size) await database.affinities.bulkPut([...weights.values()]);
  for (const m of await database.missions.toArray())
    await rebuildMission(m.id, database);
}
export async function deleteMission(
  id: string,
  database = db,
  deleteSharedCandidates = false,
) {
  await database.transaction("rw", database.tables, async () => {
    if (
      (await database.runs.where("status").equals("running").count()) ||
      (await database.pendingPageJobs.where("status").equals("running").count())
    )
      throw new Error("Pause collection before deleting a mission.");
    // Keep excluded source-only profiles; included sources are review candidates too.
    const members = await database.candidates
      .where("missionId")
      .equals(id)
      .toArray();
    const targets = members
      .filter((c) => c.base || c.visible === 1)
      .map((c) => c.profileId);
    await database.pendingPageJobs.where("missionId").equals(id).delete();
    await database.missions.delete(id);
    await database.candidates.where("missionId").equals(id).delete();
    await database.sources.where("missionId").equals(id).delete();
    await database.runLinks.where("missionId").equals(id).delete();
    if (!targets.length) return;
    const shared = new Set<string>();
    if (!deleteSharedCandidates) {
      for (const c of await database.candidates
        .where("profileId")
        .anyOf(targets)
        .toArray())
        if (c.base || c.visible === 1) shared.add(c.profileId);
      for (const s of await database.sources
        .where("profileId")
        .anyOf(targets)
        .toArray())
        shared.add(s.profileId);
    }
    const ids = targets.filter((profileId) => !shared.has(profileId));
    if (!ids.length) return;
    const removed = new Set(ids);
    const posts = await database.posts.where("ownerId").anyOf(ids).toArray();
    const postIds = new Set(posts.map((p) => p.id));
    const results = await database.results
      .filter((r) => removed.has(r.profileId))
      .toArray();
    const affected = new Set(results.map((r) => r.runId));
    for (const r of await database.runPosts
      .filter((r) => postIds.has(r.postId))
      .toArray())
      affected.add(r.runId);
    const runs = await database.runs.toArray();
    const erasedRuns = new Set(
      runs
        .filter(
          (r) =>
            removed.has(r.sourceId) ||
            (r.targetPostId && postIds.has(r.targetPostId)),
        )
        .map((r) => r.id),
    );
    await database.profiles.bulkDelete(ids);
    await database.candidates.where("profileId").anyOf(ids).delete();
    await database.sources.where("profileId").anyOf(ids).delete();
    await database.follows.where("followerId").anyOf(ids).delete();
    await database.follows.where("followingId").anyOf(ids).delete();
    for (const table of [database.comments, database.likes])
      await table
        .filter(
          (c) =>
            removed.has(c.profileId) ||
            removed.has(c.ownerId) ||
            postIds.has(c.postId),
        )
        .delete();
    await database.posts.bulkDelete([...postIds]);
    await database.results
      .filter((r) => removed.has(r.profileId) || erasedRuns.has(r.runId))
      .delete();
    await database.runs.bulkDelete([...erasedRuns]);
    await database.runLinks.filter((r) => erasedRuns.has(r.runId)).delete();
    // A cached traversal is no longer complete after its saved results are deleted.
    // Close its checkpoints so explicit recollection starts from a valid state.
    for (const r of runs) {
      if (affected.has(r.id) && !erasedRuns.has(r.id))
        await database.runs.put({
          ...r,
          status: "partial",
          completedAt: undefined,
          retryAt: undefined,
          reason:
            "Candidates were deleted. Collect again to refresh saved results.",
          updatedAt: Date.now(),
          checkpoint: {
            stage: "done",
            cursor: null,
            seenCursors: [],
            pageCount: 0,
            stageCount: 0,
          },
        });
    }
    for (const table of [
      database.pageReceipts,
      database.runPosts,
      database.threads,
      database.seenComments,
    ])
      await table
        .filter(
          (r) =>
            erasedRuns.has(r.runId) ||
            affected.has(r.runId) ||
            ("postId" in r && postIds.has(r.postId)),
        )
        .delete();
    await rebuildAffinities(database);
  });
}
