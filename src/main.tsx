import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useLiveQuery } from "dexie-react-hooks";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ArrowUpRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Compass,
  Database as DatabaseIcon,
  Flag,
  Heart,
  Layers,
  List,
  LoaderCircle,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings as SettingsIcon,
  ShieldCheck,
  Trash2,
  Undo2,
  Users,
  X,
} from "lucide-react";
import { db, preferences } from "./db";
import {
  candidatePage,
  createMission,
  decide,
  deleteMission,
  includeSources,
  setSource,
} from "./data";
import {
  download,
  exportBackup,
  restoreBackup,
  validateBackup,
  type Backup,
} from "./backup";
import { parseInput } from "./instagram";
import { runner } from "./runner";
import type { Decision, Mission, Mode, Profile, Resolved, Run } from "./types";
import "./styles.css";
const labels: Record<Decision, string> = {
  unreviewed: "Unreviewed",
  no: "Not the person",
  unlikely: "Probably not",
  possible: "Possible match",
};
const modes: { value: Mode; label: string }[] = [
  {
    value: "both",
    label: "Followers + following",
  },
  {
    value: "followers",
    label: "Followers",
  },
  {
    value: "following",
    label: "Following",
  },
  {
    value: "commenters",
    label: "Commenters",
  },
];
const date = (time: number) =>
  new Date(time).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
const number = (n: number) => n.toLocaleString();
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
type Toast = (
  message: string,
  action?: { label: string; fn: () => void },
) => void;
function Avatar({
  profile,
  large = false,
}: {
  profile?: Profile;
  large?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [profile?.avatarUrl, profile?.updatedAt]);
  return (
    <div className={large ? "avatar avatar-large" : "avatar"}>
      {profile?.avatarUrl && !failed ? (
        <img
          src={profile.avatarUrl}
          alt={profile.fullName || profile.userName}
          onError={() => setFailed(true)}
          referrerPolicy="no-referrer"
          loading={large ? "eager" : "lazy"}
        />
      ) : (
        <span>
          {(profile?.fullName || profile?.userName || "?")
            .slice(0, 2)
            .toUpperCase()}
        </span>
      )}
    </div>
  );
}
function Dialog({
  title,
  children,
  close,
  wide = false,
}: {
  title: string;
  children: React.ReactNode;
  close: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`dialog ${wide ? "wide" : ""}`}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (
          e.target === e.currentTarget &&
          (e.clientX < e.currentTarget.getBoundingClientRect().left ||
            e.clientX > e.currentTarget.getBoundingClientRect().right ||
            e.clientY < e.currentTarget.getBoundingClientRect().top ||
            e.clientY > e.currentTarget.getBoundingClientRect().bottom)
        )
          close();
      }}
    >
      <div className="dialog-heading">
        <h2>{title}</h2>
        <button
          className="icon-button"
          aria-label="Close dialog"
          onClick={close}
        >
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
const introCards = [
  {
    title: "Find someone on Instagram",
    text: "Collect accounts, then review them one by one to find the person you’re looking for.",
    Icon: Compass,
  },
  {
    title: "Missions",
    text: "A mission is one search. Give it a name to keep its candidates and your choices together.",
    Icon: Layers,
  },
  {
    title: "Sources",
    text: "A source is an Instagram account or post you start from. Collect its followers, following or commenters as candidates.",
    Icon: Flag,
  },
  {
    title: "Review candidates",
    text: "A candidate is someone you might be looking for. Choose Not the person, Probably not or Possible match.",
    Icon: Users,
  },
];
function IntroDialog({ close }: { close: () => void }) {
  const [step, setStep] = useState(0);
  const { title, text, Icon } = introCards[step];
  return (
    <Dialog title={title} close={close}>
      <div className="intro-card" aria-live="polite">
        <span className="intro-icon">
          <Icon size={32} strokeWidth={1.5} />
        </span>
        <p>{text}</p>
      </div>
      <div
        className="intro-progress"
        aria-label={`Step ${step + 1} of ${introCards.length}`}
      >
        {introCards.map((card, index) => (
          <span key={card.title} className={index === step ? "active" : ""} />
        ))}
      </div>
      <div className="dialog-actions intro-actions">
        <button className="button secondary" onClick={close}>
          Skip
        </button>
        <div>
          {step > 0 && (
            <button
              className="button secondary"
              onClick={() => setStep(step - 1)}
            >
              Back
            </button>
          )}
          <button
            className="button primary"
            onClick={() =>
              step === introCards.length - 1 ? close() : setStep(step + 1)
            }
          >
            {step === introCards.length - 1 ? "Get started" : "Next"}
            <ChevronRight size={16} />
          </button>
        </div>
      </div>
    </Dialog>
  );
}
function MissionMenu({
  open,
  setOpen,
  edit,
  add,
  busy,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  edit: () => void;
  add: () => void;
  busy: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const outside = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open, setOpen]);
  return (
    <div className="mission-menu" ref={ref}>
      <button
        ref={trigger}
        className="icon-button"
        aria-label="Mission actions"
        title="Mission actions"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? "mission-actions-menu" : undefined}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <MoreHorizontal size={20} />
      </button>
      {open && (
        <div
          id="mission-actions-menu"
          className="mission-menu-panel"
          role="menu"
          aria-label="Mission actions"
          onKeyDown={(e) => {
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key))
              return;
            e.preventDefault();
            const items = [
              ...e.currentTarget.querySelectorAll<HTMLButtonElement>(
                "button:not(:disabled)",
              ),
            ];
            const index = items.indexOf(
              document.activeElement as HTMLButtonElement,
            );
            const next =
              e.key === "Home"
                ? 0
                : e.key === "End"
                  ? items.length - 1
                  : (index + (e.key === "ArrowDown" ? 1 : -1) + items.length) %
                    items.length;
            items[next]?.focus();
          }}
        >
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              edit();
            }}
          >
            Edit mission name
          </button>
          <button
            role="menuitem"
            disabled={busy}
            onClick={() => {
              setOpen(false);
              add();
            }}
          >
            Add Candidate Manually
          </button>
        </div>
      )}
    </div>
  );
}
function DeleteMissionDialog({
  mission,
  close,
  toast,
  busy,
}: {
  mission: Mission;
  close: () => void;
  toast: Toast;
  busy: boolean;
}) {
  const [deleteShared, setDeleteShared] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  return (
    <Dialog
      title="Delete this mission?"
      close={() => {
        if (!loading) close();
      }}
    >
      <p className="muted">
        “{mission.name}” and its decisions will be removed. Candidates used only
        here will also be deleted.
      </p>
      <label className="delete-option">
        <input
          type="checkbox"
          checked={deleteShared}
          disabled={loading}
          onChange={(e) => setDeleteShared(e.target.checked)}
        />
        <span>
          Also delete candidates of this mission even if they are used by other
          missions
        </span>
      </label>
      {busy && (
        <p className="notice">Pause collection before deleting a mission.</p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button className="button secondary" disabled={loading} onClick={close}>
          Keep mission
        </button>
        <button
          className="button danger"
          disabled={loading || busy}
          onClick={async () => {
            setLoading(true);
            setError("");
            try {
              await deleteMission(mission.id, db, deleteShared);
              close();
              toast("Mission deleted.");
            } catch (e) {
              setError(errorText(e));
            } finally {
              setLoading(false);
            }
          }}
        >
          {loading && <LoaderCircle size={16} className="spin" />}Delete mission
        </button>
      </div>
    </Dialog>
  );
}
function MissionDialog({
  mission,
  close,
  onSave,
  toast,
}: {
  mission?: Mission;
  close: () => void;
  onSave: (id: string) => void;
  toast: Toast;
}) {
  const [name, setName] = useState(mission?.name || "");
  return (
    <Dialog title={mission ? "Rename mission" : "A new mission"} close={close}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            if (mission) {
              await db.missions.update(mission.id, { name: name.trim() });
              onSave(mission.id);
            } else onSave((await createMission(name)).id);
            close();
          } catch (error) {
            toast(errorText(error));
          }
        }}
      >
        <label className="field">
          Mission name
          <input
            autoFocus
            required
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Someone from the opening night"
          />
        </label>
        <div className="dialog-actions">
          <button type="button" className="button secondary" onClick={close}>
            Cancel
          </button>
          <button className="button primary" disabled={!name.trim()}>
            {mission ? "Save name" : "Create mission"}
            <ArrowUpRight size={16} />
          </button>
        </div>
      </form>
    </Dialog>
  );
}
function AddDialog({
  missionId,
  initial,
  close,
  toast,
  busy,
}: {
  missionId: string;
  initial?: { value: string; mode: Mode };
  close: () => void;
  toast: Toast;
  busy: boolean;
}) {
  const manual = initial?.mode === "single";
  const [value, setValue] = useState(initial?.value || "");
  const [mode, setMode] = useState<Mode>(initial?.mode || "both");
  const [resolved, setResolved] = useState<Resolved>();
  const [previous, setPrevious] = useState<Run[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const cacheCounts = useLiveQuery(
    async () =>
      Object.fromEntries(
        await Promise.all(
          previous.map(async (r) => [
            r.id,
            new Set(
              (await db.results.where("runId").equals(r.id).toArray()).map(
                (p) => p.profileId,
              ),
            ).size,
          ]),
        ),
      ),
    [previous],
  );
  let isPost = false;
  try {
    isPost = parseInput(value).type === "post";
  } catch {
    /* Validate on submit. */
  }
  const launch = async (reuse?: Run, resume = false) => {
    if (!resolved) return;
    setLoading(true);
    setError("");
    try {
      const run = reuse || (await runner.create(resolved, missionId));
      if (reuse) await runner.attach(run.id, missionId);
      close();
      toast(
        reuse && !resume
          ? "Saved candidates added to this mission."
          : resolved.mode === "single"
            ? "Candidate added."
            : "Collection started. Keep this app tab open.",
      );
      if ((!reuse || resume) && run.status !== "completed")
        void runner.run(run.id).catch((e) => toast(errorText(e)));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  };
  const completed = previous.find((r) => r.status === "completed");
  const interrupted = previous.find(
    (r) => r.status !== "completed" && r.checkpoint.stage !== "done",
  );
  return (
    <Dialog
      title={manual ? "Add Candidate Manually" : "Add source"}
      close={close}
    >
      {!resolved ? (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setLoading(true);
            setError("");
            try {
              if (manual && isPost)
                throw new Error("Enter a username or profile URL.");
              const result = await runner.resolve(
                value,
                isPost ? "commenters" : mode,
              );
              setResolved(result);
              setPrevious(await runner.previous(result));
            } catch (err) {
              setError(errorText(err));
            } finally {
              setLoading(false);
            }
          }}
        >
          <label className="field">
            {manual ? "Username or profile URL" : "Username or Instagram URL"}
            <input
              autoFocus
              required
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="@username or https://instagram.com/…"
            />
          </label>
          {!manual && isPost ? (
            <div className="notice">
              <Users size={18} />
              <span>Commenters, including replies</span>
            </div>
          ) : mode !== "single" ? (
            <fieldset className="mode-grid">
              <legend>Collect</legend>
              {modes.map((m) => (
                <label
                  key={m.value}
                  className={`mode-option ${mode === m.value ? "selected" : ""}`}
                >
                  <input
                    type="radio"
                    name="collection-mode"
                    value={m.value}
                    checked={mode === m.value}
                    onChange={() => setMode(m.value)}
                  />
                  <strong>{m.label}</strong>
                </label>
              ))}
            </fieldset>
          ) : null}
          {busy && (
            <div className="notice">
              Pause the current collection before adding another account.
            </div>
          )}
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <button type="button" className="button secondary" onClick={close}>
              Cancel
            </button>
            <button className="button primary" disabled={loading || busy}>
              {loading ? (
                <LoaderCircle className="spin" size={17} />
              ) : (
                <Search size={17} />
              )}
              Look up account
            </button>
          </div>
        </form>
      ) : (
        <>
          <div className="profile-preview">
            <Avatar profile={resolved.source} />
            <div>
              <strong>
                {resolved.source.fullName || resolved.source.userName}
              </strong>
              <p>@{resolved.source.userName}</p>
            </div>
            <span className="pill">
              {resolved.mode === "single"
                ? "One account"
                : modes.find((m) => m.value === resolved.mode)?.label}
            </span>
          </div>
          {completed && (
            <div className="cache-box">
              <div>
                <ShieldCheck size={20} />
                <strong>Saved results available</strong>
              </div>
              <p>
                {number(cacheCounts?.[completed.id] || 0)} unique profiles ·
                Collected {date(completed.completedAt || completed.updatedAt)}
              </p>
              <button
                className="button secondary"
                disabled={loading}
                onClick={() => void launch(completed)}
              >
                Use saved results
              </button>
            </div>
          )}
          {interrupted && (
            <div className="cache-box">
              <div>
                <Pause size={20} />
                <strong>Previous collection is incomplete</strong>
              </div>
              <p>
                {number(cacheCounts?.[interrupted.id] || 0)} profiles saved ·{" "}
                {interrupted.reason || labels.unreviewed}
              </p>
              <button
                className="button secondary"
                disabled={
                  loading ||
                  (!!interrupted.retryAt && interrupted.retryAt > Date.now())
                }
                onClick={() => void launch(interrupted, true)}
              >
                Resume saved progress
              </button>
              {interrupted.retryAt && interrupted.retryAt > Date.now() && (
                <p>Resume after {date(interrupted.retryAt)}</p>
              )}
            </div>
          )}
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <button
              className="button secondary"
              onClick={() => {
                setResolved(undefined);
                setError("");
              }}
            >
              Back
            </button>
            <button
              className="button primary"
              disabled={loading || busy}
              onClick={() => void launch()}
            >
              {loading ? (
                <LoaderCircle className="spin" size={17} />
              ) : (
                <Plus size={17} />
              )}{" "}
              {resolved.mode === "single"
                ? "Add this candidate"
                : completed || interrupted
                  ? "Collect again"
                  : "Add source & collect"}
            </button>
          </div>
        </>
      )}
    </Dialog>
  );
}
function Sources({
  mission,
  toast,
  collect,
}: {
  mission: Mission;
  toast: Toast;
  collect: (p: Profile) => void;
}) {
  const [query, setQuery] = useState("");
  const [include, setInclude] = useState(mission.includeSources);
  useEffect(
    () => setInclude(mission.includeSources),
    [mission.id, mission.includeSources],
  );
  const sources = useLiveQuery(async () => {
    const rows = await db.sources
      .where("missionId")
      .equals(mission.id)
      .toArray();
    return (await db.profiles.bulkGet(rows.map((s) => s.profileId))).filter(
      (p): p is Profile => !!p,
    );
  }, [mission.id]);
  const library = useLiveQuery(
    async () =>
      query.trim()
        ? db.profiles
            .filter((p) =>
              `${p.userName} ${p.fullName}`
                .toLowerCase()
                .includes(query.toLowerCase().trim()),
            )
            .limit(8)
            .toArray()
        : [],
    [query],
  );
  return (
    <details className="sources-panel">
      <summary>
        <span className="summary-title">
          <Flag size={17} />
          {sources?.length || 0} {sources?.length === 1 ? "source" : "sources"}
        </span>
        <ChevronRight size={17} />
      </summary>
      <div className="sources-body">
        <div className="sources-top">
          <label className="toggle">
            <input
              type="checkbox"
              checked={include}
              onChange={(e) => {
                const value = e.target.checked;
                setInclude(value);
                void includeSources(mission.id, value).catch((err) => {
                  setInclude(mission.includeSources);
                  toast(errorText(err));
                });
              }}
            />
            Include sources as candidates
          </label>
        </div>
        <div className="source-list">
          {sources?.map((p) => (
            <div className="source-row" key={p.id}>
              <Avatar profile={p} />
              <a href={p.profileUrl} target="_blank" rel="noreferrer">
                @{p.userName}
                <ArrowUpRight size={13} />
              </a>
              <button
                className="button small secondary"
                onClick={() => collect(p)}
              >
                <RefreshCw size={13} />
                Collect
              </button>
              <button
                className="icon-button"
                aria-label={`Demote ${p.userName}`}
                title="Demote source"
                onClick={() =>
                  void setSource(mission.id, p.id, false)
                    .then(() => toast("Source removed."))
                    .catch((err) => toast(errorText(err)))
                }
              >
                <X size={16} />
              </button>
            </div>
          ))}
        </div>
        <label className="field compact">
          Saved profiles
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search saved profiles…"
          />
        </label>
        {library && query && (
          <div className="library-results">
            {library.length ? (
              library.map((p) => (
                <button
                  className="library-row"
                  key={p.id}
                  disabled={sources?.some((s) => s.id === p.id)}
                  onClick={() =>
                    void setSource(mission.id, p.id, true)
                      .then(() => {
                        setQuery("");
                        toast(`@${p.userName} is now a source.`, {
                          label: "Collect",
                          fn: () => collect(p),
                        });
                      })
                      .catch((err) => toast(errorText(err)))
                  }
                >
                  <Avatar profile={p} />
                  <span>
                    <strong>@{p.userName}</strong>
                    <small>{p.fullName}</small>
                  </span>
                  <Plus size={16} />
                </button>
              ))
            ) : (
              <p className="muted">No saved profiles match.</p>
            )}
          </div>
        )}
      </div>
    </details>
  );
}
function Review({
  mission,
  toast,
  collect,
  busy,
  modalOpen,
  active,
}: {
  mission: Mission;
  toast: Toast;
  collect: (p: Profile) => void;
  busy: boolean;
  modalOpen: boolean;
  active: boolean;
}) {
  const top = useLiveQuery(
    () => candidatePage(mission.id, "unreviewed", "", 0, 1),
    [mission.id],
  );
  const [pinnedId, setPinnedId] = useState<string>();
  const [undo, setUndo] = useState<{ id: string; decision: Decision }>();
  const card = useLiveQuery(async () => {
    if (!pinnedId) return undefined;
    const candidate = await db.candidates.get([mission.id, pinnedId]);
    const profile = await db.profiles.get(pinnedId);
    return candidate && profile ? { ...candidate, profile } : null;
  }, [mission.id, pinnedId]);
  const source = useLiveQuery(
    () => (pinnedId ? db.sources.get([mission.id, pinnedId]) : undefined),
    [mission.id, pinnedId],
  );
  useEffect(() => {
    setPinnedId(undefined);
    setUndo(undefined);
  }, [mission.id]);
  useEffect(() => {
    if (!pinnedId && top?.rows[0]) setPinnedId(top.rows[0].profileId);
  }, [pinnedId, top]);
  useEffect(() => {
    if (
      card === null ||
      (card && (card.decision !== "unreviewed" || !card.visible))
    )
      setPinnedId(undefined);
  }, [card]);
  const action = async (decision: Decision) => {
    if (!card || card.decision !== "unreviewed") return;
    try {
      await decide(mission.id, card.profileId, decision);
      setUndo({ id: card.profileId, decision: card.decision });
      setPinnedId(undefined);
    } catch (e) {
      toast(errorText(e));
    }
  };
  const reverse = async () => {
    if (!undo) return;
    await decide(mission.id, undo.id, undo.decision);
    setPinnedId(undo.id);
    setUndo(undefined);
  };
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (
        !active ||
        modalOpen ||
        (e.target as HTMLElement)?.closest(
          'input, textarea, select, [contenteditable="true"]',
        )
      )
        return;
      if (["1", "2", "3"].includes(e.key)) {
        e.preventDefault();
        void action(
          (
            { "1": "no", "2": "unlikely", "3": "possible" } as Record<
              string,
              Decision
            >
          )[e.key],
        );
      }
      if (e.key.toLowerCase() === "z" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void reverse();
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  });
  return (
    <section className="review-layout">
      <div className="review-main">
        <div className="review-heading">
          <button
            className="button small ghost"
            disabled={!undo}
            onClick={() => void reverse()}
          >
            <Undo2 size={15} />
            Undo
          </button>
        </div>
        {card && card.visible && card.decision === "unreviewed" ? (
          <>
            <article className="review-card">
              <div className="photo-wrap">
                <Avatar profile={card.profile} large />
                <button
                  className={`source-badge ${source ? "active" : ""}`}
                  title={source ? "Demote source" : "Promote to source"}
                  aria-label={source ? "Demote source" : "Promote to source"}
                  onClick={() =>
                    void setSource(mission.id, card.profileId, !source)
                      .then(
                        () =>
                          !source &&
                          toast(`@${card.profile.userName} is now a source.`, {
                            label: "Collect",
                            fn: () => collect(card.profile),
                          }),
                      )
                      .catch((e) => toast(errorText(e)))
                  }
                >
                  <Flag size={16} />
                </button>
              </div>
              <div className="card-copy">
                <div>
                  <h2>{card.profile.fullName || card.profile.userName}</h2>
                  <p>@{card.profile.userName}</p>
                </div>
                <a
                  className="icon-button instagram-link"
                  href={card.profile.profileUrl}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="Open Instagram profile"
                >
                  <ArrowUpRight size={21} />
                </a>
              </div>
              <button
                className="refresh-photo"
                disabled={busy}
                onClick={() =>
                  void runner
                    .refreshProfile(card.profile.userName)
                    .then(() => toast("Profile refreshed."))
                    .catch((e) => toast(errorText(e)))
                }
              >
                <RefreshCw size={12} />
                Refresh photo
              </button>
            </article>
            <div className="decision-grid">
              <button className="decision no" onClick={() => void action("no")}>
                <span className="decision-icon">
                  <X size={24} />
                </span>
                <strong>Not the person</strong>
                <kbd>1</kbd>
              </button>
              <button
                className="decision unlikely"
                onClick={() => void action("unlikely")}
              >
                <span className="decision-icon">
                  <MoreHorizontal size={24} />
                </span>
                <strong>Probably not</strong>
                <kbd>2</kbd>
              </button>
              <button
                className="decision possible"
                onClick={() => void action("possible")}
              >
                <span className="decision-icon">
                  <Heart size={22} />
                </span>
                <strong>Possible match</strong>
                <kbd>3</kbd>
              </button>
            </div>
          </>
        ) : (
          <div className="empty review-empty">
            <div className="empty-icon">
              <Check size={32} />
            </div>
            <h2>
              {top?.count
                ? "Finding your next candidate…"
                : "Nothing to review."}
            </h2>
            {undo && (
              <button
                className="button secondary"
                onClick={() => void reverse()}
              >
                <Undo2 size={16} />
                Undo last choice
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
function CandidateList({
  mission,
  toast,
  collect,
}: {
  mission: Mission;
  toast: Toast;
  collect: (p: Profile) => void;
}) {
  const [filter, setFilter] = useState<Decision | "all">("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const data = useLiveQuery(
    () => candidatePage(mission.id, filter, search, page),
    [mission.id, filter, search, page],
  );
  const sources = useLiveQuery(
    () => db.sources.where("missionId").equals(mission.id).toArray(),
    [mission.id],
  );
  useEffect(() => setPage(0), [mission.id, filter, search]);
  useEffect(() => {
    if (data && page > 0 && !data.rows.length) setPage((p) => p - 1);
  }, [data, page]);
  return (
    <section className="list-panel">
      <div className="list-toolbar">
        <label className="search-field">
          <Search size={17} />
          <input
            type="search"
            aria-label="Search candidates"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name or username…"
          />
        </label>
        <select
          aria-label="Filter candidates"
          value={filter}
          onChange={(e) => setFilter(e.target.value as Decision | "all")}
        >
          <option value="all">All outcomes</option>
          {Object.entries(labels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <span className="muted tiny">{number(data?.count || 0)} people</span>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Person</th>
              <th>Your decision</th>
              <th>Source</th>
              <th>
                <span className="sr-only">Instagram</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {data?.rows.map((c) => {
              const isSource = sources?.some(
                (s) => s.profileId === c.profileId,
              );
              return (
                <tr key={c.profileId}>
                  <td>
                    <div className="person-cell">
                      <Avatar profile={c.profile} />
                      <div>
                        <strong>
                          {c.profile.fullName || c.profile.userName}
                        </strong>
                        <span>@{c.profile.userName}</span>
                      </div>
                    </div>
                  </td>

                  <td>
                    <select
                      className={`decision-select ${c.decision}`}
                      aria-label={`Decision for ${c.profile.userName}`}
                      value={c.decision}
                      onChange={(e) =>
                        void decide(
                          mission.id,
                          c.profileId,
                          e.target.value as Decision,
                        ).catch((err) => toast(errorText(err)))
                      }
                    >
                      {Object.entries(labels).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <button
                      className={`icon-button ${isSource ? "flag-active" : ""}`}
                      aria-label={`${isSource ? "Demote" : "Promote"} ${c.profile.userName}`}
                      title={isSource ? "Demote source" : "Promote to source"}
                      onClick={() =>
                        void setSource(mission.id, c.profileId, !isSource)
                          .then(() => {
                            if (!isSource)
                              toast(`@${c.profile.userName} is now a source.`, {
                                label: "Collect",
                                fn: () => collect(c.profile),
                              });
                          })
                          .catch((err) => toast(errorText(err)))
                      }
                    >
                      <Flag size={16} />
                    </button>
                  </td>
                  <td>
                    <a
                      className="icon-button"
                      href={c.profile.profileUrl}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`Open ${c.profile.userName} on Instagram`}
                    >
                      <ArrowUpRight size={18} />
                    </a>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!data?.rows.length && (
        <div className="empty small-empty">
          <Search size={28} />
          <h3>
            {search || filter !== "all" ? "No matches." : "No candidates yet."}
          </h3>
        </div>
      )}
      <div className="pagination">
        <span>
          {data?.count
            ? `${page * 40 + 1}–${Math.min((page + 1) * 40, data.count)} of ${number(data.count)}`
            : "0 candidates"}
        </span>
        <div>
          <button
            className="icon-button"
            aria-label="Previous page"
            disabled={page === 0}
            onClick={() => setPage((p) => p - 1)}
          >
            <ChevronLeft size={18} />
          </button>
          <span>Page {page + 1}</span>
          <button
            className="icon-button"
            aria-label="Next page"
            disabled={!data || (page + 1) * 40 >= data.count}
            onClick={() => setPage((p) => p + 1)}
          >
            <ChevronRight size={18} />
          </button>
        </div>
      </div>
    </section>
  );
}
function HistoryDialog({
  close,
  toast,
  collectAgain,
  busy,
}: {
  close: () => void;
  toast: Toast;
  collectAgain: (run: Run) => void;
  busy: boolean;
}) {
  const [page, setPage] = useState(0);
  const history = useLiveQuery(async () => {
    const runs = await db.runs
      .orderBy("updatedAt")
      .reverse()
      .offset(page * 20)
      .limit(20)
      .toArray();
    return Promise.all(
      runs.map(async (r) => ({
        ...r,
        count: new Set(
          (await db.results.where("runId").equals(r.id).toArray()).map(
            (p) => p.profileId,
          ),
        ).size,
      })),
    );
  }, [page]);
  const count = useLiveQuery(() => db.runs.count());
  return (
    <Dialog title="Collection history" close={close} wide>
      <div className="history-list">
        {history?.map((run) => (
          <div className="history-row" key={run.id}>
            <div>
              <strong>@{run.targetLabel}</strong>
              <p>
                {run.mode === "both" ? "Followers + following" : run.mode} ·{" "}
                {number(run.count)} unique profiles · {date(run.updatedAt)}
              </p>
              {run.reason && <p className="history-reason">{run.reason}</p>}
              {run.retryAt && run.retryAt > Date.now() && (
                <p>Resume after {date(run.retryAt)}</p>
              )}
            </div>
            <div className="history-actions">
              <span className={`status-pill ${run.status}`}>{run.status}</span>
              {run.status === "running" ? (
                <button
                  className="button small secondary"
                  onClick={() => runner.pause()}
                >
                  <Pause size={13} />
                  Pause
                </button>
              ) : run.status !== "completed" &&
                run.checkpoint.stage !== "done" ? (
                <button
                  className="button small secondary"
                  disabled={busy || (!!run.retryAt && run.retryAt > Date.now())}
                  onClick={() =>
                    void runner.run(run.id).catch((e) => toast(errorText(e)))
                  }
                >
                  <Play size={13} />
                  Resume
                </button>
              ) : null}
              <button
                className="button small ghost"
                disabled={busy}
                onClick={() => {
                  close();
                  collectAgain(run);
                }}
              >
                Collect again
              </button>
            </div>
          </div>
        ))}
      </div>
      {!history?.length && (
        <div className="empty small-empty">
          <DatabaseIcon size={28} />
          <h3>No collections yet.</h3>
          <p>Your collection history will appear here.</p>
        </div>
      )}
      <div className="pagination">
        <span>{number(count || 0)} collections</span>
        <div>
          <button
            className="icon-button"
            aria-label="Previous history page"
            disabled={page === 0}
            onClick={() => setPage((p) => p - 1)}
          >
            <ChevronLeft size={18} />
          </button>
          <span>Page {page + 1}</span>
          <button
            className="icon-button"
            aria-label="Next history page"
            disabled={(page + 1) * 20 >= (count || 0)}
            onClick={() => setPage((p) => p + 1)}
          >
            <ChevronRight size={18} />
          </button>
        </div>
      </div>
    </Dialog>
  );
}
function SettingsDialog({
  close,
  toast,
  busy,
}: {
  close: () => void;
  toast: Toast;
  busy: boolean;
}) {
  const [delay, setDelay] = useState(5);
  const [backup, setBackup] = useState<Backup>();
  const [working, setWorking] = useState(false);
  const stats = useLiveQuery(async () => ({
    profiles: await db.profiles.count(),
    follows: await db.follows.count(),
    comments: await db.comments.count(),
  }));
  const [usage, setUsage] = useState<number>();
  useEffect(() => {
    void preferences().then((p) => setDelay(p.delaySeconds));
    void navigator.storage?.estimate().then((s) => setUsage(s.usage));
  }, []);
  return (
    <Dialog title="Workspace settings" close={close}>
      <div className="settings-section">
        <h3>Collection pace</h3>
        <form
          className="delay-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!Number.isFinite(delay) || delay < 1 || delay > 3600) return;
            await db.settings.put({
              ...(await preferences()),
              delaySeconds: delay,
            });
            toast("Collection pace saved.");
          }}
        >
          <label className="field">
            Delay in seconds
            <input
              type="number"
              min={1}
              max={3600}
              step={1}
              required
              value={delay}
              onChange={(e) => setDelay(Number(e.target.value))}
            />
          </label>
          <button className="button secondary">Save pace</button>
        </form>
      </div>
      <div className="settings-section">
        <h3>Saved on this device</h3>
        <div className="storage-stats">
          <span>
            <strong>{number(stats?.profiles || 0)}</strong>profiles
          </span>
          <span>
            <strong>{number(stats?.follows || 0)}</strong>follow links
          </span>
          <span>
            <strong>{number(stats?.comments || 0)}</strong>post connections
          </span>
        </div>
        <p className="tiny muted">
          {usage !== undefined
            ? `${(usage / 1024 / 1024).toFixed(1)} MB used. `
            : ""}
        </p>
      </div>
      <div className="settings-section">
        <h3>Backup & restore</h3>
        <p className="muted">Removing the extension deletes its local data.</p>
        <div className="backup-actions">
          <button
            className="button secondary"
            disabled={working || busy}
            onClick={async () => {
              setWorking(true);
              try {
                const data = await exportBackup();
                download(
                  `instafinder-${new Date().toISOString().slice(0, 10)}.backup.json`,
                  JSON.stringify(data),
                );
                toast("Backup downloaded.");
              } catch (e) {
                toast(errorText(e));
              } finally {
                setWorking(false);
              }
            }}
          >
            <ArrowDownToLine size={16} />
            Export backup
          </button>
          <label
            className={`button secondary file-button ${busy || working ? "disabled" : ""}`}
          >
            <ArrowUpFromLine size={16} />
            Restore backup
            <input
              aria-label="Choose backup file"
              type="file"
              accept=".json"
              disabled={working || busy}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                setWorking(true);
                try {
                  setBackup(validateBackup(JSON.parse(await file.text())));
                } catch (err) {
                  toast(errorText(err));
                } finally {
                  setWorking(false);
                }
              }}
            />
          </label>
        </div>
        {working && (
          <p className="muted">
            <LoaderCircle size={14} className="spin" /> Preparing your data…
          </p>
        )}
        {backup && (
          <div className="notice restore-confirm">
            <p>
              Restore this backup? It replaces all data in this workspace with{" "}
              {backup.tables.missions.length} missions and{" "}
              {number(backup.tables.profiles.length)} profiles.
            </p>
            <div>
              <button
                className="button secondary"
                onClick={() => setBackup(undefined)}
              >
                Cancel
              </button>
              <button
                className="button danger"
                disabled={working || busy}
                onClick={async () => {
                  setWorking(true);
                  try {
                    await restoreBackup(backup);
                    setBackup(undefined);
                    toast("Workspace restored.");
                    close();
                  } catch (err) {
                    toast(errorText(err));
                  } finally {
                    setWorking(false);
                  }
                }}
              >
                Replace workspace
              </button>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}
function App() {
  const missions = useLiveQuery(() =>
    db.missions.orderBy("createdAt").toArray(),
  );
  const [selected, setSelected] = useState(
    localStorage.getItem("selectedMission") || "",
  );
  const [tab, setTab] = useState<"review" | "candidates">("review");
  const [dialog, setDialog] = useState<
    "mission" | "rename" | "add" | "settings" | "history" | "delete" | null
  >(null);
  const [showIntro, setShowIntro] = useState(
    () => localStorage.getItem("instafinderIntroSeen") !== "1",
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const [addInitial, setAddInitial] = useState<{ value: string; mode: Mode }>();
  const [message, setMessage] = useState<{
    text: string;
    action?: { label: string; fn: () => void };
  }>();
  const toast: Toast = (text, action) => setMessage({ text, action });
  const mission = missions?.find((m) => m.id === selected);
  const activeRun = useLiveQuery(() =>
    db.runs.where("status").equals("running").first(),
  );
  const counts = useLiveQuery(async () => {
    if (!selected) return { total: 0, unreviewed: 0, possible: 0 };
    const values = await Promise.all([
      db.candidates.where("[missionId+visible]").equals([selected, 1]).count(),
      db.candidates
        .where("[missionId+visible+decision]")
        .equals([selected, 1, "unreviewed"])
        .count(),
      db.candidates
        .where("[missionId+visible+decision]")
        .equals([selected, 1, "possible"])
        .count(),
    ]);
    return { total: values[0], unreviewed: values[1], possible: values[2] };
  }, [selected]);
  const activeCount = useLiveQuery(
    async () =>
      activeRun
        ? new Set(
            (
              await db.results.where("runId").equals(activeRun.id).toArray()
            ).map((r) => r.profileId),
          ).size
        : 0,
    [activeRun],
  );
  useEffect(() => {
    if (missions && !missions.some((m) => m.id === selected))
      setSelected(missions[0]?.id || "");
  }, [missions, selected]);
  useEffect(() => {
    localStorage.setItem("selectedMission", selected);
  }, [selected]);
  useEffect(() => {
    void runner.recover().catch((e) => toast(errorText(e)));
  }, []);
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(
      () => setMessage(undefined),
      message.action ? 14000 : 7000,
    );
    return () => clearTimeout(timer);
  }, [message]);
  useEffect(() => {
    const listener = () => runner.pause();
    window.addEventListener("pagehide", listener);
    return () => window.removeEventListener("pagehide", listener);
  }, []);
  useEffect(() => {
    setMenuOpen(false);
  }, [selected, dialog]);
  const finishIntro = () => {
    localStorage.setItem("instafinderIntroSeen", "1");
    setShowIntro(false);
  };
  const collect = (p: Profile) => {
    setAddInitial({ value: p.userName, mode: "both" });
    setDialog("add");
  };
  const collectAgain = (run: Run) => {
    if (!mission) {
      toast("Create or select a mission first.");
      return;
    }
    void (async () => {
      const source = await db.profiles.get(run.sourceId);
      const post = run.targetPostId
        ? await db.posts.get(run.targetPostId)
        : undefined;
      if (!source) throw new Error("Source profile not found.");
      setAddInitial({ value: post?.url || source.userName, mode: run.mode });
      setDialog("add");
    })().catch((e) => toast(errorText(e)));
  };
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#" onClick={(e) => e.preventDefault()}>
          <span className="brand-mark">
            <Compass size={23} />
          </span>
          <span>InstaFinder</span>
        </a>
        <div className="sidebar-heading">
          <span>YOUR MISSIONS</span>
          <button
            className="icon-button"
            aria-label="New mission"
            onClick={() => setDialog("mission")}
          >
            <Plus size={18} />
          </button>
        </div>
        <nav className="mission-nav">
          {missions?.map((m) => (
            <button
              key={m.id}
              className={`mission-item ${selected === m.id ? "selected" : ""}`}
              onClick={() => {
                setSelected(m.id);
                setTab("review");
              }}
            >
              <Layers size={17} />
              <span>{m.name}</span>
              {selected === m.id && <span className="nav-dot" />}
            </button>
          ))}
        </nav>
        <button
          className="button sidebar-new"
          onClick={() => setDialog("mission")}
        >
          <Plus size={16} />
          New mission
        </button>
        <div className="sidebar-bottom">
          <button className="sidebar-link" onClick={() => setDialog("history")}>
            <DatabaseIcon size={17} />
            Collection history
          </button>
          <button
            className="sidebar-link"
            onClick={() => setDialog("settings")}
          >
            <SettingsIcon size={17} />
            Settings & backups
          </button>
        </div>
      </aside>
      <main className="main">
        {activeRun && (
          <div className="collection-banner" role="status">
            <LoaderCircle size={17} className="spin" />
            <div>
              <strong>Collecting @{activeRun.targetLabel}</strong>
              <span>
                {number(activeCount || 0)} profiles saved ·{" "}
                {activeRun.checkpoint.stage} · Keep this app tab open
              </span>
            </div>
            <button
              className="button small secondary"
              onClick={() => runner.pause()}
            >
              <Pause size={14} />
              Pause
            </button>
          </div>
        )}
        <div className="content">
          {mission ? (
            <>
              <div className="mission-heading">
                <div>
                  <h1>{mission.name}</h1>
                </div>
                <div className="heading-actions">
                  <MissionMenu
                    open={menuOpen}
                    setOpen={setMenuOpen}
                    busy={!!activeRun}
                    edit={() => setDialog("rename")}
                    add={() => {
                      setAddInitial({ value: "", mode: "single" });
                      setDialog("add");
                    }}
                  />
                  <button
                    className="icon-button"
                    aria-label="Delete mission"
                    title="Delete mission"
                    onClick={() => setDialog("delete")}
                  >
                    <Trash2 size={17} />
                  </button>
                  <button
                    className="button primary"
                    disabled={!!activeRun}
                    onClick={() => {
                      setAddInitial(undefined);
                      setDialog("add");
                    }}
                  >
                    <Plus size={17} />
                    Add source
                  </button>
                </div>
              </div>
              <Sources mission={mission} toast={toast} collect={collect} />
              <div className="view-tabs" role="tablist">
                <button
                  role="tab"
                  aria-label="Review"
                  aria-selected={tab === "review"}
                  className={tab === "review" ? "active" : ""}
                  onClick={() => setTab("review")}
                >
                  <Compass size={17} />
                  Review<span>{number(counts?.unreviewed || 0)}</span>
                </button>
                <button
                  role="tab"
                  aria-selected={tab === "candidates"}
                  className={tab === "candidates" ? "active" : ""}
                  onClick={() => setTab("candidates")}
                >
                  <List size={17} />
                  Candidates<span>{number(counts?.total || 0)}</span>
                </button>
              </div>
              <div hidden={tab !== "review"}>
                <Review
                  key={mission.id}
                  mission={mission}
                  toast={toast}
                  collect={collect}
                  busy={!!activeRun}
                  modalOpen={!!dialog || showIntro || menuOpen}
                  active={tab === "review"}
                />
              </div>
              <div hidden={tab !== "candidates"}>
                <CandidateList
                  key={mission.id}
                  mission={mission}
                  toast={toast}
                  collect={collect}
                />
              </div>
            </>
          ) : (
            <div className="welcome">
              <span className="welcome-symbol">
                <Compass size={50} strokeWidth={1.3} />
              </span>
              <h1>No missions yet.</h1>
              <button
                className="button primary"
                onClick={() => setDialog("mission")}
              >
                <Plus size={18} />
                Create mission
              </button>
            </div>
          )}
        </div>
      </main>
      {(dialog === "mission" || (dialog === "rename" && mission)) && (
        <MissionDialog
          mission={dialog === "rename" ? mission : undefined}
          close={() => setDialog(null)}
          toast={toast}
          onSave={(id) => setSelected(id)}
        />
      )}
      {dialog === "add" && mission && (
        <AddDialog
          missionId={mission.id}
          initial={addInitial}
          close={() => setDialog(null)}
          toast={toast}
          busy={!!activeRun}
        />
      )}
      {dialog === "settings" && (
        <SettingsDialog
          close={() => setDialog(null)}
          toast={toast}
          busy={!!activeRun}
        />
      )}
      {dialog === "history" && (
        <HistoryDialog
          close={() => setDialog(null)}
          toast={toast}
          collectAgain={collectAgain}
          busy={!!activeRun}
        />
      )}
      {dialog === "delete" && mission && (
        <DeleteMissionDialog
          mission={mission}
          close={() => setDialog(null)}
          toast={toast}
          busy={!!activeRun}
        />
      )}
      {showIntro && <IntroDialog close={finishIntro} />}
      {message && (
        <div className="toast" role="status">
          <Check size={17} />
          <span>{message.text}</span>
          {message.action && (
            <button
              onClick={() => {
                message.action!.fn();
                setMessage(undefined);
              }}
            >
              {message.action.label}
              <ArrowUpRight size={14} />
            </button>
          )}
          <button
            className="toast-close"
            aria-label="Dismiss notification"
            onClick={() => setMessage(undefined)}
          >
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
