# Independent Editorial Reviewer: steps for Claude Code

These are the app's own steps. The owner's machine rules come first and win where they differ. The rules for anything that lands on GitHub are in `AGENTS.md`: read it first.

## Deploy line

`deploy reviewer at <40-character commit>. The app's repo is mikeohallo/independent-editorial-reviewer. Deploy folder: <folder>. Settings: <file>.`
(Add "with migrations" only when the commit adds a Durable Object migration.)

1. The owner's machine rules first: the careful copy into `<deploy folder>/<YYYYMMDD-HHMM>-<commit>` (the deploy folder the line names), the commit check, this file read with `git show <commit>:CLAUDE.md`, the switch with hooks off, a clean tree. Don't clone again.
2. From the root of that copy, run exactly:
   `node scripts/deploy.mjs <commit> --settings <settings file the line names>` (add `--with-migrations` only if the line says "with migrations").
   - Run it with Node directly. Never `npm run`, `npx` or `npm`.
   - The settings file lives outside every repo and holds the Drive folder IDs, the account's `workers.dev` subdomain, the run-report folder and the empty no-hooks folder. Don't open, print, copy or change it; the script reads it. If it's missing, the script stops: say so.
   - The script checks the machine, the commit, the settings guard and that no Wrangler login exists; installs and tests while logged out; reinstalls with no scripts; logs in once with a short permission list (the owner clicks Allow); finds or creates the OAuth storage; deploys **staging first** (no address, editorial off), checks it, then production on `reviewer.mikeohalloran.au`, checks it; and **always logs out**, even after a failure.
   - It stops before deploying if the production Worker has no `ALLOWED_EMAIL` secret. Don't add it: the owner types it in the dashboard.
   - It writes its report to the run-report folder in the settings file. Don't paste the report back; the build chat reads it.
3. If the script stops: don't retry, don't work round a check, don't log in or out by hand. Tell the owner the line the report says it stopped at.
4. If a step is refused by your own safety check: stop and say which step. Never a broad allow rule.
5. At the end, step out of the run folder and delete it. If your safety check won't allow the delete, leave it and say which folder is left.

## Never

- Deploy with `wrangler deploy` directly, or with `--name` or `--env` by hand.
- Run `wrangler secret put`, `secret bulk`, or anything that reads or changes a secret value.
- Call `start_editorial_review` or any other review tool: they cost money.
- Change `src/legacy-v4.1.mjs`.
- Put a Drive folder ID, a path on the owner's machine or anything from the settings file into this repo: it is public.
