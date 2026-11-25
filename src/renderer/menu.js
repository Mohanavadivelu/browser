'use strict';

// Dark pop-up menus drawn in the page: the bookmarks bar's folders, » and right-click menu, and
// the Bookmarks page's ⋯ menu. Folders open as submenus to the side. Keyboard: ↑ ↓ move,
// → or Enter opens a submenu, ← closes it, Enter or Space picks, Esc closes.
//
// An item is { label, icon?, onSelect?, submenu?, disabled?, danger? } or { separator: true }.
// `icon` is a data: URL or an element; `submenu` returns (a promise of) more items.
// Options for open(): x, y (where the menu's top left goes), anchor (the button that opened it:
// clicking it again closes the menu), maxBottom (how far down menus may reach, default the
// page's height), onLayout(bottom) when menus open or close, onClose().
const DarkMenu = (() => {
  const stack = [];
  let options = {};
  let openSeq = 0;
  let toggleSeq = 0;
  let openWidth = 0;
  // The button whose menu a mousedown on it just closed: its click that follows must not reopen it.
  let closedByAnchor = null;

  const span = (className, text) => {
    const node = document.createElement('span');
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const maxBottom = () => options.maxBottom ?? window.innerHeight;
  const bottom = () => Math.max(0, ...stack.map((menu) => Math.ceil(menu.el.getBoundingClientRect().bottom)));
  const layoutChanged = () => options.onLayout?.(bottom());

  function closeFrom(level) {
    let changed = false;
    while (stack.length > level) {
      stack.pop().el.remove();
      changed = true;
    }
    openSeq += 1;
    if (changed && stack.length) layoutChanged();
  }

  function close() {
    if (!stack.length) return;
    closeFrom(0);
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', close);
    window.removeEventListener('resize', onResize);
    const { onClose, onLayout } = options;
    options = {};
    onLayout?.(0);
    onClose?.();
  }

  // Keeps a menu inside the page: left of x if it would run off the right edge, and as tall as
  // the room below allows (it scrolls beyond that).
  function place(el, x, y, flipX) {
    el.style.left = '0px';
    el.style.top = '0px';
    const room = Math.max(120, maxBottom() - 8);
    el.style.maxHeight = `${room - 8}px`;
    const { width, height } = el.getBoundingClientRect();
    let left = x;
    if (left + width > window.innerWidth - 8) left = flipX !== undefined ? flipX - width : window.innerWidth - 8 - width;
    let top = y;
    if (top + height > room) top = Math.max(8, room - height);
    el.style.left = `${Math.max(8, Math.round(left))}px`;
    el.style.top = `${Math.round(top)}px`;
  }

  function setActive(menu, index, focus) {
    menu.active = index;
    menu.rows.forEach(({ row }, i) => row.classList.toggle('active', i === index));
    if (focus && menu.rows[index]) menu.rows[index].row.focus({ preventScroll: false });
  }

  async function openSubmenu(menu, index, focusFirst) {
    const { row, item } = menu.rows[index];
    closeFrom(menu.level + 1);
    const seq = openSeq;
    let items = await item.submenu();
    if (seq !== openSeq || stack[menu.level] !== menu || menu.active !== index) return;
    if (!items?.length) items = [{ label: '(empty)', disabled: true }];
    const box = row.getBoundingClientRect();
    const sub = build(items, menu.level + 1);
    document.body.append(sub.el);
    place(sub.el, box.right - 4, box.top - 5, menu.el.getBoundingClientRect().left + 4);
    stack.push(sub);
    layoutChanged();
    if (focusFirst) setActive(sub, firstEnabled(sub, 0, 1), true);
  }

  function firstEnabled(menu, from, step) {
    for (let i = 0; i < menu.rows.length; i += 1) {
      const index = (from + i * step + menu.rows.length * 2) % menu.rows.length;
      if (!menu.rows[index].item.disabled) return index;
    }
    return -1;
  }

  function choose(menu, index, fromKeyboard) {
    const entry = menu.rows[index];
    if (!entry || entry.item.disabled) return;
    if (entry.item.submenu) {
      openSubmenu(menu, index, fromKeyboard);
      return;
    }
    close();
    entry.item.onSelect?.();
  }

  function build(items, level) {
    const el = document.createElement('div');
    el.className = 'dark-menu';
    el.tabIndex = -1;
    el.setAttribute('role', 'menu');
    const menu = { el, rows: [], active: -1, level };
    for (const item of items) {
      if (item.separator) {
        el.append(span('dm-separator'));
        continue;
      }
      const index = menu.rows.length;
      const row = document.createElement('button');
      row.type = 'button';
      row.className = `dm-item${item.danger ? ' danger' : ''}`;
      row.setAttribute('role', 'menuitem');
      row.tabIndex = -1;
      row.disabled = Boolean(item.disabled);
      const icon = span('dm-icon');
      if (item.icon instanceof Node) {
        icon.append(item.icon);
      } else if (item.icon) {
        const image = document.createElement('img');
        image.src = item.icon;
        image.alt = '';
        icon.append(image);
      }
      row.append(icon, span('dm-label', item.label));
      if (item.title) row.title = item.title;
      if (item.submenu) {
        row.setAttribute('aria-haspopup', 'menu');
        row.append(span('dm-arrow', '›'));
      }
      row.addEventListener('mouseenter', () => {
        if (menu.active === index && (!item.submenu || stack[level + 1])) return;
        setActive(menu, index, false);
        if (item.submenu && !item.disabled) openSubmenu(menu, index, false);
        else closeFrom(level + 1);
      });
      row.addEventListener('click', () => choose(menu, index, false));
      el.append(row);
      menu.rows.push({ row, item });
    }
    return menu;
  }

  function onOutside(event) {
    if (stack.some((menu) => menu.el.contains(event.target))) return;
    // A click on the button that opened the menu closes it (the button's own click must not
    // open it again, see toggle()).
    if (options.anchor?.contains(event.target)) {
      closedByAnchor = options.anchor;
      setTimeout(() => { closedByAnchor = null; }, 500);
    }
    close();
  }

  // Only a change of width closes the menus: the toolbar's view grows in height to show them.
  function onResize() {
    if (window.innerWidth !== openWidth) close();
  }

  function onKey(event) {
    const menu = stack[stack.length - 1];
    if (!menu) return;
    const keys = {
      ArrowDown: () => setActive(menu, firstEnabled(menu, menu.active + 1, 1), true),
      ArrowUp: () => setActive(menu, firstEnabled(menu, menu.active < 0 ? menu.rows.length - 1 : menu.active - 1, -1), true),
      Home: () => setActive(menu, firstEnabled(menu, 0, 1), true),
      End: () => setActive(menu, firstEnabled(menu, menu.rows.length - 1, -1), true),
      ArrowRight: () => { if (menu.rows[menu.active]?.item.submenu) choose(menu, menu.active, true); },
      ArrowLeft: () => {
        if (stack.length < 2) return;
        closeFrom(stack.length - 1);
        const parent = stack[stack.length - 1];
        setActive(parent, parent.active, true);
      },
      Enter: () => choose(menu, menu.active, true),
      ' ': () => choose(menu, menu.active, true),
      Escape: () => close(),
      Tab: () => close(),
    };
    const action = keys[event.key];
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    action();
  }

  function open(items, opts = {}) {
    close();
    options = { ...opts };
    const menu = build(items.length ? items : [{ label: '(empty)', disabled: true }], 0);
    document.body.append(menu.el);
    place(menu.el, opts.x ?? 0, opts.y ?? 0);
    stack.push(menu);
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', close);
    openWidth = window.innerWidth;
    window.addEventListener('resize', onResize);
    layoutChanged();
    if (opts.keyboard) setActive(menu, firstEnabled(menu, 0, 1), true);
    else menu.el.focus({ preventScroll: true });
  }

  // Opens a menu from the button `anchor`, or closes it if that button's menu is open.
  // `getItems` and `getOptions` may be async (a folder's items come from the main process).
  async function toggle(anchor, getItems, getOptions = () => ({})) {
    if (closedByAnchor === anchor) {
      closedByAnchor = null;
      return;
    }
    if (stack.length && options.anchor === anchor) {
      close();
      return;
    }
    const seq = ++toggleSeq;
    const [items, opts] = await Promise.all([getItems(), getOptions()]);
    if (seq !== toggleSeq || !items) return;
    open(items, { ...opts, anchor });
  }

  return { open, toggle, close, isOpen: () => stack.length > 0, bottom };
})();
