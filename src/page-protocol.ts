import type {
  CommentItem,
  Input,
  Mode,
  PageReceipt,
  Post,
  Profile,
  RunStatus,
  Stage,
} from "./types";
export const BRIDGE = "instafinder-page-v1";
export interface PageBinding {
  jobId: string;
  input: Input;
  mode: Mode;
  sourceId?: string;
  postId?: string;
}
export interface Capture {
  kind: "profile" | "media-info" | PageReceipt["kind"] | "error";
  source?: Profile;
  profiles: Profile[];
  posts: Post[];
  comments: CommentItem[];
  targetId?: string;
  parentId?: string;
  requestCursor: string;
  nextCursors: string[];
  terminal: boolean;
  preview?: boolean;
  restriction?: string;
  failure?: "rate" | "login" | "restricted" | "schema" | "network";
  retryAt?: number;
  warnings: string[];
}
export interface PageGoal extends PageBinding {
  stage: Stage | "profile";
  channel?: "feed" | "reels";
  postUrl?: string;
  threadId?: string;
  automatic: boolean;
  count: number;
  hint?: string;
}
export interface PageOutcome {
  status: Exclude<RunStatus, "running">;
  count: number;
  reason?: string;
  retryAt?: number;
  resumable?: boolean;
}
export function cleanOutcome(value: any): PageOutcome | undefined {
  if (
    !value ||
    !["completed", "partial", "paused", "failed", "cooldown"].includes(
      value.status,
    ) ||
    !Number.isSafeInteger(value.count) ||
    value.count < 0
  )
    return;
  return {
    status: value.status,
    count: value.count,
    resumable: value.resumable === true,
    reason:
      typeof value.reason === "string" ? value.reason.slice(0, 500) : undefined,
    retryAt:
      Number.isFinite(value.retryAt) && value.retryAt > 0
        ? value.retryAt
        : undefined,
  };
}
export type DriverEvent =
  | { type: "capture"; capture: Capture }
  | { type: "automatic"; value: boolean }
  | { type: "pause" | "finish" }
  | { type: "ready" }
  | { type: "identity-needed" }
  | {
      type: "action";
      progress: boolean;
      unsupported?: string;
      login?: boolean;
      navigate?: string;
    };
export function validBinding(value: any): value is PageBinding {
  return (
    !!value &&
    typeof value.jobId === "string" &&
    value.jobId.length < 100 &&
    [
      "single",
      "followers",
      "following",
      "both",
      "commenters",
      "likers",
    ].includes(value.mode) &&
    (value.sourceId === undefined || /^\d+$/.test(value.sourceId)) &&
    (value.postId === undefined || /^\d+$/.test(value.postId)) &&
    (value.input?.type === "profile"
      ? /^[a-zA-Z0-9_.]{1,30}$/.test(value.input.username)
      : value.input?.type === "post" &&
        /^[A-Za-z0-9_-]+$/.test(value.input.shortcode) &&
        /^https:\/\/www\.instagram\.com\/(p|reel)\/[A-Za-z0-9_-]+\/$/.test(
          value.input.url,
        ))
  );
}
// Page-world data is untrusted. Whitelist fields instead of persisting a bridge payload.
export function cleanCapture(value: any): Capture | undefined {
  if (
    !value ||
    ![
      "profile",
      "media-info",
      "followers",
      "following",
      "feed",
      "reels",
      "comments",
      "replies",
      "likes",
      "error",
    ].includes(value.kind)
  )
    return;
  const text = (v: unknown, max = 2048) =>
    typeof v === "string" ? v.slice(0, max) : "";
  const id = (v: unknown) =>
    typeof v === "string" && /^\d+$/.test(v) ? v : undefined;
  const profile = (p: any): Profile | undefined => {
    if (!p || !id(p.id) || !/^[a-zA-Z0-9_.]{1,30}$/.test(p.userName)) return;
    return {
      id: p.id,
      userName: p.userName,
      fullName: text(p.fullName, 500),
      profileUrl: `https://www.instagram.com/${p.userName}/`,
      avatarUrl: /^https:\/\//.test(p.avatarUrl) ? text(p.avatarUrl, 8192) : "",
      updatedAt: Date.now(),
      ...(Number.isSafeInteger(p.postCount) && p.postCount >= 0
        ? { postCount: p.postCount }
        : {}),
    };
  };
  let truncated = false;
  const rows = (v: any) => {
    if (Array.isArray(v) && v.length > 10000) truncated = true;
    return Array.isArray(v) ? v.slice(0, 10000) : [];
  };
  const comment = (c: any, depth = 0): CommentItem | undefined => {
    if (!c || !id(c.id) || depth > 3) return;
    return {
      id: c.id,
      profile: profile(c.profile),
      replyCount:
        Number.isSafeInteger(c.replyCount) && c.replyCount >= 0
          ? c.replyCount
          : 0,
      replies: rows(c.replies)
        .map((r) => comment(r, depth + 1))
        .filter(Boolean) as CommentItem[],
    };
  };
  return {
    kind: value.kind,
    source: profile(value.source),
    profiles: rows(value.profiles).map(profile).filter(Boolean) as Profile[],
    posts: rows(value.posts)
      .filter((p) => p && id(p.id) && id(p.ownerId))
      .map((p) => ({
        id: p.id,
        ownerId: p.ownerId,
        url: /^https:\/\/www\.instagram\.com\/(p|reel)\/[A-Za-z0-9_-]+\/$/.test(
          p.url,
        )
          ? p.url
          : "",
        ...(Number.isSafeInteger(p.likeCount) && p.likeCount >= 0
          ? { likeCount: p.likeCount }
          : {}),
        ...(Number.isSafeInteger(p.commentCount) && p.commentCount >= 0
          ? { commentCount: p.commentCount }
          : {}),
      })),
    comments: rows(value.comments)
      .map((c) => comment(c))
      .filter(Boolean) as CommentItem[],
    targetId: id(value.targetId),
    parentId: id(value.parentId),
    requestCursor: text(value.requestCursor),
    nextCursors: rows(value.nextCursors).filter(
      (c) => typeof c === "string" && c.length > 0 && c.length <= 2048,
    ),
    terminal: value.terminal === true,
    ...(value.preview === true && ["comments", "replies"].includes(value.kind)
      ? { preview: true }
      : {}),
    restriction: text(value.restriction, 500) || undefined,
    failure: ["rate", "login", "restricted", "schema", "network"].includes(
      value.failure,
    )
      ? value.failure
      : undefined,
    retryAt:
      Number.isFinite(value.retryAt) && value.retryAt > 0
        ? value.retryAt
        : undefined,
    warnings: [
      ...rows(value.warnings)
        .filter((w) => typeof w === "string")
        .map((w) => text(w, 500)),
      ...(truncated
        ? [
            "A response was too large to process fully. Saved results are partial.",
          ]
        : []),
    ],
  };
}
