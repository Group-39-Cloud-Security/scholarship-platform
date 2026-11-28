// admin-common.js — helpers shared by the admin pages. Loaded after ../js/nav.js (el, showMessage, busy, formatDate).
// Owner: Mohamed Wael   ·   Rules: CLAUDE.md §8 (admin-service API), §10 (textContent only, token in sessionStorage)
//
// The admin links live here, not in js/nav.js (a shared file): every admin page shows them under its title.
// Nothing here is security. admin-service checks the token and the admin role on every call (401/403).

const AdminUI = (() => {
  const PAGES = [
    ['Overview', 'index.html'],
    ['Scholarships', 'scholarships.html'],
    ['New scholarship', 'scholarship-edit.html'],
    ['Applications', 'applications.html'],
    ['Users', 'users.html'],
    ['Audit log', 'audit.html'],
  ];
  // admin-service only accepts lowercase UUIDs for scholarships and applications.
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  function subnav() {
    const nav = document.getElementById('admin-nav');
    if (!nav) return;
    const here = window.location.pathname.split('/').pop() || 'index.html';
    nav.replaceChildren(...PAGES.map(([text, page]) => {
      const link = el('a', { href: page }, text);
      if (page === here) link.setAttribute('aria-current', 'page');
      return link;
    }));
  }

  // Login check, admin role check and the admin links. Returns true when the page's own code may run.
  function start() {
    if (!startPage('admin')) return false;
    subnav();
    return true;
  }

  // The logged-in admin's userId (the token's sub), only to mark "you" in the users list. Not checked here:
  // the backend refuses to let an admin disable their own account (409) whatever the page shows.
  function myUserId() {
    const token = Auth.getToken();
    const part = token ? token.split('.')[1] : '';
    try {
      const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='))).sub || null;
    } catch {
      return null;
    }
  }

  const cleanId = (value) => String(value || '').trim().toLowerCase();
  const isUuid = (value) => UUID.test(value);
  const shortId = (id) => (typeof id === 'string' ? id.slice(0, 8) : '-');

  // A monospace short id with the full id as a tooltip.
  function idCell(id) {
    return el('td', { className: 'mono', title: id || '' }, shortId(id));
  }

  // <input type="datetime-local"> value (the admin's local time) → ISO 8601 UTC with Z, or null.
  function localToIso(value) {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  // Shows the rows of a table, or the empty note when there are none.
  function fillTable(table, empty, rows) {
    table.querySelector('tbody').replaceChildren(...rows);
    table.hidden = rows.length === 0;
    empty.hidden = rows.length !== 0;
  }

  return { start, myUserId, cleanId, isUuid, shortId, idCell, localToIso, fillTable };
})();
