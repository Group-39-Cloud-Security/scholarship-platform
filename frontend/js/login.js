// login.js — logic for index.html: log in or register, store the token, go to the role's home page
// Owner: Mohamed Khalil (shared shell)   ·   Rules: CLAUDE.md §6 (login never says whether the email exists), §10
//
// POST /api/auth/login    { email, password }        → 200 { token, user: { role, mustChangePassword, ... } }
//                                                       401 wrong details · 429 this email + IP is blocked for a while
// POST /api/auth/register { email, name, password }  → 201, then the same login call

(() => {
  const $ = (id) => document.getElementById(id);
  const message = $('message');

  // Fixed texts for ?reason=…; the query value itself is never shown.
  const REASONS = {
    expired: ['Your session has ended. Please log in again.', 'info'],
    'logged-out': ['You have logged out.', 'success'],
  };

  // Already logged in with a usable token: go straight to the right page.
  const role = Auth.getRole();
  if (role) {
    window.location.replace(Auth.homeUrl(role));
    return;
  }
  Auth.clearToken(); // drop an expired or unreadable token

  const reason = new URLSearchParams(window.location.search).get('reason');
  if (Object.hasOwn(REASONS, reason || '')) showMessage(message, ...REASONS[reason]);

  // Error messages (401, 429, validation) come from auth-service as they are.
  async function logIn(email, password) {
    const data = await apiRequest('/api/auth/login', { method: 'POST', body: { email, password }, auth: false });
    const token = data && typeof data.token === 'string' ? data.token : '';
    const tokenRole = Auth.roleOf(token);
    if (!tokenRole) throw new Error('Login worked, but the server sent a token without a known role.');
    Auth.setToken(token);
    Auth.setMustChangePassword(Boolean(data.user && data.user.mustChangePassword));
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
    const done = busy(e.submitter || e.target.querySelector('button'), 'Logging in…');
    showMessage(message, '');
    try {
      await logIn(email, password);
    } catch (err) {
      showMessage(message, err.message);
      done();
    }
  });

  $('register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('reg-name').value.trim();
    const email = $('reg-email').value.trim().toLowerCase();
    const password = $('reg-password').value;
    if (name.length < 2 || !email || password.length < 10) {
      showMessage(message, 'Enter your name, your university email and a password of at least 10 characters.');
      return;
    }
    const done = busy(e.submitter || e.target.querySelector('button'), 'Registering…');
    showMessage(message, '');
    try {
      await apiRequest('/api/auth/register', { method: 'POST', body: { email, name, password }, auth: false });
      await logIn(email, password);
    } catch (err) {
      showMessage(message, err.message);
      done();
    }
  });
})();
