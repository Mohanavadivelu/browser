# Simple Browser

A simple Windows browser built with Electron. Each tab is sandboxed, it has a full-screen mode, and it can record the browser window after you give consent.

## Features

- Tabs, address bar (URL or search), back/forward/reload/home, bookmarks.
- **Private tabs**: each one has its own in-memory session that is wiped when the tab closes.
- **Full screen** (F11 or the ⛶ button): only the page is shown. Move the mouse to the top edge to bring the toolbar back. Pages can also take the whole window for their own video full screen.
- **Record** (● button or menu): captures this window to a `.webm` file in `Videos\Simple Browser` (change it from the ⋮ menu). A native consent dialog comes first, and a REC indicator stays visible while recording, including in full screen.
- Security model: see [SECURITY.md](SECURITY.md).

Only record content you own or have permission to record, and respect the privacy of other people and the terms of the websites you visit.

## Run

Requires Node.js 20 or newer on Windows.

```powershell
npm install
npm start
```

| Command | What it does |
|---|---|
| `npm start` | Launch the browser |
| `npm test` | Unit tests (security rules, recording consent) |
| `npm run smoke` | End-to-end test: launches the app against a local server and checks sandboxing, navigation blocking, tabs, full screen and a real recording |
| `npm run audit:prod` | Check production dependencies for known vulnerabilities |

## Keyboard shortcuts

| Keys | Action |
|---|---|
| F11 / Esc | Enter / leave full screen |
| Ctrl+T, Ctrl+W | New tab, close tab |
| Ctrl+Shift+N | New private tab |
| Ctrl+L | Focus the address bar |
| Ctrl+R / F5 | Reload |
| Alt+Left / Alt+Right | Back / forward |
| Ctrl+Tab, Ctrl+Shift+Tab | Next / previous tab |
| Ctrl+D | Bookmark the page |

## Project layout

```
src/
  main/            Trusted app process
    app.js           Wires everything together and registers IPC handlers
    window.js        Window, browser-chrome view and full-screen layout
    tabs.js          One sandboxed view per tab
    shortcuts.js     Keyboard shortcuts
    sandbox/         Locked-down web preferences, per-tab session manager
    security/        Navigation, permissions, certificates, downloads, IPC validation
    recording/       Consent dialog, recorder, file storage
    storage/         Settings and bookmarks (JSON in the user profile)
  preload/         The only bridge between the browser UI and the main process
  renderer/        Browser UI, new-tab page, certificate warning, REC indicator
mockup/            Original design mockup
tests/
  unit/            node:test unit tests
  smoke/           End-to-end Electron test
```

## Status

First working version. Not yet packaged as an installer; code signing and an installer (for example with electron-builder) are the next release steps.