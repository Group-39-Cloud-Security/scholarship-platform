// applications.js — logic for admin/applications.html?scholarship=<id>: applications with scores, decide reviewed ones
// Owner: Mohamed Wael   ·   Rules: CLAUDE.md §6 Deciding, §8, §10 (textContent only)
//
// GET   /api/admin/scholarships                       → the list for the picker (published and closed ones)
// GET   /api/admin/scholarships/{id}/applications     → 200 { scholarship, applications: [...] } highest total first
// PATCH /api/admin/applications/{id}/decision { decision: 'accepted' | 'rejected' }
//   → 200 { status, emailStatus: 'queued' | 'failed', ... }; 409 not reviewed / already decided / flagged accept / awards used up

(() => {
  if (!AdminUI.start()) return;

  const $ = (id) => document.getElementById(id);
  const message = $('message');
  const STATUS = { submitted: 'Submitted', under_review: 'Under review', reviewed: 'Reviewed', accepted: 'Accepted', rejected: 'Rejected' };
  const FLAG = { incomplete_documents: 'Incomplete documents', ineligible: 'Ineligible', plagiarism_suspected: 'Plagiarism suspected', other: 'Other' };

  async function decide(a, decision, button) {
    const text = decision === 'accepted'
      ? `Accept the application from ${a.studentEmail}? It uses one award and the student is emailed. A decision is final.`
      : `Reject the application from ${a.studentEmail}? The student is emailed. A decision is final.`;
    if (!window.confirm(text)) return;
    const done = busy(button, decision === 'accepted' ? 'Accepting…' : 'Rejecting…');
    try {
      const r = await apiRequest(`/api/admin/applications/${encodeURIComponent(a.applicationId)}/decision`, {
        method: 'PATCH', body: { decision },
      });
      const email = r.emailStatus === 'failed'
        ? 'The email could not be queued (email failed); the decision still stands.'
        : 'The decision email is queued.';
      await load(false);
      showMessage(message, `${a.studentEmail}: ${STATUS[r.status] || r.status}. ${email}`, r.emailStatus === 'failed' ? 'info' : 'success');
    } catch (err) {
      showMessage(message, err.message);
    } finally {
      done();
    }
  }

  function reviewCell(a) {
    if (a.flagged) {
      return el('td', {}, el('strong', {}, `Flagged: ${FLAG[a.flagReason] || a.flagReason || '-'}`),
        a.flagNote ? el('br') : null, a.flagNote ? el('span', { className: 'hint' }, a.flagNote) : null);
    }
    if (a.scores) return el('td', {}, Object.entries(a.scores).map(([k, v]) => `${k} ${v}`).join(', '));
    return el('td', { className: 'hint' }, a.status === 'under_review' ? 'Being reviewed' : 'Not reviewed yet');
  }

  function render({ scholarship, applications }) {
    const full = scholarship.acceptedCount >= scholarship.awards;
    $('summary').textContent = `${scholarship.title} (${scholarship.status}): ${applications.length} application(s), `
      + `${scholarship.acceptedCount || 0} of ${scholarship.awards} awards used.`;
    $('summary').hidden = false;
    const rows = applications.filter((a) => AdminUI.isUuid(a.applicationId)).map((a) => {
      let actions = null;
      if (a.status === 'reviewed') {
        const accept = el('button', { type: 'button' }, 'Accept');
        const reject = el('button', { type: 'button', className: 'danger' }, 'Reject');
        if (a.flagged || full) {
          accept.disabled = true;
          accept.title = a.flagged ? 'A flagged application can only be rejected.' : 'All awards are used.';
        }
        accept.addEventListener('click', () => decide(a, 'accepted', accept));
        reject.addEventListener('click', () => decide(a, 'rejected', reject));
        actions = el('div', { className: 'actions' }, accept, reject);
      }
      return el('tr', {},
        el('td', {}, a.studentEmail || '-', el('br'), el('span', { className: 'hint' },
          `GPA ${a.gpa ?? '-'}, year ${a.yearOfStudy ?? '-'}, submitted ${formatDate(a.submittedAt)}`)),
        el('td', {}, STATUS[a.status] || a.status, a.decidedAt ? el('span', { className: 'hint' }, ` ${formatDate(a.decidedAt)}`) : null),
        el('td', { className: 'num' }, a.totalScore === null || a.totalScore === undefined ? '-' : `${a.totalScore} / 100`),
        reviewCell(a),
        el('td', {}, a.emailStatus || '-'),
        el('td', {}, actions));
    });
    AdminUI.fillTable($('apps'), $('empty'), rows);
  }

  async function load(clearMessage = true) {
    const id = $('scholarship').value;
    if (!AdminUI.isUuid(id)) return;
    window.history.replaceState(null, '', `?scholarship=${encodeURIComponent(id)}`);
    if (clearMessage) showMessage(message, 'Loading applications…', 'info');
    try {
      render(await apiRequest(`/api/admin/scholarships/${encodeURIComponent(id)}/applications`));
      if (clearMessage) showMessage(message, '');
    } catch (err) {
      ['apps', 'empty', 'summary'].forEach((x) => { $(x).hidden = true; });
      showMessage(message, err.message);
    }
  }

  async function start() {
    showMessage(message, 'Loading scholarships…', 'info');
    try {
      // Drafts can't have applications, so only published and closed ones are offered.
      const list = (await apiRequest('/api/admin/scholarships')).filter((s) => s.status !== 'draft' && AdminUI.isUuid(s.scholarshipId));
      if (!list.length) {
        showMessage(message, 'No published or closed scholarships yet, so there are no applications.', 'info');
        $('pick').hidden = true;
        return;
      }
      $('scholarship').replaceChildren(...list.map((s) => el('option', { value: s.scholarshipId }, `${s.title} (${s.status})`)));
      const wanted = AdminUI.cleanId(new URLSearchParams(window.location.search).get('scholarship'));
      if (list.some((s) => s.scholarshipId === wanted)) $('scholarship').value = wanted;
      await load();
    } catch (err) {
      showMessage(message, err.message);
    }
  }

  $('pick').addEventListener('submit', (e) => { e.preventDefault(); load(); });
  $('scholarship').addEventListener('change', () => load());
  start();
})();
