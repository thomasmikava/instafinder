import { db } from "./db";
import { PageRunner } from "./page-runner";
import { PageStore } from "./page-store";
import {
  cleanOutcome,
  validBinding,
  type PageBinding,
  type PageOutcome,
} from "./page-protocol";
import { instagramTabInput, sameInput } from "./popup-context";
import type { Input, Mode } from "./types";

interface Owned {
  tabId: number;
  lastJobId?: string;
  binding?: PageBinding;
  navigating?: boolean;
  navigationUrl?: string;
  documentId?: string;
}
const ownedKey = (tabId: number) => `ownedPage:${tabId}`;
const getOwned = async (tabId?: number): Promise<Owned | undefined> =>
  tabId === undefined
    ? undefined
    : ((await chrome.storage.session.get(ownedKey(tabId)))[ownedKey(tabId)] as
        Owned | undefined);
const putOwned = async (value: Owned) =>
  chrome.storage.session.set({ [ownedKey(value.tabId)]: value });
const allOwned = async (): Promise<Owned[]> => {
  const saved = await chrome.storage.session.get(null);
  return Object.entries(saved)
    .filter(([key]) => key.startsWith("ownedPage:"))
    .map(([, value]) => value as Owned);
};
const findOwned = async (jobId: string) =>
  (await allOwned()).find(
    (owned) => (owned.binding?.jobId || owned.lastJobId) === jobId,
  );
interface Job {
  id: string;
  page: PageRunner;
  tabId?: number;
  from?: Input;
  task?: Promise<unknown>;
  queue: Promise<unknown>;
  started: boolean;
}
const jobs = new Map<string, Job>();
const serialized = <T>(job: Job, operation: () => Promise<T>): Promise<T> => {
  const next = job.queue.then(operation, operation);
  job.queue = next.catch(() => {});
  return next;
};
const disarm = async (tabId: number, outcome?: PageOutcome, jobId?: string) => {
  await chrome.tabs
    .sendMessage(tabId, { type: "page-disarm", outcome, jobId })
    .catch(() => {});
};
const extensionSender = (sender: chrome.runtime.MessageSender) =>
  sender.id === chrome.runtime.id &&
  ["app.html", "popup.html"].some((path) =>
    sender.url?.startsWith(chrome.runtime.getURL(path)),
  );
const store = new PageStore(db);
const ready = (async () => {
  // A worker/browser restart never silently resumes a traversal.
  await db.transaction("rw", db.runs, db.pendingPageJobs, async () => {
    const paused = {
      status: "paused" as const,
      reason: "Collection interrupted. Resume from the extension menu.",
      updatedAt: Date.now(),
    };
    await db.runs
      .where("status")
      .equals("running")
      .filter((r) => r.method === "page")
      .modify(paused);
    await db.pendingPageJobs.where("status").equals("running").modify(paused);
  });
  // Migrate the old single-tab binding; tab bindings remain temporary.
  const legacy = (await chrome.storage.session.get("ownedPage")).ownedPage as
    Owned | undefined;
  if (legacy) {
    await putOwned(legacy);
    await chrome.storage.session.remove("ownedPage");
  }
  for (const owned of await allOwned()) {
    if (owned.binding) {
      await disarm(owned.tabId);
      await putOwned({
        tabId: owned.tabId,
        lastJobId: owned.binding.jobId,
        documentId: owned.documentId,
      });
    }
  }
})();

async function pageCommand(message: any, job: Job): Promise<any> {
  if (message.type === "page-open" && validBinding(message.binding)) {
    const binding: PageBinding = message.binding;
    let tab =
      job.tabId !== undefined ? await chrome.tabs.get(job.tabId) : undefined;
    if (
      tab &&
      !sameInput(
        instagramTabInput(tab.url) || { type: "profile", username: "" },
        job.from || binding.input,
      )
    )
      throw new Error("The Instagram page changed. Open the menu again.");
    if (!tab) {
      const owned = await findOwned(binding.jobId);
      if (owned)
        tab = await chrome.tabs.get(owned.tabId).catch(() => undefined);
      if (tab && jobsForTab(tab.id!).some((other) => other.id !== job.id))
        tab = undefined;
      if (!tab)
        tab = await chrome.tabs.create({ url: "about:blank", active: true });
    }
    if (jobsForTab(tab.id!).some((other) => other.id !== job.id))
      throw new Error("This Instagram tab is already collecting.");
    job.tabId = tab.id!;
    if (message.inPlace) {
      if (!tab) throw new Error("The Instagram tab is no longer open.");
      await putOwned({ tabId: tab.id!, binding, navigating: false });
      return armPage(tab.id!, binding, message.continueTraversal === true);
    }
    const url =
      binding.input.type === "profile"
        ? `https://www.instagram.com/${binding.input.username}/`
        : binding.input.url;
    await putOwned({
      tabId: tab.id!,
      binding,
      navigating: true,
      navigationUrl: url,
    });
    // A fragment-only update does not create a document. Move through an empty
    // document when restarting this exact URL, then navigate with the marker in
    // place from document_start. SPA history updates must not strip the marker
    // before a separate reload starts.
    if (tab.url?.split("#")[0] === url)
      await chrome.tabs.update(tab.id!, { url: "about:blank" });
    await navigateTab(
      tab.id!,
      `${url}#if-collect=${encodeURIComponent(binding.jobId)}`,
    );
    return armPage(tab.id!, binding, false);
  }
  if (
    message.type === "page-cooldown" &&
    message.jobId === job.id &&
    Number.isFinite(message.retryAt) &&
    message.retryAt > Date.now()
  ) {
    for (const other of jobs.values())
      if (other.id !== job.id) other.page.cooldown(message.retryAt);
    return { ok: true };
  }
  const owned = await getOwned(job.tabId);
  if (!owned?.binding || owned.binding.jobId !== message.jobId) return {};
  if (message.type === "page-bind" && validBinding(message.binding)) {
    await putOwned({ ...owned, binding: message.binding });
    return { ok: true };
  }
  if (message.type === "page-stop") {
    await putOwned({
      tabId: owned.tabId,
      lastJobId: owned.binding.jobId,
      documentId: owned.documentId,
    });
    await disarm(
      owned.tabId,
      cleanOutcome(message.outcome),
      owned.binding.jobId,
    );
    return { ok: true };
  }
  if (
    message.type === "page-navigate" &&
    /^https:\/\/www\.instagram\.com\/(p|reel)\/[A-Za-z0-9_-]+\/$/.test(
      message.url,
    )
  ) {
    await putOwned({ ...owned, navigating: true, navigationUrl: message.url });
    await navigateTab(
      owned.tabId,
      `${message.url}#if-collect=${encodeURIComponent(owned.binding.jobId)}`,
    );
    const connected = await armPage(owned.tabId, owned.binding, false);
    return { ok: true, documentId: connected.documentId };
  }
  return {};
}
async function navigateTab(tabId: number, url: string) {
  await new Promise<void>((resolve, reject) => {
    const expected = instagramTabInput(url);
    const stop = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
    };
    const listener = (
      id: number,
      change: chrome.tabs.OnUpdatedInfo,
      tab: chrome.tabs.Tab,
    ) => {
      const input = instagramTabInput(tab.url);
      if (
        id === tabId &&
        change.status === "complete" &&
        input &&
        expected &&
        sameInput(input, expected)
      ) {
        stop();
        resolve();
      }
    };
    const timer = setTimeout(() => {
      stop();
      reject(
        new Error(
          "Instagram did not finish opening. Resume when the page is ready.",
        ),
      );
    }, 20000);
    chrome.tabs.onUpdated.addListener(listener);
    void chrome.tabs.update(tabId, { url }).catch((error) => {
      stop();
      reject(error);
    });
  });
}
async function armPage(
  tabId: number,
  binding: PageBinding,
  continueTraversal: boolean,
) {
  const goal = await store.goal(binding.jobId);
  const posts = binding.sourceId
    ? await db.posts
        .where("ownerId")
        .equals(binding.sourceId)
        .filter(
          (p) =>
            p.id === binding.postId ||
            (!!goal.postUrl && p.url === goal.postUrl),
        )
        .limit(2)
        .toArray()
    : [];
  const deadline = Date.now() + 12000;
  let error: unknown;
  while (Date.now() < deadline) {
    try {
      const injected = await chrome.scripting.executeScript({
        target: { tabId },
        files: ["page-observer.js"],
        world: "MAIN",
      });
      const documentId = injected[0]?.documentId;
      if (!documentId) throw new Error("Instagram page is not ready.");
      const alive = await chrome.tabs
        .sendMessage(tabId, { type: "page-ping" }, { documentId })
        .catch(() => undefined);
      if (alive?.version !== 3) {
        // Reloading an extension can leave an invalidated isolated-world global
        // behind. A flag alone is not proof that its runtime listeners still live.
        await chrome.scripting.executeScript({
          target: { tabId, documentIds: [documentId] },
          world: "ISOLATED",
          func: () => {
            delete (globalThis as any).__instafinderDriverV3;
          },
        });
        await chrome.scripting.executeScript({
          target: { tabId, documentIds: [documentId] },
          files: ["page-driver.js"],
          world: "ISOLATED",
        });
      }
      const reply = await chrome.tabs.sendMessage(
        tabId,
        { type: "page-arm", goal, posts, continueTraversal },
        { documentId },
      );
      if (!reply?.ok)
        throw new Error(reply?.error || "Instagram page did not connect.");
      const owned = await getOwned(tabId);
      if (owned?.binding?.jobId !== binding.jobId)
        throw new Error("Collection changed.");
      await putOwned({ ...owned, documentId, navigating: false });
      return { tabId, documentId };
    } catch (e) {
      error = e;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    error instanceof Error
      ? `Could not start on this Instagram page: ${error.message}`
      : "Instagram page could not connect.",
  );
}
const jobsForTab = (tabId: number) =>
  [...jobs.values()].filter((job) => job.tabId === tabId);
async function ensureAvailable(id: string, tabId?: number) {
  const conflicts = [...jobs.values()].filter(
    (job) => job.id === id || (tabId !== undefined && job.tabId === tabId),
  );
  for (const job of conflicts) {
    const previous =
      (await db.runs.get(job.id)) || (await db.pendingPageJobs.get(job.id));
    if (job.started && previous && previous.status !== "running")
      await job.task;
  }
  if (jobs.has(id))
    throw new Error("This collection is already running in another tab.");
  if (tabId !== undefined && jobsForTab(tabId).length)
    throw new Error(
      "This Instagram tab is already collecting. Pause it first.",
    );
}
async function start(
  id: string,
  tabId?: number,
  from?: Input,
  inPlace = false,
  continueTraversal = false,
) {
  await ensureAvailable(id, tabId);
  // Reserve synchronously after the check, before any startup work can yield.
  if (jobs.has(id) || (tabId !== undefined && jobsForTab(tabId).length))
    throw new Error("This collection or tab is already running.");
  const job: Job = {
    id,
    tabId,
    from,
    queue: Promise.resolve(),
    started: false,
    page: undefined!,
  };
  job.page = new PageRunner(db, (message) =>
    serialized(job, () => pageCommand(message, job)),
  );
  jobs.set(id, job);
  let announced = false;
  const accepted = new Promise<{ id: string }>((resolve, reject) => {
    job.task = navigator.locks
      .request(
        "instafinder-collection",
        { ifAvailable: true, mode: "shared" },
        async (collectionLock) => {
          if (!collectionLock)
            throw new Error(
              "Pause direct collection before collecting from Instagram.",
            );
          return navigator.locks.request(
            `instafinder-page-job:${id}`,
            { ifAvailable: true },
            async (jobLock) => {
              if (!jobLock)
                throw new Error(
                  "This collection is already running in another tab.",
                );
              const heartbeat = setInterval(() => {
                void chrome.storage.session
                  .get(job.tabId === undefined ? [] : ownedKey(job.tabId))
                  .catch(() =>
                    job.page.pause(
                      "Connection interrupted. Resume from the extension menu.",
                    ),
                  );
              }, 20000);
              try {
                await job.page.run(
                  id,
                  () => {
                    job.started = true;
                    announced = true;
                    resolve({ id });
                  },
                  { inPlace, continueTraversal },
                );
                if (!announced) {
                  const state =
                    (await db.runs.get(id)) ||
                    (await db.pendingPageJobs.get(id));
                  reject(
                    new Error(state?.reason || "Collection could not start."),
                  );
                }
              } finally {
                clearInterval(heartbeat);
              }
            },
          );
        },
      )
      .catch(reject)
      .finally(() => {
        if (jobs.get(id) === job) jobs.delete(id);
      });
  });
  return accepted;
}
async function openApp(missionId?: string) {
  const base = chrome.runtime.getURL("app.html");
  const url = missionId
    ? `${base}#mission=${encodeURIComponent(missionId)}`
    : base;
  // Own extension contexts are discoverable without requesting access to
  // unrelated tabs' URLs. tabs.query may omit app.html's URL without tabs access.
  const contexts = chrome.runtime.getContexts
    ? await chrome.runtime.getContexts({ contextTypes: ["TAB"] })
    : [];
  const app = contexts.find(
    (c) => c.tabId >= 0 && c.documentUrl?.startsWith(base),
  );
  const existing = app
    ? await chrome.tabs.get(app.tabId).catch(() => undefined)
    : (await chrome.tabs.query({})).find((tab) => tab.url?.startsWith(base));
  if (existing?.id) {
    await chrome.tabs.update(existing.id, {
      active: true,
      ...(missionId ? { url } : {}),
    });
    if (existing.windowId)
      await chrome.windows.update(existing.windowId, { focused: true });
  } else await chrome.tabs.create({ url });
  return { ok: true };
}
async function handle(message: any, sender: chrome.runtime.MessageSender) {
  await ready;
  if (message?.type === "page-bootstrap") {
    const ownedTab = await getOwned(sender.tab?.id);
    const job = ownedTab?.binding && jobs.get(ownedTab.binding.jobId);
    if (!job) return {};
    return serialized(job, async () => {
      const owned = await getOwned(sender.tab?.id);
      if (
        !owned?.binding ||
        owned.binding.jobId !== job.id ||
        sender.tab?.id !== owned.tabId ||
        sender.id !== chrome.runtime.id ||
        !sender.url?.startsWith("https://www.instagram.com/")
      )
        return {};
      if (owned.navigating && owned.navigationUrl && sender.documentId) {
        const current = instagramTabInput(sender.url),
          expected = instagramTabInput(owned.navigationUrl);
        if (current && expected && sameInput(current, expected))
          await putOwned({
            ...owned,
            documentId: sender.documentId,
            navigating: false,
          });
      }
      return { binding: owned.binding };
    });
  }
  if (message?.type === "page-open-app") {
    const owned = await getOwned(sender.tab?.id);
    if (
      !owned ||
      sender.id !== chrome.runtime.id ||
      sender.tab?.id !== owned.tabId ||
      !sender.url?.startsWith("https://www.instagram.com/") ||
      message.jobId !== (owned.binding?.jobId || owned.lastJobId)
    )
      return {};
    const pending = await db.pendingPageJobs.get(message.jobId);
    const link = await db.runLinks.where("runId").equals(message.jobId).first();
    return openApp(pending?.missionId || link?.missionId);
  }
  if (message?.type === "page-resume-here") {
    const owned = await getOwned(sender.tab?.id);
    if (
      !owned ||
      sender.id !== chrome.runtime.id ||
      sender.tab?.id !== owned.tabId ||
      !sender.url?.startsWith("https://www.instagram.com/") ||
      message.jobId !== owned.lastJobId ||
      sender.documentId !== owned.documentId
    )
      throw new Error("This page changed. Resume from the extension menu.");
    const run = await db.runs.get(message.jobId);
    const pending = await db.pendingPageJobs.get(message.jobId);
    if (
      (!run && !pending) ||
      (run && (run.method !== "page" || run.checkpoint.stage === "done"))
    )
      throw new Error("Choose a new collection from the extension menu.");
    await start(
      message.jobId,
      owned.tabId,
      instagramTabInput(sender.url),
      true,
      true,
    );
    return { ok: true };
  }
  if (!extensionSender(sender)) return {};
  if (message.type === "open-app") return openApp(message.missionId);
  if (message.type === "popup-context") {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    const owned = await getOwned(tab?.id);
    return {
      previousJobId:
        owned?.tabId === tab?.id
          ? owned?.binding?.jobId || owned?.lastJobId
          : undefined,
      tabId: tab?.id,
      input: instagramTabInput(tab?.url),
      busy: !!tab?.id && jobsForTab(tab.id).length > 0,
      activeJobId: tab?.id ? jobsForTab(tab.id)[0]?.id : undefined,
    };
  }
  if (message.type === "collector-state")
    return {
      busy: jobs.size > 0,
      jobs: [...jobs.values()].map((job) => ({ id: job.id, tabId: job.tabId })),
    };
  if (message.type === "collector-pause") {
    const job =
      typeof message.id === "string"
        ? jobs.get(message.id)
        : Number.isInteger(message.tabId)
          ? jobsForTab(message.tabId)[0]
          : undefined;
    if (!job) throw new Error("Choose the collection to pause.");
    job.page.pause();
    return { ok: true };
  }
  if (message.type === "collector-again") {
    const run = await db.runs.get(message.id);
    if (run?.method !== "page") throw new Error("Page collection not found.");
    const binding = await store.binding(run.id);
    const job = await store.create(
      binding.input.type === "profile"
        ? binding.input.username
        : binding.input.url,
      binding.mode,
      message.missionId,
    );
    return start(job.id);
  }
  if (message.type === "collector-resume") {
    const run = await db.runs.get(message.id),
      pending = await db.pendingPageJobs.get(message.id);
    if (run?.method !== "page" && !pending)
      throw new Error("Page collection not found.");
    if (run && (run.status === "completed" || run.checkpoint.stage === "done"))
      throw new Error("Choose Collect again to start a new traversal.");
    let from: Input | undefined;
    if (message.tabId !== undefined) {
      const tab = await chrome.tabs.get(message.tabId);
      from = instagramTabInput(tab.url);
      const owned = await getOwned(tab.id);
      if (
        !from ||
        (!sameInput(from, (await store.binding(message.id)).input) &&
          !(owned && owned.tabId === tab.id && owned.lastJobId === message.id))
      )
        throw new Error(
          "Open the original Instagram profile or post to resume.",
        );
    }
    return start(message.id, message.tabId, from);
  }

  if (message.type === "popup-start") {
    if (
      !Number.isInteger(message.tabId) ||
      !["followers", "following", "commenters", "likers"].includes(message.mode)
    )
      throw new Error("Choose a collection on an Instagram profile or post.");
    const tab = await chrome.tabs.get(message.tabId),
      input = instagramTabInput(tab.url);
    if (!message.input || !input || !sameInput(input, message.input))
      throw new Error("The Instagram page changed. Open the menu again.");
    if (
      !input ||
      (input.type === "post" &&
        !["commenters", "likers"].includes(message.mode))
    )
      throw new Error("Open an Instagram profile, post or reel first.");
    await ensureAvailable("new", tab.id);
    const mission = await db.missions.get(message.missionId);
    if (!mission) throw new Error("Choose a mission first.");
    const value = input.type === "post" ? input.url : input.username;
    const job = await store.create(value, message.mode as Mode, mission.id);
    return start(job.id, tab.id, input, true);
  }
  return {};
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  void handle(message, sender).then(reply, (error) =>
    reply({
      error: error instanceof Error ? error.message : "Collection failed.",
    }),
  );
  return true;
});
chrome.tabs.onRemoved.addListener((id) => {
  for (const job of jobsForTab(id))
    job.page.pause("The Instagram tab closed. Resume from the extension menu.");
  void chrome.storage.session.remove(ownedKey(id));
});
