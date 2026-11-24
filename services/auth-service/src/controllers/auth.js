// auth.js — validation + status codes for register/login/password/me
// Owner: Shared (lead: Mohamed Wael, reviewed by all)   ·   Rules: CLAUDE.md §6 Accounts and login
// TODO:
//   - register: email domain in ALLOWED_DOMAINS, password ≥ 10 chars, not in Pwned Passwords → 201
//   - login: check LoginAttempts backoff (email#sourceIp from requestContext) → 429; never reveal whether the email exists
//   - on success issue JWT {sub, role} HS256 1 h; audit login / login_failed
