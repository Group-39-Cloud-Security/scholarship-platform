// apply.js — logic for student/apply.html?scholarship=<scholarshipId>  (STUB: not connected to the API yet)
// Owner: Mohamed Khalil   ·   Rules: CLAUDE.md §6 Applying, §8 (POST /api/applications), §10
// The checks here only save the student a round trip. The server checks all of them again
// (and the ones the browser can't: eligibility, deadline, one per scholarship, max 3 active).

(() => {
  if (!startPage('student')) return;

  const $ = (id) => document.getElementById(id);
  const message = $('message');
  const MAX_PDF_BYTES = 2 * 1024 * 1024;
  const scholarshipId = new URLSearchParams(window.location.search).get('scholarship');

  const countWords = (text) => (text.trim() ? text.trim().split(/\s+/).length : 0);

  $('essay').addEventListener('input', () => {
    const n = countWords($('essay').value);
    $('word-count').textContent = `${n} word${n === 1 ? '' : 's'}`;
  });

  if (!validId(scholarshipId)) {
    // TODO: link to student/scholarships.html once the scholarship list page is built.
    showMessage(message, 'No scholarship selected. Open this page from a scholarship (apply.html?scholarship=<id>).', 'info');
    $('apply-form').hidden = true;
    return;
  }

  // TODO: load the scholarship's title (and show its eligibility rules) with
  //   const s = await apiRequest(`/api/scholarships/${encodeURIComponent(scholarshipId)}`);
  //   $('scholarship-name').textContent = s.title;          // 404 SCHOLARSHIP_NOT_FOUND → show err.message
  $('scholarship-name').textContent = scholarshipId;

  // The PDF goes inside the JSON body as base64 (CLAUDE.md §8 PDFs).
  function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = () => reject(new Error('Could not read the PDF file.'));
      reader.readAsDataURL(file);
    });
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

  $('apply-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    let form;
    try { form = readForm(); } catch (err) { showMessage(message, err.message); return; }

    // TODO: the real call goes here:
    //   const button = e.submitter; button.disabled = true;
    //   const pdfBase64 = await readFileAsBase64(form.file);
    //   const created = await apiRequest('/api/applications', {
    //     method: 'POST',
    //     body: { scholarshipId, essay: form.essay, gpa: form.gpa, yearOfStudy: form.yearOfStudy, pdfBase64 },
    //   });
    //   → 201 { applicationId, scholarshipId, status: 'submitted', submittedAt }:
    //     window.location.href = `application-status.html?id=${encodeURIComponent(created.applicationId)}`;
    //   → 400 / 409 / 413: showMessage(message, err.message) — the server's message names the failed rule.
    showMessage(message, 'The form is valid. Sending it is not connected to the API yet (TODO).', 'info');
  });
})();
