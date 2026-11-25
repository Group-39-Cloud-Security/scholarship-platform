// reviewer-common.js — small helpers shared by the three reviewer pages
// Owner: Mohamed Hazem   ·   Rules: CLAUDE.md §10 (textContent only, token in sessionStorage, 401 → login)
//
// Until the shared shell (js/api.js, js/auth.js) is built in Phase C, the reviewer pages use this helper so they
// work on their own. Everything is inside one object so nothing clashes with the shell's global names.
// Security: the DOM is only ever built with createElement + textContent (never innerHTML), so an essay or
// title containing <script> is shown as text, not run.

const ReviewerUI = (() => {
  const TOKEN_KEY = 'token'; // same key the shared auth.js uses for sessionStorage
  const LOGIN_PAGE = '../index.html';
  const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
  const apiBase = typeof FLOCI_API !== 'undefined' ? FLOCI_API : ''; // FLOCI_API comes from js/config.js

  function token() {
    try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
  }

  function toLogin() {
    try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* storage blocked */ }
    window.location.replace(LOGIN_PAGE);
  }

  // No token → straight to login. The backend still checks the role on every call (hiding a page is not security).
  function guard() {
    if (!token()) toLogin();
  }

  // fetch + JSON. Returns the parsed body (or null for 204). Throws Error(<API message>) on any error status.
  async function api(path, { method = 'GET', body } = {}) {
    const headers = { Authorization: `Bearer ${token()}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(apiBase + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'omit', // the token goes in the header, never in cookies
        cache: 'no-store',
      });
    } catch {
      throw new Error('Could not reach the server. Check your connection and try again.');
    }
    if (res.status === 401) {
      toLogin();
      throw new Error('Your session has ended. Please log in again.');
    }
    if (res.status === 204) return null;
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) {
      const message = data && data.error && data.error.message ? data.error.message : `Request failed (${res.status}).`;
      const err = new Error(message);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // Tiny DOM builder: el('td', { className: 'num' }, 'text', childNode, ...). Text children become text nodes.
  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    Object.entries(props).forEach(([k, v]) => {
      if (k === 'dataset') Object.assign(node.dataset, v);
      else node[k] = v;
    });
    children.flat().forEach((c) => {
      if (c === null || c === undefined || c === false) return;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    });
    return node;
  }

  function showMessage(box, text, kind = 'error') {
    box.textContent = text;
    box.className = `message ${kind}`;
    box.hidden = !text;
  }

  function formatDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
  }

  // Time left on a claim, e.g. "31 h 05 min left" or "expired".
  function timeLeft(expiresAt) {
    const ms = Date.parse(expiresAt) - Date.now();
    if (!Number.isFinite(ms)) return '—';
    if (ms <= 0) return 'expired';
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    return `${h} h ${String(m).padStart(2, '0')} min left`;
  }

  // Only ids that look like ours ever go into a URL.
  function validId(id) {
    return typeof id === 'string' && ID_PATTERN.test(id);
  }

  function reviewLink(applicationId, text) {
    return el('a', { href: `review.html?id=${encodeURIComponent(applicationId)}` }, text);
  }

  // Only plain http(s) links are ever opened (never javascript: or data: URLs).
  function safeUrl(url) {
    let parsed;
    try { parsed = new URL(url); } catch { return null; }
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  }

  // Opens a link that is only known after an API call. The tab is opened right away on the click (so popup
  // blockers allow it), cut off from this page (opener = null), and only then sent to the link.
  async function openAfter(getUrl) {
    const tab = window.open('', '_blank');
    if (tab) tab.opener = null;
    try {
      const url = safeUrl(await getUrl());
      if (!url) throw new Error('The server returned an invalid link.');
      if (tab) tab.location.replace(url);
      else window.location.assign(url); // popups blocked: open it here instead
    } catch (err) {
      if (tab) tab.close();
      throw err;
    }
  }

  function wireLogout() {
    const btn = document.getElementById('logout');
    if (btn) btn.addEventListener('click', toLogin);
  }

  return { api, el, guard, showMessage, formatDate, timeLeft, validId, reviewLink, openAfter, wireLogout };
})();
