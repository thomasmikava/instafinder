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
    for (const c of observation.comments || []) {
      const post = await database.posts.get(c.postId);
      if (!post || post.ownerId !== c.ownerId)
        throw new Error("Comment owner does not match its post.");
      if (!(await database.comments.get([c.postId, c.profileId])))
        delta(c.ownerId, c.profileId);
      await database.comments.put(c);
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
    if (run.mode !== "single")
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
export async function deleteMission(id: string, database = db) {
  await database.transaction(
    "rw",
    [
      database.missions,
      database.candidates,
      database.sources,
      database.runLinks,
    ],
    async () => {
      await database.missions.delete(id);
      await database.candidates.where("missionId").equals(id).delete();
      await database.sources.where("missionId").equals(id).delete();
      await database.runLinks.where("missionId").equals(id).delete();
    },
  );
}
