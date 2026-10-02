import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useLiveQuery } from "dexie-react-hooks";
import {
  ArrowUpRight,
  Users,
  UserPlus,
  MessageCircle,
  Heart,
  Play,
  Pause,
} from "lucide-react";
import { db } from "./db";
import { sameInput } from "./popup-context";
import type { Input, Mode } from "./types";
import "./popup.css";
interface Context {
  tabId?: number;
  previousJobId?: string;
  activeJobId?: string;
  input?: Input;
}
const choices = [
  { mode: "followers", label: "Followers", Icon: Users },
  { mode: "following", label: "Following", Icon: UserPlus },
  { mode: "commenters", label: "Commenters", Icon: MessageCircle },
  { mode: "likers", label: "Likers", Icon: Heart },
] as const;
async function request(message: any) {
  const response = await chrome.runtime.sendMessage(message);
  if (response?.error) throw new Error(response.error);
  return response;
}
function Popup() {
  const missions = useLiveQuery(() =>
    db.missions.orderBy("createdAt").toArray(),
  );
  const [context, setContext] = useState<Context>();
  const pageActive = useLiveQuery(async () => {
    const id = context?.activeJobId;
    if (!id) return;
    const state = (await db.runs.get(id)) || (await db.pendingPageJobs.get(id));
    return state?.status === "running" ? state : undefined;
  }, [context?.activeJobId]);
  const directActive = useLiveQuery(() =>
    db.runs
      .where("status")
      .equals("running")
      .filter((run) => run.method !== "page")
      .first(),
  );
  const active = pageActive || directActive;
  const [missionId, setMissionId] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    void request({ type: "popup-context" })
      .then(setContext)
      .catch((e) => setError(e.message));
    void chrome.storage.session
      .get("popupMission")
      .then((s) =>
        setMissionId(typeof s.popupMission === "string" ? s.popupMission : ""),
      );
  }, []);
  useEffect(() => {
    if (missions?.length && !missions.some((m) => m.id === missionId))
      setMissionId(missions[0].id);
  }, [missions, missionId]);
  const previous = useLiveQuery(async () => {
    if (!context?.input || !missionId) return;
    if (context.previousJobId) {
      const ownedRun = await db.runs.get(context.previousJobId);
      const ownedPending = await db.pendingPageJobs.get(context.previousJobId);
      if (
        ownedRun &&
        ownedRun.method === "page" &&
        ownedRun.status !== "running" &&
        ownedRun.status !== "completed" &&
        ownedRun.checkpoint.stage !== "done" &&
        (await db.runLinks.get([ownedRun.id, missionId]))
      )
        return ownedRun;
      if (
        ownedPending &&
        ownedPending.missionId === missionId &&
        ownedPending.status !== "running"
      )
        return ownedPending;
    }
    const pending = await db.pendingPageJobs
      .where("missionId")
      .equals(missionId)
      .filter(
        (j) => j.status !== "running" && sameInput(j.input, context.input!),
      )
      .sortBy("updatedAt");
    const runs = await db.runs
      .orderBy("updatedAt")
      .reverse()
      .filter(
        (r) =>
          r.method === "page" &&
          r.status !== "running" &&
          r.status !== "completed" &&
          r.checkpoint.stage !== "done" &&
          !!r.pageInput &&
          sameInput(r.pageInput, context.input!),
      )
      .toArray();
    for (const run of runs)
      if (await db.runLinks.get([run.id, missionId])) return run;
    return pending.at(-1);
  }, [context?.input, context?.previousJobId, missionId]);
  const collect = async (mode: Mode, resumeId?: string) => {
    setWorking(true);
    setError("");
    try {
      await chrome.storage.session.set({ popupMission: missionId });
      await request(
        resumeId
          ? { type: "collector-resume", id: resumeId, tabId: context?.tabId }
          : {
              type: "popup-start",
              tabId: context?.tabId,
              input: context?.input,
              missionId,
              mode,
            },
      );
      window.close();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Collection could not start.");
    } finally {
      setWorking(false);
    }
  };
  return (
    <main>
      <header>
        <strong>InstaFinder</strong>
        <span>Collect from Instagram</span>
      </header>
      {!missions || !context ? (
        <p className="muted">Loading…</p>
      ) : !missions.length ? (
        <p>Create a mission in InstaFinder to start collecting.</p>
      ) : (
        <>
          {missions.length > 1 && (
            <label className="field">
              Mission
              <select
                aria-label="Mission"
                value={missionId}
                onChange={(e) => setMissionId(e.target.value)}
              >
                {missions.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!context.input ? (
            <p>Open an Instagram profile, post or reel to collect.</p>
          ) : (
            <>
              <p className="target">
                {context.input.type === "profile"
                  ? `@${context.input.username}`
                  : "This post / reel"}
              </p>
              {(active || working) && (
                <div className="notice">
                  <span>
                    {working
                      ? "Starting on this page…"
                      : pageActive
                        ? "Collection is running."
                        : "Direct collection is running."}
                  </span>
                  {pageActive && !working && (
                    <button
                      className="text-button"
                      onClick={() =>
                        void request({
                          type: "collector-pause",
                          id: pageActive.id,
                        }).catch((e) => setError(e.message))
                      }
                    >
                      <Pause size={13} />
                      Pause
                    </button>
                  )}
                </div>
              )}
              {previous && !active && (
                <button
                  className="resume"
                  disabled={
                    working ||
                    (!!previous.retryAt && previous.retryAt > Date.now())
                  }
                  onClick={() => void collect(previous.mode, previous.id)}
                >
                  <Play size={15} />
                  Resume{" "}
                  {choices.find((c) => c.mode === previous.mode)?.label ||
                    "collection"}
                </button>
              )}
              <div className="choices">
                {choices
                  .filter(
                    (c) =>
                      context.input?.type === "profile" ||
                      ["commenters", "likers"].includes(c.mode),
                  )
                  .map(({ mode, label, Icon }) => (
                    <button
                      key={mode}
                      disabled={working || !!active || !missionId}
                      onClick={() => void collect(mode)}
                    >
                      <Icon size={19} />
                      <span>{label}</span>
                    </button>
                  ))}
              </div>
            </>
          )}
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <footer>
        <button
          className="open-app"
          onClick={() =>
            void request({ type: "open-app", missionId })
              .then(() => window.close())
              .catch((e) => setError(e.message))
          }
        >
          Open InstaFinder
          <ArrowUpRight size={16} />
        </button>
      </footer>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Popup />);
