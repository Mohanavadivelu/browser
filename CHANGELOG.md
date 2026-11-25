# Changelog

## 0.6.0

Recordings you can work with: watch, trim, join and mark them, stop them on a timer, and add your voice.

### New

- **Player and thumbnails** on the Recordings page: each recording shows a frame, and plays in the page with its length and seeking. Screenshots open as images.
- **Trim**: in the player, pick a start and an end and save a trimmed copy. There is no re-encoding, so the copy starts on the keyframe at or before your start (at most 2 seconds earlier).
- **Join**: a recording that followed you across tabs (`…`, `…-part2`, …) can be joined back into one file from the Recordings page.
- **Markers**: press **Ctrl+Shift+M**, or Mark on the REC controls, to mark a moment while recording. Markers are saved in the file as chapters that players such as VLC list (up to about 120 per file), and the player shows them as buttons that jump there. Trimmed and joined copies keep the markers inside them.
- **Stop after a set time**: in Settings, stop recordings automatically after 5 minutes up to 3 hours (paused time does not count). The REC badge then shows the limit, e.g. `REC 12:04 / 30:00`.
- **Narration** (off by default): add your microphone to recordings, mixed with the page's sound. The consent dialog says so each time. Only the browser's toolbar can open the microphone, and only during such a recording; web pages still cannot use it.

Trimmed and joined recordings are new files; the originals are never changed.

## 0.5.0

Everyday browsing: suggestions as you type, tab handling, a bookmarks manager, PDF, ad and tracker blocking, and automatic updates.

### New

- **Address-bar suggestions** as you type: the search or address itself first, then matching bookmarks and visited pages (visited pages only while history is on). Use the arrow keys and Enter, or click.
- **Tabs**: reopen the last closed tab with **Ctrl+Shift+T** (private tabs are never kept), drag tabs to reorder them, and mute a tab from the 🔊 icon that appears while it plays sound.
- **Bookmarks page** (**Ctrl+Shift+O**): rename, reorder and delete bookmarks, and import or export them as the bookmarks file Chrome, Edge and Firefox use. Up to 1,000 bookmarks (was 200).
- **Print** (**Ctrl+P**) and **Save page as PDF** (⋮ menu).
- **Ad and tracker blocking**, on by default, with the EasyList and EasyPrivacy lists. The 🛡 in the address bar counts what was blocked on the page; click it to allow ads and trackers on that site. Turn it off, or see the allowed sites, in Settings. The lists are downloaded from easylist.to every few days.
- **Automatic updates**: installed copies download new versions from GitHub Releases and install them when the browser closes; the portable `.exe` tells you about a new version and opens its download page. Turn the checks off in Settings.

### Changes

- Recording now starts and stops with **Ctrl+Shift+E**. **Ctrl+Shift+R** and **Ctrl+F5** reload the page without the cache, as in other browsers.
- In F11 full screen, Esc now goes to the page (for example, to close its own pop-ups). Hold Esc, or press F11, to leave full screen.

### Fixes

- Starting the browser while it is already open brings the open window to the front, instead of doing nothing.
- Jumping to a section of the same page (an address that only changes after `#`) no longer adds an entry to History.
- Pause or Resume pressed while a recording is moving to another tab is no longer ignored.
- Closing a tab in the background now updates the saved tabs for "Reopen my tabs" straight away.

## 0.4.0

Recordings you can scrub through, sturdier recording, and a more locked-down browser.

### Recording

- Recordings now carry their length and a seek index, so video players show how long they are and can jump to any point. A seek point is written at least every 2 seconds.
- Closing the window while recording keeps the last second of video and sound.
- If the recording file cannot be written (disk full, folder removed), the recording stops with one clear message instead of carrying on into a broken file.
- Pressing record twice while the consent dialog is open no longer opens two files.

### Downloads

- A download renamed to a blocked type (such as `.exe`) in the Save dialog is cancelled, or deleted if it already finished. It shows as "Blocked" on the Downloads page.
- More risky file types are blocked: disk images (`.iso`, `.img`, `.vhd`, `.vhdx`), help files, web and shell shortcuts, installer patches, ClickOnce apps, Office add-ins and cabinet files. Names ending in dots or spaces no longer hide the real extension.

### Security

- Each of the browser's own pages can call only the functions it needs. The History, Downloads, Recordings and Settings tab, which shows text from websites, can no longer control recording, tabs or navigation.
- Tab icons are fetched through the tab's own session, so a private tab's icon request stays private. The toolbar no longer loads anything from the network.
- The app is built with Electron fuses: it cannot be run as plain Node.js, ignores `NODE_OPTIONS` and `--inspect`, loads code only from its integrity-checked `app.asar`, and encrypts cookies on disk. Cookie encryption is one-way: if you go back to 0.3.0 afterwards, you will be signed out of websites.

### Fixes

- Closing the window while the browser is still starting no longer shows a "JavaScript error occurred in the main process" dialog.

## 0.3.0

Core browsing features (right-click menu, find, zoom, history, downloads, settings, restore tabs), recording controls (pause, hotkeys, quality, screenshot, recordings list) and recording that follows the active tab. Windows installer and portable builds.
