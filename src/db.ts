import Dexie, { type Table } from "dexie";
import type {
  Profile,
  Mission,
  Candidate,
  Source,
  Follow,
  Post,
  CommentLink,
  Affinity,
  Run,
  RunLink,
  RunResult,
  RunPost,
  Thread,
  SeenComment,
  Settings,
} from "./types";
export class Database extends Dexie {
  profiles!: Table<Profile, string>;
  missions!: Table<Mission, string>;
  candidates!: Table<Candidate, [string, string]>;
  sources!: Table<Source, [string, string]>;
  follows!: Table<Follow, [string, string]>;
  posts!: Table<Post, string>;
  comments!: Table<CommentLink, [string, string]>;
  affinities!: Table<Affinity, [string, string]>;
  runs!: Table<Run, string>;
  runLinks!: Table<RunLink, [string, string]>;
  results!: Table<RunResult, [string, string, string]>;
  runPosts!: Table<RunPost, [string, string]>;
  threads!: Table<Thread, [string, string, string]>;
  seenComments!: Table<SeenComment, [string, string, string]>;
  settings!: Table<Settings, string>;
  constructor(name = "instafinder") {
    super(name);
    this.version(1).stores({
      profiles: "id, userName",
      missions: "id, createdAt",
      candidates:
        "[missionId+profileId], missionId, profileId, [missionId+visible], [missionId+visible+decision], [missionId+visible+sortScore+addedAt+profileId], [missionId+visible+decision+sortScore+addedAt+profileId]",
      sources: "[missionId+profileId], missionId, profileId",
      follows: "[followerId+followingId], followerId, followingId",
      posts: "id, ownerId",
      comments: "[postId+profileId], ownerId, profileId",
      affinities: "[sourceId+profileId], sourceId, profileId",
      runs: "id, key, updatedAt, status",
      runLinks: "[runId+missionId], runId, missionId",
      results: "[runId+kind+profileId], runId",
      runPosts: "[runId+postId], runId, [runId+done]",
      threads: "[runId+postId+commentId], runId, [runId+postId+done]",
      seenComments: "[runId+postId+commentId], runId",
      settings: "id",
    });
  }
}
export const db = new Database();
export async function preferences(database = db): Promise<Settings> {
  return (
    (await database.settings.get("preferences")) || {
      id: "preferences",
      delaySeconds: 5,
    }
  );
}
