// change-password.js — logic for change-password.html
// Owner: Mohamed Khalil (shared shell)   ·   Rules: CLAUDE.md §6 (password ≥ 10, Pwned Passwords), §10
//
// PUT /api/auth/password { currentPassword, newPassword } → 200 the account (mustChangePassword now false)
// A wrong current password is a 400 (not 401), so a typo doesn't log the user out; 429 while blocked.

(() => {
  if (!Auth.requireLogin()) return;
  const $ = (id) => document.getElementById(id);
  const message = $('message');
  const forced = Auth.mustChangePassword();
  renderNav(Auth.getRole(), !forced); // only Log out while the change is required
  $('required').hidden = !forced;

  $('password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const currentPassword = $('current').value;
    const newPassword = $('new').value;
    if (!currentPassword) return showMessage(message, 'Enter your current password.');
    if (newPassword.length < 10) return showMessage(message, 'The new password must be at least 10 characters.');
    if (newPassword !== $('repeat').value) return showMessage(message, 'The two new passwords do not match.');
    if (newPassword === currentPassword) return showMessage(message, 'The new password must be different from the current one.');

    const done = busy(e.submitter || e.target.querySelector('button'), 'Saving…');
    showMessage(message, '');
    try {
      await apiRequest('/api/auth/password', { method: 'PUT', body: { currentPassword, newPassword } });
      Auth.setMustChangePassword(false);
      e.target.reset();
      $('required').hidden = true;
      showMessage(message, 'Your password has been changed.', 'success');
      if (forced) window.location.replace(Auth.homeUrl(Auth.getRole()));
      else done();
    } catch (err) {
      showMessage(message, err.message);
      done();
    }
  });
})();
