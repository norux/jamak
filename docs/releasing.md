# Chrome Web Store release

After one-time store/OAuth setup, run:

```sh
npm run release:chrome
```

This refreshes an OAuth access token, fetches the item's published version through API V2 `fetchStatus`, selects its next patch version, runs `npm run verify` (including the production build), creates `.ralph/releases/jamak-<manifest-version>.zip`, uploads to the existing Chrome Web Store item, waits for upload processing, and submits for review. Approval publishes automatically with the item's existing visibility/distribution settings. A successful command means submission was accepted, not that review passed or the extension is already public. The command does not change store descriptions, images, privacy declarations, permission justifications or visibility.

Requirements: Node.js 22.12+, installed npm dependencies and Playwright Chromium as described in [Testing](testing.md), and the `zip` utility on PATH. macOS includes `zip`; Linux typically provides it through its package manager.

## One-time setup

1. [Register a Chrome Web Store developer account](https://developer.chrome.com/docs/webstore/register), pay the registration fee, verify your contact email and enable Google Account two-step verification.
2. Build a first package with `npm run build` and ZIP the contents of `apps/chrome/dist` with `manifest.json` at the archive root. The release command requires an already published remote version, so the first publication is done through the dashboard. In the [developer dashboard](https://chrome.google.com/webstore/devconsole), create a new item by uploading that ZIP. Complete the Store listing, Privacy, Distribution and test instructions. Provide the privacy-policy URL, actual screenshots and promotional image. Save the extension/item ID; the publisher ID is under Publisher > Settings. API V2 uploads packages to an existing item; it does not create the initial listing.
3. Follow Google's [API setup guide](https://developer.chrome.com/docs/webstore/using-api): enable **Chrome Web Store API** in a Google Cloud project, configure OAuth consent, create a **Web application** OAuth client and allow `https://developers.google.com/oauthplayground` as a redirect URI.
4. In [OAuth Playground](https://developers.google.com/oauthplayground), enable **Use your own OAuth credentials**, enter the client ID/secret, authorize `https://www.googleapis.com/auth/chromewebstore` with the Google account that owns the store item, then exchange the authorization code for tokens. Save the refresh token, not the short-lived access token. Google OAuth apps in External/Testing mode can issue refresh tokens that expire after seven days; configure the OAuth app for ongoing use or renew the token when needed. See Google's [refresh-token expiration guidance](https://developers.google.com/identity/protocols/oauth2#expiration).
5. Copy the template and fill all five values:

   ```sh
   cp .env.chrome-store.example .env.chrome-store
   ```

   ```dotenv
   CWS_PUBLISHER_ID=your-publisher-id
   CWS_EXTENSION_ID=your-extension-id
   CWS_CLIENT_ID=your-oauth-client-id
   CWS_CLIENT_SECRET=your-oauth-client-secret
   CWS_REFRESH_TOKEN=your-refresh-token
   ```

`.env.chrome-store` and release ZIPs are ignored by Git and are outside the packaged `apps/chrome/dist` directory. Keep credentials private; never place them in extension source or public build assets. Environment variables may also supply these values for CI; existing environment values take precedence over the local file.

## Orca workspaces

Keep the private `.env.chrome-store` in the project's main checkout. In Orca's project settings, add `.env.chrome-store` to **Worktree shared paths**. Orca transfers this file when creating new workspaces: macOS uses an APFS clone-copy when available, and otherwise Orca uses a symlink to the main checkout. This is a local Orca setting, not a Git-tracked credential or configuration.

Existing workspaces are not updated by adding the setting. Copies keep the values from creation time; after rotating credentials, refresh those copies from the main checkout. Keep the source and copies readable only by their owner (`chmod 600 .env.chrome-store`). Never copy the file into `apps/chrome/dist`.

## Each release

The release command reads `publishedItemRevisionStatus.distributionChannels[].crxVersion` from [API V2 `fetchStatus`](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/fetchStatus), selects the highest published version numerically, and writes its next version to `apps/chrome/public/manifest.json` before verification/build. The local manifest and unsubmitted/rejected drafts are not version baselines. It accepts one optional positional argument and defaults to `patch`:

```sh
npm run release:chrome             # patch: 1.2.3 → 1.2.4
npm run release:chrome -- patch    # same explicit choice
npm run release:chrome -- minor    # 1.2.3 → 1.3.0
npm run release:chrome -- major    # 1.2.3 → 2.0.0
```

Only the extension manifest version changes; npm package/lockfile versions, Git commits and tags are untouched. The published version must use three numeric `major.minor.patch` components within [Chrome's version limits](https://developer.chrome.com/docs/extensions/reference/manifest/version). Invalid arguments, missing credentials, authentication/status errors, missing/invalid published versions and pending/staged submissions stop before changing the manifest. There is no local-version fallback. A new item must be published once through the dashboard before this command can update it.

Dry runs and every failed release restore the source manifest's original contents, including verification, packaging, upload and review-submission errors. Only an accepted review submission keeps the selected version. Retrying after a failed release selects the same next version as long as the published remote version is unchanged. Commit the resulting manifest version with the release changes. Authentication and the read-only status lookup precede verification; verification must pass before upload or submission. An upload failure or missing/unknown upload state stops submission; an asynchronous upload is polled every five seconds for up to five minutes. HTTP requests have a two-minute timeout. No upload or submission is retried automatically. If a network error/timeout leaves the outcome uncertain, inspect the developer dashboard before rerunning; an active pending/staged submission blocks another upload.

When changing store visibility, publish with the new visibility through the dashboard once before resuming API releases, as required by Google's [API guide](https://developer.chrome.com/docs/webstore/using-api).

To read the remote version and verify/package without uploading or submitting:

```sh
npm run release:chrome -- --dry-run
npm run release:chrome -- minor --dry-run
```

This requires the same credentials and internet access as a real release. It refreshes OAuth, reads the published remote version, runs verification and produces the actual ZIP for its next selected version, then restores the source manifest even on failure. The bump argument and `--dry-run` may appear in either order. A real release uses the same version as the preview if the published remote version is still unchanged. Dry run does not upload, submit, change store metadata or verify server-side package acceptance/review eligibility. `verify` does not prove real audio/model availability; test a fresh ordinary Chrome profile before release as described in [Testing](testing.md).

## Release-script verification

```sh
npm run test:release:chrome
```

These subprocess tests use a stubbed npm verification command and mocked API responses, with all real network requests disabled. They exercise published-remote version selection despite a higher local version, default/explicit patch/minor/major increments, numeric channel comparison, ignoring rejected revisions, unavailable versions/pending submissions stopping without fallback, dry-run restoration, rollback after upload/submission failures, authentication/status failures, real ZIP creation, upload-before-submission, async upload processing and credential redaction. They do not upload or publish an extension. Use the real dry run above to verify the complete read-only preflight and local pipeline.

## Review submission fails with HTTP 400

`Review submission: HTTP 400: Your submission does not meet the requirements...` means the package upload completed but the store refused the review submission. Open the item's **Why can't I submit? / 제출할 수 없는 이유** button to see the concrete missing requirements. Resolve them in the dashboard before retrying submission; another package upload does not fill out store declarations.

On 2026-10-12, the Jamak dashboard reported a missing justification for the new `notifications` permission. The Privacy tab's `notifications` justification field was empty. A description matching the implementation is: “Show a local desktop notification when the user-selected Advanced recognition and translation models finish preparing, so the user knows they are ready even after closing the Advanced window. Notifications contain no audio or transcript text.” Enter it under **Privacy → Permission justification → notifications**, then save the draft. The already-uploaded `0.3.0` draft can be submitted from the dashboard after its remaining requirements are satisfied; the published version observed through API V2 was still `0.1.0`. This investigation did not edit store declarations or submit the draft.
