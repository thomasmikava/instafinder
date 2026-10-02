# InstaFinder — product requirements

InstaFinder is a local, single-user Chrome extension for finding a person among Instagram accounts. It has no app registration, backend, paid tier, or artificial collection limit. Each installation keeps its own data.

## Missions and candidates

- Create a mission with a name; rename it through the three-dot menu.
- Delete a mission and its candidates that are unused by other missions. Offer an unchecked option to also delete its shared candidates across missions; keep unrelated data and excluded source-only profiles. Remove affected relationships and invalidate affected cached collections.
- Add one Instagram profile or collect followers, following, both, commenters, or likers using a username or Instagram URL. CSV import is not included.
- Collect commenters from all accessible posts/reels of a profile, or only the specific post/reel URL provided. Include reply authors. Collect likers from the toolbar using a profile or specific post/reel.
- Share saved profiles and observed relationships across missions; keep candidate membership and review decisions mission-specific.
- Repeated additions update metadata, avoid duplicates, and preserve review decisions.

## Sources and priority

- Collection targets become sources for the mission. Promote any saved profile or demote a source at any time.
- Promotion uses existing data and suggests collecting more; collection is always explicit.
- Each mission can include or exclude active sources from its candidates; this setting is changeable and defaults to excluded.
- Rank candidates against that mission's active sources: +1 for following a source, +1 for being followed by a source, +1 per distinct source-owned post commented on, and +1 per distinct source-owned post liked. Mutual follows count twice; repeated comments on the same post count once. Ignore self-connections and account follower totals.

## Collection

- Use the current Instagram login in Chrome; never save authentication cookies in the database or backups.
- The toolbar button opens a compact menu offering Open InstaFinder and collection from the current Instagram tab. Hide mission selection when there is only one mission; otherwise offer a selector. Choose Followers, Following, Commenters or Likers to attach to the current page without reloading and start the bottom-right overlay, with automatic controls and optional manual capture. The main app’s Add source flow uses direct requests only. Never silently switch methods.
- Collect in parallel across Instagram tabs, with one job per tab and one tab per history run. Support different sources, the same source/action, and different actions on the same source. Keep each tab's controls, history, checkpoints and interruptions independent while deduplicating shared facts and preserving mission decisions. The popup and main app can close; each collecting Instagram tab must stay open. Direct collection runs alone.
- Default to 1.5 seconds between page actions per tab and five seconds between direct requests, adjustable separately in Settings. Pace automatic page actions; leave native requests and manual actions unchanged. Direct mode paces each request, including replies, retries, and profile lookups. A native 429 stops all page jobs with a shared durable cooldown.
- Save observations and pagination coverage after every page. Closing/reloading the collecting Instagram tab pauses collection. A paused overlay offers Dismiss and Resume. Overlay Resume continues in the same document/list without reloading and preserves pagination coverage; cooldowns remain enforced. Offer explicit resume or restart after interruption; history/popup resume revisits the unfinished scope from the beginning without duplicating facts or decisions.
- Automatic commenter collection targets the comments pane beside the post or inside its dialog, loads more comments and expands replies. If those controls cannot be identified, offer manual capture instead of scrolling the whole page. Short previews do not establish complete coverage; accept native comments only after verifying the post and owner.
- Offer dated saved results when a collection is already complete, or collect again.
- Older unfinished collections covered by a newer successful collection of the same source, action and scope offer an × to clear only their history entry. Preserve all saved data and decisions; remember the cleared entry across reopening and backups.
- Keep collection scope, timestamps, counts, cursors, and outcomes globally. Distinguish completed traversal, partial/restricted results, and failure. Stop on login challenges; respect separate method cooldowns. Native page 429 responses stop page mode. Unknown pagination, hidden content, stalled traversal, or missing reply coverage cannot be marked complete. Offer Finish with saved results for partial collections. When collection ends, keep a clear dismissible outcome on Instagram with the saved profile count and Open InstaFinder. Distinguish successful completion from partial results, pauses and restrictions.

## Review

- Show one unreviewed person at a time: photo, username, display name, and a link opening Instagram in a new tab.
- Offer Not the person, Probably not, and Possible match, with keyboard shortcuts and undo.
- Keep the visible card stable until an action. Show a subtle point count on the active review card and a Points column in the candidate list. A question-mark button in either place opens the same short modal explaining the calculation; keep the explanation out of the main views.
- Provide a searchable, paginated candidate list with outcome/unreviewed filters and controls to change or clear a decision.

## Local data and usability

- Use React and IndexedDB with Chrome's unlimitedStorage permission; no 5/10/50 MB application limit.
- Use a minimal responsive light interface with **Add source** as the main action. Put **Edit mission name** and **Add Candidate Manually** in a small three-dot menu. Show four short first-visit cards explaining the goal, missions, sources, and candidate review, with an option to replay them in Settings; keep the main interface free of explanatory copy and redundant statistics. Retain compact progress, empty states, and photo refresh.
- Provide versioned full-data backup and restore in Settings. Removing the extension removes its local data, so backups matter.
- Install/build with npm; use as an unpacked Chrome extension. No Node version pin or enforced version check, no separate server or SQLite installation.

## Boundaries

Instagram's browser endpoints are undocumented and can change. Access restrictions, hidden content, and rate limits cannot be bypassed or guaranteed away. Saved connections are observations, not a continuous unfollow tracker. Collection starts only when requested; page collection can continue with the main app closed. There is no cloud sync or account sharing.
