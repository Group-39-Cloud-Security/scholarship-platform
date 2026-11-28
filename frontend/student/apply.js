// apply.js — logic for student/apply.html?scholarship=<scholarshipId>
// Owner: Mohamed Khalil   ·   Rules: CLAUDE.md §6 Applying, §8 (GET /api/scholarships/{id}, POST /api/applications), §10
//
// The checks here only save the student a round trip. The server checks all of them again
// (and the ones the browser can't: eligibility, deadline, one per scholarship, max 3 active).

(() => {
  if (!startPage('student')) return;

  const $ = (id) => document.getElementById(id);
  const message = $('message');
  const form = $('apply-form');
  const MAX_PDF_BYTES = 2 * 1024 * 1024;
  const scholarshipId = new URLSearchParams(window.location.search).get('scholarship');

  const countWords = (text) => (text.trim() ? text.trim().split(/\s+/).length : 0);

  $('essay').addEventListener('input', () => {
    const n = countWords($('essay').value);
    $('word-count').textContent = `${n} word${n === 1 ? '' : 's'}`;
  });

  // The PDF goes inside the JSON body as base64 (CLAUDE.md §8 PDFs).
  function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = () => reject(new Error('Could not read the PDF file.'));
      reader.readAsDataURL(file);
    });
  }

  // Same content check as the server: a PDF starts with %PDF- whatever the file is called.
  async function looksLikePdf(file) {
    const head = new Uint8Array(await file.slice(0, 5).arrayBuffer());
    return String.fromCharCode(...head) === '%PDF-';
  }

  function readForm() {
    const essay = $('essay').value;
    const words = countWords(essay);
    if (words < 200 || words > 1000) throw new Error(`The essay must be 200 to 1000 words (it has ${words}).`);
    const gpa = Number($('gpa').value);
    if ($('gpa').value.trim() === '' || !Number.isFinite(gpa) || gpa < 0 || gpa > 4) throw new Error('GPA must be a number from 0 to 4.');
    const yearOfStudy = Number($('year').value);
    if (!Number.isInteger(yearOfStudy) || yearOfStudy < 1 || yearOfStudy > 6) throw new Error('Choose your year of study.');
    const file = $('pdf').files[0];
    if (!file) throw new Error('Attach your PDF.');
    if (file.size > MAX_PDF_BYTES) throw new Error('The PDF must be at most 2 MB.');
    return { essay, gpa, yearOfStudy, file };
  }

  function showScholarship(s) {
    const e = s.eligibility || {};
    $('title').textContent = `Apply: ${s.title}`;
    $('description').textContent = s.description || '';
    $('deadline').textContent = formatDate(s.deadline);
    $('awards').textContent = s.awards;
    $('min-gpa').textContent = typeof e.minGpa === 'number' && e.minGpa > 0 ? e.minGpa : 'None';
    $('years').textContent = Array.isArray(e.years) && e.years.length ? e.years.join(', ') : 'Any';
    $('domains').textContent = Array.isArray(e.allowedDomains) && e.allowedDomains.length ? e.allowedDomains.join(', ') : 'Any';
    $('details').hidden = false;
  }

  async function load() {
    if (!validId(scholarshipId)) {
      showMessage(message, 'No scholarship selected. Choose one from the scholarship list.', 'info');
      return;
    }
    showMessage(message, 'Loading the scholarship…', 'info');
    try {
      const s = await apiRequest(`/api/scholarships/${encodeURIComponent(scholarshipId)}`);
      showScholarship(s);
      if (s.isOpen) {
        showMessage(message, '');
        form.hidden = false;
      } else {
        showMessage(message, 'The deadline for this scholarship has passed, so you can no longer apply.', 'info');
      }
    } catch (err) {
      showMessage(message, err.message); // 404: "Scholarship not found."
    }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    let input;
    try {
      input = readForm();
      if (!(await looksLikePdf(input.file))) throw new Error('The file must be a PDF.');
    } catch (err) {
      showMessage(message, err.message);
      return;
    }

    const done = busy(e.submitter || form.querySelector('button'), 'Submitting…');
    showMessage(message, 'Uploading your application…', 'info');
    try {
      const pdfBase64 = await readFileAsBase64(input.file);
      const created = await apiRequest('/api/applications', {
        method: 'POST',
        body: { scholarshipId, essay: input.essay, gpa: input.gpa, yearOfStudy: input.yearOfStudy, pdfBase64 },
      });
      window.location.href = `application-status.html?id=${encodeURIComponent(created.applicationId)}&submitted=1`;
    } catch (err) {
      showMessage(message, err.message); // 400 / 409 / 413: the server's message names the failed rule
      done();
    }
  });

  load();
})();
