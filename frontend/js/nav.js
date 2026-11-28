// nav.js — shared header navigation per role + startPage() and small helpers for every shell page
// Owner: Mohamed Khalil (shared shell)   ·   Rules: CLAUDE.md §10 (built with textContent, never innerHTML)
//
// Each page has <nav id="nav" aria-label="Main"></nav> in its header and calls, first thing:
//   if (!startPage('student')) return;
// Only the section for the role in the token is built. Hiding links is not authorization:
// the backend still answers 401/403 to a wrong role.

const NAV_SECTIONS = {
  student: {
    label: 'Student',
    links: [ // apply.html and application-status.html need an id, so they are opened from these two pages
      ['Scholarships', 'student/scholarships.html'],
      ['My applications', 'student/my-applications.html'],
    ],
  },
  reviewer: {
    label: 'Reviewer',
    links: [ // Hazem's pages, linked as they are (review.html needs ?id=, so it is opened from these)
      ['Queue', 'reviewer/queue.html'],
      ['My reviews', 'reviewer/my-reviews.html'],
    ],
  },
  admin: {
    label: 'Admin',
    links: [
      ['Admin home', 'admin/index.html'], // TODO Phase C (Wael): replace with the real admin pages
    ],
  },
};

const ROLE_NAMES = { student: 'students', reviewer: 'reviewers', admin: 'admins' };

// el('a', { href }, 'text') — text children become text nodes, so nothing is ever parsed as HTML.
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  children.flat().forEach((c) => {
    if (c === null || c === undefined || c === false) return;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  });
  return node;
}

// links = false shows only the Log out button (used while a password change is required).
function renderNav(role, links = true) {
  const nav = document.getElementById('nav');
  if (!nav) return;
  const section = links ? NAV_SECTIONS[role] : null;
  const here = window.location.pathname;
  const items = [];
  if (section) {
    items.push(el('span', { className: 'nav-section' }, section.label));
    section.links.forEach(([text, path]) => {
      const href = Auth.url(path);
      const link = el('a', { href }, text);
      if (new URL(href).pathname === here) link.setAttribute('aria-current', 'page');
      items.push(link);
    });
  }
  const logout = el('button', { type: 'button', className: 'link', id: 'logout' }, 'Log out');
  logout.addEventListener('click', Auth.logout);
  items.push(logout);
  nav.replaceChildren(...items);
}

// Shows a message box: kind is 'error' (default), 'success' or 'info'. Empty text hides it.
function showMessage(box, text, kind = 'error') {
  box.textContent = text;
  box.className = `message ${kind}`;
  box.hidden = !text;
}

// Login check + nav for the page. Returns true when the page's own code may run.
// Wrong role: the page body is replaced by a short note and the user's own nav stays usable.
function startPage(requiredRole) {
  if (!Auth.requireLogin()) return false;
  if (Auth.mustChangePassword()) {
    window.location.replace(Auth.url(Auth.CHANGE_PASSWORD_PAGE));
    return false;
  }
  const role = Auth.getRole();
  renderNav(role);
  if (requiredRole && role !== requiredRole) {
    const main = document.querySelector('main');
    if (main) {
      main.replaceChildren(
        el('h1', {}, 'Not available'),
        el('p', {}, `This page is only for ${ROLE_NAMES[requiredRole] || requiredRole}. Use the links at the top to go to your own pages.`),
      );
    }
    return false;
  }
  return true;
}

function formatDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleString();
}

// Same id rule as the backend (1-64 of A-Z a-z 0-9 -), so a bad ?id= never reaches a URL.
function validId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(id);
}

// Opens a link from the API in a new tab. Only http(s) links, and the new tab gets no access to this page.
function openLink(link) {
  let parsed;
  try { parsed = new URL(link); } catch { throw new Error('The server returned an invalid link.'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('The server returned an invalid link.');
  window.open(parsed.href, '_blank', 'noopener,noreferrer');
}

// Disables a button and swaps its text while work runs; returns a function that puts it back.
function busy(button, text) {
  const before = button.textContent;
  button.disabled = true;
  button.textContent = text;
  return () => {
    button.disabled = false;
    button.textContent = before;
  };
}
