import { db, preferences, type Database } from "./db";
import { wait } from "./instagram";
import { PageStore } from "./page-store";
import { BRIDGE, type DriverEvent, type PageGoal } from "./page-protocol";
export class PageRunner {
  store: PageStore;
  private controller?: AbortController;
  private jobId?: string;
  private port?: chrome.runtime.Port;
  private reason?: string;
  private navigating = false;
  private sharedRetryAt?: number;
  constructor(
    public database: Database = db,
    private request: (message: any) => Promise<any> = (message) =>
      chrome.runtime.sendMessage(message),
  ) {
    this.store = new PageStore(database);
  }
  get busy() {
    return !!this.jobId;
  }
  pause(reason = "Paused. Resume when ready.") {
    if (this.controller?.signal.aborted) return;
    this.reason = reason;
    this.controller?.abort();
  }
  cooldown(retryAt: number) {
    this.sharedRetryAt = Math.max(retryAt, this.sharedRetryAt || 0);
    this.pause(
      "Instagram requested a cooldown. Resume after the indicated time.",
    );
  }
  async run(
    id: string,
    onStarted?: () => void,
    options: { inPlace?: boolean; continueTraversal?: boolean } = {},
  ) {
    if (this.busy) throw new Error("A collection is already running.");
    if (!(await this.store.begin(id, options.continueTraversal))) return;
    await this.store.identifySaved(id);
    this.jobId = id;
    this.controller = new AbortController();
    this.reason = undefined;
    this.sharedRetryAt = undefined;
    const signal = this.controller.signal;
    let serial = Promise.resolve(),
      stalls = 0,
      progress = 0,
      previousProgress = -1;
    let waitingForIdentity = false;
    let tabId: number | undefined;
    let documentId: string | undefined;
    let connectingPort: chrome.runtime.Port | undefined;
    const state = () =>
      this.database.transaction(
        "r",
        this.database.runs,
        this.database.pendingPageJobs,
        async () =>
          (await this.database.runs.get(id)) ||
          (await this.database.pendingPageJobs.get(id)),
      );
    const sendGoal = async () => {
      const port = this.port;
      if (!port) return;
      const goal = await this.store.goal(id);
      if (signal.aborted || this.port !== port) return;
      port.postMessage({ type: "goal", goal });
      await this.request({
        type: "page-bind",
        jobId: id,
        binding: goal,
      });
    };
    const interruption = (message: any) => {
      if (message?.type === "page-interrupted" && message.jobId === id)
        this.pause(message.reason);
    };
    chrome.runtime.onMessage.addListener(interruption);
    const onEvent = async (event: DriverEvent) => {
      if (signal.aborted) return;
      if (event.type === "capture") {
        if (await this.store.accept(id, event.capture)) {
          progress++;
          if (["likes", "comments", "replies"].includes(event.capture.kind))
            waitingForIdentity = false;
        }
        const current = await state();
        if (current?.status === "cooldown" && current.retryAt)
          await this.request({
            type: "page-cooldown",
            jobId: id,
            retryAt: current.retryAt,
          });
        if (current?.status !== "running") {
          this.pause();
          return;
        }
        await sendGoal();
      } else if (event.type === "identity-needed") {
        waitingForIdentity = true;
        const reason = "Waiting for post details from Instagram.";
        await this.database.runs.update(id, { reason });
        await this.database.pendingPageJobs.update(id, { reason });
        await sendGoal();
      } else if (event.type === "automatic") {
        await this.store.setAutomatic(id, event.value);
        stalls = 0;
        await sendGoal();
      } else if (event.type === "pause") this.pause();
      else if (event.type === "finish") {
        await this.store.stop(
          id,
          "Finished with saved results. Traversal was incomplete.",
          "partial",
        );
        this.pause();
      } else if (event.type === "ready") await sendGoal();
      else if (event.type === "action") {
        if (event.progress) progress++;
        if (event.login) {
          this.pause("Sign in or finish Instagram verification, then resume.");
          return;
        }
        if (event.navigate) {
          this.navigating = true;
          documentId = undefined;
          const reply = await this.request({
            type: "page-navigate",
            jobId: id,
            url: event.navigate,
          });
          if (reply?.error || !reply?.ok)
            throw new Error(
              reply?.error || "Could not open the next Instagram post.",
            );
          documentId = reply.documentId;
        }
        if (event.unsupported) {
          const goal = await this.store.goal(id);
          if (goal.stage === "media" && goal.channel === "reels")
            await this.store.skipReels(id, event.unsupported);
          else {
            await this.store.setAutomatic(id, false);
            await this.database.runs.update(id, { reason: event.unsupported });
            await this.database.pendingPageJobs.update(id, {
              reason: event.unsupported,
            });
          }
          await sendGoal();
        }
      }
    };
    const connect = async () => {
      const deadline = Date.now() + 30000;
      while (!signal.aborted && Date.now() < deadline) {
        let ready = false;
        const port = chrome.tabs.connect(tabId!, {
          name: BRIDGE,
          ...(documentId ? { documentId } : {}),
        });
        connectingPort = port;
        port.onMessage.addListener((event) => {
          if (event?.type === "ready") {
            ready = true;
            this.port = port;
            this.navigating = false;
          }
          serial = serial
            .then(() => onEvent(event))
            .catch((error) =>
              this.pause(
                error instanceof Error ? error.message : "Page capture failed.",
              ),
            );
        });
        port.onDisconnect.addListener(() => {
          if (this.port !== port) return;
          this.port = undefined;
          if (!signal.aborted && !this.navigating)
            this.pause(
              "The Instagram tab closed or reloaded. Resume when ready.",
            );
        });
        await wait(150, signal);
        if (ready) {
          this.port = port;
          this.navigating = false;
          await sendGoal();
          return;
        }
        port.disconnect();
        await wait(250, signal);
      }
      if (!signal.aborted)
        throw new Error(
          "Instagram page mode could not connect. Reload the extension and resume.",
        );
    };
    try {
      const reply = await this.request({
        type: "page-open",
        binding: await this.store.binding(id),
        inPlace: options.inPlace,
        continueTraversal: options.continueTraversal,
      });
      if (reply?.error || !reply?.tabId)
        throw new Error(reply?.error || "Could not open Instagram.");
      tabId = reply.tabId;
      documentId = reply.documentId;
      await connect();
      onStarted?.();
      while (!signal.aborted) {
        await serial;
        const current = await state();
        if (!current || current.status !== "running") break;
        const timing = await preferences(this.database);
        if ((timing.pageCooldownUntil || 0) > Date.now()) {
          this.cooldown(timing.pageCooldownUntil!);
          break;
        }
        if (this.navigating && !this.port) {
          await connect();
          stalls = 0;
        }
        const settings = await preferences(this.database);
        await wait(
          Math.max(0.5, settings.pageDelaySeconds ?? 1.5) * 1000,
          signal,
        );
        await serial;
        if ((await state())?.status !== "running") break;
        const cooldown = (await preferences(this.database)).pageCooldownUntil;
        if (cooldown && cooldown > Date.now()) {
          this.cooldown(cooldown);
          break;
        }
        const goal: PageGoal = await this.store.goal(id);
        if (!goal.automatic) {
          stalls = 0;
          continue;
        }
        if (previousProgress === progress) stalls++;
        else stalls = 0;
        previousProgress = progress;
        if (stalls >= 3) {
          await this.store.stop(
            id,
            waitingForIdentity
              ? "Couldn’t verify this post and its owner from Instagram. Open the post/reel directly and resume."
              : "No new data after three attempts. You can resume collection.",
            "paused",
          );
          break;
        }
        this.port?.postMessage({ type: "goal", goal });
        this.port?.postMessage({ type: "step" });
      }
    } catch (error) {
      if (!signal.aborted)
        this.reason =
          error instanceof Error ? error.message : "Page mode failed.";
    } finally {
      this.controller?.abort();
      await serial;
      if ((await state())?.status === "running")
        await this.store.stop(
          id,
          this.reason || "Paused. Resume when ready.",
          this.sharedRetryAt ? "cooldown" : "paused",
          this.sharedRetryAt,
        );
      try {
        this.port?.postMessage({ type: "stop" });
        this.port?.disconnect();
      } catch {}
      try {
        connectingPort?.disconnect();
      } catch {}
      const final = await state();
      const count = new Set(
        (await this.database.results.where("runId").equals(id).toArray()).map(
          (r) => r.profileId,
        ),
      ).size;
      await this.request({
        type: "page-stop",
        jobId: id,
        outcome:
          final && final.status !== "running"
            ? {
                status: final.status,
                count,
                reason: final.reason,
                retryAt: final.retryAt,
                resumable:
                  !("checkpoint" in final) || final.checkpoint.stage !== "done",
              }
            : undefined,
      }).catch(() => {});
      chrome.runtime.onMessage.removeListener(interruption);
      this.port = undefined;
      this.jobId = undefined;
      this.controller = undefined;
      this.navigating = false;
    }
  }
}
