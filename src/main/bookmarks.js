'use strict';

const crypto = require('node:crypto');
const { isAllowedUrl } = require('./security/navigation');

// Bookmarks are a tree with two fixed folders at the top, as in other browsers:
//   { bar:   { id: 'bar',   type: 'folder', title: 'Bookmarks bar',   children: [...] },
//     other: { id: 'other', type: 'folder', title: 'Other bookmarks', children: [...] } }
// A child is a link { id, type: 'link', url, title } or a folder { id, type: 'folder', title,
// children }. Folders can hold folders. Every helper returns a new tree (or null when nothing
// changed) and never changes the one it is given.

const ROOTS = Object.freeze({ bar: 'Bookmarks bar', other: 'Other bookmarks' });
const MAX_TITLE_LENGTH = 200;
const MAX_NODES = 5000;
const MAX_DEPTH = 10;
const ID = /^[A-Za-z0-9_-]{1,40}$/;

function newId() {
  return crypto.randomBytes(6).toString('base64url');
}

function cleanTitle(title, fallback) {
  const text = String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LENGTH);
  return text || fallback;
}

function emptyTree() {
  return {
    bar: { id: 'bar', type: 'folder', title: ROOTS.bar, children: [] },
    other: { id: 'other', type: 'folder', title: ROOTS.other, children: [] },
  };
}

// Any stored value, including the flat list of 0.5 and earlier (which becomes the bar), as a
// valid tree: unsafe links dropped, ids made unique, size and depth capped.
function sanitizeTree(raw) {
  const tree = emptyTree();
  const seen = new Set(['bar', 'other']);
  let count = 0;
  const clean = (nodes, depth) => {
    const out = [];
    for (const node of Array.isArray(nodes) ? nodes : []) {
      if (count >= MAX_NODES || !node || typeof node !== 'object') continue;
      let id = typeof node.id === 'string' && ID.test(node.id) && !seen.has(node.id) ? node.id : newId();
      while (seen.has(id)) id = newId();
      const isFolder = node.type === 'folder' || (node.type === undefined && Array.isArray(node.children));
      if (isFolder) {
        if (depth >= MAX_DEPTH) continue;
        seen.add(id);
        count += 1;
        out.push({ id, type: 'folder', title: cleanTitle(node.title, 'Folder'), children: clean(node.children, depth + 1) });
      } else if (typeof node.url === 'string' && isAllowedUrl(node.url)) {
        seen.add(id);
        count += 1;
        out.push({ id, type: 'link', url: node.url, title: cleanTitle(node.title, node.url) });
      }
    }
    return out;
  };
  if (Array.isArray(raw)) {
    tree.bar.children = clean(raw, 1);
  } else if (raw && typeof raw === 'object') {
    tree.bar.children = clean(raw.bar?.children, 1);
    tree.other.children = clean(raw.other?.children, 1);
  }
  return tree;
}

const copy = (tree) => structuredClone(tree);
const roots = (tree) => [tree.bar, tree.other];

// Where a node is: { node, parent, index, path } (path: the folders above it, top first).
function find(tree, id) {
  const search = (folder, path) => {
    for (let index = 0; index < folder.children.length; index += 1) {
      const node = folder.children[index];
      if (node.id === id) return { node, parent: folder, index, path: [...path, folder] };
      if (node.type === 'folder') {
        const found = search(node, [...path, folder]);
        if (found) return found;
      }
    }
    return null;
  };
  for (const root of roots(tree)) {
    if (root.id === id) return { node: root, parent: null, index: -1, path: [] };
    const found = search(root, []);
    if (found) return found;
  }
  return null;
}

// Every link, in order, with the names of the folders it is in.
function links(tree) {
  const out = [];
  const walk = (folder, path) => {
    for (const node of folder.children) {
      if (node.type === 'folder') walk(node, [...path, node.title]);
      else out.push({ id: node.id, url: node.url, title: node.title, folder: path.join(' › ') });
    }
  };
  for (const root of roots(tree)) walk(root, [root.title]);
  return out;
}

function countNodes(tree) {
  let count = 0;
  const walk = (folder) => {
    for (const node of folder.children) {
      count += 1;
      if (node.type === 'folder') walk(node);
    }
  };
  roots(tree).forEach(walk);
  return count;
}

function findLinkByUrl(tree, url) {
  return links(tree).find((link) => link.url === url) ?? null;
}

// Every folder, for "Move to" lists: [{ id, title, label: 'Bookmarks bar › Work', depth }].
function folders(tree) {
  const out = [];
  const walk = (folder, path) => {
    const names = [...path, folder.title];
    out.push({ id: folder.id, title: folder.title, label: names.join(' › '), depth: names.length - 1 });
    for (const node of folder.children) if (node.type === 'folder') walk(node, names);
  };
  roots(tree).forEach((root) => walk(root, []));
  return out;
}

function insertInto(tree, parentId, node, index) {
  const parent = find(tree, parentId)?.node;
  if (!parent || parent.type !== 'folder') return false;
  const at = Number.isInteger(index) ? Math.max(0, Math.min(index, parent.children.length)) : parent.children.length;
  parent.children.splice(at, 0, node);
  return true;
}

function addLink(tree, parentId, { url, title }, index) {
  if (!isAllowedUrl(url) || countNodes(tree) >= MAX_NODES) return null;
  const next = copy(tree);
  const node = { id: newId(), type: 'link', url, title: cleanTitle(title, url) };
  return insertInto(next, parentId, node, index) ? { tree: next, id: node.id } : null;
}

function addFolder(tree, parentId, title, index) {
  const parent = find(tree, parentId);
  if (!parent || parent.path.length + 1 >= MAX_DEPTH || countNodes(tree) >= MAX_NODES) return null;
  const next = copy(tree);
  const node = { id: newId(), type: 'folder', title: cleanTitle(title, 'New folder'), children: [] };
  return insertInto(next, parentId, node, index) ? { tree: next, id: node.id } : null;
}

// Renames a node, or changes a link's address.
function update(tree, id, { title, url } = {}) {
  const next = copy(tree);
  const found = find(next, id);
  if (!found || found.parent === null) return null;
  if (url !== undefined) {
    if (found.node.type !== 'link' || !isAllowedUrl(url)) return null;
    found.node.url = url;
  }
  if (title !== undefined) found.node.title = cleanTitle(title, found.node.type === 'link' ? found.node.url : 'Folder');
  return next;
}

function remove(tree, ids) {
  const next = copy(tree);
  let removed = 0;
  for (const id of ids) {
    const found = find(next, id);
    if (!found || found.parent === null) continue;
    found.parent.children.splice(found.index, 1);
    removed += 1;
  }
  return removed ? next : null;
}

function depthOf(node) {
  if (node.type !== 'folder' || node.children.length === 0) return 1;
  return 1 + Math.max(...node.children.map(depthOf));
}

// Moves a node into a folder at `index` (in that folder as it is after taking the node out).
// A folder cannot move into itself or one of its own folders, and the two top folders stay put.
function move(tree, id, parentId, index) {
  const next = copy(tree);
  const found = find(next, id);
  const target = find(next, parentId);
  if (!found || found.parent === null || !target || target.node.type !== 'folder') return null;
  if (found.node.type === 'folder' && (target.node.id === id || target.path.some((folder) => folder.id === id))) return null;
  if (target.path.length + depthOf(found.node) >= MAX_DEPTH) return null;
  found.parent.children.splice(found.index, 1);
  const children = target.node.children;
  const at = Number.isInteger(index) ? Math.max(0, Math.min(index, children.length)) : children.length;
  children.splice(at, 0, found.node);
  return next;
}

// ---------- The bookmarks HTML file Chrome, Edge and Firefox read and write ----------

const escapeHtml = (text) => String(text)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function toHtml(tree) {
  const lines = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<!-- This is an automatically generated file. It will be read and overwritten. DO NOT EDIT! -->',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>',
  ];
  const writeFolder = (folder, indent, attributes = '') => {
    lines.push(`${indent}<DT><H3${attributes}>${escapeHtml(folder.title)}</H3>`, `${indent}<DL><p>`);
    for (const node of folder.children) {
      if (node.type === 'folder') writeFolder(node, `${indent}    `);
      else lines.push(`${indent}    <DT><A HREF="${escapeHtml(node.url)}">${escapeHtml(node.title)}</A>`);
    }
    lines.push(`${indent}</DL><p>`);
  };
  writeFolder(tree.bar, '    ', ' PERSONAL_TOOLBAR_FOLDER="true"');
  writeFolder(tree.other, '    ');
  lines.push('</DL><p>', '');
  return lines.join('\n');
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeHtml(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
    if (name[0] === '#') {
      const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

const attribute = (tag, name) => {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return match ? decodeHtml(match[1] ?? match[2] ?? match[3] ?? '') : null;
};

const IMAGE_DATA_URL = /^data:image\/(png|x-icon|vnd\.microsoft\.icon|gif|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/i;
const MAX_ICON_LENGTH = 32 * 1024;

// A bookmarks file as { bar: [...], other: [...] }, keeping its folders, plus the icons it
// carries ({ url: data URL }). The toolbar folder's contents go to the bar; everything else to
// Other bookmarks. Only http(s) links are kept.
function fromHtml(html) {
  const result = { bar: [], other: [] };
  const icons = {};
  const token = /<h3\b[^>]*>([\s\S]*?)<\/h3>|<a\s[^>]*>[\s\S]*?<\/a>|<dl\b[^>]*>|<\/dl>/gi;
  // stack of child lists; the first is the file's top level
  const top = [];
  const stack = [top];
  let pendingFolder = null;
  for (const match of String(html).matchAll(token)) {
    const text = match[0];
    const current = stack.at(-1);
    if (/^<h3/i.test(text)) {
      pendingFolder = {
        type: 'folder',
        title: cleanTitle(decodeHtml(match[1].replace(/<[^>]*>/g, '')), 'Folder'),
        children: [],
        toolbar: /PERSONAL_TOOLBAR_FOLDER\s*=\s*"?true/i.test(text),
      };
      current.push(pendingFolder);
    } else if (/^<a/i.test(text)) {
      const opening = /^<a\s[^>]*>/i.exec(text)[0];
      const url = (attribute(opening, 'href') ?? '').trim();
      if (!isAllowedUrl(url)) continue;
      const title = cleanTitle(decodeHtml(text.slice(opening.length).replace(/<\/a>$/i, '').replace(/<[^>]*>/g, '')), url);
      current.push({ type: 'link', url, title });
      const icon = attribute(opening, 'icon');
      if (icon && icon.length <= MAX_ICON_LENGTH && IMAGE_DATA_URL.test(icon)) icons[url] = icon;
    } else if (/^<dl/i.test(text)) {
      // A list right after a folder's name holds that folder's contents; the file's own outer
      // list adds nothing.
      if (pendingFolder) {
        stack.push(pendingFolder.children);
        pendingFolder = null;
      }
    } else if (stack.length > 1) {
      stack.pop();
    }
  }
  for (const node of top) {
    if (node.type === 'folder' && node.toolbar) result.bar.push(...node.children);
    else result.other.push(node);
  }
  const strip = (nodes) => nodes.map((node) => (node.type === 'folder'
    ? { type: 'folder', title: node.title, children: strip(node.children) }
    : node));
  return { bar: strip(result.bar), other: strip(result.other), icons };
}

// Adds an imported file's bookmarks after the existing ones: its bar into the bar, the rest into
// Other bookmarks. Addresses already bookmarked are skipped; nothing past MAX_NODES is added.
function merge(tree, imported) {
  const next = copy(tree);
  const known = new Set(links(next).map((link) => link.url));
  let room = MAX_NODES - countNodes(next);
  let added = 0;
  let skipped = 0;
  const graft = (nodes, depth) => {
    const out = [];
    for (const node of nodes) {
      if (node.type === 'folder') {
        if (room <= 0 || depth >= MAX_DEPTH) {
          skipped += 1;
          continue;
        }
        room -= 1;
        const folder = { id: newId(), type: 'folder', title: node.title, children: graft(node.children, depth + 1) };
        // An imported folder left empty (every link already known) is not kept.
        if (folder.children.length) out.push(folder);
        else room += 1;
      } else if (known.has(node.url) || room <= 0) {
        skipped += 1;
      } else {
        known.add(node.url);
        room -= 1;
        added += 1;
        out.push({ id: newId(), type: 'link', url: node.url, title: node.title });
      }
    }
    return out;
  };
  next.bar.children.push(...graft(imported.bar ?? [], 1));
  next.other.children.push(...graft(imported.other ?? [], 1));
  return { tree: next, added, skipped };
}

module.exports = {
  ROOTS, MAX_NODES, MAX_DEPTH, emptyTree, sanitizeTree, find, links, folders, findLinkByUrl, countNodes,
  addLink, addFolder, update, remove, move, toHtml, fromHtml, merge, cleanTitle,
};
