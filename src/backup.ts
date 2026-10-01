import { db, preferences, type Database } from "./db";
import { rebuildMission } from "./data";
const names = [
  "profiles",
  "missions",
  "candidates",
  "sources",
  "follows",
  "posts",
  "comments",
  "affinities",
  "runs",
  "runLinks",
  "results",
  "runPosts",
  "threads",
  "seenComments",
  "settings",
] as const;
export interface Backup {
  format: "instafinder";
  version: 1;
  createdAt: string;
  tables: Record<string, Record<string, any>[]>;
}
export async function exportBackup(database = db): Promise<Backup> {
  return database.transaction("r", database.tables, async () => {
    const tables: Backup["tables"] = {};
    for (const name of names)
      tables[name] = await database.table(name).toArray();
    tables.settings = tables.settings.map((s) => ({
      id: "preferences",
      delaySeconds: s.delaySeconds,
      ...(s.cooldownUntil ? { cooldownUntil: s.cooldownUntil } : {}),
    }));
    return {
      format: "instafinder",
      version: 1,
      createdAt: new Date().toISOString(),
      tables,
    };
  });
}
export function validateBackup(input: unknown): Backup {
  const b = input as Backup;
  if (
    !b ||
    b.format !== "instafinder" ||
    b.version !== 1 ||
    !b.tables ||
    typeof b.tables !== "object"
  )
    throw new Error("This is not a supported InstaFinder backup.");
  if (
    Object.keys(b.tables).some(
      (name) => !names.includes(name as (typeof names)[number]),
    )
  )
    throw new Error("Backup contains unknown tables.");
  const rejectAuth = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (/cookie|token|password|csrf|session/i.test(key))
        throw new Error(
          "Authentication data must not be included in a backup.",
        );
      rejectAuth(child);
    }
  };
  rejectAuth(b.tables);
  const hasString = (row: any, key: string) =>
    typeof row[key] === "string" && row[key].length > 0;
  const required: Record<string, string[]> = {
    profiles: ["id", "userName"],
    missions: ["id", "name"],
    candidates: ["missionId", "profileId"],
    sources: ["missionId", "profileId"],
    follows: ["followerId", "followingId"],
    posts: ["id", "ownerId"],
    comments: ["postId", "profileId", "ownerId"],
    affinities: ["sourceId", "profileId"],
    runs: ["id", "key", "sourceId"],
    runLinks: ["runId", "missionId"],
    results: ["runId", "kind", "profileId"],
    runPosts: ["runId", "postId"],
    threads: ["runId", "postId", "commentId"],
    seenComments: ["runId", "postId", "commentId"],
    settings: ["id"],
  };
  for (const name of names) {
    if (!Array.isArray(b.tables[name]))
      throw new Error(`Backup is missing ${name}.`);
    for (const row of b.tables[name]) {
      if (
        !row ||
        typeof row !== "object" ||
        required[name].some((k) => !hasString(row, k))
      )
        throw new Error(`Invalid ${name} record.`);
      if (
        Object.keys(row).some((k) =>
          /cookie|token|password|csrf|session/i.test(k),
        )
      )
        throw new Error(
          "Authentication data must not be included in a backup.",
        );
    }
  }
  const profiles = new Set(b.tables.profiles.map((p) => p.id));
  const missions = new Set(b.tables.missions.map((m) => m.id));
  const posts = new Map(b.tables.posts.map((p) => [p.id, p.ownerId]));
  const runs = new Set(b.tables.runs.map((r) => r.id));
  for (const p of b.tables.profiles)
    if (
      !/^\d+$/.test(p.id) ||
      !/^[a-zA-Z0-9_.]{1,30}$/.test(p.userName) ||
      typeof p.fullName !== "string" ||
      typeof p.avatarUrl !== "string"
    )
      throw new Error("Invalid profile fields.");
  for (const m of b.tables.missions)
    if (typeof m.includeSources !== "boolean" || !Number.isFinite(m.createdAt))
      throw new Error("Invalid mission settings.");
  for (const c of b.tables.candidates)
    if (
      !profiles.has(c.profileId) ||
      !missions.has(c.missionId) ||
      !["unreviewed", "no", "unlikely", "possible"].includes(c.decision) ||
      typeof c.base !== "boolean" ||
      !Number.isFinite(c.addedAt)
    )
      throw new Error("Invalid candidate or decision.");
  for (const s of b.tables.sources)
    if (!profiles.has(s.profileId) || !missions.has(s.missionId))
      throw new Error("Invalid source reference.");
  for (const f of b.tables.follows)
    if (!profiles.has(f.followerId) || !profiles.has(f.followingId))
      throw new Error("Invalid follow reference.");
  for (const c of b.tables.comments)
    if (!profiles.has(c.profileId) || posts.get(c.postId) !== c.ownerId)
      throw new Error("Invalid comment reference.");
  for (const r of b.tables.runs)
    if (
      !profiles.has(r.sourceId) ||
      !["single", "followers", "following", "both", "commenters"].includes(
        r.mode,
      ) ||
      !["profile", "post"].includes(r.scope) ||
      !["followers", "following", "media", "comments", "done"].includes(
        r.checkpoint?.stage,
      ) ||
      !Array.isArray(r.checkpoint.seenCursors) ||
      ![
        "running",
        "paused",
        "completed",
        "partial",
        "failed",
        "cooldown",
      ].includes(r.status)
    )
      throw new Error("Invalid collection checkpoint.");
  for (const l of b.tables.runLinks)
    if (!runs.has(l.runId) || !missions.has(l.missionId))
      throw new Error("Invalid collection mission reference.");
  for (const r of b.tables.results)
    if (!runs.has(r.runId) || !profiles.has(r.profileId))
      throw new Error("Invalid collection result.");
  for (const r of b.tables.runPosts)
    if (
      !runs.has(r.runId) ||
      !posts.has(r.postId) ||
      ![0, 1].includes(r.done) ||
      !Number.isFinite(r.commentCount) ||
      r.commentCount < 0
    )
      throw new Error("Invalid collected post reference.");
  const invalidQueue = (value: unknown) =>
    value !== undefined &&
    (!Array.isArray(value) ||
      value.some((cursor) => typeof cursor !== "string"));
  const invalidCount = (value: unknown) =>
    value !== undefined && (!Number.isFinite(value) || Number(value) < 0);
  for (const t of b.tables.threads)
    if (
      ![0, 1].includes(t.done) ||
      (t.cursor !== null && typeof t.cursor !== "string") ||
      !Array.isArray(t.seenCursors) ||
      t.seenCursors.some((c: unknown) => typeof c !== "string") ||
      invalidQueue(t.pendingCursors) ||
      (t.branchStart !== undefined && typeof t.branchStart !== "boolean") ||
      invalidCount(t.expectedCount) ||
      invalidCount(t.fetchedCount) ||
      invalidCount(t.pageCount)
    )
      throw new Error("Invalid reply checkpoint.");
  for (const r of b.tables.runs)
    if (
      (r.checkpoint.cursor !== null &&
        typeof r.checkpoint.cursor !== "string") ||
      r.checkpoint.seenCursors.some((c: unknown) => typeof c !== "string") ||
      !Number.isFinite(r.checkpoint.pageCount) ||
      !Number.isFinite(r.checkpoint.stageCount) ||
      invalidQueue(r.checkpoint.pendingCursors) ||
      (r.checkpoint.branchStart !== undefined &&
        typeof r.checkpoint.branchStart !== "boolean")
    )
      throw new Error("Invalid pagination state.");
  for (const t of [...b.tables.threads, ...b.tables.seenComments])
    if (!runs.has(t.runId) || !posts.has(t.postId))
      throw new Error("Invalid comment checkpoint reference.");
  for (const s of b.tables.settings)
    if (
      s.id !== "preferences" ||
      !Number.isFinite(s.delaySeconds) ||
      s.delaySeconds < 1 ||
      s.delaySeconds > 3600 ||
      invalidCount(s.cooldownUntil)
    )
      throw new Error("Invalid request delay.");
  return b;
}
export async function restoreBackup(input: unknown, database = db) {
  const b = validateBackup(input);
  const profileMap = new Map(b.tables.profiles.map((p) => [p.id, p]));
  await database.transaction("rw", database.tables, async () => {
    const localTiming = await preferences(database);
    for (const name of names) await database.table(name).clear();
    for (const name of names) {
      if (name === "affinities") continue;
      let rows = b.tables[name];
      if (name === "profiles")
        rows = rows.map((p) => ({
          ...p,
          profileUrl: `https://www.instagram.com/${encodeURIComponent(p.userName)}/`,
        }));
      if (name === "candidates")
        rows = rows.map((c) => {
          const p = profileMap.get(c.profileId)!;
          return {
            ...c,
            score: 0,
            sortScore: 0,
            visible: 0,
            search: `${p.userName} ${p.fullName}`.toLowerCase(),
          };
        });
      if (name === "runs")
        rows = rows.map((r) =>
          r.status === "running"
            ? {
                ...r,
                status: "paused",
                reason: "Restored collection. Resume when ready.",
              }
            : r,
        );
      if (name === "settings")
        rows = rows.map((s) => ({
          id: "preferences",
          delaySeconds: s.delaySeconds,
          ...(s.cooldownUntil ? { cooldownUntil: s.cooldownUntil } : {}),
        }));
      if (rows.length) await database.table(name).bulkPut(rows);
    }
    // Restoring older data must not erase a cooldown already required by Instagram.
    const restoredTiming = await preferences(database);
    await database.settings.put({
      ...restoredTiming,
      lastRequestAt: localTiming.lastRequestAt,
      cooldownUntil: Math.max(
        localTiming.cooldownUntil || 0,
        restoredTiming.cooldownUntil || 0,
      ),
    });
    const weights = new Map<
      string,
      { sourceId: string; profileId: string; score: number }
    >();
    const add = (sourceId: string, profileId: string) => {
      if (sourceId === profileId) return;
      const k = JSON.stringify([sourceId, profileId]);
      const prev = weights.get(k);
      weights.set(k, { sourceId, profileId, score: (prev?.score || 0) + 1 });
    };
    for (const f of await database.follows.toArray()) {
      add(f.followerId, f.followingId);
      add(f.followingId, f.followerId);
    }
    for (const c of await database.comments.toArray())
      add(c.ownerId, c.profileId);
    if (weights.size) await database.affinities.bulkPut([...weights.values()]);
    for (const m of await database.missions.toArray())
      await rebuildMission(m.id, database);
  });
}
export function download(name: string, text: string) {
  const url = URL.createObjectURL(
    new Blob([text], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
