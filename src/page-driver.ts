import {
  numericLikesControl,
  commentLoadControl,
  commentScrollTarget,
} from "./page-controls";
import { samePostPath } from "./instagram-url";
import {
  BRIDGE,
  cleanCapture,
  cleanOutcome,
  validBinding,
  type DriverEvent,
  type PageBinding,
  type PageGoal,
  type PageOutcome,
} from "./page-protocol";
if (!(globalThis as any).__instafinderDriverV3) {
  (globalThis as any).__instafinderDriverV3 = true;
  let seedPosts: unknown[] = [];
  let recheckScroll = false;
  let reopenScope = false;
  let binding: PageBinding | undefined,
    port: chrome.runtime.Port | undefined,
    goal: PageGoal | undefined;
  let buffered: DriverEvent[] = [];
  let overflowed = false;
  let stopped = false;
  let openedList: string | undefined;
  let openedLikesPost: string | undefined;
  let loginReported = false;
  let host: HTMLDivElement | undefined;
  let notice = false;
  const emit = (event: DriverEvent) => {
    if (port) port.postMessage(event);
    else if (binding && buffered.length < 100) buffered.push(event);
    else if (binding) overflowed = true;
  };
  const arm = () => {
    if (binding)
      window.postMessage(
        { channel: BRIDGE, type: "arm", binding, posts: seedPosts },
        location.origin,
      );
  };
  const overlayStyles = `
:host{all:initial;color-scheme:light;position:fixed;z-index:2147483647;bottom:20px;right:20px;font:14px/1.45 system-ui;color:#20372e}
*{box-sizing:border-box}section{width:320px;max-width:calc(100vw - 32px);background:#fff;color:#20372e;border:1px solid #c5d1c9;border-radius:16px;padding:16px;box-shadow:0 6px 28px #0003}
strong{font-size:16px;color:#20372e}p{margin:8px 0;color:#40544a}#progress{font-size:13px}#instructions{color:#20372e}#warning{background:#fff4dc;color:#704800;border-radius:8px;padding:8px}#hint{font-size:13px}p:empty{display:none}
button{color:#20372e;background:#edf2ee;border:1px solid #b5c5ba;border-radius:8px;padding:9px 11px;cursor:pointer;font:inherit;font-weight:600;line-height:1.3}button:hover{background:#dfe9e2}button:focus-visible,input:focus-visible{outline:3px solid #287c56;outline-offset:3px}#finish{color:#fff;background:#245b40;border-color:#245b40;flex:1}#finish:hover{background:#19452f}
button:disabled,#open-app:disabled{cursor:not-allowed;background:#edf2ee;color:#526359;border-color:#b5c5ba}
footer{display:flex;gap:8px;margin-top:14px}label{display:flex;align-items:center;gap:8px;color:#20372e;margin-top:12px;cursor:pointer}input{margin:0;width:16px;height:16px;accent-color:#245b40;flex-shrink:0}#open-post{margin-top:4px}[hidden]{display:none!important}

h2{font-size:18px;line-height:1.3;margin:12px 0 8px;color:#245b40}.unfinished{color:#704800}#open-app{color:#fff;background:#245b40;border-color:#245b40;flex:1}
`;
  function outcomeNotice(outcome: PageOutcome, jobId: string) {
    host?.remove();
    host = document.createElement("div");
    host.id = "instafinder-collection";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${overlayStyles}</style><section aria-label="InstaFinder collection"><strong>InstaFinder</strong><h2 id="result" role="status" aria-live="polite"></h2><p id="saved"></p><p id="reason"></p><footer><button id="dismiss">Dismiss</button><button id="open-app">Open InstaFinder</button></footer></section>`;
    const heading = root.getElementById("result")!;
    heading.textContent =
      outcome.status === "completed"
        ? "Collection complete"
        : outcome.status === "partial"
          ? "Saved partial results"
          : outcome.status === "paused"
            ? "Collection paused"
            : "Collection stopped";
    if (outcome.status !== "completed") heading.className = "unfinished";
    root.getElementById("saved")!.textContent =
      `${outcome.count.toLocaleString()} ${outcome.count === 1 ? "profile" : "profiles"} saved.`;
    root.getElementById("reason")!.textContent =
      outcome.status === "completed"
        ? ""
        : (outcome.reason ||
            "Collection is incomplete. Resume from the extension menu.") +
          (outcome.retryAt && outcome.retryAt > Date.now()
            ? ` Resume after ${new Date(outcome.retryAt).toLocaleString()}.`
            : "");
    root.getElementById("dismiss")!.addEventListener("click", () => {
      host?.remove();
      host = undefined;
      notice = false;
    });
    const actionButton = root.getElementById("open-app") as HTMLButtonElement;
    actionButton.textContent = outcome.resumable
      ? "Resume"
      : "Open InstaFinder";
    const cooldown = outcome.retryAt && outcome.retryAt > Date.now();
    if (outcome.resumable && cooldown) {
      actionButton.disabled = true;
      setTimeout(
        () => {
          actionButton.disabled = false;
        },
        Math.min(2147483647, outcome.retryAt! - Date.now()),
      );
    }
    actionButton.addEventListener("click", () => {
      actionButton.disabled = true;
      void chrome.runtime
        .sendMessage({
          type: outcome.resumable ? "page-resume-here" : "page-open-app",
          jobId,
        })
        .then((reply) => {
          if (reply?.error || !reply?.ok)
            throw new Error(
              reply?.error || "Open InstaFinder from the extension menu.",
            );
          if (!outcome.resumable) actionButton.disabled = false;
        })
        .catch((error) => {
          root.getElementById("reason")!.textContent = error.message;
          actionButton.disabled = false;
        });
    });
    notice = true;
    document.documentElement.append(host);
  }
  function overlay() {
    if (!goal) return;
    if (
      !loginReported &&
      (/\/accounts\/login|\/challenge|\/checkpoint/.test(location.pathname) ||
        document.querySelector('input[name="password"]'))
    ) {
      loginReported = true;
      emit({ type: "action", progress: false, login: true });
    }
    if (!host) {
      host = document.createElement("div");
      host.id = "instafinder-collection";
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML = `<style>${overlayStyles}</style><section aria-label="InstaFinder collection"><strong>InstaFinder</strong><p id="progress"></p><p id="instructions"></p><p id="warning" role="status" aria-live="polite"></p><p id="hint"></p><button id="open-post" hidden>Open next post</button><label><input type="checkbox" id="automatic">Automatic</label><footer><button id="pause">Pause</button><button id="finish">Finish with saved results</button></footer></section>`;
      root.getElementById("open-post")!.addEventListener("click", () => {
        if (goal?.postUrl)
          emit({ type: "action", progress: true, navigate: goal.postUrl });
      });
      root
        .getElementById("pause")!
        .addEventListener("click", () => emit({ type: "pause" }));
      root
        .getElementById("finish")!
        .addEventListener("click", () => emit({ type: "finish" }));
      root.getElementById("automatic")!.addEventListener("change", (e) =>
        emit({
          type: "automatic",
          value: (e.target as HTMLInputElement).checked,
        }),
      );
      (host as any).__root = root;
      document.documentElement.append(host);
    }
    const root = (host as any).__root as ShadowRoot;
    const label =
      goal.stage === "followers"
        ? "Followers"
        : goal.stage === "following"
          ? "Following"
          : goal.stage === "media"
            ? goal.channel === "reels"
              ? "Reels"
              : "Posts"
            : goal.stage === "comments"
              ? "Comments"
              : goal.stage === "likes"
                ? "Likers"
                : "Profile";
    const target =
      goal.input.type === "profile"
        ? `@${goal.input.username}`
        : "Selected post";
    root.getElementById("progress")!.textContent =
      `${target} · ${label} · ${goal.count.toLocaleString()} saved`;
    const list = goal.stage === "followers" || goal.stage === "following";
    root.getElementById("instructions")!.textContent = goal.automatic
      ? list
        ? `Opening ${label} and scrolling for you.`
        : "Collecting automatically. You can keep reviewing in InstaFinder."
      : list
        ? `Open ${label} on ${target}, then scroll inside that list.`
        : goal.stage === "media"
          ? `Open ${label} on ${target}, then scroll down.`
          : goal.stage === "comments"
            ? "Open the selected post, scroll its comments and expand replies."
            : goal.stage === "likes"
              ? "Open the post’s likes count, then scroll inside the people list."
              : "Keep this profile open while it is saved.";
    const actualList = currentList();
    const wrongList = list && actualList && actualList !== goal.stage;
    root.getElementById("warning")!.textContent = wrongList
      ? goal.mode === "both"
        ? `${actualList === "followers" ? "Followers" : "Following"} is included too. Open ${label} to finish this step.`
        : `This is ${actualList === "followers" ? "Followers" : "Following"}; it is not being saved. Close it and open ${label}.`
      : "";
    root.getElementById("hint")!.textContent = goal.hint || "";
    (root.getElementById("open-post") as HTMLButtonElement).hidden = !(
      ["comments", "likes"].includes(goal.stage) &&
      goal.postUrl &&
      !samePostPath(new URL(goal.postUrl).pathname, location.pathname)
    );
    (root.getElementById("automatic") as HTMLInputElement).checked =
      goal.automatic;
  }
  const visible = (el: HTMLElement): boolean => {
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
    // Instagram can use display:contents on profile counter links.
    return (
      !!el.getClientRects().length ||
      (style.display === "contents" &&
        [...el.children].some((child) => visible(child as HTMLElement)))
    );
  };
  const clickable = () =>
    [
      ...document.querySelectorAll<HTMLElement>(
        'button, a[href], [role="button"], [role="link"]',
      ),
    ].filter(visible);
  function currentList(): "followers" | "following" | undefined {
    const dialog = [
      ...document.querySelectorAll<HTMLElement>('[role="dialog"]'),
    ].find(visible);
    const title = dialog
      ?.querySelector("h1,h2,[role=heading]")
      ?.textContent?.trim()
      .toLowerCase();
    if (title === "followers" || title === "following") return title;
    const pathList = /\/(followers|following)\/?$/.exec(location.pathname)?.[1];
    const value = pathList || (dialog ? openedList : undefined);
    return value === "followers" || value === "following" ? value : undefined;
  }
  function listControl(username: string, kind: "followers" | "following") {
    const target = (control: HTMLElement) =>
      [...control.querySelectorAll<HTMLElement>("span,div")]
        .reverse()
        .find(
          (el) => el.textContent?.trim().toLowerCase() === kind && visible(el),
        ) || control;
    const controls = clickable().filter((el) => !el.closest('[role="dialog"]'));
    const link = controls.find((el) => {
      const href = el.getAttribute("href");
      if (!href) return false;
      try {
        const url = new URL(href, location.href);
        return (
          url.origin === location.origin &&
          decodeURIComponent(url.pathname).replace(/\/$/, "").toLowerCase() ===
            `/${username}/${kind}`
        );
      } catch {
        return false;
      }
    });
    if (link) return target(link);
    if (location.pathname.split("/")[1]?.toLowerCase() !== username) return;
    // New layouts expose profile counters as buttons, with the label nested
    // alongside the count. Match the full word, never the Follow/Following action.
    const counter = controls.find((el) => {
      const labels = [el.getAttribute("aria-label"), el.textContent];
      return (
        labels.some(
          (label) =>
            label &&
            new RegExp(
              `^(?:[\\d.,\\s]+[KMBkmb]?\\s*)?${kind}(?:\\s*[\\d.,]+[KMBkmb]?)?$`,
            ).test(label.trim().toLowerCase()),
        ) &&
        (kind !== "following" ||
          /\d/.test(el.textContent || "") ||
          el.querySelector("[title], [data-count]"))
      );
    });
    return counter ? target(counter) : undefined;
  }
  // Give immediate feedback in manual mode, including when the other list is ignored
  // by the response observer. Shadow-root mutations cannot trigger this observer.
  let lastVisibleList: string | undefined;
  new MutationObserver(() => {
    if (!goal) return;
    const list = currentList();
    if (list !== lastVisibleList) {
      lastVisibleList = list;
      overlay();
    }
  }).observe(document, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  document.addEventListener(
    "click",
    (event) => {
      if (!goal || !(event.target instanceof Element)) return;
      const link = event.target.closest<HTMLAnchorElement>("a[href]");
      const match =
        link &&
        /\/([^/]+)\/(followers|following)\/?$/.exec(
          new URL(link.href).pathname,
        );
      if (
        match &&
        goal.input.type === "profile" &&
        match[1].toLowerCase() === goal.input.username
      )
        openedList = match[2];
    },
    true,
  );
  let lastClick: HTMLElement | undefined,
    lastClickState = "";
  let openingKey = "",
    openingMisses = 0;
  const click = (el?: HTMLElement | null) => {
    if (!el) return false;
    const state = `${goal?.stage}:${goal?.channel || ""}:${goal?.postUrl || ""}:${el.textContent || ""}`;
    const changed = el !== lastClick || state !== lastClickState;
    lastClick = el;
    lastClickState = state;
    el.click();
    return changed;
  };
  function action(): DriverEvent {
    if (!goal || !goal.automatic) return { type: "action", progress: false };
    if (
      /\/accounts\/login|\/challenge|\/checkpoint/.test(location.pathname) ||
      document.querySelector('input[name="password"]')
    )
      return { type: "action", progress: false, login: true };
    if (goal.stage === "profile") return { type: "action", progress: false };
    const targetName =
      goal.input.type === "profile" ? goal.input.username : undefined;
    const dialog = [
      ...document.querySelectorAll<HTMLElement>('[role="dialog"]'),
    ]
      .filter(visible)
      .at(-1);
    if (goal.stage === "followers" || goal.stage === "following") {
      const key = `${goal.jobId}:${goal.stage}`;
      if (key !== openingKey) {
        openingKey = key;
        openingMisses = 0;
      }
      const control = targetName && listControl(targetName, goal.stage);
      const opposite = goal.stage === "followers" ? "following" : "followers";
      if (reopenScope) {
        reopenScope = false;
        if (dialog && currentList() === goal.stage) {
          const close = [
            ...dialog.querySelectorAll<HTMLElement>('button,[role="button"]'),
          ].find((el) =>
            /close/i.test(
              el.getAttribute("aria-label") ||
                el.querySelector("svg")?.getAttribute("aria-label") ||
                "",
            ),
          );
          if (close) return { type: "action", progress: click(close) };
          return {
            type: "action",
            progress: false,
            unsupported:
              "Close the open list, then open it again. Manual capture is active.",
          };
        }
      }
      const title = (
        dialog?.querySelector("h1,h2,[role=heading]")?.textContent || ""
      )
        .trim()
        .toLowerCase();
      if (dialog && (title || openedList) === opposite) {
        return {
          type: "action",
          progress: click(
            [
              ...dialog.querySelectorAll<HTMLElement>('button,[role="button"]'),
            ].find((el) =>
              /close/i.test(
                el.getAttribute("aria-label") ||
                  el.querySelector("svg")?.getAttribute("aria-label") ||
                  "",
              ),
            ),
          ),
        };
      }
      if (!dialog && !location.pathname.includes(`/${goal.stage}`)) {
        if (control) {
          openingMisses = 0;
          openedList = goal.stage;
          return { type: "action", progress: click(control) };
        }
        // A native SPA may reveal its counters after the initial document loads.
        // Retry before deciding that the layout needs manual capture.
        if (++openingMisses < 3) return { type: "action", progress: false };
        return {
          type: "action",
          progress: false,
          unsupported: `Couldn’t find the ${goal.stage === "followers" ? "Followers" : "Following"} control. Manual capture is active.`,
        };
      }
      return {
        type: "action",
        progress: scroll(dialog || document.documentElement),
      };
    }
    if (goal.stage === "media") {
      if (goal.channel === "reels" && !location.pathname.endsWith("/reels/")) {
        const reels = clickable().find(
          (el) =>
            el instanceof HTMLAnchorElement &&
            new URL(el.href).pathname === `/${targetName}/reels/`,
        );
        if (!reels) {
          const key = `${goal.jobId}:reels`;
          if (openingKey !== key) {
            openingKey = key;
            openingMisses = 0;
          }
          if (++openingMisses < 3) return { type: "action", progress: false };
          return {
            type: "action",
            progress: false,
            unsupported:
              "Instagram did not expose a reels tab. Reels coverage is partial.",
          };
        }
        openingMisses = 0;
        return { type: "action", progress: click(reels) };
      }
      return { type: "action", progress: scroll(document.documentElement) };
    }
    if (goal.stage === "comments" || goal.stage === "likes") {
      const expectedPath = goal.postUrl && new URL(goal.postUrl).pathname;
      if (expectedPath && !samePostPath(expectedPath, location.pathname)) {
        if (dialog) {
          const close = [
            ...dialog.querySelectorAll<HTMLElement>('button,[role="button"]'),
          ].find((el) =>
            /close/i.test(
              el.getAttribute("aria-label") ||
                el.querySelector("svg")?.getAttribute("aria-label") ||
                "",
            ),
          );
          if (close) return { type: "action", progress: click(close) };
        }
        const link = clickable().find(
          (el) =>
            el instanceof HTMLAnchorElement &&
            new URL(el.href).origin === location.origin &&
            samePostPath(
              new URL(el.href).pathname,
              new URL(goal!.postUrl!).pathname,
            ),
        );
        if (link) return { type: "action", progress: click(link) };
        // A source's accessible post may have scrolled out of a virtualized grid.
        return { type: "action", progress: true, navigate: goal.postUrl };
      }
      const buttons = clickable();
      if (goal.stage === "likes") {
        const title =
          dialog?.querySelector("h1,h2,[role=heading]")?.textContent?.trim() ||
          "";
        const likesDialog =
          dialog &&
          (/^(likes|likers)$/i.test(title) || openedLikesPost === goal.postUrl);
        if (reopenScope) {
          reopenScope = false;
          if (likesDialog) {
            const close = buttons.find(
              (el) =>
                dialog.contains(el) &&
                /^(close|dismiss)$/i.test(
                  el.getAttribute("aria-label") || el.textContent?.trim() || "",
                ),
            );
            if (close) {
              openedLikesPost = undefined;
              return { type: "action", progress: click(close) };
            }
            return {
              type: "action",
              progress: false,
              unsupported:
                "Close the likes list, then open it again. Manual capture is active.",
            };
          }
        }
        if (likesDialog) return { type: "action", progress: scroll(dialog) };
        const controls = buttons.filter((el) => !dialog || dialog.contains(el));
        const shortcode = goal.postUrl?.split("/").filter(Boolean).at(-1);
        const likes =
          controls.find((el) => {
            const href = el.getAttribute("href");
            if (!href) return false;
            try {
              const url = new URL(href, location.href);
              return (
                url.origin === location.origin &&
                new RegExp(`/(p|reel)/${shortcode}/liked_by/?$`).test(
                  url.pathname,
                )
              );
            } catch {
              return false;
            }
          }) ||
          controls.find((el) =>
            /^(?:[\d.,\s]+[kmb]?\s+likes|view likes|liked by .+|others)$/i.test(
              el.textContent?.trim() || "",
            ),
          ) ||
          numericLikesControl(controls);
        if (likes) {
          openedLikesPost = goal.postUrl;
          return {
            type: "action",
            progress: click(likes.querySelector<HTMLElement>("span") || likes),
          };
        }
        const key = `${goal.jobId}:likes:${goal.postUrl}`;
        if (openingKey !== key) {
          openingKey = key;
          openingMisses = 0;
        }
        if (++openingMisses < 3) return { type: "action", progress: false };
        return {
          type: "action",
          progress: false,
          unsupported:
            "Couldn’t find the likes count. Open it manually to capture likers.",
        };
      }
      const postRoots = dialog
        ? [dialog]
        : [...document.querySelectorAll<HTMLElement>("article")].filter(
            visible,
          );
      if (!postRoots.length) {
        const main = document.querySelector<HTMLElement>("main,[role=main]");
        if (main && visible(main)) postRoots.push(main);
      }
      for (const root of postRoots) {
        const controls = buttons.filter((el) => root.contains(el));
        const more = commentLoadControl(controls);
        if (more) return { type: "action", progress: click(more) };
        const target = commentScrollTarget(root);
        if (target) return { type: "action", progress: scroll(target, false) };
      }
      const key = `${goal.jobId}:comments:${goal.postUrl}`;
      if (openingKey !== key) {
        openingKey = key;
        openingMisses = 0;
      }
      const commentButton = buttons.find((el) =>
        el.querySelector('svg[aria-label="Comment"]'),
      );
      if (++openingMisses === 1 && commentButton)
        return { type: "action", progress: click(commentButton) };
      if (openingMisses < 3) return { type: "action", progress: false };
      return {
        type: "action",
        progress: false,
        unsupported:
          "Couldn’t find the comments pane. Open all comments and expand replies manually; capture remains active.",
      };
    }
    return { type: "action", progress: false };
  }
  function scroll(root: HTMLElement, findContainer = true) {
    const containers = [
      root,
      ...root.querySelectorAll<HTMLElement>("div,ul"),
    ].filter(
      (el) =>
        el.scrollHeight > el.clientHeight + 30 &&
        /auto|scroll/.test(getComputedStyle(el).overflowY),
    );
    const target = !findContainer
      ? root
      : containers.sort((a, b) => b.scrollHeight - a.scrollHeight)[0] ||
        (document.scrollingElement as HTMLElement);
    if (!target) return false;
    const old = target.scrollTop;
    if (recheckScroll) {
      recheckScroll = false;
      if (old > 0) {
        target.scrollTop = Math.max(
          0,
          old - Math.min(120, target.clientHeight / 2),
        );
        return target.scrollTop !== old;
      }
    }
    target.scrollBy({
      top: Math.max(900, target.clientHeight * 2.4),
      behavior: "instant",
    });
    return target.scrollTop > old;
  }
  window.addEventListener("message", (event) => {
    if (
      !binding ||
      event.source !== window ||
      event.origin !== location.origin ||
      event.data?.channel !== BRIDGE ||
      event.data.jobId !== binding.jobId
    )
      return;
    if (event.data.type === "identity-needed")
      emit({ type: "identity-needed" });
    else if (event.data.type === "capture") {
      const capture = cleanCapture(event.data.capture);
      if (capture) emit({ type: "capture", capture });
    }
  });
  chrome.runtime.onConnect.addListener((connection) => {
    if (
      connection.name !== BRIDGE ||
      !binding ||
      connection.sender?.id !== chrome.runtime.id
    )
      return;
    port = connection;
    connection.onMessage.addListener((message) => {
      if (port !== connection) return;
      if (
        message?.type === "goal" &&
        validBinding(message.goal) &&
        message.goal.jobId === binding?.jobId
      ) {
        goal = message.goal;
        binding = message.goal;
        arm();
        overlay();
      } else if (message?.type === "step") {
        try {
          emit(action());
        } catch {
          emit({
            type: "action",
            progress: false,
            unsupported: "Instagram's layout changed. Use manual capture.",
          });
        }
      } else if (message?.type === "stop") {
        stopped = true;
        binding = undefined;
        goal = undefined;
        buffered = [];
        window.postMessage(
          { channel: BRIDGE, type: "disarm" },
          location.origin,
        );
        if (!notice) {
          host?.remove();
          host = undefined;
        }
      }
    });
    connection.onDisconnect.addListener(() => {
      if (port !== connection) return;
      stopped = true;
      binding = undefined;
      goal = undefined;
      buffered = [];
      port = undefined;
      if (!notice) {
        host?.remove();
        host = undefined;
      }
      window.postMessage({ channel: BRIDGE, type: "disarm" }, location.origin);
    });
    emit({ type: "ready" });
    for (const event of buffered) emit(event);
    buffered = [];
    if (overflowed) {
      emit({
        type: "capture",
        capture: {
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
            "Native capture overflowed before connection. Resume from the beginning.",
        },
      });
      overflowed = false;
    }
  });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message?.type === "page-ping") {
      respond({ version: 3 });
      return;
    }
    if (message?.type === "page-arm" && validBinding(message.goal)) {
      const input = message.goal.input;
      const path = location.pathname;
      const scoped =
        input.type === "profile"
          ? path.split("/")[1]?.toLowerCase() === input.username ||
            (message.goal.postUrl &&
              samePostPath(path, new URL(message.goal.postUrl).pathname))
          : samePostPath(path, new URL(input.url).pathname);
      if (!scoped) {
        respond({ error: "The Instagram page changed." });
        return;
      }
      const pendingEvents =
        binding?.jobId === message.goal.jobId ? buffered : [];
      port?.disconnect();
      port = undefined;
      stopped = false;
      binding = message.goal;
      goal = message.goal;
      buffered = pendingEvents;
      overflowed = false;
      seedPosts = Array.isArray(message.posts) ? message.posts : [];
      recheckScroll = message.continueTraversal === true;
      reopenScope =
        !recheckScroll ||
        (message.goal.stage === "likes" && message.goal.count === 0);
      if (reopenScope) {
        openedList = undefined;
        openedLikesPost = undefined;
      }
      openingKey = "";
      openingMisses = 0;
      notice = false;
      host?.remove();
      host = undefined;
      document.getElementById("instafinder-collection")?.remove();
      arm();
      overlay();
      respond({ ok: true });
      return;
    }
    if (message?.type !== "page-disarm") return;
    stopped = true;
    binding = undefined;
    goal = undefined;
    buffered = [];
    overflowed = false;
    window.postMessage({ channel: BRIDGE, type: "disarm" }, location.origin);
    const outcome = cleanOutcome(message.outcome);
    if (outcome && typeof message.jobId === "string")
      outcomeNotice(outcome, message.jobId);
    else {
      host?.remove();
      host = undefined;
      notice = false;
    }
  });
  void chrome.runtime
    .sendMessage({ type: "page-bootstrap" })
    .then((reply) => {
      if (stopped || binding) return;
      if (validBinding(reply?.binding)) {
        binding = reply.binding;
        arm();
        const marker = new URLSearchParams(location.hash.slice(1)).get(
          "if-collect",
        );
        if (marker === binding!.jobId)
          history.replaceState(
            history.state,
            "",
            location.pathname + location.search,
          );
      } else
        window.postMessage(
          { channel: BRIDGE, type: "disarm" },
          location.origin,
        );
    })
    .catch(() => {
      if (binding) return;
      window.postMessage({ channel: BRIDGE, type: "disarm" }, location.origin);
    });
}
