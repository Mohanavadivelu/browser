// Reading mode, run in an isolated world of the page (never the page's own scripts' world, and
// never with the browser's bridge): it shows the page's article, as Mozilla's Readability finds
// it, over the page in a calm layout, or closes it again if it is open. The article only ever
// holds the page's own content, cleaned of scripts, frames, forms and event handlers, inside a
// closed shadow root. It evaluates to true (opened), false (closed) or null (no article found).
/* global Readability */
(() => {
  const reader = window.__sbReader;
  if (reader.overlay) {
    reader.overlay.close();
    return false;
  }
  const article = new reader.Readability(document.cloneNode(true)).parse();
  if (!article || !article.content) return null;

  // The article, cleaned: parsed inert (nothing runs), then stripped of anything active.
  const parsed = new DOMParser().parseFromString(article.content, 'text/html');
  parsed.querySelectorAll('script, style, link, meta, iframe, frame, object, embed, form, input, button, select, textarea, noscript, base')
    .forEach((node) => node.remove());
  for (const node of parsed.querySelectorAll('*')) {
    for (const attribute of [...node.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim().toLowerCase();
      if (name.startsWith('on') || name === 'style' || name === 'class' || ((name === 'href' || name === 'src' || name === 'srcset') && /^(javascript|vbscript|data:text)/.test(value))) {
        node.removeAttribute(attribute.name);
      }
    }
  }

  const host = document.createElement('simple-browser-reader');
  const root = host.attachShadow({ mode: 'closed' });
  const SIZES = [15, 17, 19, 21, 24, 27];
  const THEMES = ['light', 'sepia', 'dark'];
  let size = reader.size ?? 2;
  let theme = reader.theme ?? 'light';

  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    .sbr-page { position: fixed; inset: 0; z-index: 2147483647; overflow-y: auto; font: 400 19px/1.65 Georgia, "Iowan Old Style", "Times New Roman", serif; }
    .sbr-page.sbr-light { background: #fbfbf9; color: #202124; }
    .sbr-page.sbr-sepia { background: #f4ecd8; color: #3b2f1e; }
    .sbr-page.sbr-dark { background: #1e1f22; color: #dcdde0; }
    .sbr-bar { position: sticky; top: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 10px 16px; font: 13px "Segoe UI", system-ui, sans-serif; }
    .sbr-light .sbr-bar { background: rgba(251, 251, 249, .95); border-bottom: 1px solid #e3e3df; }
    .sbr-sepia .sbr-bar { background: rgba(244, 236, 216, .95); border-bottom: 1px solid #e0d3b5; }
    .sbr-dark .sbr-bar { background: rgba(30, 31, 34, .95); border-bottom: 1px solid #3c3d42; }
    .sbr-bar .sbr-site { flex: 1; min-width: 120px; opacity: .75; }
    button { min-width: 36px; height: 34px; padding: 0 12px; border: 1px solid currentColor; border-radius: 6px; background: none; color: inherit; font: inherit; cursor: pointer; opacity: .85; }
    button:hover { opacity: 1; }
    button:focus-visible { outline: 2px solid #4c8dff; outline-offset: 2px; }
    button[aria-pressed="true"] { background: rgba(127, 127, 127, .2); }
    article { max-width: 680px; margin: 0 auto; padding: 32px 24px 80px; }
    h1.title { margin: 0 0 8px; font-size: 1.8em; line-height: 1.2; }
    .sbr-byline { margin: 0 0 28px; font: 14px "Segoe UI", system-ui, sans-serif; opacity: .7; }
    .sbr-content img, .sbr-content video, .sbr-content figure { max-width: 100%; height: auto; }
    .sbr-content pre { overflow-x: auto; padding: 12px; border-radius: 6px; background: rgba(127, 127, 127, .12); font-size: .85em; }
    .sbr-content a { color: #2a62c9; }
    .sbr-dark .sbr-content a { color: #8ab4ff; }
    .sbr-content blockquote { margin: 1em 0; padding-left: 1em; border-left: 3px solid rgba(127, 127, 127, .4); opacity: .9; }
    @media print {
      .sbr-page { position: static; overflow: visible; background: #fff !important; color: #000 !important; }
      .sbr-bar { display: none; }
    }
  `;

  const page = document.createElement('div');
  page.className = `sbr-page sbr-${theme}`;
  page.setAttribute('role', 'dialog');
  page.setAttribute('aria-label', 'Reading mode');
  page.tabIndex = -1;
  const bar = document.createElement('div');
  bar.className = 'sbr-bar';
  const site = document.createElement('span');
  site.className = 'sbr-site';
  site.textContent = `Reading mode · ${article.siteName || location.hostname}`;
  const button = (label, title, onClick) => {
    const node = document.createElement('button');
    node.type = 'button';
    node.textContent = label;
    node.title = title;
    node.setAttribute('aria-label', title);
    node.addEventListener('click', onClick);
    return node;
  };
  const body = document.createElement('article');
  const applySize = () => { body.style.fontSize = `${SIZES[size]}px`; };
  const smaller = button('A−', 'Smaller text', () => { size = Math.max(0, size - 1); reader.size = size; applySize(); });
  const larger = button('A+', 'Larger text', () => { size = Math.min(SIZES.length - 1, size + 1); reader.size = size; applySize(); });
  const themeButtons = THEMES.map((name) => {
    const node = button(name[0].toUpperCase() + name.slice(1), `${name[0].toUpperCase() + name.slice(1)} page`, () => {
      theme = name;
      reader.theme = name;
      page.className = `sbr-page sbr-${name}`;
      for (const other of themeButtons) other.setAttribute('aria-pressed', String(other === node));
    });
    node.setAttribute('aria-pressed', String(name === theme));
    return node;
  });
  const print = button('Print', 'Print the article', () => window.print());
  const close = button('Close', 'Close reading mode (Esc)', () => reader.overlay.close());
  bar.append(site, smaller, larger, ...themeButtons, print, close);

  const title = document.createElement('h1');
  title.className = 'sbr-title';
  title.textContent = article.title || document.title;
  const byline = document.createElement('p');
  byline.className = 'sbr-byline';
  byline.textContent = [article.byline, article.publishedTime ? new Date(article.publishedTime).toLocaleDateString() : ''].filter(Boolean).join(' · ');
  const content = document.createElement('div');
  content.className = 'sbr-content';
  content.append(...[...parsed.body.childNodes].map((node) => document.importNode(node, true)));
  body.append(title);
  if (byline.textContent) body.append(byline);
  body.append(content);
  applySize();
  page.append(bar, body);
  root.append(style, page);

  // Only the article prints, and the page under it doesn't scroll.
  const printStyle = document.createElement('style');
  printStyle.textContent = '@media print { body { display: none !important; } }';
  const overflow = document.documentElement.style.overflow;
  document.documentElement.style.overflow = 'hidden';
  document.documentElement.append(host);
  (document.head || document.documentElement).append(printStyle);
  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      reader.overlay.close();
    }
  };
  window.addEventListener('keydown', onKey, true);
  reader.overlay = {
    close() {
      window.removeEventListener('keydown', onKey, true);
      host.remove();
      printStyle.remove();
      document.documentElement.style.overflow = overflow;
      reader.overlay = null;
    },
  };
  page.focus();
  return true;
})();
