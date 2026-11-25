# Simple Browser

A simple Windows browser built with Electron. Each tab is sandboxed, it has a full-screen mode, and it can record a page (with its sound) after you give consent.

## Features

- Tabs, address bar (URL or search, **Google** by default), back/forward/reload/home, bookmarks.
- **Address-bar suggestions** as you type: the search or address itself, then matching bookmarks and visited pages (visited pages only while history is on). Use the arrow keys and Enter, or click.
- **Tabs**: drag to reorder, reopen a closed tab with Ctrl+Shift+T (private tabs are never kept), and a 🔊 icon on tabs playing sound that mutes the tab when clicked.
- **Private tabs**: each one has its own in-memory session that is wiped when the tab closes.
- **Ad and tracker blocking** (on by default): requests on the EasyList and EasyPrivacy lists are blocked in every tab. The 🛡 in the address bar shows how many were blocked on the page; click it to allow them on that site. Turn it off, or see the allowed sites, in Settings.
- **Right-click menu** in pages: open a link in a new tab, copy link, save/copy image, cut/copy/paste, search for the selected text, back/forward/reload.
- **Print** (Ctrl+P) and **Save page as PDF** (⋮ menu).
- **Find in page** (Ctrl+F) with match count and next/previous, and **zoom** (Ctrl +, −, 0) that is remembered per site and shown in the address bar.
- **Bookmarks** in folders (folders can hold folders): the bar shows its bookmarks with their site icons and its folders, a folder opens as a menu with its subfolders and "Open all", bookmarks that do not fit go under », and "Other bookmarks" holds the rest. Right-click a bookmark to open it in a new or private tab, edit or delete it; Ctrl+Shift+B shows or hides the bar. The Bookmarks page (Ctrl+Shift+O) has the folder tree, search across all folders, drag to reorder or to drop into a folder, ↑ ↓, edit name and address, select several to move or delete, "Open all", and import or export as the bookmarks file Chrome, Edge and Firefox use (folders kept). The star (☆, Ctrl+D) bookmarks the page into the folder you used last and opens a small popover to change its name or folder (or make a new folder), or remove it; ★ on a bookmarked page opens the same popover.
- **History** (off by default; never saved from private tabs), **Downloads** (progress, cancel, show in folder) and **Recordings** pages. Open them from the ⋮ menu or by typing `simple-browser://history`, `bookmarks`, `downloads`, `recordings` or `settings` in the address bar.
- **Settings**: home page, search engine, reopen tabs on start (off by default), history on/off, recording quality, keep recording across tabs, and the folder for recordings and screenshots.
- **Full screen** (F11 or the ⛶ button): only the page is shown. Move the mouse to the top edge to bring the toolbar back. After **5 seconds without mouse or keyboard activity**, the top bar and the mouse pointer hide automatically; move the mouse or press a key to bring them back. Pages can also take the whole window for their own video full screen.
- **Record** (● button, Ctrl+Shift+E or menu): captures the current tab's page **and its sound** (not the browser bars, other windows or other apps) to a `.webm` file in `Videos\Simple Browser`. A native consent dialog comes first, and a REC indicator with **Pause/Resume** and **Stop** stays visible while recording, including in full screen. Paused time is not counted. Quality is Low (720p, 15 fps), Medium (1080p, 30 fps) or High (1440p, 60 fps).
- **Markers**: while recording, press Ctrl+Shift+M (or Mark on the REC controls) to mark a moment. Markers are saved in the file as chapters that players such as VLC list (up to about 120 per file), and the built-in player shows them as buttons that jump there. Trimmed and joined copies keep the markers inside them.
- **Narration** (off by default): turn on "Add my microphone to recordings" in Settings to mix your default microphone with the page's sound. The consent dialog says so each time. Only the browser's toolbar can open the microphone, and only while such a recording runs; web pages still cannot use it.
- **Stop after a set time**: in Settings, choose to stop recordings automatically after 5 minutes up to 3 hours (paused time does not count); the REC badge then shows the limit, e.g. `REC 12:04 / 30:00`.
- **Recording follows you across tabs**: when you switch tabs, the recording carries on with the new tab and saves it as the next part (`…-part2.webm`). Turn this off in Settings to stay on the original tab.
- **Screenshot** (📷 button or Ctrl+Shift+S): saves the current page as a PNG in the same folder.
- **Recordings page**: lists recordings and screenshots with a thumbnail, length and size. Play a recording or view a screenshot in the built-in player, or open, show in folder, rename and delete it (to the Recycle Bin). In the player, **trim** a recording: pick a start and an end and save a trimmed copy (no re-encoding, so it starts on the keyframe at or before your start, at most 2 s earlier). A recording that followed you across tabs can be **joined** back into one file. Trimmed and joined copies are new files; the originals are kept.
- **Updates**: installed copies check GitHub Releases every few hours, download a new version in the background and install it when you close the browser (or restart from the ⋮ menu). The portable `.exe` cannot replace itself, so it tells you about a new version and opens its download page from the ⋮ menu. Turn the checks off in Settings.
- Security model: see [SECURITY.md](SECURITY.md).

Only record content you own or have permission to record, and respect the privacy of other people and the terms of the websites you visit.

## Design

The [design document](https://claude.ai/artifact/9qiJqgcBuDJVj4QLg8mAKA) covers the architecture and trust layers, each module, the recording flow, the IPC surface and stored data, plus code review findings and recommendations.

## Run

Requires Node.js 20 or newer on Windows.

```powershell
npm install
npm start
```

| Command | What it does |
|---|---|
| `npm start` | Launch the browser |
| `npm test` | Unit tests (security rules, settings, history, zoom, downloads, recordings, shortcuts) |
| `npm run smoke` | End-to-end tests: launch the app against a local server and check sandboxing, navigation blocking, tabs, full screen, find, zoom, history, the library pages, downloads, screenshots, restoring tabs, and real recordings (audio, pause, quality, following tabs) |
| `npm run test:packaged` | After a build: start the packaged app (`dist\win-unpacked`) with a temporary profile and check it works from its `app.asar` |
| `npm run audit:prod` | Check production dependencies for known vulnerabilities |
| `npm run dist` | Build the Windows installer and portable `.exe` into `dist\` |

## Keyboard shortcuts

| Keys | Action |
|---|---|
| F11 | Enter / leave full screen |
| Esc | Close the find bar. In full screen Esc goes to the page; hold Esc to leave full screen |
| Ctrl+T, Ctrl+W | New tab, close tab |
| Ctrl+Shift+N | New private tab |
| Ctrl+Shift+T | Reopen the last closed tab |
| Ctrl+L | Focus the address bar |
| Ctrl+R / F5 | Reload |
| Ctrl+Shift+R / Ctrl+F5 | Reload without the cache |
| Alt+Left / Alt+Right | Back / forward |
| Ctrl+Tab, Ctrl+Shift+Tab | Next / previous tab |
| Ctrl+D | Bookmark the page |
| Ctrl+F | Find in page (Enter / Shift+Enter for next / previous) |
| Ctrl+P | Print the page |
| Ctrl+Plus, Ctrl+Minus, Ctrl+0 | Zoom in, out, reset |
| Ctrl+H, Ctrl+J | History, Downloads |
| Ctrl+Shift+O | Bookmarks |
| Ctrl+Shift+B | Show or hide the bookmarks bar |
| Ctrl+Shift+E | Start / stop recording |
| Ctrl+Shift+P | Pause / resume recording |
| Ctrl+Shift+M | Add a marker to the recording |
| Ctrl+Shift+S | Screenshot of the page |

## Project layout

```
src/
  main/            Trusted app process
    app.js             Wires everything together
    ipc-handlers.js    Every call from the browser's own pages (validated)
    menus.js           The ⋮ menu
    context-menu.js    Right-click menu
    window.js          Window, browser-chrome views (toolbar, REC indicator, find bar) and layout
    tabs.js            One sandboxed view per tab, plus the internal pages tab
    shortcuts.js       Keyboard shortcuts
    zoom.js            Per-site zoom
    download-manager.js  Tracks downloads for the Downloads page
    idle-tracker.js, fullscreen-idle.js  Hide the top bar and pointer after 5 s idle in full screen
    sandbox/           Locked-down web preferences, per-tab session manager
    security/          Navigation, permissions, certificates, downloads, IPC validation
    recording/         Consent, recorder (pause, parts), quality, file storage, recordings library
    storage/           Settings, bookmarks and history (JSON in the user profile)
  preload/         The only bridge between the browser's own pages and the main process
  renderer/        Toolbar, find bar, library pages (history, downloads, recordings, settings),
                   new-tab page, certificate warning, REC indicator
mockup/            Original design mockup
tests/
  unit/            node:test unit tests
  packaged/        Check of the built app (check.js)
  smoke/           End-to-end Electron tests (run.js, features.js, restore.js; launch.js runs them)
```

## Build the .exe

```powershell
npm run dist
```

This creates, in `dist\` (not committed to git):

- `Simple-Browser-Setup-<version>.exe`: installer (per-user, choose the folder).
- `Simple-Browser-<version>-portable.exe`: single file, no install needed.

The build is **not code-signed**, so Windows SmartScreen may show an "unknown publisher" warning. Signing needs a code-signing certificate (see the release checklist in [SECURITY.md](SECURITY.md)). The app icon is `build\icon.ico`.

## Release

1. Set the new version in `package.json` and add a section for it to [CHANGELOG.md](CHANGELOG.md).
2. Push a tag with the same version: `git tag v0.4.0` then `git push origin v0.4.0`.

The Release workflow then runs all tests on Windows, builds the installer and portable `.exe`, and publishes them on the GitHub Releases page with the changelog section and SHA-256 checksums. It also uploads `latest.yml` and the installer's `.blockmap`, which installed copies use to find and download the update.

## Status

Version 0.7.0: bookmarks in folders, a new Bookmarks page (tree, search, drag and drop, bulk actions), a bookmarks bar with icons, folder menus and an overflow menu, and a star popover to name and file a bookmark. See [CHANGELOG.md](CHANGELOG.md).

Version 0.6.0: recordings you can work with: a player with thumbnails, trimming, joining parts, markers saved as chapters, stopping after a set time, and optional microphone narration.

Version 0.5.0: address-bar suggestions, reopen/drag/mute for tabs, a bookmarks page with import and export, print and save as PDF, ad and tracker blocking, and automatic updates from GitHub Releases. See [CHANGELOG.md](CHANGELOG.md).

Version 0.4.0: recordings now have a length and a seek index, so players show their length and can jump around; recording survives closing the window and stops cleanly on disk errors; downloads renamed to a blocked type in the Save dialog are refused; each of the browser's own pages can call only what it needs; tab icons are fetched through the tab's own session; and the packaged app is locked down with Electron fuses. Tests run on GitHub Actions for every push.

Version 0.3.0: core browsing features (right-click menu, find, zoom, history, downloads, settings, restore tabs), recording controls (pause, hotkeys, quality, screenshot, recordings list) and recording that follows the active tab. Windows installer and portable builds.