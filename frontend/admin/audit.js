// audit.js — logic for admin/audit.html: one event type at a time, newest first, page by page
// Owner: Mohamed Wael   ·   Rules: CLAUDE.md §8 (GET /api/admin/audit-log), §10 (textContent only)
//
// GET /api/admin/audit-log?action=&since=&limit=&next= → 200 { items: [ { action, createdAt, userId, targetId, detail } ], next }
// action is required (it's the table's key, so every call is one Query); next only works for the same action.
// detail is shown as plain text: audit rows never hold passwords, hashes or tokens.

(() => {
  if (!AdminUI.start()) return;

  const $ = (id) => document.getElementById(id);
  const message = $('message');
  // Same list as admin-service's src/controllers/audit.js.
  const ACTIONS = [
    ['login_failed', 'Failed login'], ['login', 'Login'], ['password_changed', 'Password changed'], ['forbidden', 'Forbidden (wrong role)'],
    ['decision', 'Decision'], ['scholarship_created', 'Scholarship created'], ['scholarship_updated', 'Scholarship updated'],
    ['scholarship_published', 'Scholarship published'], ['scholarship_closed', 'Scholarship closed'],
    ['user_created', 'User created'], ['user_disabled', 'User disabled'], ['user_enabled', 'User enabled'],
    ['claim', 'Claim'], ['release', 'Release'], ['claim_expired', 'Claim expired'], ['review', 'Review submitted'],
    ['pdf_download', 'PDF download'], ['email_sent', 'Email sent'], ['email_failed', 'Email failed'],
  ];
  const NAMES = Object.fromEntries(ACTIONS);
  $('action').replaceChildren(...ACTIONS.map(([value, text]) => el('option', { value }, text)));

  let query = null; // the query of the rows on screen, so "Load older" asks the same thing
  let next = null;

  function rowsOf(items) {
    return items.map((r) => el('tr', {},
      el('td', {}, formatDate(r.createdAt)),
      el('td', {}, NAMES[r.action] || r.action),
      AdminUI.idCell(r.userId),
      el('td', { className: 'mono' }, r.targetId || '-'),
      el('td', {}, r.detail || '-')));
  }

  async function fetchPage(append) {
    const params = new URLSearchParams(query);
    if (append && next) params.set('next', next);
    const button = append ? $('more') : $('query').querySelector('button');
    const done = busy(button, 'Loading…');
    try {
      const data = await apiRequest(`/api/admin/audit-log?${params}`);
      const items = Array.isArray(data.items) ? data.items : [];
      const tbody = $('rows').querySelector('tbody');
      if (append) tbody.append(...rowsOf(items));
      else AdminUI.fillTable($('rows'), $('empty'), rowsOf(items));
      next = data.next || null;
      $('more').hidden = !next;
      showMessage(message, '');
    } catch (err) {
      showMessage(message, err.message); // 400: bad since, limit outside 1-100 …
    } finally {
      done();
    }
  }

  $('query').addEventListener('submit', (e) => {
    e.preventDefault();
    const params = new URLSearchParams({ action: $('action').value, limit: $('limit').value || '50' });
    if ($('since').value) {
      const since = AdminUI.localToIso($('since').value);
      if (!since) { showMessage(message, 'The "since" date is not valid.'); return; }
      params.set('since', since);
    }
    query = params.toString();
    next = null;
    fetchPage(false);
  });
  $('more').addEventListener('click', () => fetchPage(true));

  $('query').requestSubmit(); // start with failed logins: the security event an admin checks first
})();
