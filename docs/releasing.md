# Chrome Web Store release

After one-time store/OAuth setup, run:

```sh
npm run release:chrome
```

This increases the extension manifest patch version, runs `npm run verify` (including the production build), creates `.ralph/releases/jamak-<manifest-version>.zip`, refreshes an OAuth access token, uploads to the existing Chrome Web Store item through API V2, waits for upload processing, and submits for review. Approval publishes automatically with the item's existing visibility/distribution settings. A successful command means submission was accepted, not that review passed or the extension is already public. The command does not change store descriptions, images, privacy declarations or visibility.

Requirements: Node.js 22.12+, installed npm dependencies and Playwright Chromium as described in [Testing](testing.md), and the `zip` utility on PATH. macOS includes `zip`; Linux typically provides it through its package manager.

## One-time setup

1. [Register a Chrome Web Store developer account](https://developer.chrome.com/docs/webstore/register), pay the registration fee, verify your contact email and enable Google Account two-step verification.
2. Build a first package with `npm run release:chrome -- --dry-run`. In the [developer dashboard](https://chrome.google.com/webstore/devconsole), create a new item by uploading that ZIP. Complete the Store listing, Privacy, Distribution and test instructions. Provide the privacy-policy URL, actual screenshots and promotional image. Save the extension/item ID; the publisher ID is under Publisher > Settings. API V2 uploads packages to an existing item; it does not create the initial listing.
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

The release command increases `version` in `apps/chrome/public/manifest.json` before verification/build. It accepts one optional positional argument and defaults to `patch`:

```sh
npm run release:chrome             # patch: 1.2.3 → 1.2.4
npm run release:chrome -- patch    # same explicit choice
npm run release:chrome -- minor    # 1.2.3 → 1.3.0
npm run release:chrome -- major    # 1.2.3 → 2.0.0
```

Only the extension manifest version changes; npm package/lockfile versions, Git commits and tags are untouched. The source must use three numeric `major.minor.patch` components within [Chrome's version limits](https://developer.chrome.com/docs/extensions/reference/manifest/version). Invalid arguments/versions and missing credentials stop before changing the manifest. Failed verification restores its original contents. Once verification passes, a real release keeps the increased version even if packaging, authentication, upload or submission fails. Each real rerun increases the version again; inspect the dashboard first after an uncertain store outcome. Commit the resulting manifest version with the release changes. Verification must pass before any API calls. Upload failure or missing/unknown upload state stops submission; an asynchronous upload is polled every five seconds for up to five minutes. HTTP requests have a two-minute timeout. No upload or submission is retried automatically. If a network error/timeout leaves the outcome uncertain, inspect the developer dashboard before rerunning.

When changing store visibility, publish with the new visibility through the dashboard once before resuming API releases, as required by Google's [API guide](https://developer.chrome.com/docs/webstore/using-api).

To verify/package without credentials or store requests:

```sh
npm run release:chrome -- --dry-run
npm run release:chrome -- minor --dry-run
```

This runs verification and produces the actual ZIP for the next selected version, restoring the source manifest afterward even on verification failure. The bump argument and `--dry-run` may appear in either order. The following real release from the same source version therefore uses the same version as the preview. It does not verify OAuth credentials, server-side package acceptance or review eligibility. `verify` does not prove real audio/model availability; test a fresh ordinary Chrome profile before release as described in [Testing](testing.md).

## Release-script verification

```sh
npm run test:release:chrome
```

These subprocess tests use a stubbed npm verification command and mocked HTTP responses, with all real network requests disabled. They exercise default/explicit patch, minor and major increments, dry-run previews/restoration, invalid arguments/version limits, verification rollback, retaining the version after upload failure, real ZIP creation, root manifest placement, exclusion of OS metadata, missing credentials, verification failure, OAuth refresh, local environment-file loading, upload-before-submission, asynchronous upload completion, upload/API failures and credential redaction. They do not upload or publish an extension. Use the real dry run above to verify the complete local pipeline.
