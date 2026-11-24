# Starting Claude Code on the Group 39 project

## One-time setup (per laptop)
1. Clone the team repo (once) and switch to your own branch:
   `git clone https://github.com/Group-39-Cloud-Security/scholarship-platform ~/group39/scholarship-platform`
   `cd ~/group39/scholarship-platform && git switch <your-branch>` (`wael`, `khalil` or `hazem`)
2. Docker Desktop running, then Floci up: `docker compose -f platform/docker-compose.yml up -d`
3. AWS CLI profile `floci` set up (Quick Installation Guide, Part 4). Check:
   `aws sts get-caller-identity --query Account --output text` prints `000000000000`.
4. Claude Code installed: `npm install -g @anthropic-ai/claude-code`

## Where to start it
Open Git Bash in `~/group39/scholarship-platform` (the repo root), then run `claude`.
The rulebook is `docs/CLAUDE.md`; the first message tells Claude Code to read it.

## First message (change NAME, BRANCH, FOLDER and TASK)

> Read docs/CLAUDE.md fully. It is the rulebook for this project and you must follow it, including rule 8 on commits. I am NAME, I work on branch BRANCH and my service folder is FOLDER (Khalil: services/application-service, Hazem: services/review-service, Wael: services/admin-service). platform/, shared-lib/ and services/auth-service are shared files, so tell me before changing them. Floci is running in Docker on this machine and the AWS profile is `floci`. My task now: TASK. Don't commit anything until I say so.

## Habits
- Start each session with `git switch <your-branch> && git pull origin main`.
- Never commit to `main`; open a PR from your branch.
- Never `docker compose down -v` (it deletes every table and function).
- Check `git log -1` before pushing: no Co-Authored-By lines.
- If a change needs a shared file (platform/, shared-lib/, services/auth-service) or another service's folder, post in the group first.

## Current phase
Phase A: build ONLY your own service until all your functions pass your tests (see docs/CLAUDE.md section 11). Do not start login, the real auth-service, the frontend, or database changes yet. Tell your Claude this in your first message.
