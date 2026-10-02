# InstaFinder privacy policy

Updated October 2, 2026.

InstaFinder helps you collect Instagram profiles and review them to find a person. It works inside Chrome and has no developer-operated server, analytics, advertising or cloud sync.

## What the extension handles

When you start a collection, InstaFinder processes profiles and activity accessible through your Instagram session: account IDs, usernames, display names, profile and photo URLs, follow relationships, post IDs and owners, and which accounts commented on or liked a post. It saves comment/reply IDs and pagination information to track progress; it does not save comment text or direct messages.

It also stores the mission names you enter, candidate membership, your review decisions, settings and collection history. The toolbar reads the current tab's URL to recognize an Instagram profile or post. Active collections inspect relevant Instagram page responses and operate the selected page's controls. This is limited to the collection you start; it does not record browsing history across unrelated sites.

Direct collection uses your existing Instagram login and reads Instagram's CSRF cookie for requests. Authentication cookies are used in memory and sent only to Instagram. InstaFinder does not ask for your password, save authentication cookies in its database, include them in backups or send them to the developer. Raw responses, request headers and ranking tokens are not saved in the database or backups.

## Where information goes

Collected data and decisions stay in the extension's database in your Chrome profile. Temporary tab/job bindings stay in Chrome's session storage. InstaFinder does not use Chrome's storage sync service or transmit your saved database to its developer.

Collection communicates with Instagram over HTTPS using your session. Profile photos are requested from Instagram's image hosts without cookies or referrers; photo bytes are temporarily displayed and are not included in backups. Instagram and its image hosts receive these requests and handle them under their own policies. Opening a profile link takes you to Instagram normally.

Choosing **Export backup** writes your saved data to a file on your device. InstaFinder does not upload that file. Anyone you share it with can read the included profiles, missions and decisions.

## Use, retention and control

Data is used only for the collection, ranking, review, resume and backup features you choose. InstaFinder does not sell data, use it for advertising, transfer it to data brokers or provide the developer with access to your saved profiles or decisions. InstaFinder's use of user data complies with the [Chrome Web Store User Data Policy's Limited Use restrictions](https://developer.chrome.com/docs/webstore/program-policies/limited-use).

Saved records remain until you delete them or remove the extension. Deleting a mission also removes candidates unused by other missions by default; its optional checkbox can remove shared candidates too. Shared profiles and other global collection facts can remain after mission deletion. Removing InstaFinder removes its extension data from that Chrome profile; backup files you downloaded remain until you delete those files yourself. Backups can be restored into another installation.

Storage uses Chrome's local extension database. InstaFinder does not apply its own encryption to the database or backup files. Protect your Chrome profile and backup files accordingly.

## Contact and changes

For questions or problems, contact the maintainer through the [InstaFinder repository](https://github.com/thomasmikava/instafinder/issues). GitHub issues are public: do not attach private backups, cookies or other sensitive information.

This policy will be updated when the extension's data practices change. The current version is linked from the repository's README and should be linked from its Chrome Web Store listing.
