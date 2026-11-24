# Security

## Model

Web pages are untrusted. The browser keeps them away from your files, from the app's own code and from each other where possible.

| Area | Rule | Where |
|---|---|---|
| Process isolation | Every view uses `sandbox`, `contextIsolation`, no `nodeIntegration`, `webSecurity`, no `<webview>`. `app.enableSandbox()` is set globally. | `src/main/sandbox/web-preferences.js`, `src/main/app.js` |
| No bridge for pages | Tab views have no preload script. Only the browser's own pages (toolbar, find bar, REC indicator, and the internal History / Downloads / Recordings / Settings tab) get the small `browserApi` bridge. | `src/preload/preload.js` |
| Internal pages | The internal tab loads only the app's own files, cannot navigate or open windows, and a web address typed while it is active opens a new regular tab, so a website never runs with the bridge. | `src/main/tabs.js` |
| Sessions | Regular tabs share one saved profile. Each private tab has its own in-memory session, cleared on close. The browser's own pages have a separate session. | `src/main/sandbox/session-manager.js` |
| Navigation | Only `http:` and `https:` can be opened, plus the four `simple-browser://` pages typed in the address bar. `file:`, `javascript:`, `data:` and others are blocked from the address bar, links, redirects and pop-ups. | `src/main/security/navigation.js` |
| Permissions | Pages get only `fullscreen` and clipboard-write. Camera, microphone, location, notifications and devices are denied. | `src/main/security/permissions.js` |
| Certificates | Invalid HTTPS certificates show a warning page with no way to continue. | `src/main/tabs.js`, `src/renderer/warning.html` |
| Downloads | Executable and script file types are refused. Other files need an explicit Save dialog. "Show in folder" is the only action offered on a finished download. | `src/main/security/downloads.js`, `src/main/download-manager.js` |
| Right-click menu | Built in the main process; only `http(s)` links and images are offered, so a page cannot place an unsafe address in it. | `src/main/context-menu.js` |
| IPC | Every handler checks the sender is one of the browser's own pages (main frame, app URL), that this page is allowed that call, and validates the arguments. Each page gets only the calls it needs: the History / Downloads / Recordings / Settings tab, which shows text from websites, cannot control recording, tabs or navigation, and the toolbar cannot reach files, settings or history. The settings page can change only a fixed list of settings. | `src/main/security/ipc-validate.js`, `src/main/ipc-handlers.js`, `src/main/storage/settings.js` |
| Recordings files | Rename, open, show and delete accept only plain `.webm` / `.png` file names inside the recordings folder; deleting moves the file to the Recycle Bin. | `src/main/recording/library.js` |
| Content-Security-Policy | The browser UI and internal pages use strict CSPs with no inline scripts. Library pages build their content with `textContent`, never `innerHTML`, because page titles and addresses come from websites. | `src/renderer/*.html`, `src/renderer/library.js` |
| User agent | The Electron and app identifiers are removed from the user agent. | `src/main/app.js` |
| Ads and trackers | Requests on the EasyList and EasyPrivacy lists are cancelled in every web session (regular and private) before they leave the browser; the page itself is never blocked. Only network blocking is used, so nothing is injected into pages. Uses `@ghostery/adblocker` (MPL-2.0), pinned to an exact version. | `src/main/blocker.js`, `src/main/app.js` |
| Updates | Installed copies use `electron-updater` (MIT, pinned) against this repository's GitHub Releases: the installer is downloaded over HTTPS and checked against the SHA-512 in the release's `latest.yml` before it runs. The builds are not code-signed, so that hash and GitHub's HTTPS are what the update relies on; signing would add a publisher check. Portable copies only read the latest release's version from the GitHub API and link to its page. | `src/main/updates.js`, `package.json` (`build.publish`) |
| Tab icons | Each tab's icon is fetched by the main process through that tab's own session (a private tab's stays in its private session) and handed to the toolbar as a `data:` URL, only if it is a real image under 256 KB. The toolbar itself has no network access (`img-src data:`). | `src/main/favicons.js`, `src/main/tabs.js` |
| Packaged app | Electron fuses are set at build time: the app cannot run as plain Node.js (`ELECTRON_RUN_AS_NODE`), ignores `NODE_OPTIONS` and `--inspect`, loads code only from its `app.asar` and checks that archive's integrity, and encrypts cookies on disk. | `package.json` (`build.electronFuses`) |

## Recording

- Recording starts only after a **native** consent dialog with a "I have permission to record this content" checkbox. Web pages cannot show, fake or skip it.
- The consent allows one capture at a time and a capture must start within 15 seconds. The capture handler refuses any request that does not come from the browser's main interface. While a recording the user agreed to is running, the app starts the next capture itself when the recording follows a tab switch or a capture has to be retried.
- A REC indicator with Pause and Stop is always visible while recording, including in full screen. It is part of the browser bars, so it is not in the recording itself.
- Video and audio come only from the tab being recorded, never from other windows, other apps or the microphone.
- Recordings are saved only to a local folder. Nothing is uploaded.
- Screenshots are saved to the same folder without a consent prompt, like the browser's own screenshot or the Windows Snipping Tool: they are a single image the user takes on purpose.

## Data

- Settings, bookmarks and (only if turned on) history are stored as JSON in the user's profile folder. History is off by default, never records private tabs, is capped at 5,000 entries and can be cleared. Private tabs cannot be bookmarked.
- The list of open tabs is saved only if "Reopen my tabs" is turned on; private and internal tabs are never saved, and turning the option off deletes the saved list.
- Zoom levels are saved per site for regular tabs only.
- No analytics or telemetry.
- Packaged copies ask GitHub for the latest release about every six hours (installed copies through `electron-updater`, portable ones through the GitHub API, with a generic `Simple-Browser-Update-Check` user agent). Turning off "Check for new versions" in Settings stops these requests; a check you start yourself still runs.
- With ad and tracker blocking on, the browser downloads the two filter lists from `easylist.to` at most every few days and keeps them, compiled, in the profile folder (`blocker\`). Turning blocking off stops these downloads. Sites where blocking was turned off are kept in the settings file.

## Known limits

- The sandbox isolates pages from your files and from the app. It does not protect against a bug in Chromium itself, so keep Electron updated.
- When a recording follows you to another tab, each tab becomes its own file; switching tabs very quickly can leave short or empty parts (empty parts are discarded).
- A minimized window cannot be recorded, because Windows stops painting it.
- The pointer is hidden with a page style, so a native video control inside a page may still show it.
- The app's own pages are loaded from `file://`, so Electron's extra `file://` privileges stay on (turning that fuse off stops these pages loading). Moving them to a custom `app://` protocol would allow it to be turned off.
- The full-screen pointer is hidden by a style added to the page, which the page itself can remove; it only affects that page's own pointer.

## Release checklist

- [ ] `npm test` and `npm run smoke` pass
- [ ] `npm run audit:prod` shows no known vulnerabilities
- [ ] Electron is on the latest stable version
- [ ] Installer is code-signed
- [ ] New dependencies reviewed

## Reporting a problem

Open an issue on the repository, or contact the maintainer directly for anything sensitive.
