# AI usage declaration

Which AI tools were used, for what, and how each member checked and can explain the result. (Confirm the format with Seif.)

## Mohamed Hazem (review-service)

- **Tool:** Claude (Anthropic), through claude.ai.
- **Used for:** writing and reviewing the review-service code, the deploy script and IAM policies, the reviewer pages, the tests (unit tests, `api-tests.sh`, the Postman collection, the e2e script) and my docs; finding and fixing problems while setting up Floci on my laptop.
- **How I checked it:** ran every test on Floci on my laptop and locally (evidence files and the T-REV rows in `docs/api-test-plan.md`), ran the end-to-end flow through API Gateway, read every file before it was merged, and went through the security points (token checks, ownership, conditional updates, IAM, no secrets) one by one. I can explain each file and every design decision in my section of `docs/decisions.md`.
