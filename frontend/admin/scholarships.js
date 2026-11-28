// scholarships.js — logic for admin/scholarships.html: list, publish, close, open a draft or the applications
// Owner: Mohamed Wael   ·   Rules: CLAUDE.md §6 (draft → published → closed), §8, §10 (textContent only)
//
// GET   /api/admin/scholarships?status=                              → 200 [ scholarship, ... ] newest first
// PATCH /api/admin/scholarships/{id}/status { status: 'published' | 'closed' } → 200 the whole scholarship
//   409 with the reason (deadline passed, not a draft, already closed ...), shown as it comes.

(() => {
  if (!AdminUI.start()) return;

  const $ = (id) => document.getElementById(id);
  const message = $('message');

  async function changeStatus(s, to, button) {
    const warning = to === 'published'
      ? `Publish "${s.title}"? Students can apply right away, and the rubric, eligibility and deadline are locked.`
      : `Close "${s.title}"? No new applications are accepted; reviewing and deciding go on.`;
    if (!window.confirm(warning)) return;
    const done = busy(button, to === 'published' ? 'Publishing…' : 'Closing…');
    try {
      const updated = await apiRequest(`/api/admin/scholarships/${encodeURIComponent(s.scholarshipId)}/status`, {
        method: 'PATCH', body: { status: to },
      });
      showMessage(message, `"${updated.title}" is now ${updated.status}.`, 'success');
      await load(false);
    } catch (err) {
      showMessage(message, err.message);
    } finally {
      done();
    }
  }

  function row(s) {
    const id = encodeURIComponent(s.scholarshipId);
    const actions = el('div', { className: 'actions' });
    if (s.status === 'draft') {
      const publish = el('button', { type: 'button' }, 'Publish');
      publish.addEventListener('click', () => changeStatus(s, 'published', publish));
      actions.append(el('a', { href: `scholarship-edit.html?id=${id}` }, 'Edit'), publish);
    } else {
      if (s.status === 'published') {
        const close = el('button', { type: 'button', className: 'secondary' }, 'Close');
        close.addEventListener('click', () => changeStatus(s, 'closed', close));
        actions.append(close);
      }
      actions.append(el('a', { href: `applications.html?scholarship=${id}` }, 'Applications'));
    }
    return el('tr', {},
      el('td', {}, el('strong', {}, s.title), el('br'), el('span', { className: 'mono hint' }, s.scholarshipId)),
      el('td', {}, formatDate(s.deadline)),
      el('td', { className: 'num' }, `${Number.isInteger(s.acceptedCount) ? s.acceptedCount : 0} / ${s.awards}`),
      el('td', {}, s.status),
      el('td', {}, actions));
  }

  async function load(clearMessage = true) {
    const status = $('status').value;
    if (clearMessage) showMessage(message, 'Loading scholarships…', 'info');
    try {
      const items = await apiRequest(`/api/admin/scholarships${status ? `?status=${encodeURIComponent(status)}` : ''}`);
      AdminUI.fillTable($('list'), $('empty'), items.filter((s) => AdminUI.isUuid(s.scholarshipId)).map(row));
      if (clearMessage) showMessage(message, '');
    } catch (err) {
      $('list').hidden = true;
      $('empty').hidden = true;
      showMessage(message, err.message);
    }
  }

  $('filters').addEventListener('submit', (e) => { e.preventDefault(); load(); });
  load();
})();
