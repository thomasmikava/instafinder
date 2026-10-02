import { db, type Database } from "./db";
import type { Run } from "./types";

async function canHide(run: Run, database: Database) {
  if (run.historyHiddenAt || ["running", "completed"].includes(run.status))
    return false;
  return !!(await database.runs
    .where("key")
    .equals(run.key)
    .filter(
      (newer) =>
        newer.status === "completed" &&
        newer.updatedAt > run.updatedAt &&
        newer.sourceId === run.sourceId &&
        newer.mode === run.mode &&
        newer.scope === run.scope &&
        newer.targetPostId === run.targetPostId,
    )
    .first());
}

export async function collectionHistory(page: number, database = db) {
  return database.transaction(
    "r",
    database.runs,
    database.results,
    async () => {
      const visible = () =>
        database.runs
          .orderBy("updatedAt")
          .reverse()
          .filter((run) => !run.historyHiddenAt);
      const total = await visible().count();
      const runs = await visible()
        .offset(page * 20)
        .limit(20)
        .toArray();
      const rows = await Promise.all(
        runs.map(async (run) => ({
          ...run,
          canHide: await canHide(run, database),
          count: new Set(
            (
              await database.results.where("runId").equals(run.id).toArray()
            ).map((result) => result.profileId),
          ).size,
        })),
      );
      return { rows, total };
    },
  );
}

export async function hideCollectionHistory(id: string, database = db) {
  await database.transaction("rw", database.runs, async () => {
    const run = await database.runs.get(id);
    if (!run || !(await canHide(run, database)))
      throw new Error(
        "Only older unfinished collections covered by a completed collection can be cleared.",
      );
    // Keep results, checkpoint, cache eligibility, timestamps and global facts intact.
    await database.runs.update(id, { historyHiddenAt: Date.now() });
  });
}
