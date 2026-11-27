// login.js — logic for index.html: log in, store the token, go to the role's home page
// Owner: Mohamed Khalil (shared shell)   ·   Rules: CLAUDE.md §6 (login never says whether the email exists), §10

(() => {
  const $ = (id) => document.getElementById(id);
  const message = $('message');

  // Fixed texts for ?reason=…; the query value itself is never shown.
  const REASONS = {
    expired: ['Your session has ended. Please log in again.', 'info'],
    'logged-out': ['You have logged out.', 'success'],
  };

  // Already logged in with a usable token: go straight to the right home page.
  const role = Auth.getRole();
  if (role) {
    window.location.replace(Auth.homeUrl(role));
    return;
  }
  Auth.clearToken(); // drop an expired or unreadable token

  const reason = new URLSearchParams(window.location.search).get('reason');
  if (Object.hasOwn(REASONS, reason || '')) showMessage(message, ...REASONS[reason]);

  function enter(token) {
    const tokenRole = Auth.roleOf(token);
    if (!tokenRole) {
      showMessage(message, 'Login worked, but the server sent a token without a known role. Ask the team to check auth-service.');
      return;
    }
    Auth.setToken(token);
    window.location.replace(Auth.homeUrl(tokenRole));
  }

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('email').value.trim().toLowerCase();
    const password = $('password').value;
    if (!email || !password) {
      showMessage(message, 'Enter your email and password.');
      return;
    }
    const button = e.submitter || e.target.querySelector('button');
    button.disabled = true;
    showMessage(message, '');
    try {
      // TODO Phase B (Wael's login slice): confirm the response shape. Assumed: 200 { "token": "<JWT>" }.
      const data = await apiRequest('/api/auth/login', { method: 'POST', body: { email, password }, auth: false });
      enter(data && typeof data.token === 'string' ? data.token : '');
    } catch (err) {
      // No status or a 404 without our error code: the login route isn't deployed yet (API Gateway answers
      // the preflight without CORS headers, or with {"message":"Not Found"}). TODO remove the hint in Phase B.
      if (!err.status || (err.status === 404 && !err.code)) {
        showMessage(message, `${err.status ? 'Login is not available yet.' : err.message} If login is not deployed yet (Phase A), use a test user below.`);
      } else {
        showMessage(message, err.message);
      }
    } finally {
      button.disabled = false;
    }
  });

  // TODO remove in Phase B, together with the #test-login section in index.html.
  $('test-login-button').addEventListener('click', () => enter($('test-user').value));
})();
