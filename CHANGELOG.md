# Changelog

## Unreleased

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
