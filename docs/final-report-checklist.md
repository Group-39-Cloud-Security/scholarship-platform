# Group 39 — Phase 1 feedback and final submission checklist

Source: Phase 1 feedback sheet, the TA announcement and the "Final Report Components" document (e-learning, Nov 2026).
How each feedback point is handled in the build: `CLAUDE.md` sections 6 and 13.

---

## 1. Our Phase 1 feedback (TA: Seif)

### Seif's feedback (verbatim) and what we do about it

| Feedback | Status / fix |
|---|---|
| "unclear status rules, and a security section that is shallow and not clear." | Status flow + business rules defined (`CLAUDE.md` §6). Security controls written specifically per service (§7, §10). |
| "The problem statement says a rubric prevents reviewer bias, but the rubric is never defined. There is no rubric entity, no criteria, and no way for the admin to set one per scholarship. 'Rubric scores (0 to 10 each)' doesn't say what is being scored." | Per-scholarship rubric: 2–6 named criteria with weights summing to 100, set by admin, locked on publish; weighted total calculated by the server. |
| "The flow between services is good, but the status rules between them are missing. Nothing stops the admin from accepting an application that hasn't been reviewed." | Admin can only decide `reviewed` applications (conditional update, 409 otherwise). |
| "A student can edit their essay after a reviewer has claimed it, which invalidates the review." | No editing; withdraw only while `submitted`. |
| "What happens after a reviewer 'flags' an application is undefined and not clear." | Flag = reason (`incomplete_documents`, `ineligible`, `plagiarism_suspected`, `other`) + note → `reviewed`, flagged; can only be rejected; email includes the reason. |
| "the distribution is not clear as Authentication (register, login, users, universities), Turnstile and Pwned Passwords sit inside Mohamed's service, but authentication is a shared task. 2.2 also makes Mohamed Wael the external API lead, while two of the three APIs belong to mohameds's service." | Shared `auth-service` (not counted in anyone's functions). Turnstile dropped; Pwned is a security control in shared auth; Brevo (the integration) sits in Wael's service, matching his lead role. |
| "Turnstile and Pwned Passwords are security controls, not application integrations. Brevo is the only real one. rethink external apis" | Brevo is the external integration (decision emails, queued with retries). Pwned described as a security control. |
| "Security controls in (6.2) is generic and written in a much simpler style than section 3. Least privilege only covers user roles" | Least privilege now covers each Lambda's IAM role (per table and action) and the SSM parameters; report must explain each specifically. |
| "Locking an account after 5 failed attempts lets anyone lock out a reviewer or admin just by knowing their email." | Replaced by per email+IP backoff (max 15 min), no account lockout, CloudWatch alarm on failed-login spikes. |
| "Reviewer Scorin is good service, with a claim and release queue, rubric scoring and scores locked after the decision. Define the rubric, what flagging does, and how abandoned claims get released." | Rubric and flag defined; claims expire after 48 h via an hourly EventBridge-scheduled Lambda; max 5 active claims per reviewer. |
| "Admin & Notification service is good. Stop decisions being made before an application has been reviewed, and add the account management endpoints you described." | Decide only `reviewed`; account management added (list users, create reviewer, disable/enable; not self, not last admin); awards limit as an atomic counter. |
| "Student Application is Mostly CRUD with a deadline rule. 'Upload' repeats 'apply', editing after a reviewer has claimed the application must be blocked, and authentication should be a shared component, not part of your service." | Upload merged into apply; no editing; auth moved out; new rules: per-scholarship eligibility (domain, min GPA, year), one application per scholarship, max 3 active, PDF checked by content, status timeline. |

### Lessons from feedback given to other groups (same TAs)
- **Seif** penalised: no **AI usage declaration**; sections that contradict each other or differ in writing style; functions described with **no endpoint**; JWT storage not specified; "least privilege" claimed with one full-access DB credential; in-memory rate limiting on serverless; lockout DoS; concurrent claims not handled; file type checked by extension instead of content; work plans that don't match the module schedule.
- **Amr** penalised: CRUD-only services (rejected outright); projects that only mirror the labs; no cloud services used to mitigate threats ("every member needs at least 2 cloud services"); one shared backend repo (wants one backend repo per member + one frontend repo); POST returning 200 instead of 201; text-only architecture diagrams.
- **Mohey** penalised: services not deployed separately; no planned calls between services; "go beyond the lab stack".

---

## 2. What we submit

1. Final report (group technical evidence pack) with **every section below** (all mandatory).
2. An **Individual Contribution Statement** per student, at the end of the report.
3. A **public GitHub repository** link: complete source and config, each member's contribution history, no credentials in code **or history**.
4. A **demo video** link (≤ 5 minutes, Google Drive/YouTube, "anyone with the link can view"), no commentary needed: main end-to-end scenario first, then security scenarios (login, blocked role, rejected invalid input).
5. Attendance at the live demo and individual discussion is **compulsory** (absence = 0%).

## 3. Minimum requirements (from the announcement)

- [ ] Browser frontend connected to a real backend/API, no static data. **Only Node.js, Express, HTML, CSS, JS or React.**
- [ ] 3 services, one owner each, ≥ 3 meaningful related functions each, with real business rules or calls to another service (not CRUD-only).
- [ ] REST API with correct methods, input validation, proper status codes.
- [ ] Persistent database with the CRUD/query operations the services need.
- [ ] ≥ 2 roles enforced in the backend (401/403, not hidden buttons).
- [ ] ≥ 1 external API/service doing a real job in a workflow.
- [ ] Authentication on all protected functions, ownership checks, no hard-coded secrets.
- [ ] Logging + monitoring evidence, threat model ≥ 6 threats, ≥ 8 documented security tests.
- [ ] Deployed on **Floci**, each student using **≥ 3 AWS services in their own component**. (Adding an external DB such as Neon/Supabase with Floci is "recommended". Vercel/Neon-only = minimum submission, loses architecture/deployment/integration marks.)
- [ ] All services work together as one app: shared login, roles, navigation, data.
- [ ] Every student has real commits on their own component.

## 4. Report sections (all mandatory)

| # | Section | Must contain | Owner |
|---|---|---|---|
| 1 | Problem definition | Real-world problem, intended users and roles, expected benefit, in/out of scope | |
| 2 | Architecture diagram (image, not text) | Frontend, API/business logic, data layers and how they communicate; label the AWS service for each layer; show Brevo; more complex than the lab example | |
| 3 | Service/API list + data model | 3 services × ≥ 3 functions; per endpoint: method, what it validates, status codes; cross-service links/business logic; ER diagram; CRUD/query operations per service | each owner + |
| 4 | Role/permission matrix | Each role's allowed actions and **where** the backend/platform enforces it | |
| 5 | External integration | Brevo: which workflow, how the key is stored (SSM) | Wael |
| 6 | Deployment approach | Cloud + service model (serverless on Floci), why (needs, complexity, cost), trade-offs, deployed app URL | Wael |
| 7 | Threat model | ≥ 6 credible, app-specific threats across identity, data, API/application, cloud config, each mapped to an **implemented** control (some controls should be cloud services) | |
| 8 | Security controls | AuthN, AuthZ, least privilege, secrets, input validation, ownership checks, secure transport, encryption at rest; shared responsibility (≥ 3 provider, ≥ 3 team); why each component gets only the permissions it needs and why broad admin access is wrong | |
| 9 | GitHub repository | Public link, full source/config, contribution history, no secrets | |
| 10 | Demo video | Link, ≤ 5 min | |
| 11 | Logs and monitoring | Log screenshots + ≥ 1 metric/query/filter/alert, explained; at least one showing errors/repeated failures/suspicious activity; no sensitive values | Hazem |
| 12 | Security test table | ≥ 8 tests incl. unauthenticated access, unauthorized role, invalid input, ownership check, secret exposure review; columns: ID, scenario, expected, actual, pass/fail, evidence | all |
| 13 | Integrated testing | Normal + invalid cases on the deployed app across all three services; results, error handling, limitations | all |
| 14 | Cost/resource statement | Main resources, how cost is avoided, handling more load at coursework scale (DynamoDB vs Neon vs RDS comparison) | |
| 15 | Recovery approach | Restore/recreate data and config after deletion, misconfiguration, compromise (infra scripts, seed, backups/PITR, secret rotation) | |
| 16 | Limitations | Residual risks, assumptions, controls not implemented — each with reason + proposed improvement | |
| – | AI usage declaration | Not in the components list and not raised in our own feedback, but Seif marked down groups 5 and 9 for missing one — include it to be safe | |
| – | Individual Contribution Statements | Per student: owned component + functions, frontend, backend/API, data operations, security controls, tests, integration work, technical decisions, difficulties and solutions — with screenshots, API/test evidence, commit/PR links | each |

## 5. Phase 1 issues the TAs listed for everyone (check our report against these)

- Problem definition not stating users, benefit, scope.
- Services made of unrelated functions instead of one coherent capability.
- Generic threats ("hacking", "DDoS") not specific to the app or not linked to a mitigation.
- Role matrices without allowed actions or where they are enforced.
- Architecture diagrams without the cloud services, external API or layer communication.
- Data models missing relationships or which service uses which entity.
- Too little detail on how secrets, input validation and logging are actually implemented.
