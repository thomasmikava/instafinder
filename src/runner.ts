import { PageRunner } from "./page-runner";
import { db, preferences, type Database } from "./db";
import { applyObservation, reuseRun, uid } from "./data";
import {
  CollectionError,
  Instagram,
  parseInput,
  shortcodeId,
} from "./instagram";
import type {
  Checkpoint,
  CommentItem,
  Input,
  Mode,
  Observation,
  Page,
  Profile,
  Resolved,
  Run,
  RunPost,
  Thread,
} from "./types";
export function nextCheckpoint(
  checkpoint: Checkpoint,
  page: Page<unknown>,
): Checkpoint {
  if (
    page.more &&
    (!page.next ||
      page.next === checkpoint.cursor ||
      checkpoint.seenCursors.includes(page.next))
  )
    throw new CollectionError(
      "Instagram repeated or omitted its next-page cursor. Collection stopped with partial results.",
      "restricted",
    );
  const pending = [
    ...new Set([
      ...(checkpoint.pendingCursors || []),
      ...(page.pendingCursors || []),
    ]),
  ].filter(
    (cursor) =>
      cursor !== checkpoint.cursor &&
      cursor !== page.next &&
      !checkpoint.seenCursors.includes(cursor),
  );
  const cursor = page.more ? page.next : pending.shift() || null;
  return {
    ...checkpoint,
    cursor,
    pendingCursors: pending,
    branchStart: !page.more && !!cursor,
    seenCursors: cursor
      ? [...checkpoint.seenCursors, cursor]
      : checkpoint.seenCursors,
    pageCount: checkpoint.pageCount + 1,
  };
}
const fresh = (stage: Checkpoint["stage"]): Checkpoint => ({
  stage,
  cursor: null,
  seenCursors: [],
  pageCount: 0,
  stageCount: 0,
});
export class Runner {
  page: PageRunner;
  private controller?: AbortController;
  private active?: string;
  constructor(
    public database: Database = db,
    public instagram = new Instagram(),
  ) {
    this.page = new PageRunner(database);
  }
  get busy() {
    return !!this.active || this.page.busy;
  }
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (typeof navigator !== "undefined" && navigator.locks) {
      return navigator.locks.request(
        "instafinder-collection",
        { ifAvailable: true },
        async (lock) => {
          if (!lock)
            throw new Error(
              "Another InstaFinder tab is collecting. Use that tab or pause its collection first.",
            );
          return operation();
        },
      );
    }
    return operation();
  }
  async recover() {
    const recover = async () => {
      const browser = typeof chrome !== "undefined" && !!chrome.runtime?.id;
      if (!browser)
        await this.database.pendingPageJobs
          .where("status")
          .equals("running")
          .modify({
            status: "paused",
            reason: "The app closed or reloaded. Resume when ready.",
            updatedAt: Date.now(),
          });
      await this.database.runs
        .where("status")
        .equals("running")
        .filter((r) => !browser || r.method !== "page")
        .modify({
          status: "paused",
          reason: "The app closed or reloaded. Resume when ready.",
          updatedAt: Date.now(),
        });
    };
    if (typeof navigator !== "undefined" && navigator.locks)
      await navigator.locks.request(
        "instafinder-collection",
        { ifAvailable: true },
        async (lock) => {
          if (lock) await recover();
        },
      );
    else await recover();
  }
  async resolve(value: string, mode: Mode, force = false): Promise<Resolved> {
    if (mode === "likers")
      throw new Error(
        "Collect likers from Instagram using the extension menu.",
      );
    if (this.busy)
      throw new Error(
        "Pause the current collection before looking up another account.",
      );
    return this.exclusive(async () => {
      const input = parseInput(value);
      if (input.type === "post") {
        if (!force) {
          const savedPost = await this.database.posts.get(
            shortcodeId(input.shortcode),
          );
          const source =
            savedPost && (await this.database.profiles.get(savedPost.ownerId));
          if (savedPost && source)
            return {
              source,
              post: savedPost,
              input,
              mode: "commenters",
              key: `post:${savedPost.id}:commenters`,
              cached: true,
            };
        }
        const result = await this.instagram.post(input.shortcode);
        result.post.url = input.url;
        await applyObservation(
          { profiles: [result.source], posts: [result.post] },
          this.database,
        );
        return {
          ...result,
          input,
          mode: "commenters",
          key: `post:${result.post.id}:commenters`,
        };
      }
      if (!force) {
        const saved = await this.database.profiles
          .where("userName")
          .equalsIgnoreCase(input.username)
          .first();
        if (saved)
          return {
            source: saved,
            input,
            mode,
            key: `profile:${saved.id}:${mode}`,
            cached: true,
          };
      }
      const source = await this.instagram.profile(input.username);
      await applyObservation({ profiles: [source] }, this.database);
      return { source, input, mode, key: `profile:${source.id}:${mode}` };
    });
  }
  async saved(value: string, mode: Mode): Promise<Resolved | undefined> {
    const input = parseInput(value);
    if (input.type === "post") {
      const post = await this.database.posts.get(shortcodeId(input.shortcode));
      const source = post && (await this.database.profiles.get(post.ownerId));
      if (post && source)
        return {
          source,
          post,
          input,
          mode: "commenters",
          key: `post:${post.id}:commenters`,
          cached: true,
        };
    } else {
      const source = await this.database.profiles
        .where("userName")
        .equalsIgnoreCase(input.username)
        .first();
      if (source)
        return {
          source,
          input,
          mode,
          key: `profile:${source.id}:${mode}`,
          cached: true,
        };
    }
  }
  async previous(resolved: Resolved) {
    return (
      await this.database.runs.where("key").equals(resolved.key).toArray()
    ).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async create(resolved: Resolved, missionId: string) {
    if (resolved.cached && resolved.mode !== "single")
      resolved = await this.resolve(
        resolved.input.type === "post"
          ? resolved.input.url
          : resolved.source.userName,
        resolved.mode,
        true,
      );
    const now = Date.now();
    const stage =
      resolved.mode === "followers" || resolved.mode === "both"
        ? "followers"
        : resolved.mode === "following"
          ? "following"
          : resolved.post
            ? "comments"
            : "media";
    const run: Run = {
      id: uid(),
      method: "direct",
      key: resolved.key,
      sourceId: resolved.source.id,
      targetLabel:
        resolved.source.userName + (resolved.post ? " · post/reel" : ""),
      mode: resolved.mode,
      scope: resolved.post ? "post" : "profile",
      targetPostId: resolved.post?.id,
      status: "paused",
      checkpoint: fresh(resolved.mode === "single" ? "done" : stage),
      createdAt: now,
      updatedAt: now,
    };
    if (resolved.mode === "single") {
      run.status = "completed";
      run.completedAt = now;
    }
    await applyObservation(
      {
        run,
        runPosts: resolved.post
          ? [
              {
                runId: run.id,
                postId: resolved.post.id,
                done: 0,
                commentCount: 0,
              },
            ]
          : [],
        results:
          resolved.mode === "single"
            ? [{ runId: run.id, kind: "single", profileId: resolved.source.id }]
            : [],
      },
      this.database,
    );
    await reuseRun(run.id, missionId, this.database);
    return run;
  }
  async attach(runId: string, missionId: string) {
    await reuseRun(runId, missionId, this.database);
  }
  pause() {
    this.controller?.abort();
    this.page.pause();
  }
  async run(runId: string) {
    if (this.busy) throw new Error("A collection is already running.");
    const saved = await this.database.runs.get(runId);
    if (
      saved?.method === "page" ||
      (await this.database.pendingPageJobs.get(runId))
    ) {
      if (typeof chrome !== "undefined" && chrome.runtime?.id) {
        const response = await chrome.runtime.sendMessage({
          type: "collector-resume",
          id: runId,
        });
        if (response?.error) throw new Error(response.error);
        return;
      }
      return this.exclusive(() => this.page.run(runId));
    }
    return this.exclusive(async () => {
      let run = await this.database.runs.get(runId);
      if (!run) throw new Error("Collection not found.");
      if (run.status === "completed") return;
      if (run.retryAt && run.retryAt > Date.now())
        throw new Error(
          `Resume after ${new Date(run.retryAt).toLocaleString()}.`,
        );
      this.active = runId;
      this.controller = new AbortController();
      const signal = this.controller.signal;
      await this.database.runs.update(runId, {
        status: "running",
        reason: undefined,
        retryAt: undefined,
        updatedAt: Date.now(),
      });
      try {
        while (!signal.aborted) {
          run = (await this.database.runs.get(runId))!;
          if (run.checkpoint.stage === "done") {
            await this.database.runs.update(runId, {
              status: run.warnings?.length ? "partial" : "completed",
              reason: run.warnings?.join(" "),
              completedAt: Date.now(),
              updatedAt: Date.now(),
            });
            break;
          }
          if (
            run.checkpoint.stage === "followers" ||
            run.checkpoint.stage === "following"
          )
            await this.followStep(run, signal);
          else if (run.checkpoint.stage === "media") {
            try {
              await this.mediaStep(run, signal);
            } catch (error) {
              if (
                !(error instanceof CollectionError) ||
                error.kind !== "schema"
              )
                throw error;
              const saved = (await this.database.runs.get(run.id))!;
              const channel = saved.checkpoint.channel || "feed";
              await this.commit({
                ...saved,
                warnings: [
                  ...new Set([
                    ...(saved.warnings || []),
                    `${channel} traversal could not finish: ${error.message}`,
                  ]),
                ],
                checkpoint:
                  channel === "feed"
                    ? { ...fresh("media"), channel: "reels" }
                    : fresh("comments"),
              });
            }
          } else await this.commentStep(run, signal);
        }
        if (signal.aborted)
          await this.database.runs.update(runId, {
            status: "paused",
            reason: "Paused. Saved progress is ready to resume.",
            updatedAt: Date.now(),
          });
      } catch (error) {
        const current = await this.database.runs.get(runId);
        const failure = error instanceof CollectionError ? error : undefined;
        const aborted =
          signal.aborted ||
          (error instanceof DOMException && error.name === "AbortError");
        await this.database.runs.update(runId, {
          status:
            aborted || failure?.kind === "login"
              ? "paused"
              : failure?.kind === "rate"
                ? "cooldown"
                : failure?.kind === "restricted" ||
                    (current?.checkpoint.pageCount || 0) > 0 ||
                    (await this.database.results
                      .where("runId")
                      .equals(runId)
                      .count()) > 0 ||
                    (await this.database.runPosts
                      .where("runId")
                      .equals(runId)
                      .count()) > 0
                  ? "partial"
                  : "failed",
          reason: aborted
            ? "Paused. Saved progress is ready to resume."
            : error instanceof Error
              ? error.message
              : "Collection failed.",
          retryAt: failure?.retryAt,
          updatedAt: Date.now(),
        });
      } finally {
        this.active = undefined;
        this.controller = undefined;
      }
    });
  }
  private async commit(run: Run, observation: Observation = {}) {
    await applyObservation(
      { ...observation, run: { ...run, updatedAt: Date.now() } },
      this.database,
    );
  }
  private async followStep(run: Run, signal: AbortSignal) {
    const kind = run.checkpoint.stage as "followers" | "following";
    const page = await this.instagram.follows(
      run.sourceId,
      kind,
      run.checkpoint.cursor,
      signal,
    );
    const results = page.items.map((p) => ({
      runId: run.id,
      kind,
      profileId: p.id,
    }));
    const old = await this.database.results.bulkGet(
      results.map((r) => [r.runId, r.kind, r.profileId]),
    );
    const newCount = new Set(
      results.filter((_, i) => !old[i]).map((r) => r.profileId),
    ).size;
    run.warnings = [
      ...new Set([...(run.warnings || []), ...(page.warnings || [])]),
    ];
    let checkpoint = {
      ...run.checkpoint,
      stageCount: run.checkpoint.stageCount + newCount,
    };
    let failure: Error | undefined;
    try {
      if (run.checkpoint.pageCount > 0 && newCount === 0 && page.more)
        throw new CollectionError(
          "Instagram repeated a follow page without new profiles. Saved results are partial.",
          "restricted",
        );
      checkpoint = nextCheckpoint(checkpoint, page);
    } catch (e) {
      failure = e as Error;
    }
    const source = await this.database.profiles.get(run.sourceId);
    const expected =
      page.expected ??
      (kind === "followers" ? source?.followerCount : source?.followingCount);
    if (!page.more && expected && checkpoint.stageCount < expected)
      run.warnings = [
        ...(run.warnings || []),
        `${kind}: collected ${checkpoint.stageCount} of ${expected} reported profiles. Instagram may hide or omit accounts.`,
      ];
    if (!page.more && !failure && !page.restricted)
      checkpoint = fresh(
        run.mode === "both" && kind === "followers" ? "following" : "done",
      );
    await this.commit(
      { ...run, checkpoint },
      {
        profiles: page.items,
        follows: page.items.map((p) => ({
          followerId: kind === "followers" ? p.id : run.sourceId,
          followingId: kind === "followers" ? run.sourceId : p.id,
          lastSeenAt: Date.now(),
        })),
        results,
      },
    );
    if (failure) throw failure;
    if (page.restricted)
      throw new CollectionError(page.restricted, "restricted");
  }
  private async mediaStep(run: Run, signal: AbortSignal) {
    const channel = run.checkpoint.channel || "feed";
    const page = await this.instagram.media(
      run.sourceId,
      run.checkpoint.cursor,
      channel,
      signal,
    );
    let checkpoint = run.checkpoint;
    let failure: Error | undefined;
    try {
      checkpoint = nextCheckpoint(checkpoint, page);
    } catch (e) {
      failure = e as Error;
    }
    const posts: RunPost[] = [];
    for (const p of page.items)
      if (!(await this.database.runPosts.get([run.id, p.id])))
        posts.push({ runId: run.id, postId: p.id, done: 0, commentCount: 0 });
    if (run.checkpoint.pageCount > 0 && !posts.length && page.more)
      failure = new CollectionError(
        "Instagram repeated a media page without new posts. Saved results are partial.",
        "restricted",
      );
    if (!page.more && !failure && !page.restricted)
      checkpoint =
        channel === "feed"
          ? { ...fresh("media"), channel: "reels" }
          : fresh("comments");
    await this.commit(
      { ...run, checkpoint },
      { posts: page.items, runPosts: posts },
    );
    if (failure) throw failure;
    if (page.restricted)
      throw new CollectionError(page.restricted, "restricted");
  }
  private async commentStep(run: Run, signal: AbortSignal) {
    let cp = run.checkpoint;
    if (!cp.postId) {
      const pending = await this.database.runPosts
        .where("[runId+done]")
        .equals([run.id, 0])
        .first();
      if (!pending) {
        await this.commit({ ...run, checkpoint: fresh("done") });
        return;
      }
      cp = { ...fresh("comments"), postId: pending.postId };
      await this.commit({ ...run, checkpoint: cp });
      run = { ...run, checkpoint: cp };
    }
    const post = await this.database.posts.get(cp.postId!);
    if (!post)
      throw new Error("Saved post not found. Restart this collection.");
    const thread = await this.database.threads
      .where("[runId+postId+done]")
      .equals([run.id, post.id, 0])
      .first();
    if (!thread && cp.commentsDone) {
      const progress = await this.database.runPosts.get([run.id, post.id]);
      if (
        post.commentCount &&
        (progress?.commentCount || 0) < post.commentCount
      )
        run.warnings = [
          ...(run.warnings || []),
          `Post ${post.id}: ${progress?.commentCount || 0} of ${post.commentCount} reported comments were accessible.`,
        ];
      await this.commit(
        { ...run, checkpoint: fresh("comments") },
        {
          runPosts: [
            {
              runId: run.id,
              postId: post.id,
              done: 1,
              commentCount: progress?.commentCount || 0,
            },
          ],
        },
      );
      return;
    }
    const page = thread
      ? await this.instagram.replies(
          post.id,
          thread.commentId,
          thread.cursor,
          signal,
        )
      : await this.instagram.comments(post.id, cp.cursor, signal);
    const flatten = (items: CommentItem[]): CommentItem[] =>
      items.flatMap((item) => [item, ...flatten(item.replies)]);
    const all = [
      ...new Map(flatten(page.items).map((c) => [c.id, c])).values(),
    ];
    const authors = all.filter(
      (c): c is CommentItem & { profile: Profile } => !!c.profile,
    );
    const seen = all.map((c) => ({
      runId: run.id,
      postId: post.id,
      commentId: c.id,
    }));
    const oldSeen = await this.database.seenComments.bulkGet(
      seen.map((s) => [s.runId, s.postId, s.commentId]),
    );
    const progress = await this.database.runPosts.get([run.id, post.id]);
    const newCount = oldSeen.filter((s) => !s).length;
    const count = (progress?.commentCount || 0) + newCount;
    run.warnings = [
      ...new Set([...(run.warnings || []), ...(page.warnings || [])]),
    ];
    let failure: Error | undefined;
    const threads: Thread[] = [];
    if (thread) {
      try {
        const n = nextCheckpoint(
          {
            ...cp,
            cursor: thread.cursor,
            seenCursors: thread.seenCursors,
            pendingCursors: thread.pendingCursors || [],
            pageCount: thread.pageCount || 0,
            branchStart: thread.branchStart,
          },
          page,
        );
        if (
          (thread.pageCount || 0) > 0 &&
          !thread.branchStart &&
          newCount === 0 &&
          page.more
        )
          throw new CollectionError(
            "Instagram repeated a reply page without new comments. Saved results are partial.",
            "restricted",
          );
        const fetchedCount = (thread.fetchedCount || 0) + newCount;
        if (
          !n.cursor &&
          thread.expectedCount &&
          fetchedCount < thread.expectedCount
        )
          run.warnings = [
            ...new Set([
              ...(run.warnings || []),
              `Post ${post.id}, comment ${thread.commentId}: ${fetchedCount} of ${thread.expectedCount} reported replies were accessible.`,
            ]),
          ];
        threads.push({
          ...thread,
          cursor: n.cursor,
          seenCursors: n.seenCursors,
          pendingCursors: n.pendingCursors,
          branchStart: n.branchStart,
          pageCount: n.pageCount,
          fetchedCount,
          done: n.cursor ? 0 : 1,
        });
      } catch (error) {
        failure = error as Error;
      }
    } else {
      try {
        if (cp.pageCount > 0 && !cp.branchStart && newCount === 0 && page.more)
          throw new CollectionError(
            "Instagram repeated a comment page without new comments. Saved results are partial.",
            "restricted",
          );
        const next = nextCheckpoint(cp, page);
        cp = { ...next, commentsDone: !next.cursor };
      } catch (error) {
        failure = error as Error;
      }
      for (const c of page.items)
        if (
          c.replyCount > c.replies.length &&
          !(await this.database.threads.get([run.id, post.id, c.id]))
        )
          threads.push({
            runId: run.id,
            postId: post.id,
            commentId: c.id,
            cursor: null,
            seenCursors: [],
            pendingCursors: [],
            expectedCount: c.replyCount,
            fetchedCount: new Set(flatten(c.replies).map((reply) => reply.id))
              .size,
            pageCount: 0,
            done: 0,
          });
    }
    await this.commit(
      { ...run, checkpoint: cp },
      {
        profiles: authors.map((c) => c.profile),
        comments: authors.map((c) => ({
          postId: post.id,
          profileId: c.profile.id,
          ownerId: post.ownerId,
          lastSeenAt: Date.now(),
        })),
        results: authors.map((c) => ({
          runId: run.id,
          kind: "commenters",
          profileId: c.profile.id,
        })),
        seenComments: seen,
        runPosts: [
          { runId: run.id, postId: post.id, done: 0, commentCount: count },
        ],
        threads,
      },
    );
    if (failure) throw failure;
    if (page.restricted)
      throw new CollectionError(page.restricted, "restricted");
  }
  async refreshProfile(username: string, _missionId?: string) {
    const result = await this.resolve(username, "single", true);
    return result.source;
  }
}
export const runner = new Runner();
