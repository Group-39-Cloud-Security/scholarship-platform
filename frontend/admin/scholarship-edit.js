// scholarship-edit.js — logic for admin/scholarship-edit.html (new draft, or ?id= to replace a draft)
// Owner: Mohamed Wael   ·   Rules: CLAUDE.md §6 (rubric sums to 100, locked on publish), §8, §10 (textContent only)
//
// POST /api/admin/scholarships            → 201 the new draft
// PUT  /api/admin/scholarships/{id}       → 200 (only while draft; replaces every editable field; 409 after publish)
// PATCH /api/admin/scholarships/{id}/status { status: 'published' } → 200 (409 with the reason, e.g. deadline passed)
// GET  /api/admin/scholarships/{id}       → 200 the current values, so editing starts from them
// The checks on this page only help the admin; the server checks everything again and its message is shown.

(() => {
  if (!AdminUI.start()) return;

  const $ = (id) => document.getElementById(id);
  const message = $('message');
  const params = new URLSearchParams(window.location.search);
  let scholarshipId = params.has('id') ? AdminUI.cleanId(params.get('id')) : null;
  const DEFAULT_RUBRIC = [ // same default as the seed data
    ['academic', 'Academic record', 'Grades and transcript', 40],
    ['essay', 'Essay', 'Clarity, motivation and fit', 40],
    ['need', 'Financial need', 'Evidence of financial need', 20],
  ];

  function setMode() {
    if (!scholarshipId) return;
    $('heading').textContent = 'Edit draft';
    $('mode-hint').textContent = `Scholarship ${scholarshipId}. Change what you need and save. `
      + 'A published or closed scholarship can no longer be edited.';
    $('save').textContent = 'Save changes';
  }

  // ---- rubric rows ----
  function addCriterion([id = '', name = '', description = '', weight = ''] = []) {
    if ($('criteria').children.length >= 6) return;
    const input = (props) => {
      const i = el('input', props);
      i.addEventListener('input', updateTotal);
      return i;
    };
    const remove = el('button', { type: 'button', className: 'link' }, 'Remove');
    const row = el('tr', {},
      el('td', {}, input({ className: 'cid', value: id, maxLength: 30, ariaLabel: 'Criterion id' })),
      el('td', {}, input({ className: 'cname', value: name, maxLength: 60, ariaLabel: 'Criterion name' })),
      el('td', {}, input({ className: 'cdesc', value: description, maxLength: 300, ariaLabel: 'What the reviewer scores' })),
      el('td', { className: 'weight' }, input({ className: 'cweight', type: 'number', min: 1, max: 100, step: 1, value: weight, ariaLabel: 'Weight' })),
      el('td', {}, remove));
    remove.addEventListener('click', () => { row.remove(); updateTotal(); });
    $('criteria').append(row);
    updateTotal();
  }

  function updateTotal() {
    const weights = [...document.querySelectorAll('.cweight')].map((i) => Number(i.value) || 0);
    const sum = weights.reduce((a, b) => a + b, 0);
    $('total').textContent = `${weights.length} criteria, weights sum to ${sum}${sum === 100 ? '' : ' (must be 100)'}`;
    $('add').disabled = weights.length >= 6;
  }

  // ---- years 1-6 ----
  $('years').replaceChildren(...[1, 2, 3, 4, 5, 6].map((y) => el('label', {},
    el('input', { type: 'checkbox', value: String(y), className: 'year', checked: true }), `Year ${y}`)));

  function readForm() {
    const num = (v) => (v === '' ? NaN : Number(v));
    const deadline = AdminUI.localToIso($('deadline').value);
    if (!deadline) throw new Error('Choose a deadline (date and time).');
    return {
      title: $('title').value,
      description: $('description').value,
      deadline,
      awards: num($('awards').value),
      rubric: [...$('criteria').children].map((row) => ({
        criterionId: row.querySelector('.cid').value.trim(),
        name: row.querySelector('.cname').value,
        description: row.querySelector('.cdesc').value,
        weight: num(row.querySelector('.cweight').value),
      })),
      eligibility: {
        allowedDomains: $('domains').value.split(',').map((d) => d.trim()).filter(Boolean),
        minGpa: num($('mingpa').value),
        years: [...document.querySelectorAll('.year:checked')].map((c) => Number(c.value)),
      },
    };
  }

  function showSaved(s) {
    const rows = [
      ['Title', s.title], ['Status', s.status], ['Deadline', formatDate(s.deadline)], ['Awards', s.awards],
      ['Rubric', (s.rubric || []).map((c) => `${c.name} ${c.weight}`).join(', ')],
      ['Domains', ((s.eligibility || {}).allowedDomains || []).join(', ')],
      ['Minimum GPA', (s.eligibility || {}).minGpa], ['Years', ((s.eligibility || {}).years || []).join(', ')],
      ['Id', s.scholarshipId],
    ];
    $('facts').replaceChildren(...rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v === undefined ? '-' : v)]));
    $('publish').hidden = s.status !== 'draft';
    $('saved').hidden = false;
  }

  $('add').addEventListener('click', () => addCriterion());

  $('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    let body;
    try { body = readForm(); } catch (err) { showMessage(message, err.message); return; }
    const done = busy($('save'), 'Saving…');
    try {
      const s = scholarshipId
        ? await apiRequest(`/api/admin/scholarships/${encodeURIComponent(scholarshipId)}`, { method: 'PUT', body })
        : await apiRequest('/api/admin/scholarships', { method: 'POST', body });
      if (!scholarshipId && AdminUI.isUuid(s.scholarshipId)) {
        scholarshipId = s.scholarshipId; // further saves edit this draft
        window.history.replaceState(null, '', `?id=${encodeURIComponent(scholarshipId)}`);
        setMode();
      }
      showMessage(message, `Draft "${s.title}" saved.`, 'success');
      showSaved(s);
    } catch (err) {
      showMessage(message, err.message); // e.g. "Rubric weights must sum to 100 (they sum to 90)."
    } finally {
      done();
    }
  });

  $('publish').addEventListener('click', async (e) => {
    if (!scholarshipId) return;
    if (!window.confirm('Publish now? Students can apply right away, and the rubric, eligibility and deadline are locked.')) return;
    const done = busy(e.currentTarget, 'Publishing…');
    try {
      const s = await apiRequest(`/api/admin/scholarships/${encodeURIComponent(scholarshipId)}/status`, { method: 'PATCH', body: { status: 'published' } });
      showMessage(message, `"${s.title}" is published. Students can apply now.`, 'success');
      showSaved(s);
    } catch (err) {
      showMessage(message, err.message); // e.g. "The deadline has passed. Set a future deadline before publishing."
    } finally {
      done();
    }
  });

  if (params.has('id') && !AdminUI.isUuid(scholarshipId)) {
    $('form').hidden = true;
    showMessage(message, 'That scholarship id is not valid. Open a draft from the Scholarships page.');
    return;
  }
  // ISO 8601 UTC → the value a datetime-local input wants, in the admin's local time ("2027-01-15T23:59").
  function isoToLocal(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }

  function fill(s) {
    $('title').value = s.title || '';
    $('description').value = s.description || '';
    $('deadline').value = isoToLocal(s.deadline);
    $('awards').value = s.awards;
    $('criteria').replaceChildren();
    (s.rubric || []).forEach((c) => addCriterion([c.criterionId, c.name, c.description, c.weight]));
    const e = s.eligibility || {};
    $('domains').value = (e.allowedDomains || []).join(', ');
    $('mingpa').value = typeof e.minGpa === 'number' ? e.minGpa : 0;
    document.querySelectorAll('.year').forEach((c) => { c.checked = (e.years || []).includes(Number(c.value)); });
  }

  async function loadDraft() {
    showMessage(message, 'Loading the scholarship…', 'info');
    try {
      const s = await apiRequest(`/api/admin/scholarships/${encodeURIComponent(scholarshipId)}`);
      fill(s);
      if (s.status !== 'draft') {
        // Locked after publishing (§6): show the values, don't offer a save the server would refuse with 409.
        $('form').querySelectorAll('input, textarea, button').forEach((n) => { n.disabled = true; });
        $('save').hidden = true;
        showMessage(message, `This scholarship is ${s.status}, so it can no longer be edited.`, 'info');
        showSaved(s);
        return;
      }
      showMessage(message, '');
    } catch (err) {
      $('form').hidden = true;
      showMessage(message, err.message); // 404 unknown id
    }
  }

  setMode();
  if (scholarshipId) loadDraft();
  else DEFAULT_RUBRIC.forEach(addCriterion);
})();
