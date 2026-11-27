// no-internet.js — TEST ONLY. Makes every fetch() fail, as if the Lambda had no outbound internet, so the
// "Pwned Passwords unreachable → fail open and log it" path can be tested (T-AUT-16). Used only by
// tests/api-tests.sh as a preload on a second local server:
//   node -r ./tests/no-internet.js src/server.js        (from services/auth-service)
// Never in the Lambda: npm run zip packs only src/, shared/, package.json and node_modules/, not tests/.
globalThis.fetch = async () => {
  throw new TypeError('fetch failed (blocked by tests/no-internet.js)');
};
