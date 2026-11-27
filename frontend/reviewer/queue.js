// queue.js - logic for reviewer/queue.html: list the queue, claim an application, go to its review page
// Owner: Mohamed Hazem   ·   Rules: CLAUDE.md §8 (GET /api/reviews/queue, POST /api/reviews), §10 (textContent only)

(() => {
  const { api, el, guard, showMessage, formatDate, validId, wireLogout } = ReviewerUI;
  guard();
  wireLogout();

  const message = document.getElementById('message');
  const table = document.getElementById('queue');
  const tbody = table.querySelector('tbody');
  const empty = document.getElementById('empty');

  async function claim(applicationId, button) {
    button.disabled = true;
    showMessage(message, '');
    try {
      await api('/api/reviews', { method: 'POST', body: { applicationId } });
      window.location.href = `review.html?id=${encodeURIComponent(applicationId)}`;
    } catch (err) {
      // 409: someone else claimed it first, or I already hold 5. Refresh so the list is current.
      showMessage(message, err.message);
      button.disabled = false;
      if (err.status === 409) load();
    }
  }

  async function load() {
    try {
      const items = await api('/api/reviews/queue');
      tbody.replaceChildren();
      items.filter((a) => validId(a.applicationId)).forEach((a) => {
        const button = el('button', { type: 'button' }, 'Claim');
        button.addEventListener('click', () => claim(a.applicationId, button));
        tbody.append(el('tr', {},
          el('td', {}, a.scholarshipTitle || 'Untitled scholarship'),
          el('td', {}, formatDate(a.submittedAt)),
          el('td', { className: 'mono' }, a.applicationId.slice(0, 8)),
          el('td', {}, button)));
      });
      table.hidden = items.length === 0;
      empty.hidden = items.length !== 0;
    } catch (err) {
      showMessage(message, err.message);
    }
  }

  load();
})();
