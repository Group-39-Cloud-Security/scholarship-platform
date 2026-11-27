// api.js — apiRequest(path, options): the only place the shell's pages call the gateway
// Owner: Mohamed Khalil (shared shell)   ·   Rules: CLAUDE.md §8 (errors), §10
//
// apiRequest('/api/applications/mine')
// apiRequest('/api/applications', { method: 'POST', body: { ... } })
// apiRequest('/api/auth/login', { method: 'POST', body: { email, password }, auth: false })
//
// Returns the JSON body (null for 204). On failure throws an Error whose message is the API's own
// message (error.message from { "error": { "code", "message" } }), with .status and .code set.
// A 401 on a call that carried a token sends the user back to the login page.

const API_BASE = typeof FLOCI_API === 'string' && FLOCI_API !== '__FLOCI_API__' ? FLOCI_API.replace(/\/$/, '') : '';

async function apiRequest(path, { method = 'GET', body, auth = true } = {}) {
  if (typeof path !== 'string' || !path.startsWith('/api/')) {
    throw new Error('Internal error: API paths must start with /api/.');
  }
  if (!API_BASE) {
    throw new Error('The API address is not set. Upload the site with platform/shared.sh, which fills in js/config.js.');
  }

  const token = auth ? Auth.getToken() : null;
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'omit', // we use the Authorization header, never cookies
      cache: 'no-store',
    });
  } catch {
    throw new Error('Could not reach the server. Check that Floci is running and try again.');
  }

  if (res.status === 401 && token) {
    Auth.goToLogin('expired');
    throw new Error('Your session has ended. Please log in again.');
  }
  if (res.status === 204) return null;

  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }

  if (!res.ok) {
    // Our services answer { error: { code, message } }; API Gateway answers {"message":"Not Found"} for unknown routes.
    const err = new Error(data && data.error && data.error.message ? data.error.message : `Request failed (${res.status}).`);
    err.status = res.status;
    err.code = data && data.error ? data.error.code : undefined;
    throw err;
  }
  return data;
}
