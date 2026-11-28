// users.js — logic for admin/users.html: list accounts, create a reviewer, disable or enable
// Owner: Mohamed Wael   ·   Rules: CLAUDE.md §6 Accounts, §8, §10 (textContent only)
//
// GET   /api/admin/users?role=&status=        → 200 [ { userId, email, name, role, status, mustChangePassword, createdAt } ]
// POST  /api/admin/users { email, name }      → 201 the account + temporaryPassword (the ONLY reply that has it)
// PATCH /api/admin/users/{id}/status { status: 'active' | 'disabled' } → 200 (409 for yourself / already in that status)
// The temporary password is shown once, kept only in the page (never in storage or the URL), and cleared on hide.

(() => {
  if (!AdminUI.start()) return;

  const $ = (id) => document.getElementById(id);
  const message = $('message');
  const me = AdminUI.myUserId();
  const ROLE = { student: 'Student', reviewer: 'Reviewer', admin: 'Admin' };

  function hideTemp() {
    $('temp-password').textContent = '';
    $('temp-email').textContent = '';
    $('temp').hidden = true;
  }

  async function setStatus(user, to, button) {
    const text = to === 'disabled'
      ? `Disable ${user.email}? They are blocked on their next request.`
      : `Enable ${user.email} again?`;
    if (!window.confirm(text)) return;
    const done = busy(button, to === 'disabled' ? 'Disabling…' : 'Enabling…');
    try {
      const u = await apiRequest(`/api/admin/users/${encodeURIComponent(user.userId)}/status`, { method: 'PATCH', body: { status: to } });
      showMessage(message, `${u.email} is now ${u.status}.`, 'success');
      await load(false);
    } catch (err) {
      showMessage(message, err.message); // 409: your own account, already in that status, or the other admin got there first
    } finally {
      done();
    }
  }

  function render(users) {
    const rows = users.filter((u) => validId(u.userId)).map((u) => {
      let action;
      if (u.userId === me) {
        action = el('span', { className: 'hint' }, 'You');
      } else {
        const to = u.status === 'active' ? 'disabled' : 'active';
        action = el('button', { type: 'button', className: to === 'disabled' ? 'danger' : 'secondary' },
          to === 'disabled' ? 'Disable' : 'Enable');
        action.addEventListener('click', () => setStatus(u, to, action));
      }
      return el('tr', {},
        el('td', {}, u.name || '-'),
        el('td', {}, u.email),
        el('td', {}, ROLE[u.role] || u.role, u.mustChangePassword ? el('span', { className: 'hint' }, ' (temporary password)') : null),
        el('td', {}, u.status),
        el('td', {}, formatDate(u.createdAt)),
        el('td', {}, action));
    });
    AdminUI.fillTable($('users'), $('empty'), rows);
  }

  async function load(clearMessage = true) {
    const q = new URLSearchParams();
    if ($('role').value) q.set('role', $('role').value);
    if ($('status').value) q.set('status', $('status').value);
    if (clearMessage) showMessage(message, 'Loading accounts…', 'info');
    try {
      render(await apiRequest(`/api/admin/users${q.toString() ? `?${q}` : ''}`));
      if (clearMessage) showMessage(message, '');
    } catch (err) {
      $('users').hidden = true;
      $('empty').hidden = true;
      showMessage(message, err.message);
    }
  }

  $('filters').addEventListener('submit', (e) => { e.preventDefault(); load(); });

  $('create').addEventListener('submit', async (e) => {
    e.preventDefault();
    hideTemp();
    const done = busy($('create-btn'), 'Creating…');
    try {
      const u = await apiRequest('/api/admin/users', { method: 'POST', body: { email: $('email').value, name: $('name').value } });
      $('temp-email').textContent = u.email;
      $('temp-password').textContent = u.temporaryPassword;
      $('temp').hidden = false;
      $('create').reset();
      showMessage(message, `Reviewer ${u.email} created.`, 'success');
      await load(false);
    } catch (err) {
      showMessage(message, err.message); // 400 invalid email/name, 409 email already used
    } finally {
      done();
    }
  });
  $('temp-hide').addEventListener('click', hideTemp);
  window.addEventListener('pagehide', hideTemp); // don't leave it in a page the browser keeps for Back

  load();
})();
