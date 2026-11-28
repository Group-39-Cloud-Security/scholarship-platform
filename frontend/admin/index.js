// index.js — logic for admin/index.html: API health and live counts
// Owner: Mohamed Wael   ·   Rules: CLAUDE.md §8 (GET /api/health, GET /api/admin/stats), §10 (textContent only)
//
// GET /api/admin/stats → 200 { scholarships: { draft, published, closed },
//                              applications: { submitted, under_review, reviewed, accepted, rejected } }

(() => {
  if (!AdminUI.start()) return;

  const $ = (id) => document.getElementById(id);
  const LABELS = {
    draft: 'Draft', published: 'Published', closed: 'Closed',
    submitted: 'Submitted', under_review: 'Under review', reviewed: 'Reviewed, to decide', accepted: 'Accepted', rejected: 'Rejected',
  };

  function counts(list, obj, keys) {
    list.replaceChildren(...keys.map((k) => el('li', {}, el('strong', {}, Number.isInteger(obj && obj[k]) ? obj[k] : '-'), LABELS[k])));
  }

  async function load() {
    showMessage($('message'), 'Loading…', 'info');
    try {
      const stats = await apiRequest('/api/admin/stats');
      counts($('scholarship-counts'), stats.scholarships, ['draft', 'published', 'closed']);
      counts($('application-counts'), stats.applications, ['submitted', 'under_review', 'reviewed', 'accepted', 'rejected']);
      showMessage($('message'), '');
    } catch (err) {
      showMessage($('message'), err.message);
    }
    try {
      const health = await apiRequest('/api/health', { auth: false });
      $('health').textContent = health && health.status === 'ok' ? `ok (${health.runtime})` : 'not ok';
    } catch (err) {
      $('health').textContent = `not reachable (${err.message})`;
    }
  }

  load();
})();
