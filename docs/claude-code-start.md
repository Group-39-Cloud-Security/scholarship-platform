# Starting Claude Code on the Group 39 project

## One-time setup (per laptop)
1. Docker Desktop running, then Floci up:
   `cd ~/group39/scholarship-frontend && docker compose -f platform/docker-compose.yml up -d`
2. AWS CLI profile `floci` set up (Quick Installation Guide, Part 4). Check:
   `aws sts get-caller-identity --query Account --output text` prints `000000000000`.
3. All 5 repos cloned side by side in `~/group39`:
   scholarship-frontend, auth-service, application-service, review-service, admin-service.
4. Claude Code installed: `npm install -g @anthropic-ai/claude-code`

## Where to start it
Open Git Bash in `~/group39` (the parent folder), then run `claude`.
The rulebook is `scholarship-frontend/docs/CLAUDE.md`. It is in a subfolder, so the first message tells Claude Code to read it.

## First message (change NAME, REPO and TASK)

> Read scholarship-frontend/docs/CLAUDE.md fully. It is the rulebook for this project and you must follow it, including rule 8 on commits. I am NAME, my repo is REPO (Khalil: application-service, Hazem: review-service, Wael: admin-service). platform/ and shared-lib/ are shared files, so tell me before changing them. Floci is running in Docker on this machine and the AWS profile is `floci`. My task now: TASK. Don't commit anything until I say so.

## Habits
- `git pull` in all 5 repos before each session.
- Never `docker compose down -v` (it deletes every table and function).
- Check `git log -1` before pushing: no Co-Authored-By lines.
- If a change needs a shared file (platform/, shared-lib/, auth-service) or another service's code, post in the group first.
