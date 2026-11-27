// my-applications.js — logic for student/my-applications.html  (STUB: not connected to the API yet)
// Owner: Mohamed Khalil   ·   Rules: CLAUDE.md §8 (GET /api/applications/mine), §10 (textContent only)

(() => {
  if (!startPage('student')) return;

  const message = document.getElementById('message');
  const table = document.getElementById('applications');
  const empty = document.getElementById('empty');

  const STATUS_LABELS = {
    submitted: 'Submitted',
    under_review: 'Being reviewed',
    reviewed: 'Review finished',
    accepted: 'Accepted',
    rejected: 'Rejected',
  };

  // items = the array from GET /api/applications/mine (newest first). Built with el(), so titles are text only.
  function render(items) {
    const rows = items.filter((a) => validId(a.applicationId)).map((a) => el('tr', {},
      el('td', {}, a.scholarshipTitle || 'Untitled scholarship'),
      el('td', {}, STATUS_LABELS[a.status] || a.status),
      el('td', {}, formatDate(a.submittedAt)),
      el('td', {}, el('a', { href: `application-status.html?id=${encodeURIComponent(a.applicationId)}` }, 'View status'))));
    table.querySelector('tbody').replaceChildren(...rows);
    table.hidden = rows.length === 0;
    empty.hidden = rows.length !== 0;
  }

  // TODO: the real call goes here:
  //   try {
  //     render(await apiRequest('/api/applications/mine'));   // 200 [] when there are none
  //   } catch (err) {
  //     showMessage(message, err.message);                    // 401 already sent the user to login
  //   }
  showMessage(message, 'Your applications will be listed here. Not connected to the API yet (TODO).', 'info');
})();
