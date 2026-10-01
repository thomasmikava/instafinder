import { parse } from "lossless-json";
import { preferences, type Database, db } from "./db";
import type { CommentItem, Input, Page, Post, Profile } from "./types";
export class CollectionError extends Error {
  constructor(
    message: string,
    public kind:
      "login" | "restricted" | "rate" | "network" | "schema" = "schema",
    public retryAt?: number,
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
    avatarUrl: String(raw.profile_pic_url || raw.profile_pic_url_hd || ""),
    updatedAt: Date.now(),
    ...(raw.follower_count !== undefined
      ? { followerCount: Number(raw.follower_count) }
      : {}),
    ...(raw.following_count !== undefined
      ? { followingCount: Number(raw.following_count) }
      : {}),
    ...(raw.media_count !== undefined
      ? { postCount: Number(raw.media_count) }
      : {}),
  };
}
export function normalizePost(raw: Raw): Post {
  const id = String(raw.pk || raw.id || "").split("_")[0];
  const ownerId = String(
    raw.user?.pk_id ?? raw.user?.pk ?? raw.user?.id ?? raw.owner?.id ?? "",
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
export function listPage(raw: Raw): Page<Profile> {
  if (!Array.isArray(raw.users))
    throw new CollectionError(
      "Instagram did not return a recognizable follow list.",
    );
  const next =
    raw.next_max_id !== undefined &&
    raw.next_max_id !== null &&
    raw.next_max_id !== ""
      ? String(raw.next_max_id)
      : null;
  return {
    items: raw.users.map(normalizeProfile),
    next,
    more:
      typeof raw.more_available === "boolean"
        ? raw.more_available
        : typeof raw.has_more === "boolean"
          ? raw.has_more
          : !!next,
    restricted: restricted(raw),
    expected:
      raw.total_count === undefined ? undefined : Number(raw.total_count),
  };
}
function normalizeComment(raw: Raw): CommentItem {
  if (!raw.user && !raw.owner)
    throw new CollectionError("A comment is missing its author.");
  const id = String(raw.pk || raw.id || "");
  if (!id) throw new CollectionError("A comment is missing its ID.");
  const replies = (raw.preview_child_comments || raw.child_comments || []).map(
    normalizeComment,
  );
  return {
    id,
    profile: normalizeProfile(raw.user || raw.owner),
    replyCount: Number(
      raw.child_comment_count || raw.reply_count || replies.length,
    ),
    replies,
  };
}
export function commentsPage(raw: Raw, replies = false): Page<CommentItem> {
  const items = replies ? (raw.child_comments ?? raw.comments) : raw.comments;
  if (!Array.isArray(items))
    throw new CollectionError(
      "Instagram did not return recognizable comments.",
    );
  const value = replies
    ? (raw.next_max_id ?? raw.next_min_id)
    : (raw.next_min_id ?? raw.next_max_id);
  const next =
    value === undefined || value === null || value === ""
      ? null
      : String(value);
  return {
    items: items.map(normalizeComment),
    next,
    more:
      typeof raw.has_more_comments === "boolean"
        ? raw.has_more_comments
        : typeof raw.has_more_tail_child_comments === "boolean"
          ? raw.has_more_tail_child_comments
          : typeof raw.more_available === "boolean"
            ? raw.more_available
            : !!next,
    restricted: restricted(raw),
  };
}
export function mediaPage(raw: Raw, reels = false): Page<Post> {
  if (!Array.isArray(raw.items))
    throw new CollectionError("Instagram did not return recognizable posts.");
  const value = reels ? raw.paging_info?.max_id : raw.next_max_id;
  const next =
    value === undefined || value === null || value === ""
      ? null
      : String(value);
  return {
    items: raw.items.map((item: Raw) =>
      normalizePost(reels ? item.media || item : item),
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
    const settings = await preferences(this.database);
    const delay = Math.max(1, settings.delaySeconds) * 1000;
    const remaining = (settings.lastRequestAt || 0) + delay - this.now();
    if (remaining > 0) await this.sleep(remaining, signal);
    if (signal?.aborted) throw new DOMException("Paused", "AbortError");
    await this.database.settings.put({
      ...settings,
      lastRequestAt: this.now(),
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
  ): Promise<Raw> {
    if (!path.startsWith("/api/v1/") && !path.startsWith("/web/search/"))
      throw new Error("Unsupported Instagram request.");
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.pacer.before(signal);
      const csrf = await this.cookie();
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
          `https://www.instagram.com${path}`,
          {
            method: form ? "POST" : "GET",
            credentials: "include",
            signal: timeout.signal,
            headers: {
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
        const message = String(raw.message || "");
        if (
          response.status === 429 ||
          raw.spam ||
          /please wait|too many requests|rate.limit/i.test(message)
        ) {
          const retry = response.headers.get("Retry-After");
          const seconds =
            retry && Number.isFinite(Number(retry)) ? Number(retry) : 0;
          const date = retry && !seconds ? Date.parse(retry) : 0;
          throw new CollectionError(
            "Instagram requested a cooldown. Resume after the indicated time.",
            "rate",
            Math.max(
              Date.now() + 60000,
              date || Date.now() + (seconds || 900) * 1000,
            ),
          );
        }
        if (
          response.status === 401 ||
          raw.login_required ||
          raw.challenge ||
          raw.checkpoint_url ||
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
        if (!response.ok || raw.status === "fail")
          throw new CollectionError(
            message ||
              `Instagram returned HTTP ${response.status}. The endpoint or content may be unavailable.`,
            "schema",
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
  async profile(username: string, signal?: AbortSignal) {
    const raw = await this.request(
      `/api/v1/users/web_profile_info/?${new URLSearchParams({ username })}`,
      signal,
    );
    if (!raw.data?.user)
      throw new CollectionError(
        "Profile not found, inaccessible, or Instagram changed its profile response.",
      );
    const p = normalizeProfile(raw.data.user);
    return {
      ...p,
      followerCount: Number(
        raw.data.user.edge_followed_by?.count ?? p.followerCount ?? 0,
      ),
      followingCount: Number(
        raw.data.user.edge_follow?.count ?? p.followingCount ?? 0,
      ),
      postCount: Number(
        raw.data.user.edge_owner_to_timeline_media?.count ?? p.postCount ?? 0,
      ),
    };
  }
  async post(shortcode: string, signal?: AbortSignal) {
    const raw = await this.request(
      `/api/v1/media/${shortcodeId(shortcode)}/info/`,
      signal,
    );
    const media = raw.items?.[0];
    if (!media) throw new CollectionError("Post not found or inaccessible.");
    return {
      post: normalizePost(media),
      source: normalizeProfile(media.user || media.owner),
    };
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
    if (cursor) query.set("max_id", cursor);
    return listPage(
      await this.request(
        `/api/v1/friendships/${encodeURIComponent(id)}/${kind}/?${query}`,
        signal,
      ),
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
      return mediaPage(
        await this.request(
          `/api/v1/feed/user/${encodeURIComponent(id)}/?${query}`,
          signal,
        ),
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
    );
  }
  async comments(postId: string, cursor: string | null, signal?: AbortSignal) {
    const query = new URLSearchParams({
      count: "50",
      can_support_threading: "true",
    });
    if (cursor) query.set("min_id", cursor);
    return commentsPage(
      await this.request(
        `/api/v1/media/${encodeURIComponent(postId)}/comments/?${query}`,
        signal,
      ),
    );
  }
  async replies(
    postId: string,
    commentId: string,
    cursor: string | null,
    signal?: AbortSignal,
  ) {
    const query = new URLSearchParams({ max_id: cursor || "", count: "50" });
    return commentsPage(
      await this.request(
        `/api/v1/media/${encodeURIComponent(postId)}/comments/${encodeURIComponent(commentId)}/child_comments/?${query}`,
        signal,
      ),
      true,
    );
  }
}
