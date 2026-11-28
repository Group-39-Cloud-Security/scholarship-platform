// scholarships.js — logic for student/scholarships.html
// Owner: Mohamed Khalil   ·   Rules: CLAUDE.md §8 (GET /api/scholarships?search=), §10 (textContent only)
//
// GET /api/scholarships?search= → 200 [ { scholarshipId, title, description, deadline, awards, isOpen, eligibility } ]
// Published only, earliest deadline first. isOpen is false after the deadline (listed, but no Apply link).

(() => {
  if (!startPage('student')) return;

  const $ = (id) => document.getElementById(id);
  const message = $('message');
  const table = $('scholarships');
  const empty = $('empty');

  // "GPA 3.0+ · years 2, 3 · example-university.edu" — an empty rule means no restriction.
  function eligibilityText(e = {}) {
    const parts = [];
    if (typeof e.minGpa === 'number' && e.minGpa > 0) parts.push(`GPA ${e.minGpa}+`);
    if (Array.isArray(e.years) && e.years.length) parts.push(`year ${e.years.join(', ')}`);
    if (Array.isArray(e.allowedDomains) && e.allowedDomains.length) parts.push(e.allowedDomains.join(', '));
    return parts.length ? parts.join(' · ') : 'Everyone';
  }

  function render(items) {
    const rows = items.filter((s) => validId(s.scholarshipId)).map((s) => el('tr', {},
      el('td', {}, el('strong', {}, s.title), el('br'), el('span', { className: 'hint' }, s.description)),
      el('td', {}, formatDate(s.deadline)),
      el('td', { className: 'num' }, s.awards),
      el('td', {}, eligibilityText(s.eligibility)),
      el('td', {}, s.isOpen
        ? el('a', { href: `apply.html?scholarship=${encodeURIComponent(s.scholarshipId)}` }, 'Apply')
        : el('span', { className: 'hint' }, 'Deadline passed'))));
    table.querySelector('tbody').replaceChildren(...rows);
    table.hidden = rows.length === 0;
    empty.hidden = rows.length !== 0;
  }

  async function load(search) {
    const button = $('search-form').querySelector('button');
    const done = busy(button, 'Loading…');
    showMessage(message, 'Loading scholarships…', 'info');
    try {
      const query = search ? `?search=${encodeURIComponent(search)}` : '';
      render(await apiRequest(`/api/scholarships${query}`));
      showMessage(message, '');
    } catch (err) {
      table.hidden = true;
      empty.hidden = true;
      showMessage(message, err.message);
    } finally {
      done();
    }
  }

  $('search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    load($('search').value.trim());
  });

  load('');
})();
