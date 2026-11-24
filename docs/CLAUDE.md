# CLAUDE.md — Group 39 Scholarship Platform (shared context)

> Give this file (plus the files you are editing, pulled fresh from `main`) to every Claude chat.
> If something here is wrong or out of date, fix it in a small PR **before** building on it.
> Items marked **[TO CONFIRM]** are still open. Version: after Phase 1 feedback + five-repo setup, 19 Nov 2026; Labs 7–8 review added 24 Nov 2026 (section 15); shared-lib file list, test users and essay character cap added 24 Nov 2026; moved to **one team repo** (`scholarship-platform`) + one personal repo per member after the TA email of 24 Nov 2026 (section 9).
> Final report requirements and the full Phase 1 feedback: `docs/final-report-checklist.md`.

---

## 1. The app and who owns what

Cloud Scholarship Application and Review Platform (Cloud Computing & Cloud Security, 26CSCN29H, Group 39, TA: Seif).
Students from partner universities apply for scholarships with an essay and one PDF.
Admins create scholarships with a **rubric** and **eligibility rules**. Reviewers claim applications from a shared queue and score them against that rubric. Admins accept or reject reviewed applications, limited by the number of awards, and the student is emailed (Brevo).
The UI is deliberately simple; the effort goes into the cloud architecture, business rules and security.

Every service must apply real business rules or talk to another service — CRUD-only services are rejected.

| Service | Owner | Functions (each one has an endpoint) | Business rules it enforces |
|---|---|---|---|
| Student Application (`application-service`) | Mohamed Khalil | browse published scholarships · apply (essay + PDF) · my applications with status timeline + own PDF download · withdraw | eligibility check against the scholarship's rules · deadline · one application per scholarship · max 3 active applications · PDF checked by content · withdraw only while `submitted` |
| Reviewer Scoring (`review-service`, `release-expired-claims`) | Mohamed Hazem | view queue · claim · score against the rubric (or flag) · my reviews · release | atomic claim · max 5 active claims per reviewer · claims expire after 48 h (scheduled release) · scores validated against the scholarship's rubric, weighted total calculated · scores locked after submission |
| Admin & Notification (`admin-service`, `notification-sender`) | Mohamed Wael | create/edit/publish/close scholarships (with rubric + eligibility) · accept/reject reviewed applications + email · account management (list users, create reviewer, disable/enable) · audit log + stats | rubric weights sum to 100 and lock on publish · decide only `reviewed` applications · flagged applications can only be rejected · accepted count ≤ awards (atomic counter) · cannot disable yourself or the last admin · email via queue with retries |

**Shared components (not part of anyone's three functions):**
- **Authentication (`auth-service`)**: register, login, current user. Lead: Wael (decided 24 Nov), built in **slices** by all three in Phase B (see section 11): Khalil = register (domain check, min length, Pwned Passwords); Hazem = login backoff (`LoginAttempts`, 429, `login_failed` events, CloudWatch filter + alarm); Wael = login (bcryptjs + JWT), `GET /me`, password change, `shared/auth.js` verification, and `services/auth-service/infra/deploy.sh`. One Lambda, one folder (`services/auth-service`), one slice per file; Wael reviews every PR. Includes the Pwned Passwords check (a security control, not the external integration).
- GitHub organization, `platform/` scripts, API Gateway, `deploy-all.sh`: lead Wael.
- `shared-lib/` helpers (including the temporary test-user `auth.js` so nobody waits for login) and `seed.sh`: lead Wael (decided 24 Nov: everyone builds their own backend first, anything shared that is a foundation goes to Wael). The CloudWatch metric filter and alarm belong to Hazem's own component (section 3).
- Shared frontend (`index.html` login page, `js/config.js`, `api.js`, `auth.js`, `nav.js`): lead Khalil.

---

## 2. Architecture (runs on Floci — local AWS emulator, port 4566)

```
Browser
   │  1. GET the page ──► S3 bucket scholarship-web (index.html, css/, js/) — plain HTML/CSS/JS
   │  2. fetch() + JSON, Authorization: Bearer <JWT>
   ▼
API Gateway v2 (HTTP API, route throttling)
   │
   ├── auth-service            (Lambda) ──► Users, LoginAttempts (DynamoDB) ──HTTPS──► Pwned Passwords
   ├── application-service     (Lambda) ──► Applications (DynamoDB), S3 (PDFs), reads Scholarships
   ├── review-service          (Lambda) ──► Reviews (DynamoDB), updates Applications, reads Scholarships rubric
   │      release-expired-claims (Lambda) ◄── EventBridge Scheduler (hourly)
   └── admin-service           (Lambda) ──► Scholarships, Users, reads Applications/Reviews ──► SQS notifications
                                                                                                   │
                                                  notification-sender (Lambda) ◄───────────────────┘ ──HTTPS──► Brevo
                                                  (failed 3x → SQS notifications-dlq)
Secrets: SSM Parameter Store (Brevo key, JWT secret)
Logs:    CloudWatch Logs /aws/lambda/<function> + metric filters + alarm · AuditLog table for business events
```

- Every Lambda gets its **own IAM role** with only the permissions in section 7.
- No endpoints or keys in code: inside Floci, Lambdas get `AWS_ENDPOINT_URL` injected; SDK clients are `new XClient({})`, exactly like Lab 7.
- **External integration:** Brevo (decision emails) is the real one. Pwned Passwords is described as a security control.
- **Login:** our own JWT (HS256, 1 hour, `jsonwebtoken`) + `bcryptjs` (not `bcrypt`, which breaks in Lambda zips built on Windows). Every service verifies the token with `shared/auth.js` and re-reads the user's role and status from `Users` (so a disabled user is blocked immediately). Cognito is no longer planned. Improvement for later: a Lambda authorizer so only one function reads the JWT secret.
- **Built in stages:** email first calls Brevo directly, then SQS + `notification-sender` are added. Until login works, `shared/auth.js` uses hard-coded test users marked `// TODO remove`, picked by the token: `Bearer test-student-1`, `test-student-2`, `test-reviewer`, `test-admin` (any other or missing token → 401). Two students so ownership (404 on someone else's record) can be tested, an admin token on a student route proves 403. `req.user` always has the shape `{ userId, email, role, status }`, so in Phase B only the body of `authenticate` changes (JWT verify + `GetItem` on `Users`) and no service code does. No `NODE_ENV` guard (every Lambda runs with `NODE_ENV=production`, so it would block testing on Floci); instead a Phase B test proves `Bearer test-admin` gets 401 after the swap.

### How it runs (confirmed with the TA)
- Floci isn't "installed": Docker downloads and runs it from `platform/docker-compose.yml`, so commands run from the repo root (`scholarship-platform`): `docker compose -f platform/docker-compose.yml up -d`. Start from a copy of the lab's `infra/floci/docker-compose.yml` (Floci Dash on, `floci-data` volume) and add the settings below; don't copy the lab's `--profile app` containers (we deploy to Lambda + S3 instead).
- One-time per laptop (anywhere): Docker Desktop, Git Bash, Node, AWS CLI and the `floci` profile (Quick Installation Guide, Part 4).
- Stop with `docker compose -f platform/docker-compose.yml down` — **never add `-v`**, it deletes the volume with every table and function (rebuild with `deploy-all.sh` if it happens).
- Everything else is created by the AWS CLI commands saved in `platform/*.sh` and each service's `services/<name>/infra/deploy.sh` (`platform/deploy-all.sh` runs them in order). Rebuilding from scratch = `reset.sh` + `deploy-all.sh`; this is also our recovery approach.
- The frontend is uploaded to the S3 bucket `scholarship-web` by `shared.sh` (`aws s3 sync frontend/ s3://scholarship-web`); its Floci URL is the "deployed application URL" in the report. Allowed stack: Node.js/Express/HTML/CSS/JS (or React) only.
- **CORS (done the Lab 7 API Gateway way):** the page and the API are different origins. Each service's Express app uses `cors()` from `shared-lib` with `origin` taken from the `CORS_ORIGINS` env var (`http://localhost:4566` on Floci — exact, no trailing `/`; open the site with `localhost`, not `127.0.0.1`). Because every request carries an `Authorization` header, the browser sends an `OPTIONS` preflight before **every** call, so each service's `deploy.sh` creates an `OPTIONS` route for **each** of its paths. CORS only protects browsers (curl ignores it); login and roles are the real protection.
- **Only listed routes exist:** each `deploy.sh` creates exactly the routes in section 8 (plus their `OPTIONS` routes), no `ANY` or `{proxy+}` catch-alls. Anything else gets `{"message":"Not Found"}` from API Gateway and never reaches our code (a control to cite in the report).
- **API address on Floci:** `http://<API_ID>.execute-api.localhost.floci.io:4566` (not the "Invoke URL" Floci Dash shows; without internet use `http://<API_ID>.execute-api.localhost:4566`). `shared.sh` writes it into `frontend/js/config.js` (`FLOCI_API`) before uploading. Website: `http://localhost:4566/scholarship-web/index.html`.
- **Lambda settings:** every function gets `NODE_ENV=production` and `CORS_ORIGINS`; `/api/health` reports `runtime: lambda` (as in the lab).
- **Every script starts with** `export AWS_PROFILE=floci MSYS_NO_PATHCONV=1` (without the second one Git Bash turns `/api/...` into Windows paths) and `set -e`.
- **Who creates what:**
  - `platform/shared.sh`: HTTP API (`apigatewayv2 create-api`, stage `$default` with auto-deploy, throttling), `AuditLog` table, `/scholarship/jwt-secret` (random value generated with `openssl rand`, never stored in a file), `scholarship-web` bucket + upload: `aws s3 sync frontend s3://scholarship-web` with `--exclude` for anything that isn't a website file (never `.env`, `node_modules`, zips), then CSS re-uploaded with `--content-type text/css` and JS with `--content-type text/javascript`, plus a bucket policy allowing only `s3:GetObject` (public read, nothing else — least privilege for the public; real AWS needs it, Floci allows reads by default).
  - Each service's `infra/deploy.sh`: its tables, IAM role, Lambda(s), one integration (`AWS_PROXY`, payload format `2.0`), its routes + `OPTIONS` routes, and `aws lambda add-permission --principal apigateway.amazonaws.com --source-arn "arn:aws:execute-api:us-east-1:000000000000:$API_ID/*"` (the IAM role says what the function may do; this permission says who may call it).
  - `services/auth-service/infra/deploy.sh`: `Users`, `LoginAttempts` (TTL on), `auth-service` Lambda + routes.
  - `services/admin-service/infra/deploy.sh`: `Scholarships`, SQS queues, `/scholarship/brevo-api-key` (value read from the deployer's local `.env`), both admin Lambdas + routes.
  - `services/application-service/infra/deploy.sh`: `Applications` (+ GSIs), `scholarship-documents` bucket (SSE-S3, Block Public Access), Lambda + routes.
  - `services/review-service/infra/deploy.sh`: `Reviews`, both review Lambdas + routes, EventBridge schedule.
  - `platform/seed.sh`: first admin (password from local `.env` `SEED_ADMIN_PASSWORD`, never committed), test users, sample scholarships.

### Floci settings (`platform/docker-compose.yml`)
Same as the lab's `infra/floci/docker-compose.yml` (Lab 7/8), plus the IAM line:
```yaml
ports:
  - "127.0.0.1:4566:4566"                        # only this PC can reach Floci (not everyone on the same Wi-Fi)
environment:
  FLOCI_HOSTNAME: floci
  FLOCI_STORAGE_MODE: persistent                 # default image is 'memory' = data lost on restart
  FLOCI_STORAGE_PERSISTENT_PATH: /app/data
  FLOCI_SERVICES_UI_BIND_ADDRESS: "127.0.0.1"    # Floci Dash at http://localhost:4566/_floci/ui
  FLOCI_BASE_URL: http://floci:4566
  FLOCI_SERVICES_UI_IMAGE: ghcr.io/ofsazib/floci-dash:latest
  FLOCI_SERVICES_UI_CONTAINER_NAME: floci-dash
  FLOCI_SERVICES_UI_ENDPOINT_ENV: FLOCI_URL
  FLOCI_SERVICES_UI_STATUS_PATH: /api/healthz
  FLOCI_SERVICES_IAM_ENFORCEMENT_ENABLED: "false" # set to "true" once the first functions work; while "false", IAM is not checked
```
Floci Dash is for looking only; everything is still created by scripts (rule 7).

---

## 3. AWS services per student (required: at least 3 in your own component)

| Student | AWS services in their own component |
|---|---|
| Khalil | Lambda (`application-service`), DynamoDB (`Applications`), S3 (`scholarship-documents`) |
| Hazem | Lambda (`review-service`, `release-expired-claims`), DynamoDB (`Reviews`), EventBridge Scheduler, CloudWatch metric filter + alarm |
| Wael | Lambda (`admin-service`, `notification-sender`), DynamoDB (`Scholarships`), SQS (+ DLQ), SSM Parameter Store |
| Shared | API Gateway, IAM (one role per Lambda), CloudWatch Logs, `auth-service` Lambda + `Users`/`LoginAttempts` |

---

## 4. Fixed names (do not rename without a PR to this file)

| Kind | Name |
|---|---|
| Lambda functions | `auth-service`, `application-service`, `review-service`, `release-expired-claims`, `admin-service`, `notification-sender` |
| IAM roles | `<function-name>-role` (e.g. `admin-service-role`) |
| DynamoDB tables | `Users`, `LoginAttempts`, `Scholarships`, `Applications`, `Reviews`, `AuditLog` |
| S3 buckets | `scholarship-documents` (private, Block Public Access ON), keys `applications/<applicationId>.pdf` · `scholarship-web` (frontend files only, readable by the browser) |
| SQS queues | `notifications`, `notifications-dlq` |
| EventBridge schedule | `release-expired-claims-hourly` |
| SSM parameters (SecureString) | `/scholarship/brevo-api-key`, `/scholarship/jwt-secret` |
| API | HTTP API `scholarship-api`, all routes under `/api` |
| Region / account (Floci) | `us-east-1` / `000000000000` |

Lambda environment variables (set by infra scripts, never hard-coded; each function gets only what it needs):
`USERS_TABLE`, `LOGIN_ATTEMPTS_TABLE`, `SCHOLARSHIPS_TABLE`, `APPLICATIONS_TABLE`, `REVIEWS_TABLE`, `AUDIT_TABLE`,
`DOCUMENTS_BUCKET`, `NOTIFICATIONS_QUEUE_URL`, `JWT_SECRET_PARAM`, `BREVO_KEY_PARAM`, `ALLOWED_DOMAINS`, `CORS_ORIGINS`, `NODE_ENV`.

---

## 5. Data design (DynamoDB)

Server always sets ids (`crypto.randomUUID()`), `status`, timestamps (ISO 8601 UTC) and owner ids (from the token, never the body).

| Table (owner) | Key | Indexes (GSIs) | Attributes |
|---|---|---|---|
| `Users` (shared auth; admin-service manages) | PK `userId` | `email-index` (PK `email`) | `email`, `name`, `role` (`student`/`reviewer`/`admin`), `passwordHash`, `status` (`active`/`disabled`), `mustChangePassword`, `createdAt` |
| `LoginAttempts` (shared auth) | PK `emailIp` (`<email>#<ip>`) | – | `failures`, `blockedUntil`, `expiresAt` (**DynamoDB TTL** deletes old rows) |
| `Scholarships` (Wael) | PK `scholarshipId` | `status-deadline-index` (PK `status`, SK `deadline`) | `title`, `description`, `deadline`, `awards` (int ≥ 1), `acceptedCount`, `status` (`draft`/`published`/`closed`), `rubric` (list of `{criterionId, name, description, weight}`), `eligibility` (`{allowedDomains[], minGpa, years[]}`), `createdBy`, `createdAt` |
| `Applications` (Khalil creates; Hazem & Wael change status) | PK `applicationId` | `studentId-index` (PK `studentId`), `scholarshipId-index` (PK `scholarshipId`, SK `submittedAt`), `status-index` (PK `status`, SK `submittedAt`) | `studentId`, `studentEmail`, `scholarshipId`, `essay`, `gpa`, `yearOfStudy`, `pdfKey`, `status`, `reviewerId`, `claimedAt`, `flagged`, `submittedAt`, `decidedBy`, `decidedAt`, `emailStatus` |
| `Reviews` (Hazem) | PK `applicationId` (one per application) | `reviewerId-index` (PK `reviewerId`, SK `submittedAt`) | `reviewerId`, `scores` (map `criterionId → 0–10`), `totalScore` (0–100), `comment`, `flagged`, `flagReason`, `flagNote`, `submittedAt` |
| `AuditLog` (everyone writes, Wael reads) | PK `action`, SK `sortKey` (value `<createdAt>#<logId>`) | – | `userId`, `targetId`, `detail` (no secrets, no request bodies) |

Relationships (for the ER diagram): User 1–N Application (student) · User 1–N Review (reviewer) · Scholarship 1–N Application · Application 1–0..1 Review · User 1–N AuditLog · Scholarship embeds its Rubric criteria and Eligibility rules.

---

## 6. Business rules (the rules Seif said were missing)

### Application status flow
```
(apply)        ──Khalil──►                  submitted
submitted      ──Hazem: claim──►            under_review   (sets reviewerId, claimedAt)
under_review   ──Hazem: release──►          submitted      (clears reviewerId, claimedAt)
under_review   ──scheduler, claimedAt > 48 h──► submitted  (abandoned claim released, audit logged)
under_review   ──Hazem: submit score/flag──► reviewed      (then PutItem into Reviews, attribute_not_exists)
reviewed       ──Wael: decide──►            accepted | rejected   (final)
```
- Every transition is **one conditional update** (`ConditionExpression: '#s = :expected'`, plus the owner check). Failed condition → **409**.
- **No editing** of applications. A student may withdraw only while `submitted` and before the deadline (once claimed, the review would be invalidated). Withdraw deletes the application item **and its PDF** from S3 (no orphaned personal documents); the student may then apply again.

### Scholarships, rubric and eligibility (Wael)
- `draft → published → closed`. Rubric, eligibility and deadline can be edited **only in `draft`**; publishing locks them (409 afterwards).
- Rubric: 2–6 criteria, each with a name, description and integer weight; **weights must sum to 100**.
- Eligibility: `allowedDomains` (subset of `ALLOWED_DOMAINS`), `minGpa` (0–4), `years` (allowed years of study).
- Publishing requires a deadline in the future, awards ≥ 1 and a valid rubric.
- Closing stops new applications only; reviewing and deciding existing applications continue.

### Applying (Khalil)
- Scholarship must be `published` and before its deadline.
- Student's email domain must be in the scholarship's `allowedDomains`; declared `gpa` ≥ `minGpa`; `yearOfStudy` in `years`. Otherwise 409 with a clear reason.
- One application per student per scholarship; at most **3 active** applications (`submitted`/`under_review`/`reviewed`). Otherwise 409.
- Essay 200–1000 words and at most 10,000 characters (`checkWords` `maxChars`, so huge "words" can't reach DynamoDB's 400 KB item limit and fail as a 500); PDF ≤ 2 MB and must start with `%PDF-` (checked by content, not file name).
- GPA and year are self-declared; the reviewer checks them against the PDF and flags `ineligible` if false.
- Students see their application's status and timeline, and the final decision; never the reviewer's identity, scores or flag details (the rejection email gives the flag reason).

### Reviewing (Hazem)
- A reviewer can hold at most **5** `under_review` claims at once (409 otherwise).
- Score: every rubric criterion must get an integer 0–10, no extra criteria. `totalScore = Σ(score × weight) / 10` → 0–100 (calculated by the server, never sent by the client).
- **Flag** instead of scoring: reason is one of `incomplete_documents`, `ineligible`, `plagiarism_suspected`, `other` (+ note ≤ 500 chars). The application becomes `reviewed` with `flagged = true` and no score.
- A submitted review is final (no update/delete).
- `release-expired-claims` runs hourly (EventBridge Scheduler) and returns claims older than 48 h to the queue. Admin can also release a claim. **[TO CONFIRM Floci supports EventBridge Scheduler; fallback: the claim condition also accepts `under_review` claims older than 48 h]**

### Deciding (Wael)
- Only `reviewed` applications can be decided. Flagged applications can **only be rejected** (the email includes the flag reason).
- Accept = transaction-free atomic counter: `UpdateItem` on the scholarship `SET acceptedCount = acceptedCount + 1` with condition `acceptedCount < awards`, then the conditional status update. If the second step fails, decrement. Award limit reached → 409.
- Every decision is logged and queued for email; email failure never undoes the decision (`emailStatus = failed`, visible to admin).
- SQS message body: `{ applicationId, studentEmail, scholarshipTitle, decision, flagReason? }` — everything the sender needs, so `notification-sender` never reads other tables. No tokens or essays in messages.

### Accounts and login (shared auth + Wael)
- Students self-register only with an email in `ALLOWED_DOMAINS`; password checked against Pwned Passwords (k-anonymity, first 5 SHA-1 chars only) and minimum length 10.
- Reviewers are created by an admin with a temporary password (`mustChangePassword = true`). The first admin is created by `seed.sh`.
- Admin can disable/enable users but **not themselves** and **not the last active admin**. Disabled users are rejected on their next request (status re-read from `Users`).
- **No account lockout** (Seif: lockout lets anyone lock out an admin by knowing their email). Instead, failures are counted per **email + source IP** in `LoginAttempts`: after 5 failures that email+IP pair is blocked for 1 min, doubling to a max of 15 min. Other IPs are unaffected. The IP comes from API Gateway's `requestContext.http.sourceIp`, never from an `X-Forwarded-For` header (the client can fake that). Login responses never say whether the email exists.
- Monitoring: CloudWatch metric filter on `login_failed` log lines + alarm when > 20 in 5 minutes; also visible via `GET /api/admin/audit-log?action=login_failed`.

---

## 7. IAM permissions per role (least privilege)

All roles also get `logs:CreateLogGroup`, `logs:CreateLogStream`, `logs:PutLogEvents` **on their own log group only** (`arn:aws:logs:us-east-1:000000000000:log-group:/aws/lambda/<function-name>:*`, not `*`; Lab 8 style). Every policy statement has a `Sid` that says what it is for (e.g. `ApplicationsReadWrite`), so the policy reads like a sentence in the report. No role gets `Delete*Table`, `iam:*` or `*`. **No role can update or delete `AuditLog`.** Every role that verifies tokens gets `ssm:GetParameter` on `/scholarship/jwt-secret` only and `dynamodb:GetItem` on `Users`.

| Role | Allowed (in addition to the above) |
|---|---|
| `auth-service-role` | `Users`: Get/Put/Update/Query (+ `email-index`) · `LoginAttempts`: Get/Put/Update · `AuditLog`: PutItem |
| `application-service-role` | `Applications`: Get/Put/Delete/Query (+ indexes) · `Scholarships`: Get/Query · S3 `scholarship-documents/applications/*`: PutObject/GetObject/DeleteObject · `AuditLog`: PutItem |
| `review-service-role` | `Reviews`: Get/Put/Query (+ index) · `Applications`: Get/Query/Update · `Scholarships`: GetItem (rubric) · S3 `applications/*`: GetObject · `AuditLog`: PutItem |
| `release-expired-claims-role` | `Applications`: Query (`status-index`)/Update · `AuditLog`: PutItem |
| `admin-service-role` | `Scholarships`: Get/Put/Update/Query · `Applications`: Get/Query/Update/Scan · `Reviews`: Get/Query · `Users`: Query/Scan/Put/Update · `AuditLog`: PutItem/Query · SQS `notifications`: SendMessage |
| `notification-sender-role` | SQS `notifications`: Receive/Delete/GetQueueAttributes · SSM `/scholarship/brevo-api-key`: GetParameter · `Applications`: UpdateItem (`emailStatus` only) · `AuditLog`: PutItem |

Each role's policies live in the owning service's folder: `services/<name>/infra/iam/<role>-trust.json` and `infra/iam/<role>-policy.json` (shared roles in `platform/iam/`).

---

## 8. API

- JSON only, camelCase. Requests with a body must send `Content-Type: application/json` (else 415).
- Success: `200` read/update · `201` create (never 200 for a create) · `204` delete. An empty list is `200` with `[]`, never 404.
- URLs are plural nouns, the HTTP method carries the action (Lab 3): PATCH changes part of a resource, PUT replaces it.
- Errors always: `{ "error": { "code": "VALIDATION_ERROR", "message": "Weights must sum to 100." } }`

| Status | code |
|---|---|
| 400 | `VALIDATION_ERROR` (also for a body that is not valid JSON: "Request body is not valid JSON.", as in Lab 4) |
| 401 | `UNAUTHENTICATED` (missing/invalid/expired token, disabled user) |
| 403 | `FORBIDDEN` (wrong role) |
| 404 | `<RESOURCE>_NOT_FOUND` — `SCHOLARSHIP_NOT_FOUND`, `APPLICATION_NOT_FOUND`, `REVIEW_NOT_FOUND`, `USER_NOT_FOUND` (Lab 3/4 style; also returned for someone else's record, so ids can't be probed) · `ROUTE_NOT_FOUND` from Express's fallback · `{"message":"Not Found"}` from API Gateway when the route doesn't exist (Lambda never runs) |
| 409 | `CONFLICT` (wrong status, deadline passed, not eligible, limit reached, already claimed/decided/applied, rubric locked) |
| 413 | `PAYLOAD_TOO_LARGE` |
| 415 | `UNSUPPORTED_MEDIA_TYPE` |
| 429 | `TOO_MANY_ATTEMPTS` (login backoff) |
| 500 | `INTERNAL_ERROR` (never stack traces or AWS error text) |

| Method + path | Lambda | Role |
|---|---|---|
| `POST /api/auth/register`, `POST /api/auth/login`, `PUT /api/auth/password`, `GET /api/auth/me` | auth-service | anyone / logged in |
| `GET /api/scholarships` (published, filter `?search=`) · `GET /api/scholarships/{id}` | application-service | any logged-in user |
| `POST /api/applications` (essay, gpa, yearOfStudy, PDF base64) | application-service | student |
| `GET /api/applications/mine` (with status timeline) | application-service | student |
| `GET /api/applications/{id}/pdf` | application-service | student (owner) |
| `DELETE /api/applications/{id}` (withdraw) | application-service | student (owner) |
| `GET /api/reviews/queue` | review-service | reviewer |
| `POST /api/reviews` (claim, body `applicationId`) | review-service | reviewer |
| `GET /api/reviews/mine` | review-service | reviewer |
| `GET /api/reviews/{applicationId}` (application + rubric) | review-service | reviewer (claimer) |
| `PUT /api/reviews/{applicationId}` (scores or flag → `reviewed`) | review-service | reviewer (claimer) |
| `DELETE /api/reviews/{applicationId}` (release) | review-service | reviewer (claimer), admin |
| `GET /api/reviews/{applicationId}/pdf` | review-service | reviewer (claimer) |
| `POST /api/admin/scholarships` · `PUT /api/admin/scholarships/{id}` (draft only) | admin-service | admin |
| `PATCH /api/admin/scholarships/{id}/status` (`published`/`closed`) | admin-service | admin |
| `GET /api/admin/scholarships/{id}/applications` (with scores, sorted by total) | admin-service | admin |
| `PATCH /api/admin/applications/{id}/decision` (`accepted`/`rejected`) | admin-service | admin |
| `GET /api/admin/users?role=&status=` · `POST /api/admin/users` (create reviewer) · `PATCH /api/admin/users/{id}/status` | admin-service | admin |
| `GET /api/admin/audit-log?action=&since=` · `GET /api/admin/stats` | admin-service | admin |
| `GET /api/health` | admin-service | anyone |

### PDFs
- **Upload:** base64 inside `POST /api/applications`; decoded, checked (≤ 2 MB, starts with `%PDF-`), then `PutObject`. Raise the Express JSON limit only on this route (`express.json({ limit: '3mb' })`).
- **Download:** owner/claimer check first, then a **presigned GET URL** valid 5 minutes. The bucket is never public.

---

## 9. Repositories (TA email, 24 Nov 2026)

The TAs require (1) **one team repository** with all members' work, where **each member has a branch of their own** for their commits, and (2) **one personal repository per member** as proof of individual work (it does not have to be a working project). Everything is in the GitHub organization `Group-39-Cloud-Security`.

| Repo | What it is | Visibility |
|---|---|---|
| `scholarship-platform` | The team repo: all code, scripts, docs. The one linked in the report (section 9 of the report) | must be **public** before submission (secret scan first, section 10) |
| `admin-service` | Wael's personal proof-of-work repo | private **[TO CONFIRM with the TA: the email says both "all public" and "private per member"]** |
| `application-service` | Khalil's personal proof-of-work repo | same |
| `review-service` | Hazem's personal proof-of-work repo | same |
| `auth-service` | Old repo, its code now lives in `scholarship-platform/services/auth-service` | to archive |

Team repo layout (clone it once, e.g. `~/group39/scholarship-platform`):

```
scholarship-platform/
  frontend/               index.html (login/register)  student/  reviewer/  admin/  js/ (config, api, auth, nav)  css/
  platform/               docker-compose.yml  shared.sh  deploy-all.sh  reset.sh  seed.sh  get-token.sh  vars.sh  .env.example
  shared-lib/             auth.js  errors.js  validate.js  middleware.js  logger.js  audit.js  dynamo.js  VERSION   (the one true copy)
  services/
    auth-service/         (shared component; lead Wael; Khalil, Hazem and Wael each own a slice, see section 1)
    application-service/  (Khalil)
    review-service/       (Hazem: review-service + release-expired-claims)
    admin-service/        (Wael: admin-service + notification-sender)
  docs/                   CLAUDE.md (this file)  api-contract.md  api-test-plan.md  decisions.md  threat-model.md  final-report-checklist.md  individual-statements/
  evidence/
```

Every service folder has the same structure:
```
src/        app.js  lambda.js  server.js  routes/  controllers/  services/
shared/     copied from ../../shared-lib by `npm run sync-shared` — gitignored, never edited here
infra/      deploy.sh (its tables, IAM role JSON, Lambda, API routes, add-permission, schedules)  iam/
events/     saved test events          tests/  Postman collection
.env.example  README.md  package.json
```

- **Branches:** each member has a long-lived personal branch, `wael`, `khalil`, `hazem`. You commit on your own branch (or on short feature branches cut from it, e.g. `wael/scholarship-publish`), then open a PR from it into `main`; one teammate reviews. After a merge, update your branch from `main` (`git pull origin main`). Nobody commits directly to `main`. This keeps each member's contribution visible in the history and the PR list (report section 9 and the Individual Contribution Statements).
- **Personal repo:** after your work is merged, copy your own service folder into your personal repo with its history: `git subtree push --prefix=services/<your-service> personal main` (once: `git remote add personal https://github.com/Group-39-Cloud-Security/<your-service>`; the very first time, its old starter commit must be replaced: `git subtree split --prefix=services/<your-service> -b proof && git push --force personal proof:main`). Add your individual statement and evidence there too.
- `platform/deploy-all.sh` runs: `shared.sh` → `services/auth-service/infra/deploy.sh` → `services/admin-service/...` → `services/application-service/...` → `services/review-service/...` → `seed.sh`.
- **Shared code:** changed only in `shared-lib/` (small PR, all three approve, bump `VERSION`). Lambda zips cannot reach outside their folder, so `npm run sync-shared` copies `../../shared-lib` into the service's `shared/` before `npm run zip` (`deploy-all.sh` does this every time). Code requires `../shared/...` (from `src/`), never `../../shared-lib` directly.
- **Contract between services:** `docs/api-contract.md` + sections 4–8 of this file. A service never imports another service's code (even though it is now in the same repo); it only talks to other services through the shared tables in section 5 (with the permissions in section 7) or the API.
- Pattern inside each service = Lab 4/5/7 MVC: **routes** (method + path + `requireRole`, nothing else) → **controller** (checks `req.is('application/json')` → 415, validates → 400 with one clear message, applies business rules, picks the status code, `next(error)` on failure) → **service** (AWS calls only, never sees `req`/`res`). `app.js` registers, in order: request logger → `securityHeaders` → `cors()` → `express.json()` → `fixBody` → routes → `ROUTE_NOT_FOUND` fallback → error handler (bad JSON → 400, everything else → 500 `INTERNAL_ERROR`, details only in the log). `server.js` = local run, `lambda.js` = `serverless(app)`. Copy `services/admin-service`'s structure.
- `fixBody` and `securityHeaders` come from `shared-lib/middleware.js`. `fixBody` is needed because Floci's API Gateway can hand Lambda the body as a Buffer or base64 text (Lab 7 found this on PATCH), so `express.json()` skips it and `req.body` is empty; it decodes and parses it (bad JSON → 400 `VALIDATION_ERROR`). Without it, our PATCH/PUT routes return confusing 400s on Floci.
- The request logger comes from `shared-lib/logger.js`: it writes the one JSON line per request from section 10 (`{ level, fn, method, path, status, userId, action }`) when the response finishes, and never logs bodies, tokens or headers.
- `npm run zip` uses the Lab 7 `scripts/zip-lambda.js` (no extra package). It zips a fixed list (`src/`, `shared/`, `package.json`, `node_modules/`), so `.env`, `events/` and `tests/` can never end up in `lambda.zip`.
- **Docs per service, in the Lab 3 formats:** its section of `docs/api-contract.md` (data dictionary with Field · Type · Source (Client/Server) · Rule, then each endpoint's request, success response, errors, as valid JSON in code fences) and its rows in `docs/api-test-plan.md` (Test ID · Request · Expected · Actual · Pass/Fail — the same table the report's security and integration test sections need). Each repo keeps a `requests.http` and exports its Postman collection to `evidence/`.

---

## 10. Security rules (apply to every line of code)

- No secrets, keys, tokens or passwords in code **or commit history** (they cost marks even if deleted later). `.env` is gitignored; `.env.example` lists names only. Runtime secrets come from SSM. Run a secret scan (e.g. gitleaks) on every repo before making it public.
- Never trust ids, roles, status, scores totals or timestamps from the request body.
- Validate every input: required fields, types, lengths, enums, ranges, business rules in section 6.
- Ownership check on every `/{id}` route. The backend returns 401/403/404 — hiding a button is not authorization.
- Logs: one JSON line per request `{ level, fn, method, path, status, userId, action }`. **Never** log bodies, essays, passwords, tokens or presigned URLs.
- Security events (`login`, `login_failed`, `forbidden`, `claim`, `claim_expired`, `decision`, `user_disabled`) go to `AuditLog`.
- Frontend: `textContent` only, never `innerHTML`. Token in `sessionStorage`; on 401 go back to login.
- Security headers on every API response (`securityHeaders`, Lab 8): `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Content-Security-Policy: default-src 'none'` (the API only returns JSON).
- Escape on **output**, not on input: store text exactly as sent (after validation) and show it with `textContent`. Do not copy Lab 8's `sanitize()`, which stores `&lt;` in the database and would corrupt essays and Brevo emails.
- Transport: everything over HTTPS on real AWS; on Floci it is local HTTP (document as a limitation). Encryption at rest: DynamoDB and S3 encrypt by default on AWS (S3 bucket set to SSE-S3 explicitly).
- Dependencies: AWS SDK **v3**, `express`, `serverless-http`, `cors`, `dotenv`, `bcryptjs`, `jsonwebtoken` (`npm run zip` uses the Lab 7 script, no package). Load testing uses k6 installed on the laptop, not an app dependency. Ask the team before adding anything else.

---

## 11. Team workflow

- **Order of work (three phases, decided 24 Nov):**
  - **Phase A — everyone builds their own backend, alone.** Each owner builds and tests every function of their own service in their own `services/<name>` folder, on their own branch, with Postman/REST Client, using the temporary test users in `shared-lib/auth.js` (section 2). Wael builds `shared-lib/` first. **Nobody touches login, the real auth-service, the frontend, or database changes (Neon, new tables, new attributes) until all three services pass their own tests.** Phase A is done when every function in section 1 returns the right status codes (section 8) and its business rules are proven by saved tests.
  - **Phase B — join the pieces.** Only after Phase A is finished by all three: each person writes their auth slice (section 1), Wael assembles and deploys `auth-service` and replaces the test user, `platform/reset.sh && platform/deploy-all.sh` must pass on a clean Floci, and we run the cross-service flow (apply → claim → score → decide → email queued). First check: a tiny page on the S3 site calling `/api/health` proves CORS and the token flow. Decide the Neon question here too.
  - **Phase C — frontend.** Khalil's shell (`index.html`, `api.js`, `config.js`, `auth.js`, `nav.js`) first, then each owner builds **their own** pages against the real backend (frontend is marked individually, 5%). Target: Phase A ends by the project's mid-point, not the last week (date: **[TO CONFIRM in the group]**).
- Work on your own branch (`wael`/`khalil`/`hazem`) or a short feature branch cut from it (`hazem/review-queue`); PR into `main` within 1–2 days, reviewed by one teammate. Every student needs real commits on their own component, under their own GitHub account.
- Before merging: pull `main`, then `platform/reset.sh && platform/deploy-all.sh` succeeds on a clean Floci and the shared Postman tests pass.
- Shared files (`shared-lib/`, `frontend/js/`, `platform/*.sh`, `auth-service`, this file): post in the group first, own small PR, all three approve. Owners merge PRs that only touch their own `services/<name>` folder and their own pages after one review; nobody pushes to `main` directly.
- Decisions go in `docs/decisions.md` (date, decision, why).
- Every Saturday: merge, wipe Floci, run everything from scratch, click through the full flow once.

---

## 12. Rules for Claude (follow these in every chat)

1. Only create or edit files in **my** service folder (`services/<name>`, named at the start of the chat) and my pages in `frontend/`. Work on my own branch, never on `main`.
2. If a change seems to need a shared file, another service's code or table, a new attribute, status, route, environment variable or dependency: **stop and tell me**. Do not do it.
3. Follow section 4 (names), section 6 (business rules), section 7 (permissions) and section 8 (API) exactly.
4. Follow the structure of `services/admin-service` and the Lab 7 style (`DynamoDBDocumentClient`, `ConditionExpression`, no endpoints or keys in code).
5. Keep the UI simple; spend the effort on business rules, validation and security.
6. After writing code, explain how a request flows through it, which business rule and security control it implements, so I can defend it in the individual discussion.
7. Infrastructure is created only by scripts (`infra/deploy.sh` in my service folder, `platform/` for shared parts), never by clicking in the dashboard. Never edit files in `shared/` inside a service folder; they are copied from `shared-lib/`.
8. Git commits: write a short, plain message in my own voice. Do not add `Co-Authored-By` lines, session links or any other tool attribution. AI use is declared in the report (`docs/ai-usage-declaration.md`), not in commit messages.

---

## 13. Changes from the Phase 1 proposal (for the final report)

| Proposal | Now | Why |
|---|---|---|
| Vercel + Neon Postgres | Floci: API Gateway, Lambda, DynamoDB, S3, SQS, SSM, EventBridge Scheduler, CloudWatch | TA direction; each student ≥ 3 AWS services; per-service IAM roles |
| One serverless function | One Lambda + IAM role per service | Least privilege per component, clear ownership |
| Auth inside Student Application | Shared `auth-service` | Seif: authentication is a shared component |
| Rubric "0–10 each", undefined | Per-scholarship weighted rubric, locked on publish | Seif: rubric never defined |
| Flag undefined | Flag with reason → `reviewed`, can only be rejected | Seif: flagging undefined |
| Claims could be abandoned | 48 h expiry, scheduled release | Seif: abandoned claims |
| Admin could decide any time | Only `reviewed` applications; awards limit | Seif: decisions before review |
| Edit after claim possible | No edit; withdraw only while `submitted` | Seif: edit invalidates review |
| Upload separate from apply | One apply request | Seif: upload repeats apply |
| Lockout after 5 failures | Per email+IP backoff, no lockout | Seif: lockout DoS on admins |
| Turnstile, Pwned as integrations | Brevo is the integration; Pwned is a security control; Turnstile dropped | Seif: security controls are not integrations |
| PDFs in the database | Private S3 bucket | DynamoDB 400 KB item limit |
| `shortlisted` status | removed; `reviewed` added | Clear status flow |
| Delete scholarship | close scholarship | No orphaned applications |
| Universities table | `ALLOWED_DOMAINS` + per-scholarship `allowedDomains` | Simpler, same check |

---

## 14. Open items **[TO CONFIRM]**

- [x] TA: running Floci locally with docker compose and saved shell (AWS CLI) commands is fine.
- [x] Seif/Amr: final project is on Floci. DB choice is ours; we will be asked about performance and cost vs alternatives. Chosen: DynamoDB.
- [ ] Announcement says adding an external DB (Neon/Supabase) with Floci is "recommended": ask Seif whether it affects marks. If yes, the natural place is the admin stats/audit reporting (SQS → `audit-writer` Lambda → Neon with INSERT-only / SELECT-only roles).
- [x] TA: **do not use RDS on Floci** (too buggy). Any SQL database must be Neon (outside Floci); RDS appears in the report only as a cost comparison.
- [x] ~~TA: one backend repo per member + one frontend repo~~ → replaced by the TA email of 24 Nov: one team repo with a branch per member + one personal proof-of-work repo per member (section 9).
- [ ] TA: personal repos public or private? (the email says both). Official deadline 25/11 with an unofficial extension: agree the real date and the Phase A end date.
- [ ] Module rules on AI-assisted code; include an **AI usage declaration** in the report (not raised in our feedback, but Seif marked down groups 5 and 9 for missing one).
- [ ] Floci checks in week 1: EventBridge Scheduler, CloudWatch metric filters/alarms, DynamoDB TTL, HTTP API throttling, Lambda outbound internet (Brevo, Pwned Passwords). (API Gateway HTTP API, S3 website, CORS via Express and `add-permission` are proven to work on Floci by the Lab 7 API Gateway + S3 lab.)
- [x] The "login lab" is Lab 8: random session token in a DynamoDB sessions table + Node's built-in `crypto.scrypt` with `timingSafeEqual`, no roles. Our JWT + re-reading `Users` on every request gives the same instant block of disabled users and adds roles, so we keep it (section 15).
- [ ] Phase B, Wael's auth slice: keep `bcryptjs`, or switch to Node's built-in `crypto.scrypt` (Lab 8) and drop a dependency. Both are defensible; decide before writing login.
- [ ] Optional, Phase B/C: one k6 load test (Lab 8) against `GET /api/scholarships` for the report's performance numbers (p95, failure rate).
- [ ] Default rubric criteria for seed data (e.g. academic record 40, essay 40, need 20).

---

## 15. What Labs 7 and 8 confirm (for the report and the discussion)

Lab 7 = API Gateway + S3 on Floci (our deployment model). Lab 8 = load balancing, scaling, k6 and security layers on Floci (ECS/ALB/SNS/EventBridge bus — not our architecture; Floci only records ECS/ALB/Auto Scaling).

| Lab shows | What we do | Why it matters |
|---|---|---|
| Lab 8 ignores `X-Forwarded-For` unless behind its own load balancer (test S3) | Login backoff uses `requestContext.http.sourceIp` only (section 6) | A client can fake the header to dodge limits. Hazem can reuse test S3 |
| Lab 8's rate limiter counts in memory, so 3 workers count separately; the lab says use a shared store (DynamoDB TTL) for real | `LoginAttempts` in DynamoDB with TTL | Lambda also runs many copies; memory counters would not hold |
| Lab 8's SQS queue has no consumer and no DLQ ("a real system would add both") | `notification-sender` consumes `notifications`; `notifications-dlq` after 3 failures | We went past the lab |
| Lab 8 keeps config in Secrets Manager | SSM Parameter Store SecureString | Same idea; SSM standard parameters cost nothing, Secrets Manager charges per secret. Note the choice in the report |
| Lab 8 "always set a maximum: scaling is not DDoS protection" | API Gateway throttling (section 2); optionally Lambda reserved concurrency as a cost cap | Serverless scales out by itself, so the cap is what stops a runaway bill |
| Lab 8: scale out needs a stateless app | Every Lambda is stateless; all state in DynamoDB/S3 | Any copy can answer any request |
| Lab 7: Lambda vs EC2 table, "name three provider and three team responsibilities" | Serverless (Lambda + API Gateway) | Needed for the report's cloud-model justification |

Tests to copy into `docs/api-test-plan.md` (security section): Lab 7 T4 (unknown route → `{"message":"Not Found"}` from API Gateway, no log line), T6 (`Origin: http://evil.example` → no `Access-Control-Allow-Origin`), "`.env` on the website → 404"; Lab 8 S1 (security headers present). Phase B: a `platform/check.sh` in the style of `check-lab7.sh` (PASS/FAIL, each FAIL followed by how to fix it) as evidence.
