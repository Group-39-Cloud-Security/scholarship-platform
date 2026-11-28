// pwnedService.js — Pwned Passwords k-anonymity check (a security control, not the app's external integration)
// Owner: Shared (lead: Mohamed Wael, reviewed by all)   ·   Rules: CLAUDE.md §6 Accounts and login
//
// Only the first 5 hex characters of the password's SHA-1 leave the Lambda; the API answers with every breached
// hash suffix under that prefix and the match is done here, so the password (or its full hash) is never sent.
// Fails OPEN (decided 28 Nov, docs/decisions.md): if the API can't be reached, returns null and the caller lets the
// password through (the 10-character minimum still applies) and logs it.

const crypto = require('crypto');

const RANGE_URL = 'https://api.pwnedpasswords.com/range/';
const TIMEOUT_MS = 5000;

// true = found in a breach, false = not found, null = could not check.
async function isPwned(password) {
  const sha1 = crypto.createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);
  try {
    // Add-Padding: the reply is padded with fake 0-count rows, so its size doesn't hint at the prefix.
    const res = await fetch(RANGE_URL + prefix, {
      headers: { 'Add-Padding': 'true' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = await res.text();
    return body.split('\n').some((line) => {
      const [s, count] = line.trim().split(':');
      return s === suffix && Number(count) > 0; // padding rows have count 0
    });
  } catch {
    return null; // timeout, DNS, no outbound internet
  }
}

module.exports = { isPwned };
