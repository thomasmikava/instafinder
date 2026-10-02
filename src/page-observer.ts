import {
  BRIDGE,
  cleanCapture,
  validBinding,
  type Capture,
  type PageBinding,
} from "./page-protocol";
import {
  nativeFailure,
  nativeRequestMatches,
  normalizeNative,
  parseNative,
  relevantRequest,
  requestInfo,
} from "./page-adapters";
import type { Post, Profile } from "./types";
import { postFromPath, samePostPath } from "./instagram-url";
export function installObserver(surface: Window = window) {
  let binding: PageBinding | undefined;
  const posts = new Map<string, Post>();
  const sources = new Map<string, Profile>();
  // Metadata can arrive after the dialog's list response. Keep only normalized
  // observations in memory until the post and owner are verified, never raw JSON.
  let deferredPages: Capture[] = [];
  let identityNotice = false;
  // Only extension-opened URLs carry this short-lived bootstrap marker. Clone early
  // responses before the asynchronous ownership check, but inspect none until armed.
  const marker = new URLSearchParams(surface.location.hash.slice(1)).get(
    "if-collect",
  );
  let early: {
    info:
      ReturnType<typeof requestInfo> | Promise<ReturnType<typeof requestInfo>>;
    status: number;
    body: Promise<string> | Record<string, any>;
    retry: string | null;
  }[] = [];
  let earlyOverflow = false;
  let provisional = !!marker && marker.length < 100;
  setTimeout(() => {
    early = [];
    provisional = false;
  }, 5000);
  const emit = (capture: unknown) => {
    if (binding)
      surface.postMessage(
        { channel: BRIDGE, type: "capture", jobId: binding.jobId, capture },
        surface.location.origin,
      );
  };
  const flushPages = () => {
    const current = binding;
    if (!current) return;
    const targetUsername =
      current.input.type === "profile" ? current.input.username : undefined;
    deferredPages = deferredPages.filter((frame) => {
      const post = posts.get(frame.targetId || "");
      if (!post) return true;
      const source = sources.get(post.ownerId);
      const ownerId =
        current.sourceId ||
        (current.input.type === "profile"
          ? [...sources.values()].find(
              (p) => p.userName.toLowerCase() === targetUsername,
            )?.id
          : source?.id);
      const matches =
        current.input.type === "post"
          ? post.url.split("/").filter(Boolean).at(-1) ===
            current.input.shortcode
          : post.ownerId === ownerId;
      if (!matches) return false;
      if (post.ownerId !== ownerId) return true;
      emit({ ...frame, posts: [post], source });
      return false;
    });
    if (!deferredPages.length) identityNotice = false;
  };
  const scoped = () => {
    if (!binding) return false;
    const path = surface.location.pathname;
    return binding.input.type === "profile"
      ? path.split("/")[1]?.toLowerCase() === binding.input.username ||
          !!postFromPath(path)
      : samePostPath(path, new URL(binding.input.url).pathname);
  };
  const consume = (
    info: ReturnType<typeof requestInfo>,
    status: number,
    text: string | Record<string, any>,
    retry: string | null,
    jobId?: string,
  ) => {
    if (
      !binding ||
      jobId !== binding.jobId ||
      !scoped() ||
      (typeof text === "string" && text.length > 16 * 1024 * 1024)
    )
      return;
    if (!nativeRequestMatches(info, binding, posts)) return;
    try {
      const raw = typeof text === "string" ? parseNative(text) : text;
      const failure = nativeFailure(status, raw, retry);
      if (failure) {
        emit(failure);
        return;
      }
      const targetUsername =
        binding.input.type === "profile" ? binding.input.username : undefined;
      const observedSource = [...sources.values()].find(
        (p) => p.userName.toLowerCase() === targetUsername,
      );
      // The isolated runner may not have acknowledged earlier metadata yet.
      const observedBinding =
        !binding.sourceId && observedSource
          ? { ...binding, sourceId: observedSource.id }
          : binding;
      for (const value of normalizeNative(
        info,
        raw,
        observedBinding,
        posts,
        true,
      )) {
        const frame = cleanCapture(value);
        if (!frame) continue;
        if (frame.source) sources.set(frame.source.id, frame.source);
        if (!["likes", "comments", "replies"].includes(frame.kind)) {
          emit(frame);
          continue;
        }
        if (
          deferredPages.length >= 100 ||
          deferredPages.reduce(
            (n, f) => n + f.profiles.length + f.comments.length,
            0,
          ) +
            frame.profiles.length +
            frame.comments.length >
            20000
        ) {
          emit({
            ...frame,
            profiles: [],
            posts: [],
            failure: "schema",
            kind: "error",
            restriction:
              "Post details could not be verified before the capture buffer filled. Resume from the post.",
          });
          deferredPages = [];
          return;
        }
        deferredPages.push(frame);
      }
      flushPages();
      if (deferredPages.length && !identityNotice) {
        identityNotice = true;
        surface.postMessage(
          { channel: BRIDGE, type: "identity-needed", jobId: binding.jobId },
          surface.location.origin,
        );
      }
    } catch {
      /* Unsupported bodies never affect Instagram's own response. */
    }
  };
  const originalFetch = surface.fetch;
  surface.fetch = function (
    this: Window,
    input: RequestInfo | URL,
    init?: RequestInit,
  ) {
    let requestBody: Promise<string> | undefined;
    try {
      if (
        (binding || provisional) &&
        input instanceof Request &&
        !init?.body &&
        relevantRequest(requestInfo(input.url))
      )
        requestBody = input
          .clone()
          .text()
          .catch(() => "");
    } catch {}
    const response = Reflect.apply(originalFetch, this, [input, init]);
    try {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const info = requestInfo(url, init?.body);
      const jobId = binding?.jobId;
      if (relevantRequest(info)) {
        const details = requestBody
          ? requestBody.then((body) => requestInfo(url, body)).catch(() => info)
          : Promise.resolve(info);
        void response
          .then(async (r: Response) => {
            const responseJobId = jobId || binding?.jobId;
            if (!responseJobId || !binding) {
              if (provisional) {
                const clone = r.clone();
                if (early.length < 100)
                  early.push({
                    info: details,
                    status: r.status,
                    body: clone.text().catch(() => ""),
                    retry: r.headers.get("Retry-After"),
                  });
                else {
                  earlyOverflow = true;
                  void clone.body?.cancel().catch(() => {});
                }
              }
              return;
            }
            if (responseJobId !== binding.jobId || !scoped()) return;
            // Clone synchronously, before an awaiting page consumer can lock the original body.
            const clone = r.clone();
            const text = clone.text();
            consume(
              await details,
              r.status,
              await text,
              r.headers.get("Retry-After"),
              responseJobId,
            );
          })
          .catch(() => {});
      }
    } catch {}
    return response;
  } as typeof fetch;
  const XHR = (surface as any).XMLHttpRequest as typeof XMLHttpRequest;
  const open = XHR.prototype.open,
    send = XHR.prototype.send;
  const requests = new WeakMap<XMLHttpRequest, string>();
  XHR.prototype.open = function (...args: any[]) {
    requests.set(this, String(args[1]));
    return Reflect.apply(open, this, args);
  };
  XHR.prototype.send = function (
    body?: Document | XMLHttpRequestBodyInit | null,
  ) {
    const info = requestInfo(requests.get(this) || "", body);
    const jobId = binding?.jobId;
    if (relevantRequest(info))
      this.addEventListener(
        "load",
        () => {
          try {
            const responseJobId = jobId || binding?.jobId;
            if (
              responseJobId &&
              (!binding || responseJobId !== binding.jobId || !scoped())
            )
              return;
            if (!responseJobId && !provisional) return;
            const text =
              this.responseType === "json"
                ? this.response
                : this.responseType === "" || this.responseType === "text"
                  ? this.responseText
                  : "";
            if (!responseJobId) {
              if (early.length < 100)
                early.push({
                  info,
                  status: this.status,
                  body: typeof text === "string" ? Promise.resolve(text) : text,
                  retry: this.getResponseHeader("Retry-After"),
                });
              else earlyOverflow = true;
              return;
            }
            consume(
              info,
              this.status,
              text,
              this.getResponseHeader("Retry-After"),
              responseJobId,
            );
          } catch {}
        },
        { once: true },
      );
    return Reflect.apply(send, this, [body]);
  };
  let seenScripts = new WeakSet<Element>();
  const scan = () => {
    if (!binding || !scoped()) return;
    for (const script of surface.document.querySelectorAll(
      'script[type="application/json"]',
    )) {
      if (seenScripts.has(script)) continue;
      seenScripts.add(script);
      const text = script.textContent || "";
      // Structured hydration only: no arbitrary script evaluation or HTML scraping for IDs.
      if (text.length < 16 * 1024 * 1024)
        consume(
          { url: "https://www.instagram.com/graphql/query/", structured: true },
          200,
          text,
          null,
          binding.jobId,
        );
    }
  };
  surface.addEventListener("message", (event) => {
    if (
      event.source !== surface ||
      event.origin !== surface.location.origin ||
      event.data?.channel !== BRIDGE
    )
      return;
    if (event.data.type === "arm" && validBinding(event.data.binding)) {
      if (binding?.jobId !== event.data.binding.jobId) {
        posts.clear();
        sources.clear();
        deferredPages = [];
        identityNotice = false;
        seenScripts = new WeakSet<Element>();
      }
      binding = event.data.binding;
      for (const post of cleanCapture({
        kind: "media-info",
        posts: event.data.posts,
      })?.posts || [])
        if (
          post.ownerId === binding!.sourceId &&
          (!binding!.postId || post.id === binding!.postId)
        )
          posts.set(post.id, post);
      if (marker === binding!.jobId) {
        const buffered = early;
        early = [];
        void (async () => {
          for (const item of buffered) {
            try {
              consume(
                await item.info,
                item.status,
                await item.body,
                item.retry,
                marker,
              );
            } catch {}
          }
          if (earlyOverflow && binding?.jobId === marker)
            emit({
              kind: "error",
              profiles: [],
              posts: [],
              comments: [],
              requestCursor: "",
              nextCursors: [],
              terminal: false,
              warnings: [],
              failure: "schema",
              restriction:
                "Native startup capture overflowed. Resume from the beginning.",
            });
          earlyOverflow = false;
        })();
      } else early = [];
      provisional = false;
      scan();
      flushPages();
    } else if (event.data.type === "disarm") {
      binding = undefined;
      provisional = false;
      early = [];
      posts.clear();
      sources.clear();
      deferredPages = [];
      identityNotice = false;
    }
  });
  const mutation = new MutationObserver(scan);
  mutation.observe(surface.document, { childList: true, subtree: true });
}
if (!(globalThis as any).__instafinderObserverV3) {
  (globalThis as any).__instafinderObserverV3 = true;
  installObserver();
}
