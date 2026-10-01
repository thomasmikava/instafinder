import { parse } from "lossless-json";
import { preferences, type Database, db } from "./db";
import type { CommentItem, Input, Page, Post, Profile } from "./types";
export class CollectionError extends Error {
  constructor(
    message: string,
    public kind:
      "login" | "restricted" | "rate" | "network" | "schema" = "schema",
    public retryAt?: number,
    public statusCode?: number,
  ) {
    super(message);
  }
}
export function parseInput(value: string): Input {
  const text = value.trim();
  if (!text) throw new Error("Enter an Instagram username or URL.");
  if (!/^https?:\/\//i.test(text) && !/^(www\.)?instagram\.com\//i.test(text)) {
    const username = text.replace(/^@/, "");
    if (!/^[a-zA-Z0-9_.]{1,30}$/.test(username))
      throw new Error("Enter a valid Instagram username.");
    return { type: "profile", username: username.toLowerCase() };
  }
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw new Error("Enter a valid Instagram URL.");
  }
  if (
    !["instagram.com", "www.instagram.com"].includes(url.hostname) ||
    url.protocol !== "https:"
  )
    throw new Error("Use an HTTPS instagram.com URL.");
  const parts = url.pathname.split("/").filter(Boolean);
  if (["p", "reel", "reels", "tv"].includes(parts[0])) {
    if (!parts[1] || !/^[A-Za-z0-9_-]+$/.test(parts[1]))
      throw new Error("This post URL is missing its code.");
    return {
      type: "post",
      shortcode: parts[1],
      url: `https://www.instagram.com/${parts[0] === "p" ? "p" : "reel"}/${parts[1]}/`,
    };
  }
  if (
    parts.length !== 1 ||
    ["accounts", "explore", "direct", "stories"].includes(parts[0]) ||
    !/^[a-zA-Z0-9_.]{1,30}$/.test(parts[0])
  )
    throw new Error("Use a profile, post, or reel URL.");
  return { type: "profile", username: parts[0].toLowerCase() };
}
export function shortcodeId(shortcode: string) {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let result = 0n;
  for (const c of shortcode) {
    const n = alphabet.indexOf(c);
    if (n < 0) throw new Error("Invalid post code.");
    result = result * 64n + BigInt(n);
  }
  return result.toString();
}
type Raw = Record<string, any>;
export function normalizeProfile(raw: Raw): Profile {
  const id = String(raw.pk_id ?? raw.pk ?? raw.id ?? "");
  const username = String(raw.username || "");
  if (!/^\d+$/.test(id) || !username)
    throw new CollectionError(
      "Instagram returned an incomplete profile. Its response format may have changed.",
    );
  return {
    id,
    userName: username,
    fullName: String(raw.full_name || ""),
    profileUrl: `https://www.instagram.com/${encodeURIComponent(username)}/`,
    avatarUrl: String(
      raw.hd_profile_pic_url_info?.url ||
        raw.profile_pic_url_hd ||
        raw.profile_pic_url ||
        "",
    ),
    updatedAt: Date.now(),
    ...((raw.follower_count ?? raw.edge_followed_by?.count) !== undefined
      ? {
          followerCount: Number(
            raw.follower_count ?? raw.edge_followed_by?.count,
          ),
        }
      : {}),
    ...((raw.following_count ?? raw.edge_follow?.count) !== undefined
      ? {
          followingCount: Number(raw.following_count ?? raw.edge_follow?.count),
        }
      : {}),
    ...((raw.media_count ?? raw.edge_owner_to_timeline_media?.count) !==
    undefined
      ? {
          postCount: Number(
            raw.media_count ?? raw.edge_owner_to_timeline_media?.count,
          ),
        }
      : {}),
  };
}
export function normalizePost(raw: Raw, knownOwnerId?: string): Post {
  const id = String(raw.pk || raw.id || "").split("_")[0];
  const ownerId = String(
    raw.user?.pk_id ??
      raw.user?.pk ??
      raw.user?.id ??
      raw.owner?.id ??
      knownOwnerId ??
      "",
  );
  if (!/^\d+$/.test(id) || !/^\d+$/.test(ownerId))
    throw new CollectionError(
      "Instagram returned a post without its owner or ID.",
    );
  const code = raw.code || raw.shortcode;
  return {
    id,
    ownerId,
    url: code
      ? `https://www.instagram.com/${raw.product_type === "clips" ? "reel" : "p"}/${code}/`
      : "",
    commentCount:
      raw.comment_count !== undefined ? Number(raw.comment_count) : undefined,
  };
}
function restricted(raw: Raw): string | undefined {
  if (
    raw.should_limit_list_of_followers ||
    raw.should_limit_list_of_followings ||
    raw.has_special_empty_state ||
    raw.special_empty_state
  )
    return "Instagram restricted this list. The saved results are partial.";
  if (raw.comments_disabled)
    return "Comments are disabled for this post. The saved results may be partial.";
}
const cursorValue = (value: unknown): string | null =>
  value === undefined || value === null || value === "" ? null : String(value);
export function listPage(
  raw: Raw,
  cursor: string | null = null,
  pageSize = 50,
): Page<Profile> {
  const restriction = restricted(raw);
  if (!Array.isArray(raw.users) && !restriction)
    throw new CollectionError(
      "Instagram did not return a recognizable follow list.",
    );
  const items = (raw.users || []).map(normalizeProfile);
  let next = cursorValue(raw.next_max_id);
  const flag =
    typeof raw.has_more === "boolean" ? raw.has_more : raw.more_available;
  const more = typeof flag === "boolean" ? flag : !!next;
  // Numeric offsets are used only when the server explicitly confirms another full page.
  // Never invent a cursor after a terminal or restricted response.
  if (
    more &&
    !next &&
    !restriction &&
    items.length >= pageSize &&
    /^\d+$/.test(cursor || "0")
  )
    next = (BigInt(cursor || "0") + BigInt(pageSize)).toString();
  return {
    items,
    next,
    more,
    restricted: restriction,
    expected:
      raw.total_count === undefined ? undefined : Number(raw.total_count),
  };
}
function normalizeComment(
  raw: Raw,
  warnings: Set<string>,
): CommentItem | undefined {
  if (!raw || typeof raw !== "object") {
    warnings.add(
      "Some comments were unavailable; saved commenters are partial.",
    );
    return undefined;
  }
  const id = cursorValue(raw.pk ?? raw.id);
  let profile: Profile | undefined;
  try {
    if (!id || (!raw.user && !raw.owner)) throw new Error();
    profile = normalizeProfile(raw.user || raw.owner);
  } catch {
    warnings.add(
      "Some comment authors or IDs were unavailable; saved commenters are partial.",
    );
    if (!id) return undefined;
  }
  const childRows = [
    ...(Array.isArray(raw.preview_child_comments)
      ? raw.preview_child_comments
      : []),
    ...(Array.isArray(raw.child_comments) ? raw.child_comments : []),
    ...(raw.edge_threaded_comments?.edges || []).map(
      (edge: Raw) => edge.node || edge,
    ),
  ];
  const replies = commentRows(childRows, warnings);
  return {
    id: id!,
    profile,
    replyCount: Number(
      raw.child_comment_count ??
        raw.reply_count ??
        raw.edge_threaded_comments?.count ??
        replies.length,
    ),
    replies,
  };
}
function commentRows(rows: Raw[], warnings: Set<string>): CommentItem[] {
  const comments = new Map<string, CommentItem>();
  for (const raw of rows) {
    const comment = normalizeComment(raw, warnings);
    if (!comment) continue;
    const existing = comments.get(comment.id);
    comments.set(
      comment.id,
      existing ? mergeComment(existing, comment) : comment,
    );
  }
  return [...comments.values()];
}
function mergeComment(
  existing: CommentItem,
  incoming: CommentItem,
): CommentItem {
  const replies = new Map(existing.replies.map((reply) => [reply.id, reply]));
  for (const reply of incoming.replies) {
    const saved = replies.get(reply.id);
    replies.set(reply.id, saved ? mergeComment(saved, reply) : reply);
  }
  return {
    ...incoming,
    profile: incoming.profile || existing.profile,
    replyCount: Math.max(existing.replyCount, incoming.replyCount),
    replies: [...replies.values()],
  };
}
export function commentCursor(cursor: string | null, replies = false) {
  const match = /^(max|min):(.*)$/.exec(cursor || "");
  return {
    direction: match?.[1] || (replies ? "max" : "min"),
    value: match?.[2] ?? cursor,
  };
}
export function commentsPage(raw: Raw, replies = false): Page<CommentItem> {
  const rows = replies
    ? (raw.child_comments ?? raw.comments)
    : [
        ...(Array.isArray(raw.preview_comments) ? raw.preview_comments : []),
        ...(Array.isArray(raw.comments) ? raw.comments : []),
      ];
  const recognized = replies
    ? Array.isArray(rows)
    : Array.isArray(raw.comments) || Array.isArray(raw.preview_comments);
  const restriction = restricted(raw);
  if (!recognized && !restriction)
    throw new CollectionError(
      "Instagram did not return recognizable comments.",
    );
  const warnings = new Set<string>();
  const max = cursorValue(raw.next_max_id) || cursorValue(raw.max_id);
  const min = cursorValue(raw.next_min_id) || cursorValue(raw.min_id);
  const tail = replies
    ? (raw.has_more_tail_child_comments ?? raw.has_more_comments)
    : raw.has_more_comments;
  const head = replies
    ? raw.has_more_head_child_comments
    : raw.has_more_headload_comments;
  const explicit = [tail, head, raw.more_available].some(
    (flag) => typeof flag === "boolean",
  );
  const cursors: string[] = [];
  if (tail === true && max) cursors.push(`max:${max}`);
  if ((head === true || (tail === true && !max)) && min)
    cursors.push(`min:${min}`);
  if (!explicit || raw.more_available === true) {
    if (!cursors.length && (replies ? max || min : min || max)) {
      const direction = replies ? (max ? "max" : "min") : min ? "min" : "max";
      cursors.push(`${direction}:${direction === "max" ? max : min}`);
    }
  }
  return {
    items: commentRows(recognized ? rows : [], warnings),
    next: cursors[0] || null,
    more:
      cursors.length > 0 ||
      tail === true ||
      head === true ||
      raw.more_available === true,
    pendingCursors: cursors.slice(1),
    restricted: restriction,
    warnings: [...warnings],
  };
}
export function mediaPage(
  raw: Raw,
  reels = false,
  ownerId?: string,
): Page<Post> {
  if (!Array.isArray(raw.items))
    throw new CollectionError("Instagram did not return recognizable posts.");
  const value = reels ? raw.paging_info?.max_id : raw.next_max_id;
  const next =
    value === undefined || value === null || value === ""
      ? null
      : String(value);
  return {
    items: raw.items.map((item: Raw) =>
      normalizePost(reels ? item.media || item : item, ownerId),
    ),
    next,
    more: reels
      ? !!(raw.paging_info?.more_available ?? next)
      : !!(raw.more_available ?? next),
    restricted: restricted(raw),
  };
}
export const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Paused", "AbortError"));
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("Paused", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
export class Pacer {
  constructor(
    private database: Database = db,
    private sleep = wait,
    private now = Date.now,
  ) {}
  async before(signal?: AbortSignal) {
    for (;;) {
      const settings = await preferences(this.database);
      if (settings.cooldownUntil && settings.cooldownUntil > this.now()) {
        console.info(
          "[InstaFinder] Request skipped: saved Instagram cooldown.",
          {
            retryAt: new Date(settings.cooldownUntil).toISOString(),
          },
        );
        throw new CollectionError(
          "An earlier Instagram response requested a cooldown. No new request was sent.",
          "rate",
          settings.cooldownUntil,
        );
      }
      const remaining =
        (settings.lastRequestAt || 0) +
        Math.max(1, settings.delaySeconds) * 1000 -
        this.now();
      if (remaining > 0) {
        await this.sleep(remaining, signal);
        continue;
      }
      if (signal?.aborted) throw new DOMException("Paused", "AbortError");
      await this.database.settings.put({
        ...settings,
        lastRequestAt: this.now(),
      });
      return;
    }
  }
  async cooldown(until: number) {
    await this.database.transaction("rw", this.database.settings, async () => {
      const settings = await preferences(this.database);
      await this.database.settings.put({
        ...settings,
        cooldownUntil: Math.max(settings.cooldownUntil || 0, until),
      });
    });
  }
}
export class Instagram {
  constructor(
    private pacer = new Pacer(),
    private fetcher: typeof fetch = fetch,
    private cookie = async () => {
      if (typeof chrome === "undefined" || !chrome.cookies)
        throw new CollectionError(
          "Load InstaFinder as a Chrome extension to collect Instagram data.",
          "login",
        );
      return (
        (
          await chrome.cookies.get({
            url: "https://www.instagram.com/",
            name: "csrftoken",
          })
        )?.value || ""
      );
    },
    private sleep = wait,
  ) {}
  async request(
    path: string,
    signal?: AbortSignal,
    form?: URLSearchParams,
    origin = "https://www.instagram.com",
  ): Promise<Raw> {
    if (
      !["https://www.instagram.com", "https://i.instagram.com"].includes(
        origin,
      ) ||
      (!path.startsWith("/api/v1/") && !path.startsWith("/web/search/"))
    )
      throw new Error("Unsupported Instagram request.");
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.pacer.before(signal);
      const csrf = await this.cookie();
      if (signal?.aborted) throw new DOMException("Paused", "AbortError");
      if (!csrf)
        throw new CollectionError(
          "Sign in to Instagram in this Chrome profile, then resume.",
          "login",
        );
      const timeout = new AbortController();
      const cancel = () => timeout.abort();
      signal?.addEventListener("abort", cancel, { once: true });
      const timer = setTimeout(cancel, 25000);
      try {
        const response = await this.fetcher.call(
          globalThis,
          `${origin}${path}`,
          {
            method: form ? "POST" : "GET",
            credentials: "include",
            signal: timeout.signal,
            headers: {
              accept: "application/json",
              "x-asbd-id": "198387",
              "x-ig-app-id": "936619743392459",
              "x-requested-with": "XMLHttpRequest",
              "x-csrftoken": csrf,
              ...(form
                ? { "Content-Type": "application/x-www-form-urlencoded" }
                : {}),
            },
            body: form?.toString(),
          },
        );
        const text = await response.text();
        let raw: Raw = {};
        try {
          raw = parse(text, undefined, {
            parseNumber: (value) =>
              /^-?\d+$/.test(value) && !Number.isSafeInteger(Number(value))
                ? value
                : Number(value),
          }) as Raw;
        } catch {
          /* HTML sign-in and challenge pages are classified below. */
        }
        const message = String(raw?.message || "");
        if (
          response.status === 429 ||
          raw?.spam ||
          /please wait|too many requests|rate.limit/i.test(message)
        ) {
          const retry = response.headers.get("Retry-After");
          const seconds =
            retry && Number.isFinite(Number(retry)) ? Number(retry) : 0;
          const date = retry && !seconds ? Date.parse(retry) : 0;
          const retryAt = Math.max(
            Date.now() + 60000,
            date || Date.now() + (seconds || 900) * 1000,
          );
          await this.pacer.cooldown(retryAt);
          console.info(
            "[InstaFinder] Instagram response triggered a cooldown.",
            {
              status: response.status,
              reason:
                response.status === 429
                  ? "HTTP 429"
                  : raw?.spam
                    ? "spam flag"
                    : "rate-limit message",
              retryAt: new Date(retryAt).toISOString(),
            },
          );
          throw new CollectionError(
            "Instagram requested a cooldown.",
            "rate",
            retryAt,
          );
        }
        if (
          response.status === 401 ||
          raw?.login_required ||
          raw?.challenge ||
          raw?.checkpoint_url ||
          /login_required|challenge_required|checkpoint_required/i.test(
            message,
          ) ||
          response.url.includes("/accounts/login") ||
          /<(?:!doctype|html)/i.test(text)
        )
          throw new CollectionError(
            "Instagram needs a login or verification. Complete it on Instagram, then resume.",
            "login",
          );
        if (
          response.status === 403 ||
          /not authorized|private|not permitted/i.test(message)
        )
          throw new CollectionError(
            "Instagram denied access to this content. Saved results are partial.",
            "restricted",
          );
        if (response.status >= 500)
          throw new CollectionError(
            "Instagram is temporarily unavailable.",
            "network",
          );
        if (!response.ok || raw?.status === "fail")
          throw new CollectionError(
            message ||
              `Instagram returned HTTP ${response.status}. The endpoint or content may be unavailable.`,
            "schema",
            undefined,
            response.status,
          );
        if (!raw || typeof raw !== "object" || !Object.keys(raw).length)
          throw new CollectionError(
            "Instagram returned an unexpected response. Sign in or try again later.",
            "schema",
          );
        return raw;
      } catch (error) {
        if (signal?.aborted) throw new DOMException("Paused", "AbortError");
        const classified =
          error instanceof CollectionError
            ? error
            : new CollectionError(
                "Network request timed out or failed.",
                "network",
              );
        if (classified.kind !== "network" || attempt === 2) throw classified;
        await this.sleep(2000 * 2 ** attempt, signal);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
      }
    }
    throw new CollectionError("Request failed.", "network");
  }
  private async read<T>(
    path: string,
    decode: (raw: Raw) => T,
    signal?: AbortSignal,
    form?: URLSearchParams,
    origins = ["https://www.instagram.com", "https://i.instagram.com"],
  ): Promise<T> {
    let failure: unknown;
    for (const origin of origins) {
      try {
        return decode(await this.request(path, signal, form, origin));
      } catch (error) {
        // Alternate endpoints are compatibility fallbacks, never retries around access decisions.
        if (
          !(error instanceof CollectionError) ||
          !["schema", "network"].includes(error.kind)
        )
          throw error;
        failure = error;
      }
    }
    throw failure;
  }
  async profile(username: string, signal?: AbortSignal) {
    const decode = (raw: Raw, web: boolean) => {
      const user = web ? raw.data?.user : raw.user;
      if (
        !user ||
        String(user.username).toLowerCase() !== username.toLowerCase()
      )
        throw new CollectionError(
          "Profile not found or Instagram changed its profile response.",
        );
      return normalizeProfile(user);
    };
    try {
      return await this.read(
        `/api/v1/users/web_profile_info/?${new URLSearchParams({ username })}`,
        (raw) => decode(raw, true),
        signal,
        undefined,
        ["https://www.instagram.com"],
      );
    } catch (error) {
      if (
        !(error instanceof CollectionError) ||
        !["schema", "network"].includes(error.kind)
      )
        throw error;
      return this.read(
        `/api/v1/feed/user/${encodeURIComponent(username)}/username/?count=1`,
        (raw) => decode(raw, false),
        signal,
        undefined,
        ["https://www.instagram.com"],
      );
    }
  }
  async post(shortcode: string, signal?: AbortSignal) {
    return this.read(
      `/api/v1/media/${shortcodeId(shortcode)}/info/`,
      (raw) => {
        const media = raw.items?.[0];
        if (!media)
          throw new CollectionError("Post not found or inaccessible.");
        return {
          post: normalizePost(media),
          source: normalizeProfile(media.user || media.owner),
        };
      },
      signal,
    );
  }
  async follows(
    id: string,
    kind: "followers" | "following",
    cursor: string | null,
    signal?: AbortSignal,
  ) {
    const query = new URLSearchParams({
      count: "50",
      search_surface: "follow_list_page",
    });
    query.set("max_id", cursor || "0");
    return this.read(
      `/api/v1/friendships/${encodeURIComponent(id)}/${kind}/?${query}`,
      (raw) => listPage(raw, cursor),
      signal,
    );
  }
  async media(
    id: string,
    cursor: string | null,
    channel: "feed" | "reels",
    signal?: AbortSignal,
  ) {
    const query = new URLSearchParams({ count: "12" });
    if (cursor) query.set("max_id", cursor);
    if (channel === "feed")
      return this.read(
        `/api/v1/feed/user/${encodeURIComponent(id)}/?${query}`,
        (raw) => mediaPage(raw, false, id),
        signal,
      );
    const form = new URLSearchParams({
      target_user_id: id,
      page_size: "12",
      include_feed_video: "true",
    });
    if (cursor) form.set("max_id", cursor);
    return mediaPage(
      await this.request("/api/v1/clips/user/", signal, form),
      true,
      id,
    );
  }
  async comments(postId: string, cursor: string | null, signal?: AbortSignal) {
    const query = new URLSearchParams({
      count: "50",
      can_support_threading: "true",
      permalink_enabled: "false",
    });
    const position = commentCursor(cursor);
    if (position.value) query.set(`${position.direction}_id`, position.value);
    return this.read(
      `/api/v1/media/${encodeURIComponent(postId)}/comments/?${query}`,
      (raw) => commentsPage(raw),
      signal,
    );
  }
  async replies(
    postId: string,
    commentId: string,
    cursor: string | null,
    signal?: AbortSignal,
  ) {
    const position = commentCursor(cursor, true);
    const query = new URLSearchParams({
      count: "50",
      [position.direction + "_id"]: position.value || "",
    });
    return this.read(
      `/api/v1/media/${encodeURIComponent(postId)}/comments/${encodeURIComponent(commentId)}/child_comments/?${query}`,
      (raw) => commentsPage(raw, true),
      signal,
    );
  }
}
