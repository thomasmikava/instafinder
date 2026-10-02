# Publish InstaFinder in the Chrome Web Store

Checked against Chrome's documentation on October 2, 2026. This guide prepares a submission; it does not mean Google has reviewed or approved InstaFinder.

## 1. Register as a publisher

Open the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole), sign in, accept the agreement and pay the one-time registration fee. Set your publisher name, verify your contact email and enable Google account [2-Step Verification](https://developer.chrome.com/docs/webstore/program-policies/two-step-verification).

Check Google's [supported registration countries](https://developer.chrome.com/docs/webstore/register#supported-countries-and-regions) before registering. Georgia is not listed in the published list checked for this guide; if that is your publisher location, confirm eligibility with Google's support before proceeding.

## 2. Prepare the extension ZIP

From the repository:

```sh
npm ci
npm test
npm run build
```

Compress the **contents** of `dist`, so `manifest.json` sits at the ZIP root. Do not upload the GitHub source ZIP or a ZIP containing an outer `dist` folder. Exclude source maps, temporary verification scripts, test data, browser profiles and backups. All runtime code is bundled; users will not need Node.js, npm or Developer mode when installing from the Store. See [Chrome's packaging instructions](https://developer.chrome.com/docs/webstore/prepare#zip-your-extension-files).

On macOS/Linux, after a clean production build, this creates the ZIP:

```sh
cd dist
zip -r ../instafinder-0.1.0.zip . -x '*.map' '*verification*' '.DS_Store' '__MACOSX/*'
```

The current manifest is version `0.1.0`, Manifest V3, with a 128px PNG icon. Each later uploaded version must have a higher manifest version. Source code remains on GitHub; the ZIP is the compiled extension.

Before submitting, test the ZIP's contents as an unpacked extension with live Instagram: followers, following, post/reel commenters with replies, likers, pause/resume and review. Automated fixtures pass, but current live layouts have not been fully verified. Export a backup before switching from the development installation to the Store installation: it normally has a different extension ID and separate data. Restore the backup through Settings.

## 3. Create the listing

In the dashboard, choose **Add new item** and upload the ZIP. Fill in the listing, privacy, distribution and test-instructions tabs. [Google's publishing flow](https://developer.chrome.com/docs/webstore/publish) describes these steps.

Suggested short description:

> Collect Instagram followers, following, commenters and likers, then review profiles to find the person you're looking for.

Suggested listing description:

> Looking for someone you met at an event, or a person connected to an Instagram account you know? InstaFinder helps you collect relevant profiles and review them one at a time.
>
> Create a named mission, open an Instagram profile or post, and choose followers, following, commenters or likers from the extension menu. The collector works through Instagram's interface, with automatic scrolling and optional manual control.
>
> Review each person's photo, name and profile. Mark them Not the person, Probably not or Possible match. Search and filter the full candidate list, change decisions and return to your saved progress. Accounts with more observed connections to your sources appear first.
>
> Your data stays in your browser. There is no InstaFinder account, subscription, developer-operated cloud service or paid collection limit. Export and restore backups from Settings.
>
> Sign in to Instagram in the same Chrome profile and keep collecting Instagram tabs open. Instagram may restrict access or request a cooldown; partial results are clearly labelled. Automatic controls currently recognize English labels. InstaFinder is independent and is not affiliated with Instagram or Meta.

Set the website to `https://github.com/thomasmikava/instafinder` and support to its Issues page. Choose **Social Networking**, or **Social Media & Networking** if that is the dashboard label. This is the recommended fit for an Instagram-specific extension in [Google's current category guide](https://developer.chrome.com/docs/webstore/best-practices#choose-your-extensions-category-well).

Prepared assets and copy are in [store/README.md](../store/README.md): the matching 128×128 icon, a **440×280 promotional image**, an optional **1400×560 marquee**, and four **1280×800 screenshots** of the real extension with fictitious profiles. Do not publish screenshots of private collections. Dimensions and required assets are in [Google's image guide](https://developer.chrome.com/docs/webstore/images).

## 4. Complete privacy practices

Use this single-purpose description:

> Help users find a person among Instagram accounts by collecting profiles connected to user-selected sources and reviewing those profiles in named missions.

Review [PRIVACY.md](PRIVACY.md) and make its URL publicly accessible. After it is pushed to a public repository, the GitHub-rendered page can be used as the policy URL; check it while signed out. A hosted HTML page is another option. Add the working URL to the designated dashboard field. [Chrome requires disclosure even for data processed only on-device](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq).

The extension handles identifiable profile information, authentication cookies in memory, selected Instagram URLs and website content/activity. Disclose these under the dashboard's matching categories, including personally identifiable information, authentication information, web history for the selected URLs, and website content. Explain that the developer receives no collected database and that authentication stays with Instagram. Do not select a blanket “handles no data” claim. Match the final declarations to the actual submitted build and the policy.

Storage security needs a check before certifying compliance: Google's [User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq#9-what-type-of-encryption-does-the-user-data-policy-require) mentions encryption at rest, while the current extension uses ordinary local IndexedDB and unencrypted JSON backups. Confirm how that requirement applies to this on-device storage with Store support, or address it in the implementation. The prepared ZIP has not been verified as meeting that requirement.

Permission justifications for the current manifest:

| Permission                          | Why InstaFinder uses it                                                                                                                   |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `cookies`                           | Read Instagram's CSRF cookie in memory for user-requested direct collection; never store or export authentication cookies.                |
| `unlimitedStorage`                  | Keep large profile collections and checkpoints in the user's local extension database without the usual quota.                            |
| `storage`                           | Keep temporary per-tab collection bindings in `storage.session`; collected profiles stay in IndexedDB.                                    |
| `scripting`                         | Attach bundled collector scripts to the Instagram tab selected by the user, including tabs already open when the extension was installed. |
| `www.instagram.com`                 | Recognize selected targets, operate native collection controls, capture scoped page responses and make direct collection requests.        |
| `i.instagram.com`                   | Support the existing direct adapter's alternate Instagram endpoint.                                                                       |
| `*.cdninstagram.com`, `*.fbcdn.net` | Fetch profile pictures from Instagram's image hosts without credentials and display them in review/candidate views.                       |

Select **No remote code**: JavaScript and dependencies are bundled in the extension. Instagram responses and photos are data, not downloaded executable code. Review the [minimum-permission and privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy); permission declarations must describe existing functionality.

## 5. Provide testing instructions and submit

Reviewer instructions:

1. Sign into Instagram normally in Chrome. InstaFinder has no separate account or credentials.
2. Click InstaFinder → Open InstaFinder. Create a mission, for example “Find Alex”.
3. Open an accessible small Instagram profile. Click the extension icon and collect Following or Followers. Keep that Instagram tab open and observe the bottom-right panel.
4. Open a post/reel with comments and likes. Collect Commenters, including replies, and Likers.
5. Open the mission's Review view, make a choice and Undo. Open Candidates, filter by outcome and change a decision. Test backup export/restore in Settings.

Choose **Public** distribution for a searchable listing, or **Unlisted** for installation by link. Both require Google's review; unlisted is not an approval shortcut. [Distribution options](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution).

Submit for review. You can disable automatic publication after approval if you want to publish manually. Google determines approval and review timing; the repository's test results do not establish Store approval.

After publication, replace the README's temporary installation paragraph with the actual Chrome Web Store install link. Continue uploading versioned ZIPs to the same item for updates.
