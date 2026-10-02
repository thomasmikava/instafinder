# Development and collection reference

For a short introduction and everyday use, see the [README](../README.md).

For Chrome Web Store submission, see [PUBLISHING.md](PUBLISHING.md).

A local Chrome extension for gathering Instagram accounts and reviewing them one at a time. Create missions, collect from sources, and sort candidates using actual observed connections. There are no app accounts, servers, subscriptions, CSV imports, or artificial collection/storage caps.

The short product specification is in [PRD.md](PRD.md).

## Install and run

With Node.js and npm installed:

```sh
npm install
npm run build
```

1. Open `chrome://extensions` in Chrome and enable **Developer mode**.
2. Click **Load unpacked** and select this project's `dist` folder.
3. Click the InstaFinder toolbar button and choose **Open InstaFinder** (pin it if helpful).
4. Sign in to Instagram normally in the **same Chrome profile**.
5. Create a mission, then visit an Instagram profile or post. Open the toolbar menu and choose **Followers**, **Following**, **Commenters**, or **Likers**.

There is no server to start, database to install, environment file to configure, or Node version pin/check. Node and npm are build/development tools; the built app runs inside Chrome.

The toolbar menu collects through **the Instagram tab you are viewing**. With one mission it selects that mission automatically without showing a selector. With several missions, choose one before choosing what to collect. On a post/reel, only Commenters and Likers are offered. Both `/p/CODE/` and `/username/p/CODE/` links are supported, as are the corresponding reel links. Collection adds the profile (or post owner) as a source once its identity is verified. Starting from the popup connects to the current page without reloading. It installs the collector on already-open tabs if needed. An already-open list is closed and reopened through its normal controls so the first page is captured. Other Instagram tabs are untouched.

Keep each **collecting Instagram tab open**. Start a collection from the toolbar on each tab to run them in parallel, for different sources or the same source/action. Each tab has its own progress, Automatic toggle, Pause and Resume. Shared profiles and connections are deduplicated; runs keep separate history and checkpoints, and mission decisions remain independent. A tab can run one collector, and a particular history run can be active in only one tab.

Collection runs in the extension background after the popup closes, and the main InstaFinder tab can be closed, reopened, or used for review. Reloading, closing, or discarding one collecting Instagram tab pauses only its job. Reopen the toolbar menu on that tab and choose **Resume**, or resume from **Collection history**; its buttons operate on that entry while other page jobs keep running. Resuming a closed tab from history opens a new tab. A browser/extension restart pauses all page jobs and requires explicit resume.

The bottom-right Instagram overlay shows progress, **Pause**, **Automatic**, and **Finish with saved results**. Automatic mode opens the selected list, scrolls, and expands replies every 1.5 seconds by default, with larger scrolling steps. With Automatic on, no clicks or scrolling are needed. With it off, follow the overlay’s instructions: for example, open **Followers** on the selected profile and scroll **inside that list**. Opening Following during a Followers collection (or vice versa) produces a warning and that list is ignored. To collect likers manually, open the post’s likes count and scroll inside the people list. Automatic mode also recognizes a bare count beside the heart in the reel action bar; it clicks the number, not the heart or comment count. Finish saves incomplete coverage as partial. Unsupported controls switch to manual capture.

**Resume** on a paused Instagram overlay continues in the same document and open list, keeping saved pagination coverage and review decisions. It never reloads the page or replays requests. An automatic resume nudges a stalled list upward before continuing down, with the configured pacing. If a likes list has saved zero profiles, Resume closes and reopens that list through Instagram’s controls to capture its first page. If the Instagram tab was closed/reloaded, or you resume through Collection history/the popup, the unfinished scope is reopened from the beginning and saved pages are deduplicated. It does not replay API requests or saved cursors. Capture stops when the job ends; the Instagram tab stays open. The overlay shows **Collection complete** with the number of profiles saved, and stays visible until dismissed or you navigate away. Partial results, pauses and restrictions show their own outcome and reason. Unfinished collections show **Dismiss** and **Resume**; Resume stays disabled during a cooldown. Finished traversals show **Open InstaFinder** to return to the mission.

Single-post collection ignores unrelated profile feed/reel previews; unavailable items there do not mark a complete liker list partial. Warnings identify unavailable liker profiles, follow-list profiles, or posts within the requested scope.

Liker responses can arrive before Instagram reveals the post owner. The observer briefly retains normalized profiles and pagination in memory until it verifies the post and owner; it saves no raw responses or ranking tokens. If the owner remains unavailable, collection pauses with a specific message rather than reporting an empty completed list.

For commenters, automatic mode scrolls the comments pane beside the post or inside its dialog, clicks **View all / Load more comments**, and expands replies. It never falls back to scrolling the whole post page to paginate comments. If the pane or controls cannot be identified, capture stays active in manual mode: open all comments and expand replies yourself. A short page preview can save authors, but cannot establish complete coverage when the reported count is larger or unknown. Native comments and replies arriving before post details are held in memory until the post and owner are verified.

The main app’s **Add source** dialog uses **direct requests**. It supports followers, following, both lists and commenters; likers currently use the toolbar’s page collection only. Direct collection runs alone: pause page jobs before using it, or pause direct collection before starting page jobs. Existing runs resume through their original method. Saved completed results can be reused across methods without making a request. Direct and page cooldowns are independent; neither method silently switches to the other. A native 429 stops all active page jobs with a shared retry time, including manual jobs; early resume is blocked. Automatic pacing is per tab, so more collecting tabs produce more combined activity.

The unpacked extension stores data under its extension ID in the Chrome profile. Keep the project/dist location stable. Reload or update the extension in place; **removing** it deletes its data. Export a backup before removing it or moving to another installation.

## Your workflow

- **Missions:** create a named search. The three-dot menu offers **Edit mission name** and **Add Candidate Manually**. The first visit shows four short cards explaining the workflow. Reopen them anytime with **Settings & backups → Show walkthrough**.
- **Collection:** choose Followers, Following, Commenters, or Likers in the toolbar menu while viewing Instagram. Use the main app’s **Add source** dialog for direct collection. Use **Add Candidate Manually** in the mission menu for one account directly. Profile commenter/liker collection scans all accessible feed posts and reels; commenter collection includes replies. A post/reel URL scans only that item.
- **Delete mission:** candidates used only in that mission are deleted along with their saved relationships. Candidates or sources used by another mission stay by default. The unchecked option also deletes this mission’s candidates from other missions, including their decisions and source memberships. Excluded source-only profiles and unrelated saved profiles stay. Affected saved collections become partial and require collecting again; deleted profiles cannot return through cached results. Pause an active collection before deletion.
- **Sources:** collection targets become sources. Promote a saved candidate or search your saved-profile library to add one. Promotion uses saved data, suggests collection, and never silently starts it. Demote sources whenever you like.
- **Source visibility:** each mission defaults to excluding active sources from candidates. The Sources panel's checkbox can change this without losing decisions.
- **Review:** choose **Not the person**, **Probably not**, or **Possible match**. Reviewed profiles leave the queue. Use `1`, `2`, `3`, Undo, or `Ctrl/⌘ Z`. A subtle point count shows known connections to mission sources; its question-mark button explains the calculation. The visible card stays stable until you act.
- **Candidates:** search, filter by outcome, change a decision, or choose Unreviewed to clear it. Lists are paginated.
- **Saved collections:** lookups can offer dated saved results without requiring a new request. Choose reuse, resume an incomplete collection, or collect again.
- **Settings:** set separate delays for page actions (1.5 seconds by default) and direct requests (five seconds by default). Page mode paces automatic UI actions; Instagram may make several native requests per action. Manual actions are not delayed. Direct mode paces each request. Export/restore a version-three JSON backup; versions one and two can still be imported. Restore validates before atomically replacing local data. Authentication cookies are never in backups.

### How ranking works

The active Review card shows a small point count, and Candidates includes a Points column. Click the question mark beside either to see how points are calculated.

Each candidate receives, against **this mission's active sources**:

- +1 for each known relationship where the candidate follows a source.
- +1 where a source follows the candidate (a mutual follow therefore contributes +2).
- +1 per distinct collected post owned by a source on which the candidate commented, including replies.
- +1 per distinct collected post owned by a source which the candidate liked. A like and a comment on the same post each contribute once.

Repeated collection, repeated comments and duplicate liker observations do not multiply points. Self-interactions and profile follower/following totals are ignored. Sources can score from any globally saved data, including data originally fetched for another mission. Decisions remain separate between missions.

Connections are historical observations. The extension does not continuously track unfollows or assume that missing profiles mean a connection was removed.

## Storage, permissions, and privacy

React and TypeScript provide the UI. Dexie manages IndexedDB with indexed profiles, graph facts, mission membership, scores, and resumable collection checkpoints. Page results and checkpoints are committed in one transaction.

- **unlimitedStorage:** removes Chrome's normal extension-origin storage quota and eviction restrictions, as described in [Chrome's storage documentation](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies). There is no application 5/10/50 MB cap; available disk space and browser/device resources still apply.
- **cookies:** reads Instagram's CSRF cookie for authenticated browser requests. It is used in memory and never stored in the app database or logged.
- **Instagram photo CDN permissions:** allow credential-free image fetching from `*.cdninstagram.com` and `*.fbcdn.net`, using [Chrome’s permitted extension requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests).
- **Instagram host permissions:** allow direct requests and document-start content scripts on Instagram. Page mode passively clones relevant fetch responses and reads XHR results, then sends only normalized collection fields to InstaFinder. Native requests, headers, and response bodies used by Instagram are unchanged.
- **scripting:** attaches the bundled observer/controller to an authorized Instagram tab without requiring a reload, using [Chrome’s scripting API](https://developer.chrome.com/docs/extensions/reference/api/scripting). No scripts are injected into unrelated sites.
- **storage:** uses in-memory `chrome.storage.session` for each collecting tab/job binding. Collected data remains in IndexedDB. Temporary tab IDs/bindings are not backed up. A short-lived URL fragment marks authorized collection navigation so immediate startup responses can be buffered in memory until ownership is verified; it is removed during bootstrap.

Content scripts are dormant outside an explicitly started collection in an authorized collecting tab. No debugger, DevTools, or webRequest permission is requested. Raw network bodies, cookies, headers, and ranking tokens are not persisted or exported.

Page mode uses Instagram’s own page requests; direct mode sends authenticated requests to Instagram. Profile photos load from the URLs Instagram supplies, so viewing them contacts the image host. Instagram CDN photos are fetched without cookies or referrers and displayed through temporary local blob URLs, allowing them to render when embedding the CDN URL is blocked. Photo bytes are not persisted or included in backups. No app-owned telemetry or cloud service exists. Avatar URLs can expire: use the profile/photo refresh control, or open the Instagram link. Offline review still works with photo placeholders.

## Collection limitations

Instagram's browser APIs are **undocumented and can change**. Direct adapters are isolated in `src/instagram.ts`; native response adapters and controls are in `src/page-adapters.ts` and `src/page-driver.ts`. Supported REST and structural GraphQL connections can be updated independently of the database and UI. Native page layouts, languages, response formats, and requests performed outside page fetch/XHR may require adapter updates. Unsupported layouts can require manual capture; unsupported pagination cannot be marked complete.

- Button-based profile counters and automatic close/reply controls currently recognize English labels. Other languages or changed layouts may need manual capture or a controller update.
- Only content accessible to the current Instagram session can be fetched. Private/restricted accounts, disabled or hidden comments, and unavailable reels can produce partial results.
- Completed means requested pagination finished without detected restrictions or reported-count shortfalls; it cannot prove Instagram exposed every account/comment. Deleted accounts and changing counts can cause shortfalls. Likes without verified terminal pagination or a matching complete response count remain incomplete.
- Login challenges stop collection and require you to finish verification on Instagram. Rate limits produce a cooldown with a resume time. Transient network/server failures have bounded retries. Direct mode delays every request, including retries and replies. Page mode delays automatic UI actions and leaves Instagram’s internal request scheduling unchanged.
- Repeated/missing cursors stop traversal instead of looping forever. Previously saved pages remain available.
- Comment checkpoints preserve both cursor directions and queued branches. Reply counts and unavailable authors can mark a collection partial. Compatible alternate endpoints observe the same pacing; challenges, access denials and cooldowns stop collection.
- Cooldowns apply within their collection method, including direct lookups, and survive reloads and backup restoration. A direct cooldown does not block page collection; a native page 429 stops page mode. An unavailable feed/reels endpoint does not discard already collected posts; their commenters can still be collected with coverage marked partial.
- Page collections can run in parallel, one job per Instagram tab. Direct collection runs alone. Background timers may run later than the configured minimum delay.

For page mode, inspect Network in the **collecting Instagram tab**. For direct mode, inspect Network in the **InstaFinder app tab**. A saved cooldown is checked before sending a request, so a blocked retry produces no new Network entry. The lookup dialog shows the retry time; the Console logs whether a cooldown came from a fresh response or saved state, with status/retry metadata only. Ensure Info messages are enabled. Cooldowns also survive reload and restore, and a lookup can be rate-limited before any collection-history entry is created.

In **Collection history**, older unfinished entries show an **×** when a newer completed collection covers the same source and action (and the same post for post collections). Click it to clear that history row. Saved profiles, connections, decisions and collection data remain available; the cleared row stays hidden after reopening or restoring a backup.

## Development and checks

```sh
npm run watch          # rebuild JS/CSS as source changes
npm test               # domain, adapters, checkpoints, backup and failure tests
npm run test:browser    # direct workflow and >50 MB real IndexedDB test
npm run test:page-browser # native-page capture, controls, replies and resume
npm run test:history-browser # clear superseded history without removing data
npm run test:parallel-browser # concurrent tabs, per-job controls and numeric likes
npm run test:likers-browser # supplied liker format, delayed post identity and empty-list resume
npm run test:comments-browser # inline/modal panes, load controls, previews and paginated replies
```

After a watch rebuild, reload the extension in `chrome://extensions` and refresh the app tab. If you change files in `public`, rerun `npm run build` (watch monitors source bundles).

The browser suites use Playwright in a disposable Chromium profile with synthetic Instagram responses and a synthetic cookie. It never reads your personal Chrome profile or contacts Instagram. Install its test browser once if needed:

```sh
npx playwright install chromium
```

It verifies real extension-origin IndexedDB beyond 50 MB, screenshots desktop/mobile views, and writes its report to `.test-artifacts/`. Synthetic data and verification hooks are not shipped in the production build. The browser suite does **not** demonstrate that Instagram's live endpoints currently work. A manual live smoke test should use an accessible small account and post, confirming followers, following, comments/replies, likers, pagination, login/cooldown behavior and the collection's final coverage status.

Delivery checks and the live verification limitation are recorded in [VALIDATION.md](VALIDATION.md).

The comparison with the installed InExporter collector and resulting improvements are recorded in [COLLECTION_COMPARISON.md](COLLECTION_COMPARISON.md).

## Repository

The repository uses npm and includes its lockfile. Generated builds, dependencies, browser test profiles, artifacts, and backup files are ignored. The extension has no runtime dependencies on other installed extensions. Nothing is published or pushed by its scripts.
