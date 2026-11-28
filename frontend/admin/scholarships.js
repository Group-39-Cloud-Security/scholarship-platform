// scholarships.js — logic for admin/scholarships.html: list, publish, close, open a draft for editing
// Owner: Mohamed Wael   ·   Rules: CLAUDE.md §6 (draft → published → closed), §8, §10 (textContent only)
//
// The admin API has no "list scholarships" route, so the list comes from the audit log:
//   GET /api/admin/audit-log?action=scholarship_created | scholarship_published | scholarship_closed
// The status shown is worked out from those rows; the server decides for real when a button is pressed:
//   PATCH /api/admin/scholarships/{id}/status { status: 'published' | 'closed' } → 200 the whole scholarship
//   409 with the reason (deadline passed, not a draft, already closed ...), which is shown as it comes.

(() => {
  if (!AdminUI.start()) return;

  const $ = (id) => document.getElementById(id);
  const message = $('message');
  const known = new Map(); // scholarshipId → { createdAt, status, title }

  async function changeStatus(id, to, button) {
    const verb = to === 'published' ? 'Publish' : 'Close';
    const warning = to === 'published'
      ? 'Publish this scholarship? Students can apply right away, and the rubric, eligibility and deadline are locked.'
      : 'Close this scholarship? No new applications are accepted; reviewing and deciding go on.';
    if (!window.confirm(warning)) return;
    const done = busy(button, `${verb}ing…`);
    try {
      const s = await apiRequest(`/api/admin/scholarships/${encodeURIComponent(id)}/status`, { method: 'PATCH', body: { status: to } });
      const entry = known.get(id) || { createdAt: s.createdAt };
      known.set(id, { ...entry, status: s.status, title: s.title });
      showMessage(message, `"${s.title}" is now ${s.status}.`, 'success');
      render();
    } catch (err) {
      showMessage(message, err.message);
    } finally {
      done();
    }
  }

  function editLink(id) {
    return el('a', { href: `scholarship-edit.html?id=${encodeURIComponent(id)}` }, 'Edit');
  }

  function render() {
    const rows = [...known.entries()]
      .sort((a, b) => String(b[1].createdAt).localeCompare(String(a[1].createdAt)))
      .map(([id, s]) => {
        const actions = el('div', { className: 'actions' });
        if (s.status === 'draft') {
          const publish = el('button', { type: 'button' }, 'Publish');
          publish.addEventListener('click', () => changeStatus(id, 'published', publish));
          actions.append(editLink(id), publish);
        } else if (s.status === 'published') {
          const close = el('button', { type: 'button', className: 'secondary' }, 'Close');
          close.addEventListener('click', () => changeStatus(id, 'closed', close));
          actions.append(close);
        }
        return el('tr', {},
          el('td', {}, s.title ? el('strong', {}, s.title) : null, s.title ? el('br') : null,
            el('span', { className: 'mono hint', title: id }, id)),
          el('td', {}, formatDate(s.createdAt)),
          el('td', {}, s.status),
          el('td', {}, actions));
      });
    AdminUI.fillTable($('list'), $('empty'), rows);
  }

  async function load() {
    showMessage(message, 'Loading scholarships…', 'info');
    try {
      const [created, published, closed] = await Promise.all(
        ['scholarship_created', 'scholarship_published', 'scholarship_closed'].map((a) => AdminUI.auditRows(a)),
      );
      const ids = (rows) => new Set(rows.map((r) => r.targetId));
      const pub = ids(published);
      const clo = ids(closed);
      created.filter((r) => AdminUI.isUuid(r.targetId)).forEach((r) => {
        const status = clo.has(r.targetId) ? 'closed' : pub.has(r.targetId) ? 'published' : 'draft';
        known.set(r.targetId, { createdAt: r.createdAt, status, title: (known.get(r.targetId) || {}).title });
      });
      render();
      showMessage(message, '');
    } catch (err) {
      $('list').hidden = true;
      $('empty').hidden = true;
      showMessage(message, err.message);
    }
  }

  // "Open by id": any scholarship, also ones not in the list.
  function idFromBox() {
    const id = AdminUI.cleanId($('sid').value);
    if (!AdminUI.isUuid(id)) {
      showMessage(message, 'Enter a scholarship id (a UUID like 8a48f941-640d-46cc-b921-78dae29152bc).');
      return null;
    }
    return id;
  }
  $('by-id').addEventListener('submit', (e) => {
    e.preventDefault();
    const id = idFromBox();
    if (id) changeStatus(id, 'published', e.submitter || $('by-id').querySelector('button'));
  });
  $('close-by-id').addEventListener('click', (e) => {
    const id = idFromBox();
    if (id) changeStatus(id, 'closed', e.currentTarget);
  });
  $('edit-by-id').addEventListener('click', () => {
    const id = idFromBox();
    if (id) window.location.href = `scholarship-edit.html?id=${encodeURIComponent(id)}`;
  });

  load();
})();
