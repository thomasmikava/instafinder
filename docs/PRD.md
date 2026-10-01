# InstaFinder — product requirements

InstaFinder is a local, single-user Chrome extension for finding a person among Instagram accounts. It has no app registration, backend, paid tier, or artificial collection limit. Each installation keeps its own data.

## Missions and candidates

- Create a mission with a name; rename or delete it later.
- Add one Instagram profile or collect followers, following, both, or commenters using a username or Instagram URL. CSV import is not included.
- Collect commenters from all accessible posts/reels of a profile, or only the specific post/reel URL provided. Include reply authors.
- Share saved profiles and observed relationships across missions; keep candidate membership and review decisions mission-specific.
- Repeated additions update metadata, avoid duplicates, and preserve review decisions.

## Sources and priority

- Collection targets become sources for the mission. Promote any saved profile or demote a source at any time.
- Promotion uses existing data and suggests collecting more; collection is always explicit.
- Each mission can include or exclude active sources from its candidates; this setting is changeable and defaults to excluded.
- Rank candidates against that mission's active sources: +1 for following a source, +1 for being followed by a source, and +1 per distinct source-owned post commented on. Mutual follows count twice; repeated comments on the same post count once. Ignore self-connections and account follower totals.

## Collection

- Use the current Instagram login in Chrome; never save authentication cookies in the database or backups.
- Collect one job at a time while the app tab stays open. Review and navigation can continue during collection.
- Default to five seconds between requests, adjustable in Settings. Pace every request, including replies, retries, and profile lookups.
- Save progress after every page. Offer explicit resume after interruption, or restart.
- Offer dated saved results when a collection is already complete, or collect again.
- Keep collection scope, timestamps, counts, cursors, and outcomes globally. Distinguish completed traversal, partial/restricted results, and failure. Stop on login challenges; respect cooldowns.

## Review

- Show one unreviewed person at a time: photo, username, display name, connection score, and a link opening Instagram in a new tab.
- Offer Not the person, Probably not, and Possible match, with keyboard shortcuts and undo.
- Show highest-scoring candidates first; keep the visible card stable until an action.
- Provide a searchable, paginated candidate list with outcome/unreviewed filters and controls to change or clear a decision.

## Local data and usability

- Use React and IndexedDB with Chrome's unlimitedStorage permission; no 5/10/50 MB application limit.
- Use a clean responsive light interface, useful empty states, compact collection progress, and placeholders/explicit refresh for missing photos.
- Provide versioned full-data backup and restore in Settings. Removing the extension removes its local data, so backups matter.
- Install/build with npm; use as an unpacked Chrome extension. No Node version pin or enforced version check, no separate server or SQLite installation.

## Boundaries

Instagram's browser endpoints are undocumented and can change. Access restrictions, hidden content, and rate limits cannot be bypassed or guaranteed away. Saved connections are observations, not a continuous unfollow tracker. Collection is not automatic, and does not run after the app tab closes. There is no cloud sync or account sharing.
