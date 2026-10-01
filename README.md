# InstaFinder

A local Chrome extension for gathering Instagram accounts and reviewing them one at a time. Create missions, collect from sources, and sort candidates using actual observed connections. There are no app accounts, servers, subscriptions, CSV imports, or artificial collection/storage caps.

The short product specification is in [docs/PRD.md](docs/PRD.md).

## Install and run

With Node.js and npm installed:

```sh
npm install
npm run build
```

1. Open `chrome://extensions` in Chrome and enable **Developer mode**.
2. Click **Load unpacked** and select this project's `dist` folder.
3. Click the InstaFinder toolbar button (pin it if helpful), or open its extension options page.
4. Sign in to Instagram normally in the **same Chrome profile**.
5. Create a mission, click **Add source**, and enter a username or Instagram URL.

There is no server to start, database to install, environment file to configure, or Node version pin/check. Node and npm are build/development tools; the built app runs inside Chrome.

Keep the app tab open during collection. Switching between Review and Candidates, using another browser tab, or minimizing the window is fine, though Chrome may slow background tabs. Closing, reloading, or discarding the app tab stops collection after the last saved checkpoint. Open **Collection history** to resume explicitly.

The unpacked extension stores data under its extension ID in the Chrome profile. Keep the project/dist location stable. Reload or update the extension in place; **removing** it deletes its data. Export a backup before removing it or moving to another installation.

## Your workflow

- **Missions:** create a named search. The three-dot menu offers **Edit mission name** and **Add Candidate Manually**. The first visit shows four short cards explaining the workflow.
- **Add source:** choose followers, following, both lists, or commenters. Use **Add Candidate Manually** in the mission menu for one account directly. Profile commenter collection scans all accessible feed posts and reels, including replies. A post/reel URL scans only that item.
- **Delete mission:** candidates used only in that mission are deleted along with their saved relationships. Candidates or sources used by another mission stay by default. The unchecked option also deletes this mission’s candidates from other missions, including their decisions and source memberships. Excluded source-only profiles and unrelated saved profiles stay. Affected saved collections become partial and require collecting again; deleted profiles cannot return through cached results. Pause an active collection before deletion.
- **Sources:** collection targets become sources. Promote a saved candidate or search your saved-profile library to add one. Promotion uses saved data, suggests collection, and never silently starts it. Demote sources whenever you like.
- **Source visibility:** each mission defaults to excluding active sources from candidates. The Sources panel's checkbox can change this without losing decisions.
- **Review:** choose **Not the person**, **Probably not**, or **Possible match**. Reviewed profiles leave the queue. Use `1`, `2`, `3`, Undo, or `Ctrl/⌘ Z`. Ranking runs behind the scenes without point displays or explanations. The visible card stays stable until you act.
- **Candidates:** search, filter by outcome, change a decision, or choose Unreviewed to clear it. Lists are paginated.
- **Saved collections:** lookups can offer dated saved results without requiring a new request. Choose reuse, resume an incomplete collection, or collect again.
- **Settings:** change the minimum delay between requests (five seconds by default) and export/restore a versioned JSON backup. Restore validates before atomically replacing local data. Authentication cookies are never in backups.

### How ranking works

Each candidate receives, against **this mission's active sources**:

- +1 for each known relationship where the candidate follows a source.
- +1 where a source follows the candidate (a mutual follow therefore contributes +2).
- +1 per distinct collected post owned by a source on which the candidate commented, including replies.

Repeated collection and repeated comments on the same post do not multiply points. Self-interactions and profile follower/following totals are ignored. Sources can score from any globally saved data, including data originally fetched for another mission. Decisions remain separate between missions.

Connections are historical observations. The extension does not continuously track unfollows or assume that missing profiles mean a connection was removed.

## Storage, permissions, and privacy

React and TypeScript provide the UI. Dexie manages IndexedDB with indexed profiles, graph facts, mission membership, scores, and resumable collection checkpoints. Page results and checkpoints are committed in one transaction.

- **unlimitedStorage:** removes Chrome's normal extension-origin storage quota and eviction restrictions, as described in [Chrome's storage documentation](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies). There is no application 5/10/50 MB cap; available disk space and browser/device resources still apply.
- **cookies:** reads Instagram's CSRF cookie for authenticated browser requests. It is used in memory and never stored in the app database or logged.
- **Instagram host permissions:** allow requests to Instagram using the current session. Collection does not require or create an app account.

Requests go directly to Instagram. Profile photos load from the URLs Instagram supplies, so viewing them contacts the image host. No app-owned telemetry or cloud service exists. Avatar URLs can expire: use the profile/photo refresh control, or open the Instagram link. Offline review still works with photo placeholders.

## Collection limitations

Instagram's browser APIs are **undocumented and can change**. The adapter is isolated in `src/instagram.ts` so request paths/normalizers can be updated independently of the database and UI.

- Only content accessible to the current Instagram session can be fetched. Private/restricted accounts, disabled or hidden comments, and unavailable reels can produce partial results.
- Completed means requested pagination finished without detected restrictions or reported-count shortfalls; it cannot prove Instagram exposed every account/comment. Deleted accounts and changing counts can cause shortfalls.
- Login challenges stop collection and require you to finish verification on Instagram. Rate limits produce a cooldown with a resume time. Transient network/server failures have bounded retries. Every request, including retries and replies, observes the delay.
- Repeated/missing cursors stop traversal instead of looping forever. Previously saved pages remain available.
- Comment checkpoints preserve both cursor directions and queued branches. Reply counts and unavailable authors can mark a collection partial. Compatible alternate endpoints observe the same pacing; challenges, access denials and cooldowns stop collection.
- Cooldowns apply to all Instagram requests, including new lookups, and survive reloads and backup restoration. An unavailable feed/reels endpoint does not discard already collected posts; their commenters can still be collected with coverage marked partial.
- Only one tab can collect at a time, enforced with a browser lock. Background timers may run later than the configured minimum delay.

## Development and checks

```sh
npm run watch          # rebuild JS/CSS as source changes
npm test               # domain, adapters, checkpoints, backup and failure tests
npm run test:browser    # extension workflow and >50 MB real IndexedDB test
```

After a watch rebuild, reload the extension in `chrome://extensions` and refresh the app tab. If you change files in `public`, rerun `npm run build` (watch monitors source bundles).

The browser suite uses Playwright in a disposable Chromium profile with synthetic Instagram responses and a synthetic cookie. It never reads your personal Chrome profile or contacts Instagram. Install its test browser once if needed:

```sh
npx playwright install chromium
```

It verifies real extension-origin IndexedDB beyond 50 MB, screenshots desktop/mobile views, and writes its report to `.test-artifacts/`. Synthetic data and verification hooks are not shipped in the production build. The browser suite does **not** demonstrate that Instagram's live endpoints currently work. A manual live smoke test should use an accessible small account and post, confirming pagination, replies, login/cooldown behavior and the collection's final coverage status.

Delivery checks and the live verification limitation are recorded in [docs/VALIDATION.md](docs/VALIDATION.md).

The comparison with the installed InExporter collector and resulting improvements are recorded in [docs/COLLECTION_COMPARISON.md](docs/COLLECTION_COMPARISON.md).

## Repository

The repository uses npm and includes its lockfile. Generated builds, dependencies, browser test profiles, artifacts, and backup files are ignored. The extension has no runtime dependencies on other installed extensions. Nothing is published or pushed by its scripts.
