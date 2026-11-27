// review.js - logic for reviewer/review.html?id=<applicationId>
// Owner: Mohamed Hazem   ·   Rules: CLAUDE.md §6 Reviewing, §8 (GET/PUT/DELETE /api/reviews/{id}, GET .../pdf), §10
// The total on this page is only a preview. The server calculates the real one.

(() => {
  const { api, el, guard, showMessage, formatDate, timeLeft, validId, openLink, wireLogout } = ReviewerUI;
  guard();
  wireLogout();

  const $ = (id) => document.getElementById(id);
  const message = $('message');
  const applicationId = new URLSearchParams(window.location.search).get('id');
  const path = validId(applicationId) ? `/api/reviews/${encodeURIComponent(applicationId)}` : null;
  let rubric = [];

  const FLAG_LABELS = {
    incomplete_documents: 'Incomplete documents',
    ineligible: 'Ineligible',
    plagiarism_suspected: 'Plagiarism suspected',
    other: 'Other',
  };

  function renderEligibility(e) {
    if (!e) return 'No eligibility rules recorded.';
    const parts = [];
    if (Array.isArray(e.allowedDomains) && e.allowedDomains.length) parts.push(`email domains: ${e.allowedDomains.join(', ')}`);
    if (typeof e.minGpa === 'number') parts.push(`minimum GPA: ${e.minGpa}`);
    if (Array.isArray(e.years) && e.years.length) parts.push(`years of study: ${e.years.join(', ')}`);
    return parts.length ? `Check the PDF against: ${parts.join(', ')}. Flag as "Ineligible" if it doesn't match.` : 'No eligibility rules recorded.';
  }

  function renderRubric() {
    const tbody = $('rubric').querySelector('tbody');
    tbody.replaceChildren();
    rubric.forEach((c) => {
      const input = el('input', {
        type: 'number', min: 0, max: 10, step: 1, required: true, inputMode: 'numeric',
        id: `score-${c.criterionId}`, className: 'score',
      });
      input.addEventListener('input', updatePreview);
      tbody.append(el('tr', {},
        el('td', {}, el('label', { htmlFor: input.id }, c.name), el('div', { className: 'hint' }, c.description || '')),
        el('td', { className: 'num' }, `${c.weight}%`),
        el('td', {}, input)));
    });
  }

  // Reads the form; returns { scores } or throws with a message naming the first bad field.
  function readScores() {
    const scores = {};
    for (const c of rubric) {
      const raw = $(`score-${c.criterionId}`).value.trim();
      const value = Number(raw);
      if (raw === '' || !Number.isInteger(value) || value < 0 || value > 10) {
        throw new Error(`Give "${c.name}" a whole number from 0 to 10.`);
      }
      scores[c.criterionId] = value;
    }
    return scores;
  }

  function updatePreview() {
    try {
      const scores = readScores();
      const total = rubric.reduce((sum, c) => sum + scores[c.criterionId] * c.weight, 0) / 10;
      $('total-preview').textContent = String(Math.round(total * 100) / 100);
    } catch {
      $('total-preview').textContent = '-';
    }
  }

  function renderResult(review) {
    const dl = $('result');
    dl.replaceChildren();
    const row = (label, value) => dl.append(el('dt', {}, label), el('dd', {}, value));
    if (review.flagged) {
      row('Result', `Flagged: ${FLAG_LABELS[review.flagReason] || review.flagReason}`);
      if (review.flagNote) row('Note', review.flagNote);
    } else {
      row('Total score', `${review.totalScore} / 100`);
      rubric.forEach((c) => row(c.name, String(review.scores ? review.scores[c.criterionId] : '-')));
    }
    if (review.comment) row('Comment', review.comment);
    row('Submitted', formatDate(review.submittedAt));
    $('result-section').hidden = false;
  }

  async function load() {
    if (!path) {
      showMessage(message, 'No application selected. Open one from the queue or My reviews.');
      return;
    }
    try {
      const data = await api(path);
      const { application: app, scholarship, review } = data;
      rubric = scholarship && Array.isArray(scholarship.rubric) ? scholarship.rubric : [];

      $('title').textContent = scholarship ? `Review: ${scholarship.title}` : 'Review application';
      $('gpa').textContent = String(app.gpa ?? '-');
      $('year').textContent = String(app.yearOfStudy ?? '-');
      $('submitted').textContent = formatDate(app.submittedAt);
      $('eligibility').textContent = renderEligibility(scholarship && scholarship.eligibility);
      $('essay').textContent = app.essay || ''; // CSS keeps line breaks; textContent keeps any HTML as plain text
      $('details').hidden = false;

      const underReview = app.status === 'under_review';
      $('pdf').hidden = !(underReview && app.hasPdf);
      $('claim-info').textContent = underReview
        ? `Claimed ${formatDate(app.claimedAt)}, ${timeLeft(app.expiresAt)} before it goes back to the queue.`
        : `Status: ${app.status.replace('_', ' ')}`;

      $('score-section').hidden = !underReview;
      $('result-section').hidden = true;
      if (underReview) renderRubric();
      if (review) renderResult(review);
    } catch (err) {
      showMessage(message, err.status === 404
        ? 'Application not found, or it is not claimed by you.'
        : err.message);
    }
  }

  async function submit(body, confirmText, button) {
    if (!window.confirm(confirmText)) return;
    button.disabled = true;
    showMessage(message, '');
    try {
      await api(path, { method: 'PUT', body });
      showMessage(message, 'Review submitted.', 'success');
      await load();
    } catch (err) {
      showMessage(message, err.message);
      button.disabled = false;
    }
  }

  $('score-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const button = e.submitter || e.target.querySelector('button');
    let scores;
    try { scores = readScores(); } catch (err) { showMessage(message, err.message); return; }
    const comment = $('comment').value.trim();
    submit({ scores, ...(comment ? { comment } : {}) },
      `Submit a total of ${$('total-preview').textContent}/100? Scores cannot be changed afterwards.`, button);
  });

  $('flag-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const button = e.submitter || e.target.querySelector('button');
    const flagReason = $('flag-reason').value;
    if (!FLAG_LABELS[flagReason]) { showMessage(message, 'Choose a reason for the flag.'); return; }
    const flagNote = $('flag-note').value.trim();
    submit({ flagged: true, flagReason, ...(flagNote ? { flagNote } : {}) },
      `Flag this application as "${FLAG_LABELS[flagReason]}"? It can then only be rejected, and this cannot be undone.`, button);
  });

  $('release').addEventListener('click', async (e) => {
    if (!window.confirm('Give this application back to the queue?')) return;
    e.target.disabled = true;
    try {
      await api(path, { method: 'DELETE' });
      window.location.href = 'queue.html';
    } catch (err) {
      showMessage(message, err.message);
      e.target.disabled = false;
    }
  });

  $('pdf').addEventListener('click', async () => {
    showMessage(message, '');
    try {
      const { url } = await api(`${path}/pdf`);
      openLink(url);
    } catch (err) {
      showMessage(message, err.message);
    }
  });

  load();
})();
