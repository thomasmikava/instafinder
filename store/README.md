# Chrome Web Store listing assets

Use [Store listing.txt](<Store listing.txt>) to copy the description, category, URLs, privacy fields, permission justifications and reviewer instructions into the dashboard. [listing.json](listing.json) contains the same fields in structured form. Review the privacy declarations against the final submitted build before certifying them.

## Images to upload

| Store field                    | File                                                                                  | Size     |
| ------------------------------ | ------------------------------------------------------------------------------------- | -------- |
| Store icon                     | [icon-128.png](assets/icon-128.png)                                                   | 128×128  |
| Small promotional tile         | [promo-small-440x280.png](assets/promo-small-440x280.png)                             | 440×280  |
| Marquee, optional              | [promo-marquee-1400x560.png](assets/promo-marquee-1400x560.png)                       | 1400×560 |
| Screenshot 1: review           | [screenshot-01-review-1280x800.png](assets/screenshot-01-review-1280x800.png)         | 1280×800 |
| Screenshot 2: candidates       | [screenshot-02-candidates-1280x800.png](assets/screenshot-02-candidates-1280x800.png) | 1280×800 |
| Screenshot 3: possible matches | [screenshot-03-matches-1280x800.png](assets/screenshot-03-matches-1280x800.png)       | 1280×800 |
| Screenshot 4: sources          | [screenshot-04-sources-1280x800.png](assets/screenshot-04-sources-1280x800.png)       | 1280×800 |

The icon is identical to the icon in the uploaded `0.1.0` extension. The promotional images match the existing compass identity and green palette. Required dimensions follow [Google's image guide](https://developer.chrome.com/docs/webstore/images).

Screenshots were captured from the production extension at 85% Chrome zoom in an isolated Chromium profile. All profiles, missions, relationships and decisions are fictitious. The demonstration never uses a real login or contacts Instagram. The same UI and collection/review logic ship in the extension; no layout or features were fabricated for the screenshots. The promotional marquee incorporates the actual review card.

## Recreate the assets

With the npm dependencies and Playwright's Chromium installed:

```sh
npm run build
node scripts/store-assets.mjs
```

The script builds a temporary demo harness, seeds an isolated extension database, captures the views, and renders promotional artwork with HTML/CSS. It removes its temporary browser profile and harness when finished. [assets/validation.json](assets/validation.json) describes the capture settings. Demo data and artwork are not bundled into the extension.

## Fictional image provenance

The photograph in [demo/alex.png](demo/alex.png) was generated with the built-in image-generation tool; no real person's photograph was used. Other demonstration avatars are simple code-generated illustrations. The photo was inspected and copied unchanged into the project. The final prompt was:

> Use case: photorealistic-natural. Asset type: fictional profile photograph for sanitized screenshots of an Instagram profile review Chrome extension. Create a square 1024 by 1024 photograph of a completely fictional adult man named Alex, approximately 28, with short dark brown hair, warm brown eyes, a small relaxed smile, wearing a plain cream sweater. Friendly natural candid portrait, chest and head clearly in frame, looking at camera, softly blurred sage green outdoor courtyard background, late afternoon natural light, realistic understated skin texture. Face centered with generous margin above head and shoulders, balanced unposed composition. This person must not resemble a recognizable public figure. No text, no username, no UI, no logo, no watermark, no borders.

For submission prerequisites and the remaining storage-security check, see [PUBLISHING.md](../docs/PUBLISHING.md).
