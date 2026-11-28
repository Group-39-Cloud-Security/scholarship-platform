// my-applications.js — logic for student/my-applications.html
// Owner: Mohamed Khalil   ·   Rules: CLAUDE.md §8 (GET /api/applications/mine), §10 (textContent only)
//
// GET /api/applications/mine → 200 [ { applicationId, scholarshipTitle, status, submittedAt, canWithdraw, ... } ]
// newest first, [] when none. Never the reviewer, scores, flag or essay.

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

  async function load() {
    showMessage(message, 'Loading your applications…', 'info');
    try {
      render(await apiRequest('/api/applications/mine'));
      // Fixed text for ?withdrawn=1 (set by application-status.html after a withdraw); the value is never shown.
      const withdrawn = new URLSearchParams(window.location.search).get('withdrawn') === '1';
      showMessage(message, withdrawn ? 'Your application was withdrawn and its PDF deleted.' : '', 'success');
    } catch (err) {
      showMessage(message, err.message); // a 401 has already sent the user to the login page
    }
  }

  load();
})();
