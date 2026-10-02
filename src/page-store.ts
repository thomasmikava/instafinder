import { db, preferences, type Database } from "./db";
import { applyObservation, reuseRun, uid } from "./data";
import { parseInput, shortcodeId } from "./instagram";
import {
  cleanCapture,
  type Capture,
  type PageBinding,
  type PageGoal,
} from "./page-protocol";
import type {
  CommentItem,
  Mode,
  Observation,
  PageReceipt,
  PendingPageJob,
  Run,
  Stage,
  Thread,
} from "./types";
const checkpoint = (stage: Stage) => ({
  stage,
  cursor: null,
  seenCursors: [],
  pageCount: 0,
  stageCount: 0,
});
export function coverage(
  receipts: PageReceipt[],
): "complete" | "incomplete" | "cycle" {
  const byCursor = new Map(receipts.map((r) => [r.requestCursor, r]));
  const state = new Map<string, number>();
  const stack = [{ key: "", finish: false }];
  while (stack.length) {
    const { key, finish } = stack.pop()!;
    const r = byCursor.get(key);
    if (finish) {
      state.set(
        key,
        r &&
          (r.terminal
            ? !r.nextCursors.length
            : r.nextCursors.length > 0 &&
              r.nextCursors.every((n) => state.get(n) === 2))
          ? 2
          : 3,
      );
      continue;
    }
    if (state.get(key) === 1) return "cycle";
    if (state.has(key)) continue;
    if (!r) {
      state.set(key, 3);
      continue;
    }
    state.set(key, 1);
    stack.push({ key, finish: true });
    for (const next of [...r.nextCursors].reverse())
      stack.push({ key: next, finish: false });
  }
  return state.get("") === 2 ? "complete" : "incomplete";
}
export const covered = (receipts: PageReceipt[]) =>
  coverage(receipts) === "complete";

export class PageStore {
  constructor(public database: Database = db) {}
  async create(
    value: string,
    mode: Mode,
    missionId: string,
  ): Promise<PendingPageJob> {
    const input = parseInput(value);
    if (input.type === "post" && mode !== "likers") mode = "commenters";
    if (!(await this.database.missions.get(missionId)))
      throw new Error("Mission not found.");
    const job: PendingPageJob = {
      id: uid(),
      missionId,
      input,
      mode,
      automatic: true,
      status: "paused",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await this.database.pendingPageJobs.put(job);
    return job;
  }
  async binding(id: string): Promise<PageBinding> {
    return this.database.transaction(
      "r",
      this.database.runs,
      this.database.pendingPageJobs,
      this.database.profiles,
      this.database.posts,
      async () => {
        const run = await this.database.runs.get(id);
        if (run) {
          let input = run.pageInput;
          if (!input) {
            const source = await this.database.profiles.get(run.sourceId);
            const post =
              run.targetPostId &&
              (await this.database.posts.get(run.targetPostId));
            input =
              post && post.url
                ? parseInput(post.url)
                : { type: "profile", username: source!.userName };
          }
          return {
            jobId: id,
            input,
            mode: run.mode,
            sourceId: run.sourceId,
            postId: run.targetPostId,
          };
        }
        const job = await this.database.pendingPageJobs.get(id);
        if (!job) throw new Error("Collection not found.");
        return { jobId: id, input: job.input, mode: job.mode };
      },
    );
  }

  async begin(id: string, continueTraversal = false) {
    const settings = await preferences(this.database);
    if ((settings.pageCooldownUntil || 0) > Date.now())
      throw new Error(
        `Page mode is cooling down. Resume after ${new Date(settings.pageCooldownUntil!).toLocaleString()}.`,
      );
    const run = await this.database.runs.get(id);
    if (run) {
      if (run.status === "completed" || run.checkpoint.stage === "done")
        return false;
      await this.database.runs.update(id, {
        status: "running",
        pageEpoch: continueTraversal ? run.pageEpoch || uid() : uid(),
        reason: undefined,
        retryAt: undefined,
        updatedAt: Date.now(),
      });
    } else if (await this.database.pendingPageJobs.get(id))
      await this.database.pendingPageJobs.update(id, {
        status: "running",
        reason: undefined,
        retryAt: undefined,
        updatedAt: Date.now(),
      });
    else throw new Error("Collection not found.");
    return true;
  }
  async identifySaved(id: string) {
    const pending = await this.database.pendingPageJobs.get(id);
    // Usernames can change owners; let native profile/follow responses identify
    // the current account. A previously verified post ID/owner is immutable.
    if (!pending || pending.input.type !== "post") return;
    const post = await this.database.posts.get(
      shortcodeId(pending.input.shortcode),
    );
    const source = post && (await this.database.profiles.get(post.ownerId));
    if (post && source)
      await this.accept(id, {
        kind: "media-info",
        source,
        profiles: [source],
        posts: [post],
        comments: [],
        requestCursor: "",
        nextCursors: [],
        terminal: false,
        warnings: [],
      });
  }
  async stop(
    id: string,
    reason = "Paused. Resume when ready.",
    status: Run["status"] = "paused",
    retryAt?: number,
  ) {
    await this.database.transaction("rw", this.database.tables, async () => {
      const table = (await this.database.runs.get(id))
        ? this.database.runs
        : this.database.pendingPageJobs;
      await table.update(id, {
        status,
        reason,
        retryAt,
        updatedAt: Date.now(),
        ...(status === "partial" ? { completedAt: Date.now() } : {}),
      });
      if (retryAt)
        await this.database.settings.put({
          ...(await preferences(this.database)),
          pageCooldownUntil: Math.max(
            retryAt,
            (await preferences(this.database)).pageCooldownUntil || 0,
          ),
        });
    });
  }
  async setAutomatic(id: string, automatic: boolean) {
    await this.database.runs.update(id, { pageAutomatic: automatic });
    await this.database.pendingPageJobs.update(id, { automatic });
  }
  async accept(id: string, value: unknown): Promise<boolean> {
    const frame = cleanCapture(value);
    if (!frame) return false;
    return this.database.transaction("rw", this.database.tables, async () => {
      let run = await this.database.runs.get(id);
      const pending = await this.database.pendingPageJobs.get(id);
      if ((run || pending)?.status !== "running") return false;
      // Reject the other list before it can identify a pending source or create a run.
      if (
        (frame.kind === "followers" || frame.kind === "following") &&
        ![frame.kind, "both"].includes((run || pending)!.mode)
      )
        return false;
      if (frame.kind === "likes" && (run || pending)!.mode !== "likers")
        return false;
      if (
        ["comments", "replies"].includes(frame.kind) &&
        (run || pending)!.mode !== "commenters"
      )
        return false;
      if (
        ["feed", "reels"].includes(frame.kind) &&
        (run?.scope === "post" || pending?.input.type === "post")
      )
        return false;
      if (frame.failure) {
        await this.stop(
          id,
          frame.restriction || "Instagram stopped collection.",
          frame.failure === "rate"
            ? "cooldown"
            : frame.failure === "restricted"
              ? "partial"
              : "paused",
          frame.retryAt,
        );
        return true;
      }
      if (!run) {
        if (!pending || !frame.source) return false;
        const source = frame.source;
        if (
          pending.input.type === "profile" &&
          source.userName.toLowerCase() !== pending.input.username
        )
          return false;
        const post =
          pending.input.type === "post"
            ? frame.posts.find(
                (p) =>
                  p.id ===
                    shortcodeId(
                      pending.input.type === "post"
                        ? pending.input.shortcode
                        : "",
                    ) && p.ownerId === source.id,
              )
            : undefined;
        if (pending.input.type === "post" && !post) return false;
        const stage =
          pending.mode === "single"
            ? "done"
            : pending.mode === "followers" || pending.mode === "both"
              ? "followers"
              : pending.mode === "following"
                ? "following"
                : post
                  ? pending.mode === "likers"
                    ? "likes"
                    : "comments"
                  : "media";
        run = {
          id,
          key: post
            ? `post:${post.id}:${pending.mode}`
            : `profile:${source.id}:${pending.mode}`,
          sourceId: source.id,
          targetLabel: source.userName + (post ? " · post/reel" : ""),
          mode: pending.mode,
          method: "page",
          pageInput: pending.input,
          pageEpoch: uid(),
          pageAutomatic: pending.automatic,
          scope: post ? "post" : "profile",
          targetPostId: post?.id,
          status: pending.mode === "single" ? "completed" : "running",
          checkpoint: checkpoint(stage),
          createdAt: pending.createdAt,
          updatedAt: Date.now(),
          ...(pending.mode === "single" ? { completedAt: Date.now() } : {}),
        };
        await applyObservation(
          {
            profiles: [source],
            posts: post ? [post] : [],
            run,
            runPosts: post
              ? [{ runId: id, postId: post.id, done: 0, commentCount: 0 }]
              : [],
            results:
              pending.mode === "single"
                ? [{ runId: id, kind: "single", profileId: source.id }]
                : [],
          },
          this.database,
        );
        await reuseRun(id, pending.missionId, this.database);
        await this.database.pendingPageJobs.delete(id);
      }
      if (run.status === "completed") return true;
      const observation: Observation = {
        profiles: frame.source?.id === run.sourceId ? [frame.source] : [],
        run,
        results: [],
      };
      if (frame.kind === "profile") {
        await applyObservation(observation, this.database);
        await this.advance(run);
        return true;
      }
      const follows = frame.kind === "followers" || frame.kind === "following";
      if (
        follows &&
        (frame.targetId !== run.sourceId ||
          ![frame.kind, "both"].includes(run.mode))
      )
        return false;
      const commentKind = frame.kind === "comments" || frame.kind === "replies";
      if (!follows && !["commenters", "likers"].includes(run.mode))
        return false;
      if (
        ["feed", "reels"].includes(frame.kind) &&
        frame.targetId !== run.sourceId
      )
        return false;
      let novel = true;
      const posts = frame.posts.filter(
        (p) =>
          p.ownerId === run!.sourceId &&
          (run!.scope === "profile" || p.id === run!.targetPostId),
      );
      if (commentKind || frame.kind === "likes") {
        const post =
          posts.find((p) => p.id === frame.targetId) ||
          (await this.database.posts.get(frame.targetId || ""));
        if (
          !post ||
          post.ownerId !== run.sourceId ||
          (run.scope === "post" && post.id !== run.targetPostId)
        )
          return false;
        if (frame.kind === "replies" && !frame.parentId) return false;
      }
      observation.posts = posts;
      observation.runPosts = [];
      for (const p of posts) {
        const old = await this.database.runPosts.get([id, p.id]);
        if (!old)
          observation.runPosts.push({
            runId: id,
            postId: p.id,
            done: 0,
            commentCount: 0,
          });
      }
      if (follows) {
        observation.profiles!.push(...frame.profiles);
        observation.follows = frame.profiles.map((p) => ({
          followerId: frame.kind === "followers" ? p.id : run!.sourceId,
          followingId: frame.kind === "followers" ? run!.sourceId : p.id,
          lastSeenAt: Date.now(),
        }));
        observation.results = frame.profiles.map((p) => ({
          runId: id,
          kind: frame.kind,
          profileId: p.id,
        }));
      }
      if (commentKind) await this.comments(run, frame, observation);
      if (frame.kind === "likes") {
        observation.profiles!.push(...frame.profiles);
        observation.likes = frame.profiles.map((p) => ({
          postId: frame.targetId!,
          ownerId: run!.sourceId,
          profileId: p.id,
          lastSeenAt: Date.now(),
        }));
        observation.results = frame.profiles.map((p) => ({
          runId: id,
          kind: `likers:${frame.targetId}`,
          profileId: p.id,
        }));
      }
      if (
        !frame.preview &&
        [
          "followers",
          "following",
          "feed",
          "reels",
          "comments",
          "replies",
          "likes",
        ].includes(frame.kind)
      ) {
        const target = frame.targetId || run.sourceId;
        const receipt: PageReceipt = {
          id: JSON.stringify([
            id,
            run.pageEpoch,
            frame.kind,
            target,
            frame.parentId || "",
            frame.requestCursor,
          ]),
          runId: id,
          epoch: run.pageEpoch!,
          kind: frame.kind as PageReceipt["kind"],
          targetId: frame.parentId ? `${target}:${frame.parentId}` : target,
          requestCursor: frame.requestCursor,
          nextCursors: frame.nextCursors,
          terminal: frame.terminal,
          updatedAt: Date.now(),
        };
        if (receipt.nextCursors.includes(receipt.requestCursor))
          frame.restriction =
            "Instagram repeated a pagination cursor. Saved results are partial.";
        const existing = await this.database.pageReceipts.get(receipt.id);
        if (
          existing &&
          JSON.stringify(existing.nextCursors) !==
            JSON.stringify(receipt.nextCursors)
        )
          frame.warnings.push(
            "Instagram changed a page during traversal. Coverage may be partial.",
          );
        novel = !existing;
        await this.database.pageReceipts.put(receipt);
        const trail = await this.database.pageReceipts
          .where("[runId+epoch]")
          .equals([id, run.pageEpoch!])
          .filter(
            (r) => r.kind === receipt.kind && r.targetId === receipt.targetId,
          )
          .toArray();
        if (coverage(trail) === "cycle")
          frame.restriction =
            "Instagram repeated a pagination cursor. Saved results are partial.";
        run.checkpoint = {
          ...run.checkpoint,
          pageCount: run.checkpoint.pageCount + (existing ? 0 : 1),
          cursor: frame.nextCursors[0] || null,
        };
      }
      run.warnings = [...new Set([...(run.warnings || []), ...frame.warnings])];
      run.updatedAt = Date.now();
      await applyObservation(observation, this.database);
      if (frame.restriction) {
        await this.stop(id, frame.restriction, "partial");
        return true;
      }
      await this.advance(run);
      return novel;
    });
  }
  private async comments(run: Run, frame: Capture, observation: Observation) {
    const id = run.id,
      postId = frame.targetId!;
    observation.profiles = observation.profiles || [];
    observation.comments = [];
    observation.results = [];
    observation.seenComments = [];
    observation.threads = [];
    const stagedThreads = new Map<string, Thread>();
    const all: CommentItem[] = [];
    const flatten = (rows: CommentItem[]) => {
      for (const c of rows) {
        all.push(c);
        flatten(c.replies);
      }
    };
    flatten(frame.comments);
    for (const c of all) {
      observation.seenComments.push({ runId: id, postId, commentId: c.id });
      if (c.profile) {
        observation.profiles.push(c.profile);
        observation.comments.push({
          postId,
          profileId: c.profile.id,
          ownerId: run.sourceId,
          lastSeenAt: Date.now(),
        });
        observation.results.push({
          runId: id,
          kind: "commenters",
          profileId: c.profile.id,
        });
      }
      if (c.replyCount > 0) {
        const old =
          stagedThreads.get(c.id) ||
          (await this.database.threads.get([id, postId, c.id]));
        const thread: Thread = old || {
          runId: id,
          postId,
          commentId: c.id,
          cursor: null,
          seenCursors: [],
          done: 0,
        };
        thread.expectedCount = Math.max(
          thread.expectedCount || 0,
          c.replyCount,
        );
        thread.fetchedCount = Math.max(
          thread.fetchedCount || 0,
          new Set(c.replies.map((r) => r.id)).size,
        );
        thread.seenCursors = [
          ...new Set([
            ...(thread.seenCursors || []),
            ...c.replies.map((r) => `reply:${r.id}`),
          ]),
        ];
        thread.fetchedCount = Math.max(
          thread.fetchedCount,
          thread.seenCursors.filter((s) => s.startsWith("reply:")).length,
        );
        thread.done = thread.fetchedCount >= thread.expectedCount ? 1 : 0;
        stagedThreads.set(c.id, thread);
      }
    }
    if (frame.kind === "replies") {
      const old =
        stagedThreads.get(frame.parentId!) ||
        (await this.database.threads.get([id, postId, frame.parentId!]));
      const previous = old || {
        runId: id,
        postId,
        commentId: frame.parentId!,
        cursor: null,
        seenCursors: [],
        done: 0,
      };
      const seen = new Set([
        ...(previous.seenCursors || []),
        ...frame.comments.map((c) => `reply:${c.id}`),
      ]);
      stagedThreads.set(frame.parentId!, {
        ...previous,
        seenCursors: [...seen],
        fetchedCount: Math.max(
          previous.fetchedCount || 0,
          [...seen].filter((s) => s.startsWith("reply:")).length,
        ),
        cursor: frame.nextCursors[0] || null,
      });
    }
    observation.threads = [...stagedThreads.values()];
  }
  private async scopeDone(
    run: Run,
    kind: PageReceipt["kind"],
    targetId = run.sourceId,
  ) {
    const receipts = await this.database.pageReceipts
      .where("[runId+epoch]")
      .equals([run.id, run.pageEpoch!])
      .toArray();
    return covered(
      receipts.filter((r) => r.kind === kind && r.targetId === targetId),
    );
  }
  async advance(run: Run) {
    if (run.status !== "running") return;
    let stage = run.checkpoint.stage;
    if (stage === "followers" || stage === "following") {
      if (!(await this.scopeDone(run, stage))) return;
      stage =
        stage === "followers" && run.mode === "both" ? "following" : "done";
    } else if (stage === "media") {
      const channel = run.checkpoint.channel || "feed";
      if (!(await this.scopeDone(run, channel))) return;
      else if (channel === "feed") {
        run.checkpoint = { ...checkpoint("media"), channel: "reels" };
        await this.database.runs.put(run);
        return;
      } else stage = run.mode === "likers" ? "likes" : "comments";
    }
    if (stage === "likes") {
      for (const queued of await this.database.runPosts
        .where("[runId+done]")
        .equals([run.id, 0])
        .toArray()) {
        const post = await this.database.posts.get(queued.postId);
        if (
          post?.likeCount !== 0 &&
          !(await this.scopeDone(run, "likes", queued.postId))
        )
          continue;
        const count = await this.database.results
          .where("runId")
          .equals(run.id)
          .filter((r) => r.kind === `likers:${queued.postId}`)
          .count();
        if (post?.likeCount != null && count < post.likeCount)
          run.warnings = [
            ...new Set([
              ...(run.warnings || []),
              "Instagram returned fewer likers than reported.",
            ]),
          ];
        await this.database.runPosts.update([run.id, queued.postId], {
          done: 1,
          commentCount: count,
        });
      }
      if (
        await this.database.runPosts
          .where("[runId+done]")
          .equals([run.id, 0])
          .count()
      ) {
        run.checkpoint = checkpoint("likes");
        await this.database.runs.put(run);
        return;
      }
      stage = "done";
    }
    if (stage === "comments") {
      for (const queued of await this.database.runPosts
        .where("[runId+done]")
        .equals([run.id, 0])
        .toArray()) {
        const post = await this.database.posts.get(queued.postId);
        if (
          post?.commentCount !== 0 &&
          !(await this.scopeDone(run, "comments", queued.postId))
        )
          continue;
        let unfinished = false;
        for (const thread of await this.database.threads
          .where("[runId+postId+done]")
          .equals([run.id, queued.postId, 0])
          .toArray()) {
          if (
            await this.scopeDone(
              run,
              "replies",
              `${queued.postId}:${thread.commentId}`,
            )
          ) {
            await this.database.threads.update(
              [run.id, queued.postId, thread.commentId],
              { done: 1 },
            );
            if (thread.expectedCount === undefined)
              run.warnings = [
                ...new Set([
                  ...(run.warnings || []),
                  "A reply thread had no available parent comment.",
                ]),
              ];
            if ((thread.fetchedCount || 0) < (thread.expectedCount || 0))
              run.warnings = [
                ...new Set([
                  ...(run.warnings || []),
                  "Instagram returned fewer replies than reported.",
                ]),
              ];
          } else unfinished = true;
        }
        if (unfinished) continue;
        const count = await this.database.seenComments
          .where("runId")
          .equals(run.id)
          .filter((c) => c.postId === queued.postId)
          .count();
        if (post?.commentCount != null && count < post.commentCount)
          run.warnings = [
            ...new Set([
              ...(run.warnings || []),
              "Instagram returned fewer comments than reported.",
            ]),
          ];
        await this.database.runPosts.update([run.id, queued.postId], {
          done: 1,
          commentCount: count,
        });
      }
      if (
        await this.database.runPosts
          .where("[runId+done]")
          .equals([run.id, 0])
          .count()
      ) {
        run.checkpoint = { ...checkpoint("comments") };
        await this.database.runs.put(run);
        return;
      }
      stage = "done";
    }
    run.checkpoint = checkpoint(stage);
    if (stage === "done") {
      run.status = run.warnings?.length ? "partial" : "completed";
      run.reason = run.warnings?.join(" ");
      run.completedAt = Date.now();
    }
    await this.database.runs.put(run);
  }
  async goal(id: string): Promise<PageGoal> {
    const binding = await this.binding(id);
    const run = await this.database.runs.get(id);
    const pending = await this.database.pendingPageJobs.get(id);
    const goal: PageGoal = {
      ...binding,
      stage:
        run?.checkpoint.stage ||
        (binding.mode === "single"
          ? "profile"
          : ["commenters", "likers"].includes(binding.mode)
            ? binding.input.type === "post"
              ? binding.mode === "likers"
                ? "likes"
                : "comments"
              : "media"
            : binding.mode === "following"
              ? "following"
              : "followers"),
      channel:
        run?.checkpoint.stage === "media"
          ? run.checkpoint.channel || "feed"
          : undefined,
      automatic: run?.pageAutomatic ?? pending?.automatic ?? true,
      hint: run?.reason || pending?.reason,
      count: new Set(
        (await this.database.results.where("runId").equals(id).toArray()).map(
          (r) => r.profileId,
        ),
      ).size,
    };
    if (goal.stage === "comments" || goal.stage === "likes") {
      const queued =
        run &&
        (await this.database.runPosts
          .where("[runId+done]")
          .equals([id, 0])
          .first());
      const post = queued && (await this.database.posts.get(queued.postId));
      goal.postUrl =
        post?.url ||
        (binding.input.type === "post" ? binding.input.url : undefined);
      goal.threadId = queued
        ? (
            await this.database.threads
              .where("[runId+postId+done]")
              .equals([id, queued.postId, 0])
              .first()
          )?.commentId
        : undefined;
    }
    return goal;
  }
  async skipReels(id: string, reason: string) {
    const run = await this.database.runs.get(id);
    if (!run) return;
    await this.database.transaction("rw", this.database.tables, async () => {
      run.warnings = [...new Set([...(run.warnings || []), reason])];
      run.checkpoint = checkpoint(run.mode === "likers" ? "likes" : "comments");
      await this.advance(run);
    });
  }
}
