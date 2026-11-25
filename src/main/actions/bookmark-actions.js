'use strict';

const bookmarkTree = require('../bookmarks');

const MAX_OPEN_AT_ONCE = 50;

// What the star, the bookmarks bar, its menus and the Bookmarks page do with bookmarks.
// `ctx` holds the app's parts: settings, bookmarkIcons, keepBookmarkIcons, tabs, host, ui, win,
// dialog, clipboard, notify, pushState, broadcastToLibrary.
function createBookmarkActions(ctx) {
  const { settings, bookmarkIcons, keepBookmarkIcons, tabs, host, ui, win, dialog, clipboard, notify, pushState, broadcastToLibrary } = ctx;

  // After a change: the Bookmarks page and the toolbar show it.
  const changed = () => {
    broadcastToLibrary('bookmarks:changed');
    pushState();
  };

  // Every link under the given bookmarks and folders, in order.
  function bookmarkUrls(ids) {
    const urls = [];
    const collect = (node) => {
      if (node.type === 'link') urls.push(node.url);
      else node.children.forEach(collect);
    };
    for (const id of ids) {
      const node = bookmarkTree.find(settings.data.bookmarks, id)?.node;
      if (node) collect(node);
    }
    return urls;
  }

  // The active tab when it is a regular web page that can be bookmarked, else null (with a
  // message for private tabs).
  function bookmarkableTab() {
    const tab = tabs.active;
    if (!tab || tab.kind !== 'web') return null;
    if (tab.isPrivate) {
      notify('Bookmarks are not saved from private tabs.', 'warning');
      return null;
    }
    return tab;
  }

  const actions = {
    toggleBookmark: () => {
      const tab = bookmarkableTab();
      if (!tab) return;
      const url = tab.view.webContents.getURL();
      const tree = settings.data.bookmarks;
      const existing = bookmarkTree.findLinkByUrl(tree, url);
      if (existing) {
        settings.update({ bookmarks: bookmarkTree.remove(tree, [existing.id]) });
        keepBookmarkIcons();
      } else {
        const added = bookmarkTree.addLink(tree, settings.data.bookmarkFolder, { url, title: tab.title || url });
        if (!added) {
          notify('This page could not be bookmarked.', 'warning');
          return;
        }
        settings.update({ bookmarks: added.tree });
        if (tab.favicon) bookmarkIcons.set(url, tab.favicon);
      }
      notify(existing ? 'Bookmark removed.' : 'Bookmark added.');
      changed();
    },

    // A folder's contents for the bookmarks bar's menus: its bookmarks (with their site icons)
    // and folders, one level at a time, and how many bookmarks it holds in all.
    bookmarkFolder: (folderId) => {
      const folder = bookmarkTree.find(settings.data.bookmarks, folderId)?.node;
      if (!folder || folder.type !== 'folder') return null;
      return {
        id: folder.id,
        title: folder.title,
        count: bookmarkUrls([folder.id]).length,
        children: folder.children.map((node) => (node.type === 'folder'
          ? { id: node.id, type: 'folder', title: node.title, count: bookmarkUrls([node.id]).length }
          : { id: node.id, type: 'link', title: node.title, url: node.url, icon: bookmarkIcons.get(node.url) ?? null })),
      };
    },

    // What the bar's menus and the Bookmarks page's menu do with one bookmark or folder. The
    // pages name it by id, so they cannot open or copy any other address.
    bookmarkAction: (id, action) => {
      const found = bookmarkTree.find(settings.data.bookmarks, id);
      if (!found) return false;
      const { node } = found;
      const fixed = found.parent === null; // Bookmarks bar and Other bookmarks
      const forLink = {
        open: () => tabs.navigate(node.url),
        tab: () => tabs.create({ url: node.url }),
        private: () => tabs.create({ url: node.url, isPrivate: true }),
        copy: () => clipboard.writeText(node.url),
      };
      const run = node.type === 'link' ? forLink[action] : { 'open-all': () => actions.openBookmarks([id]) }[action];
      if (run) {
        run();
        return true;
      }
      if (action === 'edit' && !fixed) {
        actions.editBookmark(id);
        return true;
      }
      if (action === 'delete' && !fixed) return actions.deleteBookmark(id);
      return false;
    },

    // Opens the Bookmarks page on this bookmark's folder, with its name and address ready to edit.
    editBookmark: (id) => {
      const page = tabs.openInternal('bookmarks');
      const reveal = () => page.view.webContents.send('bookmarks:reveal', id);
      if (page.view.webContents.isLoading()) page.view.webContents.once('did-finish-load', reveal);
      else reveal();
    },

    // A folder that still holds bookmarks is deleted only after the user agrees.
    deleteBookmark: async (id) => {
      const found = bookmarkTree.find(settings.data.bookmarks, id);
      if (!found || found.parent === null) return false;
      const { node } = found;
      const inside = node.type === 'folder' ? bookmarkUrls([id]).length : 0;
      if (inside > 0) {
        const { response } = await dialog.showMessageBox(win, {
          type: 'warning',
          message: `Delete the folder “${node.title}” and the ${inside} bookmark${inside === 1 ? '' : 's'} in it?`,
          buttons: ['Delete', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        });
        if (response !== 0) return false;
      }
      settings.update({ bookmarks: bookmarkTree.remove(settings.data.bookmarks, [id]) });
      keepBookmarkIcons();
      notify(node.type === 'folder' ? `Deleted the folder “${node.title}”.` : 'Bookmark deleted.');
      changed();
      return true;
    },

    // The star (☆ or Ctrl+D): bookmarks the page into the folder used last if it is not yet
    // bookmarked, and returns what the star's popover shows. Null for pages that cannot be.
    starPage: () => {
      const tab = bookmarkableTab();
      if (!tab) return null;
      const url = tab.view.webContents.getURL();
      let tree = settings.data.bookmarks;
      let link = bookmarkTree.findLinkByUrl(tree, url);
      const added = !link;
      if (added) {
        const result = bookmarkTree.addLink(tree, settings.data.bookmarkFolder, { url, title: tab.title || url });
        if (!result) {
          notify('This page could not be bookmarked.', 'warning');
          return null;
        }
        settings.update({ bookmarks: result.tree });
        if (tab.favicon) bookmarkIcons.set(url, tab.favicon);
        tree = settings.data.bookmarks;
        link = bookmarkTree.findLinkByUrl(tree, url);
        changed();
      }
      const found = bookmarkTree.find(tree, link.id);
      return {
        added,
        id: link.id,
        title: link.title,
        folderId: found.parent.id,
        folders: bookmarkTree.folders(tree).map(({ id, label }) => ({ id, label })),
      };
    },

    // Done in the star's popover: the name, and the folder (a new one is made in the bar).
    saveStar: (id, { title, folderId, newFolder }) => {
      let tree = settings.data.bookmarks;
      const found = bookmarkTree.find(tree, id);
      if (!found || found.node.type !== 'link') return false;
      let target = folderId ?? found.parent.id;
      if (newFolder !== undefined) {
        const made = bookmarkTree.addFolder(tree, 'bar', newFolder);
        if (!made) return false;
        tree = made.tree;
        target = made.id;
      }
      if (title !== undefined) tree = bookmarkTree.update(tree, id, { title }) ?? tree;
      if (target !== found.parent.id) tree = bookmarkTree.move(tree, id, target, 10000) ?? tree;
      settings.update({ bookmarks: tree, bookmarkFolder: target });
      changed();
      return true;
    },

    removeStar: (id) => {
      const next = bookmarkTree.remove(settings.data.bookmarks, [id]);
      if (!next) return false;
      settings.update({ bookmarks: next });
      keepBookmarkIcons();
      notify('Bookmark removed.');
      changed();
      return true;
    },

    // Ctrl+D: the toolbar opens the star's popover.
    openStar: () => {
      host.setRevealed(true);
      ui.webContents.focus();
      ui.webContents.send('ui:star');
    },

    toggleBookmarksBar: () => {
      settings.update({ showBookmarksBar: !settings.data.showBookmarksBar });
      host.setBookmarksBar(settings.data.showBookmarksBar);
      pushState();
    },

    // Opens the links under these bookmarks and folders in new tabs, at most 50 at once.
    openBookmarks: (ids) => {
      const urls = bookmarkUrls(ids);
      urls.slice(0, MAX_OPEN_AT_ONCE).forEach((url, i) => tabs.create({ url, activate: i === 0 }));
      if (urls.length > MAX_OPEN_AT_ONCE) notify(`Opened the first ${MAX_OPEN_AT_ONCE} of ${urls.length} bookmarks.`, 'warning');
      return Math.min(urls.length, MAX_OPEN_AT_ONCE);
    },
  };
  return actions;
}

module.exports = { createBookmarkActions, MAX_OPEN_AT_ONCE };
