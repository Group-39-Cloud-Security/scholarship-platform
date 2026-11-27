// my-reviews.js - logic for reviewer/my-reviews.html: open claims (time left, release) + submitted reviews
// Owner: Mohamed Hazem   ·   Rules: CLAUDE.md §8 (GET /api/reviews/mine, DELETE /api/reviews/{id}), §10

(() => {
  const { api, el, guard, showMessage, formatDate, timeLeft, validId, reviewLink, wireLogout } = ReviewerUI;
  guard();
  wireLogout();

  const $ = (id) => document.getElementById(id);
  const message = $('message');
  const FLAG_LABELS = {
    incomplete_documents: 'Incomplete documents',
    ineligible: 'Ineligible',
    plagiarism_suspected: 'Plagiarism suspected',
    other: 'Other',
  };

  async function release(applicationId, button) {
    if (!window.confirm('Give this application back to the queue?')) return;
    button.disabled = true;
    try {
      await api(`/api/reviews/${encodeURIComponent(applicationId)}`, { method: 'DELETE' });
      showMessage(message, 'Released back to the queue.', 'success');
      load();
    } catch (err) {
      showMessage(message, err.message);
      button.disabled = false;
    }
  }

  function fill(tableId, emptyId, rows) {
    const table = $(tableId);
    table.querySelector('tbody').replaceChildren(...rows);
    table.hidden = rows.length === 0;
    $(emptyId).hidden = rows.length !== 0;
  }

  async function load() {
    try {
      const { claims, reviews } = await api('/api/reviews/mine');

      fill('claims', 'claims-empty', claims.filter((c) => validId(c.applicationId)).map((c) => {
        const button = el('button', { type: 'button', className: 'secondary' }, 'Release');
        button.addEventListener('click', () => release(c.applicationId, button));
        return el('tr', {},
          el('td', {}, c.scholarshipTitle || 'Untitled scholarship'),
          el('td', {}, formatDate(c.claimedAt)),
          el('td', {}, timeLeft(c.expiresAt)),
          el('td', {}, reviewLink(c.applicationId, 'Continue'), ' ', button));
      }));

      fill('reviews', 'reviews-empty', reviews.filter((r) => validId(r.applicationId)).map((r) => el('tr', {},
        el('td', {}, r.scholarshipTitle || 'Untitled scholarship'),
        el('td', {}, r.flagged ? `Flagged: ${FLAG_LABELS[r.flagReason] || r.flagReason}` : `${r.totalScore} / 100`),
        el('td', {}, formatDate(r.submittedAt)),
        el('td', {}, reviewLink(r.applicationId, 'View')))));
    } catch (err) {
      showMessage(message, err.message);
    }
  }

  load();
})();
