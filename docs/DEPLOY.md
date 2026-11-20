# How a deploy works

Updated 18 November 2026 (step 2: the login; the settings file, for the public repo). This replaces the `npx wrangler deploy --name …` commands in the System Guide (section 10); everything else in the guide stands.

## In one paragraph

A deploy happens only from the owner's machine, on his line naming a full commit that has passed CI, the deploy folder and the settings file: `deploy reviewer at <commit>. … Deploy folder: <folder>. Settings: <file>.` Claude Code makes a fresh copy of that commit with git hooks off, then runs `node scripts/deploy.mjs <commit> --settings <file>`. The script checks everything it can before logging in, installs and tests while logged out, logs in to Cloudflare once with a short permission list, deploys **staging** (no address, editorial off), checks it, deploys **production** on `reviewer.mikeohalloran.au`, checks it, and **always logs out**. Cloudflare's version message records `reviewer <commit>`, so what's live can be traced to a commit.

## How the reviewer is reached

- `https://reviewer.mikeohalloran.au/mcp` is the connector address. claude.ai connects with OAuth; the sign-in page (`/authorize`) is behind Cloudflare Access (the owner's address, a one-time code) and the Worker checks the Access token itself.
- After the OAuth check, the request is handed to the unchanged reviewer with `x-api-key` set server-side from `MCP_ACCESS_TOKEN`. Callers never see or send that key.
- `/health` and the OAuth endpoints (`/oauth/*`, `/.well-known/*`) are public; everything else is behind a token or Access.
- No `workers.dev` address on either Worker. Staging has no address at all and editorial off.

## The settings file

This repo is public, so what is specific to the owner's account and machine lives in one JSON file on the deploy machine, outside every repo. The script reads it and stops if it is missing, inside the clone, or not exactly this shape:

```json
{
  "driveFolders": {
    "WORKSPACE_ROOT_FOLDER_ID": "<Drive folder ID>",
    "SUBMISSIONS_FOLDER_ID": "<Drive folder ID>",
    "REFERENCES_FOLDER_ID": "<Drive folder ID>",
    "EDITORIAL_FOLDER_ID": "<Drive folder ID>"
  },
  "workersDevSubdomain": "<the account's workers.dev subdomain>",
  "runsDir": "<absolute folder for run reports>",
  "noHooksDir": "<absolute empty folder git uses as its hooks folder>"
}
```

No secrets go in it. `wrangler.jsonc` carries `SET-AT-DEPLOY` for the four folder IDs; the script fills them in only in its scratch deploy config, and the live-settings check stops the deploy if they differ from what's live.

## The checks, in order

| Step | What it checks | Why |
| --- | --- | --- |
| Settings file | Exactly the four Drive folder IDs (each shaped like one, all different), the subdomain, two absolute folders; outside the clone; on Windows the no-hooks folder exists and is empty | Account details stay out of the public repo and can't be half-set |
| The machine | No environment variable that redirects git, npm, Node or Wrangler; Windows' own folder; npm settings files | Nothing on the machine can change what runs while logged in |
| The commit | `HEAD` and `origin/main` both equal the named 40-character commit; clean tree; no git hooks | Only the reviewed commit runs |
| Settings guard | `wrangler.jsonc` equals the reviewed settings exactly (caps, model, Drive mode, folder placeholders, host, `workers_dev` off, staging's settings, Durable Objects, migrations); the two Access values look real, not placeholders | A cap, access or address change can't ride along unseen; to change one, change the script's `EXPECTED_CONFIG` in the same commit |
| No login | No Wrangler login in any place Wrangler keeps one | Another deploy may be running |
| Install and test, logged out | `npm ci`, the unit tests, both runtime tests (the reviewer; the login end to end) | Nothing runs while logged in that hasn't passed |
| Clean install, no scripts | `npm ci --ignore-scripts`, Wrangler's cache deleted, Wrangler is the lockfile's version, a dry-run build (its SHA-256 goes in the report) | Nothing the tests ran can have changed what runs logged in |
| Leftovers | Only `node_modules/` untracked; no `.env`, `.dev.vars` or `.wrangler/` | A stray file can redirect a deploy |
| Login | `wrangler login --scopes account:read user:read workers:write workers_scripts:write workers_kv:write workers_routes:write zone:read` | No access to D1, R2, Pages, mail or DNS records beyond the Worker's own custom domain |
| OAuth storage | KV namespace `reviewer-oauth` found or created (from an empty folder, so the clone's config isn't touched); the deploy settings written outside the clone with its id | Tokens are stored hashed in KV by the OAuth library |
| Live settings, before either deploy | Each Worker's live version: every variable equals the reviewed value (the folder IDs from the settings file) (or is a planned change: staging's editorial off), secrets present by name (production needs `ALLOWED_EMAIL`) | A cap or setting changed in the dashboard stops the deploy. (Replaces Wrangler's `--strict`, which refuses every deploy after a secret is typed in the dashboard, the owner's route for secrets.) |
| Staging | `wrangler deploy --env=staging --message "reviewer <commit>"`; its `workers.dev` address no longer serves the reviewer; the live version's message | Staging can't be reached or start a review |
| Production | `wrangler deploy --env= --message …`; `/health` online on the new host; `/mcp` 401 with the OAuth challenge; OAuth metadata; `/authorize` sends to Access; other paths behind Access or not found; no `workers.dev`; the live version's message | Unpaid checks only; checked through Cloudflare's resolver so a new hostname works before the machine's DNS cache catches up |
| Logout | `wrangler logout`, named profiles deleted, no login file left | The login never outlives the deploy |

No check calls a paid review. No secret value is read, printed or changed.

## Before the first deploy of the login

1. The owner makes the two Access apps (`docs/ACCESS.md`); the build chat commits their team domain and audience tag.
2. The owner types `ALLOWED_EMAIL` on the production Worker in the dashboard (Settings → Variables and secrets).
3. The deploy line. Then the owner removes the old connector in claude.ai and adds a custom connector named exactly **OpenAI Independent Reviewer** with `https://reviewer.mikeohalloran.au/mcp`, signs in with the emailed code and clicks Allow. The tool names come from that name, so chats that already use the tools keep working.

## Changing a setting

Edit `wrangler.jsonc` and `EXPECTED_CONFIG` in `scripts/deploy.mjs` in the same commit. A Drive folder change is a change to the settings file instead; the live-settings check will stop the next deploy until the live value is changed to match, on the owner's word. A new Durable Object migration also needs "with migrations" in the owner's line.

## Rolling back

Cloudflare keeps earlier versions, but `workers_dev` and the custom domain are settings, not code. The history before this repo went public is kept privately by the owner, including the static-key reviewer it can roll back to. A code-only rollback within the login era is `wrangler rollback <version>` per Worker, under the same login and logout, on its own line from the owner.

## Line endings

`.gitattributes` fixes every text file to LF on checkout. Git for Windows defaults to `core.autocrlf=true`, which otherwise writes CRLF files; the script's clean-tree check runs git with the machine's settings off, so it would see every file as changed (the first step 2 line stopped there, 18 Nov 2026, 1:55pm, before any install or login).

## Rehearsal

`node scripts/deploy.mjs <commit> --settings <test file> --rehearse` runs every step up to the login on a non-Windows machine, from a fresh clone made the way Git for Windows makes it (`core.autocrlf=true`), and writes its report beside the clone. It is how a change to the script is tried before the owner's line. The browser test (`python test/browser/consent_browser.py`) runs in CI.

## v5.1 candidate release notes

The private image path uses the existing jobs and budget bindings. No new route, binding, migration, scope or Cloudflare resource is required. The protected deployment script, configuration, OAuth code and CI workflows remain unchanged; deployment stays with the release owner after separate owner authorization.

The generated legacy transport module is checked in. The clean `npm ci --ignore-scripts` install does not regenerate source. `npm test` checks its exact regeneration and protected-source hash. The existing runtime entry point also imports private-image and memory tests, so the release script runs them without changing its command list.

See [PRIVATE_IMAGES.md](PRIVATE_IMAGES.md) for limits, original-day reservation settlement, synchronous timeout behavior, cleanup recovery and the synthetic live acceptance checks still required. No v5.1 live checks or deployment were performed during implementation.

The release owner manages the shared daily amount separately through the existing settings guard. Review tests exercise a synthetic USD 5 daily limit and the USD 1 private per-call maximum.
