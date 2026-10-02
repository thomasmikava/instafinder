import { parse } from "lossless-json";
import type { Capture, PageBinding } from "./page-protocol";
import type { CommentItem, Post, Profile } from "./types";
import { shortcodeId } from "./instagram";
type Raw = Record<string, any>;
const numeric = (v: any) =>
  (typeof v !== "number" || Number.isSafeInteger(v)) &&
  /^\d+$/.test(String(v ?? ""))
    ? String(v)
    : undefined;
const cursor = (v: any) => (v == null || String(v) === "" ? null : String(v));
const array = (v: any) => (Array.isArray(v) ? v : []);
export function nativeProfile(raw: Raw): Profile | undefined {
  const id = numeric(raw?.pk_id ?? raw?.pk ?? raw?.id);
  if (!id || !/^[a-zA-Z0-9_.]{1,30}$/.test(raw.username || "")) return;
  return {
    id,
    userName: raw.username,
    fullName: String(raw.full_name || ""),
    profileUrl: `https://www.instagram.com/${raw.username}/`,
    avatarUrl: String(
      raw.hd_profile_pic_url_info?.url ||
        raw.profile_pic_url_hd ||
        raw.profile_pic_url ||
        "",
    ),
    updatedAt: Date.now(),
    ...(raw.media_count != null ||
    raw.edge_owner_to_timeline_media?.count != null
      ? {
          postCount: Number(
            raw.media_count ?? raw.edge_owner_to_timeline_media.count,
          ),
        }
      : {}),
  };
}
function nativePost(raw: Raw, owner?: string): Post | undefined {
  const rawId = raw?.pk_id ?? raw?.pk ?? raw?.id;
  if (typeof rawId === "number" && !Number.isSafeInteger(rawId)) return;
  const id = numeric(String(rawId ?? "").split("_")[0]);
  const ownerId =
    nativeProfile(raw?.user || raw?.owner)?.id ||
    numeric(
      raw?.user?.pk_id ??
        raw?.user?.pk ??
        raw?.user?.id ??
        raw?.owner?.pk_id ??
        raw?.owner?.pk ??
        raw?.owner?.id ??
        raw?.owner_id ??
        raw?.user_id,
    ) ||
    owner;
  if (!id || !ownerId) return;
  const code = String(raw.code || raw.shortcode || "");
  return {
    id,
    ownerId,
    url: /^[A-Za-z0-9_-]+$/.test(code)
      ? `https://www.instagram.com/${raw.product_type === "clips" ? "reel" : "p"}/${code}/`
      : "",
    ...(raw.like_count != null || raw.edge_media_preview_like?.count != null
      ? {
          likeCount: Number(
            raw.like_count ?? raw.edge_media_preview_like.count,
          ),
        }
      : {}),
    ...(raw.comment_count != null ||
    raw.edge_media_to_parent_comment?.count != null ||
    raw.edge_media_to_comment?.count != null ||
    raw.edge_media_preview_comment?.count != null
      ? {
          commentCount: Number(
            raw.comment_count ??
              raw.edge_media_to_parent_comment?.count ??
              raw.edge_media_to_comment?.count ??
              raw.edge_media_preview_comment?.count,
          ),
        }
      : {}),
  };
}
function comment(
  raw: Raw,
  warnings: string[],
  depth = 0,
): CommentItem | undefined {
  const id = numeric(raw?.pk_id ?? raw?.pk ?? raw?.id);
  if (!id || depth > 3) {
    warnings.push("Some comment IDs were unavailable.");
    return;
  }
  const profile = nativeProfile(raw.user || raw.owner);
  if (!profile) warnings.push("Some comment authors were unavailable.");
  const children = [
    ...array(raw.preview_child_comments),
    ...array(raw.child_comments),
    ...array(raw.edge_threaded_comments?.edges).map((e) => e.node),
  ];
  return {
    id,
    profile,
    replyCount: Number(
      raw.child_comment_count ??
        raw.reply_count ??
        raw.edge_threaded_comments?.count ??
        children.length,
    ),
    replies: children
      .map((r) => comment(r, warnings, depth + 1))
      .filter(Boolean) as CommentItem[],
  };
}
function base(kind: Capture["kind"]): Capture {
  return {
    kind,
    profiles: [],
    posts: [],
    comments: [],
    requestCursor: "",
    nextCursors: [],
    terminal: false,
    warnings: [],
  };
}
function restriction(raw: Raw) {
  return raw.should_limit_list_of_followers ||
    raw.should_limit_list_of_followings ||
    Number(raw.hidden_following_account_count || 0) > 0 ||
    raw.has_special_empty_state ||
    raw.special_empty_state ||
    raw.comments_disabled
    ? "Instagram restricted this content. Saved results are partial."
    : undefined;
}
function pagination(frame: Capture, raw: Raw, next: any, flags: any[]) {
  const n = cursor(next);
  frame.nextCursors = n ? [n] : [];
  const explicit = flags.filter((v) => typeof v === "boolean");
  frame.terminal = explicit.length > 0 && explicit.every((v) => v === false);
  if (frame.terminal) frame.nextCursors = [];
  if (explicit.includes(true) && !n)
    frame.warnings.push("Instagram omitted a pagination cursor.");
  frame.restriction = restriction(raw);
}
export interface NativeRequest {
  url: string;
  variables?: Raw;
  structured?: boolean;
}
export function requestInfo(url: string, body?: unknown): NativeRequest {
  let variables: Raw | undefined;
  try {
    const u = new URL(url, "https://www.instagram.com");
    const params =
      typeof body === "string"
        ? new URLSearchParams(body)
        : body instanceof URLSearchParams
          ? body
          : undefined;
    let v = params?.get("variables") || u.searchParams.get("variables");
    if (!v && typeof body === "string" && body.startsWith("{")) {
      const json = JSON.parse(body);
      v =
        typeof json.variables === "string"
          ? json.variables
          : JSON.stringify(json.variables);
    }
    if (v) variables = parse(v) as Raw;
    else if (params) {
      variables = {};
      for (const key of [
        "user_id",
        "target_user_id",
        "max_id",
        "media_id",
        "comment_id",
        "after",
        "before",
      ]) {
        const value = params.get(key);
        if (value !== null) variables[key] = value;
      }
    }
    return { url: u.href, variables };
  } catch {
    return { url };
  }
}
export function relevantRequest(request: NativeRequest) {
  try {
    const u = new URL(request.url);
    return (
      ["www.instagram.com", "i.instagram.com"].includes(u.hostname) &&
      (/^\/api\/v1\/(friendships\/\d+\/(followers|following)\/|users\/web_profile_info\/|users\/\d+\/info\/|feed\/user\/|clips\/user\/|media\/\d+\/(info|likers|comments|comments\/\d+\/child_comments)\/)/.test(
        u.pathname,
      ) ||
        /\/graphql\/(query|query\/)?$/.test(u.pathname) ||
        u.pathname.replace(/\/$/, "") === "/api/graphql")
    );
  } catch {
    return false;
  }
}
export function nativeRequestMatches(
  request: NativeRequest,
  binding: PageBinding,
  posts = new Map<string, Post>(),
): boolean {
  if (!relevantRequest(request)) return false;
  const u = new URL(request.url),
    v = request.variables || {};
  const follow = /\/friendships\/(\d+)\/(followers|following)\//.exec(
    u.pathname,
  );
  if (follow && ![follow[2], "both"].includes(binding.mode)) return false;
  if (follow && binding.sourceId && follow[1] !== binding.sourceId)
    return false;
  if (u.pathname.includes("/likers/") && binding.mode !== "likers")
    return false;
  if (u.pathname.includes("/comments/") && binding.mode !== "commenters")
    return false;
  const media = /\/media\/(\d+)\//.exec(u.pathname);
  if (
    media &&
    binding.input.type === "post" &&
    media[1] !== (binding.postId || shortcodeId(binding.input.shortcode))
  )
    return false;
  if (
    media &&
    binding.input.type === "profile" &&
    binding.sourceId &&
    posts.has(media[1]) &&
    posts.get(media[1])!.ownerId !== binding.sourceId
  )
    return false;
  const feed = /\/feed\/user\/([^/]+)\//.exec(u.pathname);
  if (
    feed &&
    binding.sourceId &&
    feed[1] !== binding.sourceId &&
    (binding.input.type !== "profile" ||
      feed[1].toLowerCase() !== binding.input.username)
  )
    return false;
  const username = u.searchParams.get("username");
  if (
    u.pathname.includes("web_profile_info") &&
    binding.input.type === "profile" &&
    username &&
    username.toLowerCase() !== binding.input.username
  )
    return false;
  const owner = String(v.target_user_id || v.user_id || "");
  if (owner && binding.sourceId && owner !== binding.sourceId) return false;
  if (
    binding.sourceId &&
    ["followers", "following", "both"].includes(binding.mode) &&
    v.id &&
    String(v.id) !== binding.sourceId
  )
    return false;
  return true;
}
export function normalizeNative(
  request: NativeRequest,
  raw: Raw,
  binding: PageBinding,
  knownPosts = new Map<string, Post>(),
  deferUnresolvedMedia = false,
): Capture[] {
  if (
    !nativeRequestMatches(request, binding, knownPosts) ||
    !raw ||
    typeof raw !== "object"
  )
    return [];
  const u = new URL(request.url),
    v = request.variables || {};
  const targetUsername =
    binding.input.type === "profile" ? binding.input.username : undefined;
  const ownerMatches = (p?: Profile) =>
    !!p &&
    (binding.sourceId
      ? p.id === binding.sourceId
      : p.userName.toLowerCase() === targetUsername);
  const frames: Capture[] = [];
  const follow = /\/friendships\/(\d+)\/(followers|following)\//.exec(
    u.pathname,
  );
  if (
    follow &&
    targetUsername &&
    binding.mode !== "single" &&
    binding.mode !== "commenters" &&
    (!binding.sourceId || binding.sourceId === follow[1])
  ) {
    const f = base(follow[2] as Capture["kind"]);
    f.source = {
      id: follow[1],
      userName: targetUsername,
      fullName: "",
      profileUrl: `https://www.instagram.com/${targetUsername}/`,
      avatarUrl: "",
      updatedAt: Date.now(),
    };
    f.targetId = follow[1];
    f.profiles = array(raw.users)
      .map(nativeProfile)
      .filter(Boolean) as Profile[];
    f.requestCursor = u.searchParams.get("max_id") || "";
    pagination(f, raw, raw.next_max_id, [raw.has_more, raw.more_available]);
    if (!Array.isArray(raw.users))
      f.warnings.push("Instagram returned an unsupported follow list.");
    else if (f.profiles.length !== raw.users.length)
      f.warnings.push("Some follow-list profiles were unavailable.");
    frames.push(f);
    return frames;
  }
  const walk = (
    root: any,
    fn: (value: Raw, key: string, parent?: Raw) => void,
  ) => {
    const stack = [
      { node: root, key: "", parent: undefined as Raw | undefined, depth: 0 },
    ];
    let visited = 0;
    while (stack.length && visited++ < 100000) {
      const { node, key, parent, depth } = stack.pop()!;
      if (!node || typeof node !== "object" || depth > 64) continue;
      fn(node, key, parent);
      for (const [k, value] of Object.entries(node).reverse())
        if (k !== "extensions")
          stack.push({ node: value, key: k, parent: node, depth: depth + 1 });
    }
  };
  let source: Profile | undefined;
  walk(raw, (n) => {
    const p = nativeProfile(n);
    if (ownerMatches(p)) source = p;
  });
  if (source) {
    const f = base("profile");
    f.source = source;
    f.profiles = [source];
    f.terminal = true;
    frames.push(f);
  }
  const sourceId = binding.sourceId || source?.id;
  const postRequest = /\/media\/(\d+)\/info\//.exec(u.pathname);
  const info = base("media-info");
  walk(raw, (n) => {
    if (!(n.code || n.shortcode) || !(n.user || n.owner)) return;
    const post = nativePost(n);
    if (!post) return;
    const matches =
      binding.input.type === "post"
        ? post.id ===
            (binding.postId || shortcodeId(binding.input.shortcode)) &&
          String(n.code || n.shortcode) === binding.input.shortcode &&
          (!binding.sourceId || post.ownerId === binding.sourceId)
        : post.ownerId === sourceId;
    if (!matches || (postRequest && post.id !== postRequest[1])) return;
    info.posts.push(post);
    knownPosts.set(post.id, post);
    const p = nativeProfile(n.user || n.owner);
    if (p) {
      info.source = p;
      info.profiles.push(p);
    }
  });
  if (info.posts.length) frames.push(info);
  const restMedia = /^\/api\/v1\/(feed\/user\/([^/]+)|clips\/user)\//.exec(
    u.pathname,
  );
  if (restMedia && sourceId && binding.input.type === "profile") {
    const requestedOwner =
      restMedia[2] || String(v.target_user_id || v.user_id || "");
    if (
      requestedOwner &&
      requestedOwner !== sourceId &&
      requestedOwner.toLowerCase() !== targetUsername
    )
      return frames;
    const f = base(u.pathname.includes("/clips/") ? "reels" : "feed");
    f.source = source;
    f.targetId = sourceId;
    f.posts = array(raw.items)
      .map((n) => nativePost(n.media || n, sourceId))
      .filter((p): p is Post => !!p && p.ownerId === sourceId);
    f.requestCursor = u.searchParams.get("max_id") || String(v.max_id || "");
    pagination(
      f,
      raw,
      f.kind === "reels" ? raw.paging_info?.max_id : raw.next_max_id,
      [raw.more_available, raw.paging_info?.more_available],
    );
    if (!Array.isArray(raw.items) || f.posts.length !== raw.items.length)
      f.warnings.push(
        "Some posts or their owners were unavailable. Saved results are partial.",
      );
    f.posts.forEach((p) => knownPosts.set(p.id, p));
    frames.push(f);
  }
  const likerPath = /\/media\/(\d+)\/likers\//.exec(u.pathname);
  if (likerPath && binding.mode === "likers") {
    const post = knownPosts.get(likerPath[1]);
    if (
      (!post && deferUnresolvedMedia) ||
      (post &&
        (binding.input.type === "post"
          ? post.url.split("/").filter(Boolean).at(-1) ===
            binding.input.shortcode
          : post.ownerId === sourceId))
    ) {
      const f = base("likes");
      f.posts = post ? [post] : [];
      f.targetId = likerPath[1];
      f.source = info.source;
      f.profiles = array(raw.users)
        .map(nativeProfile)
        .filter(Boolean) as Profile[];
      f.requestCursor = u.searchParams.get("max_id") || String(v.max_id || "");
      pagination(f, raw, raw.next_max_id, [raw.has_more, raw.more_available]);
      const total = Number(raw.user_count);
      if (
        ![raw.has_more, raw.more_available].some(
          (flag) => typeof flag === "boolean",
        ) &&
        Number.isSafeInteger(total) &&
        total >= 0 &&
        new Set(f.profiles.map((p) => p.id)).size === total
      )
        f.terminal = true;
      if (!Array.isArray(raw.users) || f.profiles.length !== raw.users.length)
        f.warnings.push("Some liker profiles were unavailable.");
      frames.push(f);
    }
  }
  const restComment =
    /\/media\/(\d+)\/comments\/(?:([0-9]+)\/child_comments\/)?/.exec(
      u.pathname,
    );
  if (restComment) {
    const post = knownPosts.get(restComment[1]);
    if (
      (!post && !deferUnresolvedMedia) ||
      (post &&
        (binding.input.type === "profile"
          ? post.ownerId !== sourceId
          : post.id !== binding.postId &&
            post.url.split("/").filter(Boolean).at(-1) !==
              binding.input.shortcode))
    )
      return frames;
    const f = base(restComment[2] ? "replies" : "comments");
    f.targetId = restComment[1];
    f.parentId = restComment[2];
    f.posts = post ? [post] : [];
    f.source = info.source;
    f.requestCursor = u.searchParams.has("max_id")
      ? `max:${u.searchParams.get("max_id")}`
      : u.searchParams.has("min_id")
        ? `min:${u.searchParams.get("min_id")}`
        : "";
    const rows =
      f.kind === "replies"
        ? raw.child_comments || raw.comments
        : [...array(raw.preview_comments), ...array(raw.comments)];
    if (
      f.kind === "replies"
        ? !Array.isArray(raw.child_comments) && !Array.isArray(raw.comments)
        : !Array.isArray(raw.comments) && !Array.isArray(raw.preview_comments)
    )
      f.warnings.push(
        "Instagram returned an unsupported comment page. Saved results are partial.",
      );
    f.comments = array(rows)
      .map((n) => comment(n, f.warnings))
      .filter(Boolean) as CommentItem[];
    const tail =
      f.kind === "replies"
        ? (raw.has_more_tail_child_comments ?? raw.has_more_comments)
        : raw.has_more_comments;
    const head =
      f.kind === "replies"
        ? raw.has_more_head_child_comments
        : raw.has_more_headload_comments;
    if (tail === true && cursor(raw.next_max_id || raw.max_id))
      f.nextCursors.push(`max:${raw.next_max_id || raw.max_id}`);
    if (head === true && cursor(raw.next_min_id || raw.min_id))
      f.nextCursors.push(`min:${raw.next_min_id || raw.min_id}`);
    f.terminal =
      (typeof tail === "boolean" || typeof raw.more_available === "boolean") &&
      ![tail, head, raw.more_available].includes(true) &&
      !f.nextCursors.length;
    if (
      [tail, head, raw.more_available].includes(true) &&
      !f.nextCursors.length
    )
      f.warnings.push("Instagram omitted a comment pagination cursor.");
    f.restriction = restriction(raw);
    frames.push(f);
  }
  // GraphQL connection adapters use structural fields, never hard-coded query IDs.
  walk(raw, (connection, key, parent) => {
    if (
      !connection.page_info ||
      (!Array.isArray(connection.edges) && !Array.isArray(connection.items))
    )
      return;
    const rows = Array.isArray(connection.edges)
      ? connection.edges.map((e: Raw) => e.node || e)
      : connection.items;
    let kind: Capture["kind"] | undefined;
    if (/edge_followed_by|followers/.test(key)) kind = "followers";
    else if (/edge_follow$|following/.test(key)) kind = "following";
    else if (/edge_liked_by|likers|liking_users/.test(key)) kind = "likes";
    else if (/threaded|replies|child_comment/.test(key)) kind = "replies";
    else if (/parent_comment|comment/.test(key)) kind = "comments";
    else if (/clips|reels/.test(key)) kind = "reels";
    else if (/timeline|user.*media|user.*feed/.test(key)) kind = "feed";
    if (!kind) return;
    // A post dialog can include the owner's timeline/reel previews. Their
    // missing items are unrelated to a collection of this single post.
    if (["feed", "reels"].includes(kind) && binding.input.type === "post")
      return;
    if (kind === "likes" && binding.mode !== "likers") return;
    if (["comments", "replies"].includes(kind) && binding.mode !== "commenters")
      return;
    const f = base(kind);
    f.source = source || info.source;
    const requested = String(v.id || v.user_id || v.target_user_id || "");
    if (
      (kind === "followers" || kind === "following") &&
      ![kind, "both"].includes(binding.mode)
    )
      return;
    if (["followers", "following", "feed", "reels"].includes(kind)) {
      if (
        !sourceId ||
        (requested && requested !== sourceId) ||
        (!["commenters", "likers"].includes(binding.mode) &&
          ["feed", "reels"].includes(kind))
      )
        return;
      f.targetId = sourceId;
      if (kind === "followers" || kind === "following")
        f.profiles = rows.map(nativeProfile).filter(Boolean);
      else {
        f.posts = rows
          .map((n: Raw) => nativePost(n.media || n, sourceId))
          .filter((p: Post | undefined) => p?.ownerId === sourceId);
        f.posts.forEach((p) => knownPosts.set(p.id, p));
      }
    } else {
      const mediaId =
        numeric(v.media_id || v.post_id) ||
        nativePost(parent || {})?.id ||
        binding.postId ||
        (info.posts.length === 1 ? info.posts[0].id : undefined);
      const post = mediaId && knownPosts.get(mediaId);
      if (
        !post ||
        (binding.input.type === "profile" && post.ownerId !== sourceId)
      )
        return;
      f.targetId = post.id;
      f.posts = [post];
      f.parentId =
        kind === "replies"
          ? numeric(
              v.comment_id ||
                v.parent_comment_id ||
                parent?.pk_id ||
                parent?.pk ||
                parent?.id,
            )
          : undefined;
      if (kind === "replies" && !f.parentId) return;
      if (kind === "likes")
        f.profiles = rows.map(nativeProfile).filter(Boolean);
      else
        f.comments = rows
          .map((n: Raw) => comment(n, f.warnings))
          .filter(Boolean);
    }
    if (
      ["followers", "following", "likes"].includes(kind) &&
      f.profiles.length !== rows.length
    )
      f.warnings.push(
        kind === "likes"
          ? "Some liker profiles were unavailable."
          : "Some follow-list profiles were unavailable.",
      );
    if (["feed", "reels"].includes(kind) && f.posts.length !== rows.length)
      f.warnings.push(
        "Some posts or their owners were unavailable. Saved results are partial.",
      );
    f.requestCursor = cursor(v.after)
      ? `after:${v.after}`
      : cursor(v.before)
        ? `before:${v.before}`
        : "";
    const pi = connection.page_info;
    if (pi.has_next_page === true && cursor(pi.end_cursor))
      f.nextCursors.push(`after:${pi.end_cursor}`);
    if (pi.has_previous_page === true && cursor(pi.start_cursor))
      f.nextCursors.push(`before:${pi.start_cursor}`);
    f.terminal =
      (cursor(v.before)
        ? typeof pi.has_previous_page === "boolean"
        : typeof pi.has_next_page === "boolean") &&
      pi.has_next_page !== true &&
      pi.has_previous_page !== true;
    if (
      kind === "comments" &&
      f.terminal &&
      (request.structured || info.posts.some((p) => p.id === f.targetId))
    ) {
      const post = knownPosts.get(f.targetId!);
      // Structured post data can expose only a short comment preview, even
      // with has_next_page:false. Account for replies when checking its size.
      const projected = new Map(
        f.comments.map((c) => [
          c.id,
          1 + Math.max(c.replyCount, new Set(c.replies.map((r) => r.id)).size),
        ]),
      );
      if (
        post?.commentCount == null ||
        [...projected.values()].reduce((a, b) => a + b, 0) < post.commentCount
      ) {
        f.terminal = false;
        f.preview = true;
        f.warnings = [];
      }
    }
    f.restriction = restriction(connection);
    frames.push(f);
  });
  return frames;
}
export function nativeFailure(
  status: number,
  raw: Raw,
  retryAfter: string | null,
): Capture | undefined {
  const message = String(raw?.message || "");
  const f = base("error");
  if (
    status === 429 ||
    raw?.spam === true ||
    /please wait|rate.limit/i.test(message)
  ) {
    f.failure = "rate";
    f.restriction = "Instagram requested a cooldown in page mode.";
    const seconds = Number(retryAfter);
    const until =
      retryAfter && !Number.isFinite(seconds)
        ? Date.parse(retryAfter)
        : Date.now() + Math.max(60, seconds || 900) * 1000;
    f.retryAt = Number.isFinite(until)
      ? Math.max(Date.now() + 60000, until)
      : Date.now() + 900000;
  } else if (
    status === 401 ||
    raw?.challenge ||
    raw?.checkpoint_url ||
    /login_required|challenge_required|checkpoint_required/.test(message)
  ) {
    f.failure = "login";
    f.restriction = "Sign in or finish Instagram verification, then resume.";
  } else if (status === 403 || raw?.status === "fail") {
    f.failure = "restricted";
    f.restriction = "Instagram restricted access. Saved results are partial.";
  } else if (status >= 500) {
    f.failure = "network";
    f.restriction = "Instagram returned a server error. Resume when ready.";
  } else return;
  return f;
}
export function parseNative(text: string): Raw {
  return parse(text) as Raw;
}
