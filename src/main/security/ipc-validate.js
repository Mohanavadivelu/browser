'use strict';

const MAX_CHUNK_BYTES = 32 * 1024 * 1024;

const validators = {
  none: (...args) => args.length === 0,
  tabId: (...args) => args.length === 1 && Number.isInteger(args[0]) && args[0] > 0,
  text: (...args) => args.length === 1 && typeof args[0] === 'string' && args[0].length <= 2048,
  optionalText: (...args) => args.length === 0 || (args.length === 1 && typeof args[0] === 'string' && args[0].length <= 2048),
  twoTexts: (...args) => args.length === 2 && args.every((value) => typeof value === 'string' && value.length <= 2048),
  bool: (...args) => args.length === 1 && typeof args[0] === 'boolean',
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

// Every IPC handler rejects unknown senders and malformed arguments before running.
function createIpc(ipcMain, isTrustedSender) {
  return {
    handle(channel, validate, handler) {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (event, ...args) => {
        if (!isTrustedSender(event)) throw new Error(`Rejected IPC "${channel}" from an untrusted sender`);
        if (!validate(...args)) throw new Error(`Rejected IPC "${channel}": invalid arguments`);
        return handler(event, ...args);
      });
    },
  };
}

module.exports = { validators, createIpc, MAX_CHUNK_BYTES };
