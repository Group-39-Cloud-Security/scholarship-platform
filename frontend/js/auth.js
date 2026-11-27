// auth.js — token storage, role from the token, page guard, logout
// Owner: Mohamed Khalil (shared shell)   ·   Rules: CLAUDE.md §2 (login), §10 (token in sessionStorage)
//
// The role read here only decides which links and pages the browser shows. It is NOT security:
// every API call is checked again by the backend (authenticate + requireRole, 401/403/404).
//
// Load order on every page: js/config.js → js/auth.js → js/api.js → js/nav.js → the page's own script.

const Auth = (() => {
  // Same key the reviewer pages use (reviewer/reviewer-common.js), so one login works everywhere.
  // sessionStorage, not localStorage (CLAUDE.md §10): the token is gone when the tab closes.
  const TOKEN_KEY = 'token';
  const ROLES = ['student', 'reviewer', 'admin'];

  // The site root, worked out from where this file was loaded (…/js/auth.js → …/), so links work
  // from any folder and on any host (S3 on Floci, a local static server).
  const SITE_ROOT = new URL('../', document.currentScript.src);

  // Where each role lands after login.
  const HOME = {
    student: 'student/my-applications.html',
    reviewer: 'reviewer/queue.html', // Hazem's page, unchanged
    admin: 'admin/index.html',       // placeholder until Wael's pages exist
  };

  // TODO remove in Phase B: the temporary test tokens from shared-lib/auth.js (CLAUDE.md §2).
  // They are not JWTs, so their role can't be decoded. After Phase B the backend answers 401 to them.
  const TEST_TOKEN_ROLES = {
    'test-student-1': 'student',
    'test-student-2': 'student',
    'test-reviewer': 'reviewer',
    'test-admin': 'admin',
  };

  function url(path) {
    return new URL(path, SITE_ROOT).href;
  }

  function getToken() {
    try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
  }

  function setToken(token) {
    try { sessionStorage.setItem(TOKEN_KEY, token); } catch { /* storage blocked: login won't stick */ }
  }

  function clearToken() {
    try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* storage blocked */ }
  }

  // Reads the JWT payload without checking the signature (the browser can't, and doesn't need to:
  // the backend verifies it). Returns null for anything that isn't a well-formed JWT.
  function decodeJwtPayload(token) {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    try {
      const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const payload = JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '=')));
      return payload && typeof payload === 'object' ? payload : null;
    } catch {
      return null;
    }
  }

  // Role in the token, or null when there is no usable token (missing, unknown role, expired).
  // TODO Phase B: confirm with Wael that the JWT payload carries `role` (auth-service controller plans { sub, role }).
  function roleOf(token) {
    if (!token) return null;
    if (Object.hasOwn(TEST_TOKEN_ROLES, token)) return TEST_TOKEN_ROLES[token]; // TODO remove in Phase B
    const payload = decodeJwtPayload(token);
    if (!payload || !ROLES.includes(payload.role)) return null;
    if (typeof payload.exp === 'number' && payload.exp * 1000 <= Date.now()) return null; // expired (1 h)
    return payload.role;
  }

  function getRole() {
    return roleOf(getToken());
  }

  // reason is a fixed code the login page turns into a fixed message (never echoed from the URL).
  function goToLogin(reason) {
    clearToken();
    window.location.replace(url(reason ? `index.html?reason=${encodeURIComponent(reason)}` : 'index.html'));
  }

  // Redirects to the login page when there is no usable token. Returns false if it redirected.
  function requireLogin() {
    if (getRole()) return true;
    goToLogin(getToken() ? 'expired' : null);
    return false;
  }

  function homeUrl(role) {
    return HOME[role] ? url(HOME[role]) : url('index.html');
  }

  function logout() {
    goToLogin('logged-out');
  }

  return { getToken, setToken, clearToken, roleOf, getRole, requireLogin, goToLogin, homeUrl, logout, url };
})();
