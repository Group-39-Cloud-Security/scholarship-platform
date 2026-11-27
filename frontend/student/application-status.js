// application-status.js — logic for student/application-status.html?id=<applicationId>  (STUB: not connected yet)
// Owner: Mohamed Khalil   ·   Rules: CLAUDE.md §6 (withdraw only while submitted), §8, §10
//
// There is no GET /api/applications/{id} route (CLAUDE.md §8), so this page reads GET /api/applications/mine
// and picks the one with this id. The student never sees the reviewer, scores or flag (the API doesn't send them).

(() => {
  if (!startPage('student')) return;

  const $ = (id) => document.getElementById(id);
  const message = $('message');
  const applicationId = new URLSearchParams(window.location.search).get('id');

  const STATUS_LABELS = {
    submitted: 'Submitted, waiting for a reviewer',
    under_review: 'Being reviewed',
    reviewed: 'Review finished, waiting for a decision',
    accepted: 'Accepted',
    rejected: 'Rejected',
  };

  // app = one item from GET /api/applications/mine (with timeline[] and canWithdraw).
  function render(app) {
    $('title').textContent = app.scholarshipTitle || 'Application status';
    $('status').textContent = STATUS_LABELS[app.status] || app.status;
    $('submitted').textContent = formatDate(app.submittedAt);
    $('deadline').textContent = formatDate(app.deadline);
    $('timeline').replaceChildren(...(app.timeline || []).map((step) => el('li', { className: step.done ? 'done' : 'todo' },
      step.label, step.at ? ` (${formatDate(step.at)})` : '')));
    $('withdraw').hidden = !app.canWithdraw; // the server checks again: 409 if a reviewer picked it up meanwhile
    $('details').hidden = false;
  }

  if (!validId(applicationId)) {
    showMessage(message, 'No application selected. Open one from My applications.', 'info');
    return;
  }

  // TODO: the real call goes here:
  //   const app = (await apiRequest('/api/applications/mine')).find((a) => a.applicationId === applicationId);
  //   if (!app) showMessage(message, 'Application not found.'); else render(app);
  showMessage(message, 'The status and timeline of this application will show here. Not connected to the API yet (TODO).', 'info');

  $('pdf').addEventListener('click', () => {
    // TODO: const { url } = await apiRequest(`/api/applications/${encodeURIComponent(applicationId)}/pdf`);
    //       open only an http(s) link, in a new tab with 'noopener,noreferrer' (see reviewer-common.js openLink).
    showMessage(message, 'PDF download is not connected to the API yet (TODO).', 'info');
  });

  $('withdraw').addEventListener('click', () => {
    // TODO: if (!confirm('Withdraw this application? Your PDF is deleted too.')) return;
    //       await apiRequest(`/api/applications/${encodeURIComponent(applicationId)}`, { method: 'DELETE' });  // 204
    //       window.location.href = 'my-applications.html';   // 409: show err.message (already picked up / deadline passed)
    showMessage(message, 'Withdraw is not connected to the API yet (TODO).', 'info');
  });
})();
