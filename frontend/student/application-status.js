// application-status.js — logic for student/application-status.html?id=<applicationId>
// Owner: Mohamed Khalil   ·   Rules: CLAUDE.md §6 (withdraw only while submitted), §8, §10
//
// There is no GET /api/applications/{id} route (CLAUDE.md §8), so this page reads GET /api/applications/mine
// and picks the one with this id. The student never sees the reviewer, scores or flag (the API doesn't send them).
// GET /api/applications/{id}/pdf → 200 { url, expiresIn: 300 } · DELETE /api/applications/{id} → 204 (409 if picked up)

(() => {
  if (!startPage('student')) return;

  const $ = (id) => document.getElementById(id);
  const message = $('message');
  const params = new URLSearchParams(window.location.search);
  const applicationId = params.get('id');

  const STATUS_LABELS = {
    submitted: 'Submitted, waiting for a reviewer',
    under_review: 'Being reviewed',
    reviewed: 'Review finished, waiting for a decision',
    accepted: 'Accepted',
    rejected: 'Rejected',
  };

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

  async function load() {
    showMessage(message, 'Loading your application…', 'info');
    try {
      const app = (await apiRequest('/api/applications/mine')).find((a) => a.applicationId === applicationId);
      if (!app) {
        showMessage(message, 'Application not found. It may have been withdrawn.');
        return;
      }
      render(app);
      // Fixed text for ?submitted=1 (set by apply.html); the value is never shown.
      showMessage(message, params.get('submitted') === '1' ? 'Your application was submitted.' : '', 'success');
    } catch (err) {
      showMessage(message, err.message);
    }
  }

  if (!validId(applicationId)) {
    showMessage(message, 'No application selected. Open one from My applications.', 'info');
    return;
  }

  $('pdf').addEventListener('click', async (e) => {
    const done = busy(e.currentTarget, 'Getting the link…');
    try {
      const { url } = await apiRequest(`/api/applications/${encodeURIComponent(applicationId)}/pdf`);
      openLink(url);
      showMessage(message, '');
    } catch (err) {
      showMessage(message, err.message);
    } finally {
      done();
    }
  });

  $('withdraw').addEventListener('click', async (e) => {
    if (!window.confirm('Withdraw this application? Your PDF is deleted too. You can apply again before the deadline.')) return;
    const done = busy(e.currentTarget, 'Withdrawing…');
    try {
      await apiRequest(`/api/applications/${encodeURIComponent(applicationId)}`, { method: 'DELETE' });
      window.location.replace('my-applications.html?withdrawn=1');
    } catch (err) {
      showMessage(message, err.message); // 409: already picked up by a reviewer, or the deadline passed
      done();
    }
  });

  load();
})();
