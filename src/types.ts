export type Decision = "unreviewed" | "no" | "unlikely" | "possible";
export type Mode =
  "single" | "followers" | "following" | "both" | "commenters" | "likers";
export interface Profile {
  id: string;
  userName: string;
  fullName: string;
  profileUrl: string;
  avatarUrl: string;
  updatedAt: number;
  followerCount?: number;
  followingCount?: number;
  postCount?: number;
}
export interface Mission {
  id: string;
  name: string;
  includeSources: boolean;
  createdAt: number;
}
export interface Candidate {
  missionId: string;
  profileId: string;
  base: boolean;
  addedAt: number;
  decision: Decision;
  decisionAt?: number;
  score: number;
  sortScore: number;
  visible: number;
  search: string;
}
export interface Source {
  missionId: string;
  profileId: string;
  addedAt: number;
}
export interface Follow {
  followerId: string;
  followingId: string;
  lastSeenAt: number;
}
export interface Post {
  id: string;
  ownerId: string;
  url: string;
  commentCount?: number;
  likeCount?: number;
}
export interface CommentLink {
  postId: string;
  profileId: string;
  ownerId: string;
  lastSeenAt: number;
}
export interface LikeLink extends CommentLink {}
export interface Affinity {
  sourceId: string;
  profileId: string;
  score: number;
}
export type Stage =
  "followers" | "following" | "media" | "comments" | "likes" | "done";
export type RunStatus =
  "paused" | "running" | "completed" | "partial" | "failed" | "cooldown";
export interface Checkpoint {
  stage: Stage;
  cursor: string | null;
  channel?: "feed" | "reels";
  postId?: string;
  seenCursors: string[];
  pendingCursors?: string[];
  branchStart?: boolean;
  pageCount: number;
  stageCount: number;
  commentsDone?: boolean;
}
export type CollectionMethod = "page" | "direct";
export interface Run {
  method?: CollectionMethod;
  pageInput?: Input;
  pageEpoch?: string;
  pageAutomatic?: boolean;
  id: string;
  key: string;
  sourceId: string;
  targetLabel: string;
  mode: Mode;
  scope: "profile" | "post";
  targetPostId?: string;
  status: RunStatus;
  checkpoint: Checkpoint;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  historyHiddenAt?: number;
  reason?: string;
  retryAt?: number;
  expected?: number;
  warnings?: string[];
}
export interface RunLink {
  runId: string;
  missionId: string;
}
export interface RunResult {
  runId: string;
  kind: string;
  profileId: string;
}
export interface RunPost {
  runId: string;
  postId: string;
  done: number;
  commentCount: number;
}
export interface Thread {
  runId: string;
  postId: string;
  commentId: string;
  cursor: string | null;
  seenCursors: string[];
  pendingCursors?: string[];
  branchStart?: boolean;
  expectedCount?: number;
  fetchedCount?: number;
  pageCount?: number;
  done: number;
}
export interface SeenComment {
  runId: string;
  postId: string;
  commentId: string;
}
export interface Settings {
  id: string;
  delaySeconds: number;
  pageDelaySeconds?: number;
  lastRequestAt?: number;
  cooldownUntil?: number;
  pageCooldownUntil?: number;
  collectionMethod?: CollectionMethod;
}
export interface Observation {
  profiles?: Profile[];
  follows?: Follow[];
  posts?: Post[];
  comments?: CommentLink[];
  likes?: LikeLink[];
  run?: Run;
  results?: RunResult[];
  runPosts?: RunPost[];
  threads?: Thread[];
  seenComments?: SeenComment[];
  missionIds?: string[];
}
export interface Page<T> {
  items: T[];
  next: string | null;
  more: boolean;
  restricted?: string;
  expected?: number;
  pendingCursors?: string[];
  warnings?: string[];
}
export interface CommentItem {
  id: string;
  profile?: Profile;
  replyCount: number;
  replies: CommentItem[];
}
export type Input =
  | { type: "profile"; username: string }
  | { type: "post"; shortcode: string; url: string };
export interface Resolved {
  source: Profile;
  post?: Post;
  input: Input;
  key: string;
  mode: Mode;
  cached?: boolean;
}

export interface PendingPageJob {
  id: string;
  missionId: string;
  input: Input;
  mode: Mode;
  automatic: boolean;
  status: RunStatus;
  createdAt: number;
  updatedAt: number;
  reason?: string;
  retryAt?: number;
}
export interface PageReceipt {
  id: string;
  runId: string;
  epoch: string;
  kind:
    | "followers"
    | "following"
    | "feed"
    | "reels"
    | "comments"
    | "replies"
    | "likes";
  targetId: string;
  requestCursor: string;
  nextCursors: string[];
  terminal: boolean;
  updatedAt: number;
}
