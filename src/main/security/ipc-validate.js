'use strict';

const MAX_CHUNK_BYTES = 32 * 1024 * 1024;

const isId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(value);

const validators = {
  none: (...args) => args.length === 0,
  tabId: (...args) => args.length === 1 && Number.isInteger(args[0]) && args[0] > 0,
  text: (...args) => args.length === 1 && typeof args[0] === 'string' && args[0].length <= 2048,
  optionalText: (...args) => args.length === 0 || (args.length === 1 && typeof args[0] === 'string' && args[0].length <= 2048),
  twoTexts: (...args) => args.length === 2 && args.every((value) => typeof value === 'string' && value.length <= 2048),
  bool: (...args) => args.length === 1 && typeof args[0] === 'boolean',
  tabMove: (...args) => args.length === 2 && Number.isInteger(args[0]) && args[0] > 0 &&
    Number.isInteger(args[1]) && args[1] >= 0 && args[1] < 1000,
  textAndIndex: (...args) => args.length === 2 && typeof args[0] === 'string' && args[0].length <= 2048 &&
    Number.isInteger(args[1]) && args[1] >= 0 && args[1] < 10000,
  // A recording's name and a time range in milliseconds (at most a day).
  trimRange: (...args) => args.length === 3 && typeof args[0] === 'string' && args[0].length <= 2048 &&
    Number.isInteger(args[1]) && Number.isInteger(args[2]) && args[1] >= 0 && args[2] > args[1] && args[2] <= 86_400_000,
  // Bookmarks are addressed by id; a patch changes a title and/or a link's address.
  bookmarkPatch: (...args) => args.length === 2 && isId(args[0]) && args[1] !== null && typeof args[1] === 'object' &&
    !Array.isArray(args[1]) && Object.keys(args[1]).every((key) => key === 'title' || key === 'url') &&
    Object.values(args[1]).every((value) => typeof value === 'string' && value.length <= 2048),
  bookmarkMove: (...args) => args.length === 3 && isId(args[0]) && isId(args[1]) &&
    Number.isInteger(args[2]) && args[2] >= 0 && args[2] <= 10000,
  idList: (...args) => args.length === 1 && Array.isArray(args[0]) && args[0].length > 0 && args[0].length <= 5000 && args[0].every(isId),
  idListAt: (...args) => args.length === 3 && Array.isArray(args[0]) && args[0].length > 0 && args[0].length <= 1000 &&
    args[0].every(isId) && [args[1], args[2]].every((n) => Number.isInteger(n) && n >= 0 && n <= 20000),
  urlList: (...args) => args.length === 1 && Array.isArray(args[0]) && args[0].length <= 5000 &&
    args[0].every((url) => typeof url === 'string' && url.length <= 2048),
  menuAt: (...args) => args.length === 3 && isId(args[0]) && [args[1], args[2]].every((n) => Number.isInteger(n) && n >= 0 && n <= 20000),
  pixels: (...args) => args.length === 1 && Number.isInteger(args[0]) && args[0] >= 0 && args[0] <= 1000,
  settingsPatch: (...args) => args.length === 1 && args[0] !== null && typeof args[0] === 'object' &&
    !Array.isArray(args[0]) && Object.keys(args[0]).length <= 20,
  findQuery: (...args) => args.length === 2 && typeof args[0] === 'string' && args[0].length <= 500 &&
    args[1] !== null && typeof args[1] === 'object' &&
    (args[1].forward === undefined || typeof args[1].forward === 'boolean') &&
    (args[1].next === undefined || typeof args[1].next === 'boolean'),
  tabOptions: (...args) => {
    if (args.length > 1) return false;
    if (args.length === 0) return true;
    const options = args[0];
    return options !== null && typeof options === 'object' &&
      (options.private === undefined || typeof options.private === 'boolean');
  },
  chunk: (...args) => {
    if (args.length !== 1) return false;
    const data = args[0];
    const isBinary = data instanceof ArrayBuffer || ArrayBuffer.isView(data);
    return isBinary && data.byteLength > 0 && data.byteLength <= MAX_CHUNK_BYTES;
  },
};

// The browser's own pages, by what they may do. Each channel names the pages allowed to call it.
const ROLES = Object.freeze(['toolbar', 'indicator', 'find', 'library']);

// Every IPC handler rejects unknown senders, pages that are not allowed that channel, and
// malformed arguments before running. `senderRole(event)` returns one of ROLES, or null for
// anything that is not one of the browser's own pages.
function createIpc(ipcMain, senderRole) {
  return {
    handle(channel, roles, validate, handler) {
      if (!Array.isArray(roles) || roles.length === 0 || !roles.every((role) => ROLES.includes(role))) {
        throw new Error(`IPC "${channel}" must name the pages allowed to call it`);
      }
      const allowed = new Set(roles);
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (event, ...args) => {
        const role = senderRole(event);
        if (!role) throw new Error(`Rejected IPC "${channel}" from an untrusted sender`);
        if (!allowed.has(role)) throw new Error(`Rejected IPC "${channel}" from the ${role} page`);
        if (!validate(...args)) throw new Error(`Rejected IPC "${channel}": invalid arguments`);
        return handler(event, ...args);
      });
    },
  };
}

module.exports = { validators, createIpc, ROLES, MAX_CHUNK_BYTES };
