# Delivery validation

Checked on October 1, 2026.

- `npm run build`: passes TypeScript checking and produces the unpacked Manifest V3 extension in `dist`.
- `npm test`: all 43 tests pass. Coverage includes directional/mutual follows, distinct-post comment scoring, deduplication, mission isolation, promotion/demotion, visibility, preserved decisions, ordering/filtering, metadata updates, transactional checkpoints, backup validation/restore, adapter normalization, request pacing, bounded retries, pagination/replies, restrictions, cooldowns, repeated cursors, saved-result reuse, interruption recovery, and restart/resume. Mission deletion checks cover default shared-candidate protection, forced deletion across missions, derived score repair, cache invalidation, excluded sources, backup validity, and transactional rollback. Other regression checks cover alternate endpoints, min/max cursors, queued pagination branches, missing parent authors, nested preview merges, reply shortfalls, rotating-page guards, persistent cooldowns, and aborts during authentication-cookie lookup.
- `npm run test:browser`: all 18 browser checks pass in an isolated Chromium extension installation. The workflow checks four first-visit cards and persistent dismissal, replay from Settings with the revised mission example and review-choice copy, the two-action mission menu, radio alignment, separate manual-candidate entry, both deletion options, a source-focused main action, hidden scores and ranking explanations, mission creation, collection with synthetic Instagram responses, an alternate-host fallback, preview comments, both comment cursor directions and paginated replies, decisions and undo, filters/search, promotion/visibility/demotion, cross-mission cache reuse, single-profile addition, backup/restore, pagination, stable review cards, and desktop/mobile rendering.
- Actual extension-origin IndexedDB contains 100,005 profiles during the storage check: 107,180,516 bytes reported by `navigator.storage.estimate()` (102.2 MiB), with 107,466,670 bytes of serialized profile metadata. The extension has `unlimitedStorage`; no quota error occurs. This uses real IndexedDB, not the unit-test mock.
- Larger mission candidate rendering stays at 40 rows per page. A candidate gaining a higher score while the Candidates view is open does not replace the pinned review card.
- Production entrypoints, icons, Manifest V3 permissions, absence of browser-test hooks, and absence of a Node version requirement are verified.
- `npm audit --omit=dev`: zero vulnerabilities reported.

The browser suite writes its report and screenshots to `.test-artifacts/`, then removes its disposable Chrome profile and temporary verification bundle. All Instagram responses and the CSRF cookie in that suite are synthetic; it does not access personal browser data.

## Live Instagram verification

Live smoke testing using the existing signed-in Chrome profile was blocked by the computer-use tool: `Sky Computer Use native pipe startup failed`. No live follower, following, post, or reply endpoint is claimed as verified. Instagram's undocumented browser endpoints may need adapter updates for the current session or response format.

For a manual smoke test, sign into Instagram in the same Chrome profile, load `dist` unpacked, and collect both lists from a small accessible account. Then collect commenters from a post with replies and from a profile. Check the final completion/partial status, pause/resume from history, and confirm saved results can be reused. Perform challenges on Instagram itself before resuming; do not override a cooldown.

The Git repository and npm lockfile are local. No remote or push is configured.
