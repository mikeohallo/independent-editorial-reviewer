# Rules for anyone working in this repository

This file is for every contributor: people, Codex, Claude, ChatGPT or any other agent. Read it before you open an issue, push a branch or open a pull request. If another instruction conflicts with it, this file wins for anything that lands on GitHub.

## 1. Everything here is public

The repository, its branches, issues, pull requests, comments and commit messages are public the moment they're pushed or posted. Deleting them later doesn't take them back.

Write about the software only. Never include:

- names, notes, file names or wording from the owner's creative projects, or from the people involved in them;
- Google Drive file or folder IDs, real or copied from anywhere;
- paths on anyone's machine (`C:\…`, `/Users/…`, `/home/…`);
- the account's `workers.dev` subdomain, email addresses (other than GitHub no-reply ones), account IDs or other account-specific values;
- keys, tokens, client secrets, refresh tokens or `google-*.json` files;
- references to private chats, private documents or earlier private versions.

Account-specific values live in a settings file on the deploy machine. Use a placeholder such as `<account>` or `SET-AT-DEPLOY`.

## 2. Test data is made up

Tests and fixtures use synthetic inputs only: generated images, invented text, fake IDs in an obviously fake shape (`test-folder-1`). Never real pages, real scripts or real Drive content. Unit and runtime tests mock the network and never call Google, OpenAI or Cloudflare.

## 3. How a change gets in

1. **An issue first.** One change per issue, describing the software, under section 1's rules.
2. **A branch, then a pull request into `main`.** `main` only accepts pull requests with passing CI; nobody can push to it directly or force-push.
3. **Never merge your own pull request, and never deploy.** The owner approves; the release owner (Claude) merges and deploys through `scripts/deploy.mjs` on the owner's word.
4. **Fill in the pull request checklist.** Say what you tested, what you couldn't test live, and the risks.

## 4. Files you don't change without the owner's explicit approval in the issue

- `src/legacy-v4.1.mjs`: byte-for-byte as reviewed; CI checks its hash.
- Sign-in: `src/index.mjs`, `src/auth.mjs`, `src/access.mjs`.
- Release: `scripts/deploy.mjs`, `.github/workflows/`, `wrangler.jsonc`, `AGENTS.md`, `CLAUDE.md`.
- The review prompts and scoring (owned by ChatGPT and the owner, changed together).

If your change needs one of these, say so in the issue and stop.

## 5. Money and limits

The review tools make paid OpenAI calls. Don't call any review tool against a live server. Keep the per-job and daily caps. Never add an automatic retry of a paid call.

The one exception is a release acceptance run that the owner approves on that release's issue. It uses synthetic images only and is run by the release owner. The approval states the number of calls, the amount authorised per call and the total limit. A paid call in the run is never retried automatically; the run stops at the first failure.

## 6. Checks that run on every push

CI runs these on every branch and pull request. A failure blocks the merge:

- a secrets scan (gitleaks);
- the public-repo check (`scripts/public-check.mjs`): Drive-ID-shaped strings, machine paths, `workers.dev` subdomains, email addresses, and a private list of names held as an encrypted secret (it reports only the file and line, never the term). It also checks commit messages and the pull request's title and description;
- the unit, runtime and browser tests, and the legacy file's hash.

Issues and comments get the same text check (`.github/workflows/public-text.yml`). A hit fails that run, and the release owner checks the Actions tab.

Run the tests before you push:

```
npm ci
npm test
npm run test:runtime
node scripts/public-check.mjs
```

Locally, the name list isn't available, so that part of the check is skipped. Section 1 is still the rule.
