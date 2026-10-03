export async function mountLegacyModule(root, moduleId) {
  const base = `/modules/${moduleId}/`;
  const [html, script] = await Promise.all([
    fetch(`${base}index.html`).then(response => {
      if (!response.ok) throw new Error('模块页面不可用');
      return response.text();
    }),
    fetch(`${base}app.js`).then(response => {
      if (!response.ok) throw new Error('模块脚本不可用');
      return response.text();
    }),
  ]);
  const host = root;
  const shadow = host.shadowRoot || host.attachShadow({ mode: 'open' });
  shadow.replaceChildren();
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const listeners = [];
  const body = {
    style: host.style,
    append: (...nodes) => shadow.append(...nodes),
  };
  const scopedDocument = {
    body,
    get activeElement() { return document.activeElement; },
    createElement: (...args) => document.createElement(...args),
    getElementById: id => shadow.querySelector(`#${CSS.escape(id)}`),
    querySelector: selector => shadow.querySelector(selector),
    querySelectorAll: selector => shadow.querySelectorAll(selector),
    addEventListener(type, handler, options) {
      shadow.addEventListener(type, handler, options);
      listeners.push([type, handler, options]);
    },
    removeEventListener: (...args) => shadow.removeEventListener(...args),
  };
  const scopedWindow = {
    location: window.location,
    scrollTo: (...args) => window.scrollTo(...args),
    setTimeout: (...args) => window.setTimeout(...args),
    clearTimeout: (...args) => window.clearTimeout(...args),
    addEventListener: (...args) => window.addEventListener(...args),
    removeEventListener: (...args) => window.removeEventListener(...args),
  };
  const style = document.createElement('link');
  style.rel = 'stylesheet';
  style.href = `${base}styles.css`;
  shadow.append(style);
  const bodyNodes = [...parsed.body.childNodes].filter(node => node.nodeName !== 'SCRIPT');
  shadow.append(...bodyNodes.map(node => document.importNode(node, true)));
  const run = new Function('document', 'window', 'localStorage', 'Blob', 'URL', 'FormData', 'confirm', `${script}\n//# sourceURL=${moduleId}-native-module.js`);
  run(scopedDocument, scopedWindow, window.localStorage, window.Blob, window.URL, window.FormData, window.confirm.bind(window));
  return () => {
    for (const args of listeners) shadow.removeEventListener(...args);
    host.style.overflow = '';
    shadow.replaceChildren();
  };
}
