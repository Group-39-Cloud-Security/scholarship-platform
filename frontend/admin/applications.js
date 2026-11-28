// applications.js — logic for admin/applications.html: decide reviewed applications
// Owner: Mohamed Wael   ·   Rules: CLAUDE.md §6 Deciding, §8, §10 (textContent only)
//
// PATCH /api/admin/applications/{id}/decision { decision: 'accepted' | 'rejected' }
//   → 200 { applicationId, scholarshipId, status, decidedBy, decidedAt, emailStatus: 'queued' | 'failed' }
//   409 not reviewed / already decided / flagged accept / awards used up (the message says which)
// The admin API has no list of applications, so the lists come from the audit log:
//   action=review   (written by review-service: targetId = applicationId, detail "scored 72" or "flagged: ineligible")
//   action=decision (targetId = applicationId, detail "accepted" / "rejected")

(() => {
  if (!AdminUI.start()) return;

  const $ = (id) => document.getElementById(id);
  const message = $('message');
  const LABEL = { accepted: 'Accepted', rejected: 'Rejected' };

  async function decide(applicationId, decision, button) {
    const text = decision === 'accepted'
      ? 'Accept this application? It uses one of the scholarship\'s awards and the student is emailed. A decision is final.'
      : 'Reject this application? The student is emailed. A decision is final.';
    if (!window.confirm(text)) return;
    const done = busy(button, decision === 'accepted' ? 'Accepting…' : 'Rejecting…');
    try {
      const r = await apiRequest(`/api/admin/applications/${encodeURIComponent(applicationId)}/decision`, {
        method: 'PATCH', body: { decision },
      });
      const email = r.emailStatus === 'failed'
        ? 'The email could not be queued (emailStatus failed); the decision still stands.'
        : 'The decision email is queued.';
      showMessage(message, `Application ${AdminUI.shortId(r.applicationId)}: ${LABEL[r.status] || r.status}. ${email}`,
        r.emailStatus === 'failed' ? 'info' : 'success');
      await load(false);
    } catch (err) {
      showMessage(message, err.message);
    } finally {
      done();
    }
  }

  function decisionButtons(applicationId, flagged) {
    const accept = el('button', { type: 'button' }, 'Accept');
    const reject = el('button', { type: 'button', className: 'danger' }, 'Reject');
    if (flagged) {
      accept.disabled = true;
      accept.title = 'A flagged application can only be rejected.';
    }
    accept.addEventListener('click', () => decide(applicationId, 'accepted', accept));
    reject.addEventListener('click', () => decide(applicationId, 'rejected', reject));
    return el('div', { className: 'actions' }, accept, reject);
  }

  async function load(clearMessage = true) {
    if (clearMessage) showMessage(message, 'Loading…', 'info');
    try {
      const [reviews, decisions] = await Promise.all([AdminUI.auditRows('review'), AdminUI.auditRows('decision')]);
      const decided = new Set(decisions.map((d) => d.targetId));
      const seen = new Set();
      const waiting = reviews
        .filter((r) => AdminUI.isUuid(r.targetId) && !decided.has(r.targetId) && !seen.has(r.targetId) && seen.add(r.targetId))
        .map((r) => {
          const flagged = typeof r.detail === 'string' && r.detail.startsWith('flagged');
          return el('tr', {}, AdminUI.idCell(r.targetId), el('td', {}, formatDate(r.createdAt)),
            el('td', {}, r.detail || '-'), el('td', {}, decisionButtons(r.targetId, flagged)));
        });
      AdminUI.fillTable($('waiting'), $('empty-waiting'), waiting);
      AdminUI.fillTable($('decided'), $('empty-decided'), decisions.map((d) => el('tr', {},
        AdminUI.idCell(d.targetId), el('td', {}, formatDate(d.createdAt)),
        el('td', {}, LABEL[d.detail] || d.detail || '-'), AdminUI.idCell(d.userId))));
      if (clearMessage) showMessage(message, '');
    } catch (err) {
      ['waiting', 'decided', 'empty-waiting', 'empty-decided'].forEach((id) => { $(id).hidden = true; });
      showMessage(message, err.message);
    }
  }

  function idFromBox() {
    const id = AdminUI.cleanId($('aid').value);
    if (!AdminUI.isUuid(id)) {
      showMessage(message, 'Enter an application id (a UUID like 4123d54c-19de-4551-8f8b-5f88bf29438e).');
      return null;
    }
    return id;
  }
  $('by-id').addEventListener('submit', (e) => {
    e.preventDefault();
    const id = idFromBox();
    if (id) decide(id, 'accepted', e.submitter || $('by-id').querySelector('button'));
  });
  $('reject-by-id').addEventListener('click', (e) => {
    const id = idFromBox();
    if (id) decide(id, 'rejected', e.currentTarget);
  });

  load();
})();
