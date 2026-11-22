# Security

## Model

Web pages are untrusted. The browser keeps them away from your files, from the app's own code and from each other where possible.

| Area | Rule | Where |
|---|---|---|
| Process isolation | Every view uses `sandbox`, `contextIsolation`, no `nodeIntegration`, `webSecurity`, no `<webview>`. `app.enableSandbox()` is set globally. | `src/main/sandbox/web-preferences.js`, `src/main/app.js` |
| No bridge for pages | Tab views have no preload script. Only the browser chrome gets the small `browserApi` bridge. | `src/preload/preload.js` |
| Sessions | Regular tabs share one saved profile. Each private tab has its own in-memory session, cleared on close. The browser chrome has its own session. | `src/main/sandbox/session-manager.js` |
| Navigation | Only `http:` and `https:` can be opened. `file:`, `javascript:`, `data:` and others are blocked from the address bar, links, redirects and pop-ups. | `src/main/security/navigation.js` |
| Permissions | Pages get only `fullscreen` and clipboard-write. Camera, microphone, location, notifications and devices are denied. | `src/main/security/permissions.js` |
| Certificates | Invalid HTTPS certificates show a warning page with no way to continue. | `src/main/tabs.js`, `src/renderer/warning.html` |
| Downloads | Executable and script file types are refused. Other files need an explicit Save dialog. | `src/main/security/downloads.js` |
| IPC | Every handler checks the sender is the browser chrome (main frame, app URL) and validates the arguments. | `src/main/security/ipc-validate.js` |
| Content-Security-Policy | The browser UI and internal pages use strict CSPs with no inline scripts. | `src/renderer/*.html` |
| User agent | The Electron and app identifiers are removed from the user agent. | `src/main/app.js` |

## Recording

- Recording starts only after a **native** consent dialog with a "I have permission to record this content" checkbox. Web pages cannot show, fake or skip it.
- The consent allows exactly one capture and expires after 15 seconds. The capture handler refuses any request that does not come from the browser chrome.
- A REC indicator is always visible while recording, including in full screen. It is part of the browser bars, so it is not in the recording itself.
- Video and audio come only from the tab that is active when recording starts, never from other windows, other apps or the microphone.
- Recordings are saved only to a local folder. Nothing is uploaded.

## Data

- Settings and bookmarks are stored as JSON in the user's profile folder. No history is stored. Private tabs cannot be bookmarked.
- No analytics or telemetry.

## Known limits

- The sandbox isolates pages from your files and from the app. It does not protect against a bug in Chromium itself, so keep Electron updated.
- The recording stays on the tab that was active when it started; switching to another tab does not change what is recorded.
- The pointer is hidden with a page style, so a native video control inside a page may still show it.
- Favicons are fetched by the browser chrome session (HTTPS only).

## Release checklist

- [ ] `npm test` and `npm run smoke` pass
- [ ] `npm run audit:prod` shows no known vulnerabilities
- [ ] Electron is on the latest stable version
- [ ] Installer is code-signed
- [ ] New dependencies reviewed

## Reporting a problem

Open an issue on the repository, or contact the maintainer directly for anything sensitive.
