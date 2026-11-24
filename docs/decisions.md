# Decisions log

| Date | Decision | Why | Who |
|---|---|---|---|
| 2026-11-24 | Everyone must understand the Brevo integration (Seif: all members involved in the APIs); we do not change the design, each member can explain it (docs/brevo-integration-explained.md). Ask Seif if he meant each service should use it. | Costs nothing, safe either way; sending from every service would change IAM roles and the queue message (Phase B at the earliest). | Wael |
