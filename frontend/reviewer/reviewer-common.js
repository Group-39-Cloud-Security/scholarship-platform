// reviewer-common.js - helpers shared by the three reviewer pages
// Owner: Mohamed Hazem   ·   Rules: CLAUDE.md §10 (textContent only, token in sessionStorage, 401 goes back to login)
//
// I wrote these before the shared js/api.js and js/auth.js existed. They use the same 'token' key, so one login
// works for every page. Everything is inside ReviewerUI so the names can't clash with the shared files.
// Pages are only built with createElement + textContent, never innerHTML, so text from the database
// (essays, titles) is always shown as text and never run as HTML.

const ReviewerUI = (() => {
  const TOKEN_KEY = 'token';
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

  // No token: go to the login page. The backend still checks the role on every call.
  function guard() {
    if (!token()) toLogin();
  }

  // Calls the API and returns the JSON body (null for 204). Throws an Error with the API's message.
  async function api(path, { method = 'GET', body } = {}) {
    const headers = { Authorization: `Bearer ${token()}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(apiBase + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'omit',
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
      const err = new Error(data && data.error ? data.error.message : `Request failed (${res.status}).`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // el('td', { className: 'num' }, 'some text', otherNode) - text children become text nodes.
  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    Object.assign(node, props);
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
    if (!iso) return '-';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '-' : d.toLocaleString();
  }

  // e.g. "31 h 05 min left" or "expired"
  function timeLeft(expiresAt) {
    const ms = Date.parse(expiresAt) - Date.now();
    if (!Number.isFinite(ms)) return '-';
    if (ms <= 0) return 'expired';
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    return `${h} h ${String(m).padStart(2, '0')} min left`;
  }

  function validId(id) {
    return typeof id === 'string' && ID_PATTERN.test(id);
  }

  function reviewLink(applicationId, text) {
    return el('a', { href: `review.html?id=${encodeURIComponent(applicationId)}` }, text);
  }

  // Opens a link from the API in a new tab. Only http(s) links, and the new tab gets no access to this page.
  function openLink(url) {
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error('The server returned an invalid link.'); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('The server returned an invalid link.');
    window.open(parsed.href, '_blank', 'noopener,noreferrer');
  }

  function wireLogout() {
    const btn = document.getElementById('logout');
    if (btn) btn.addEventListener('click', toLogin);
  }

  return { api, el, guard, showMessage, formatDate, timeLeft, validId, reviewLink, openLink, wireLogout };
})();
