# Validation

Updated 18 November 2026 (step 2: the login). This replaces the 17 November candidate note, which said v5 was not deployed; it is live (see `docs/SYSTEM_GUIDE.md`, "Operational status").

## Checked on every push (GitHub Actions, `.github/workflows/ci.yml`)

- `src/legacy-v4.1.mjs` is byte-for-byte as reviewed (SHA-256 `e3430357…f10a3950`; changed once, 18 November 2026, when two example strings in `review_illustration`'s input descriptions were made generic for publication).
- `npm test`: 63 unit tests (the reviewer's 59, external services simulated; 4 for the Access check: placeholders refused, the owner admitted, ten kinds of wrong token refused, keys cached).
- `npm run test:runtime`, dry-run builds with no Cloudflare login, no secrets, no deploy:
  - the reviewer itself (authenticated MCP, SQLite jobs, alarms, saved reports), built from `test/runtime-entry/`;
  - the login end to end with the real bundle: public `/health` only; `/mcp` 401 with the OAuth challenge, and the inner key alone refused; discovery and registration; the sign-in page refusing a missing, wrong-address, wrong-app, wrong-team, expired, unknown-key or forged Access token; consent with `form-action` naming claude.ai; Allow once only; PKCE token exchange; `tools/list` through the bridge with a wrong caller key overwritten; the free `get_editorial_review` "not found" check; the reviewer's own Origin check still applied.
- `test/browser/consent_browser.py`: Allow clicked in a real Chromium reaches claude.ai's return address with a code (every other host blocked, so nothing reaches the real claude.ai); no horizontal scroll at 390px or 1366px, light and dark.

## Deploys

`scripts/deploy.mjs` (see `docs/DEPLOY.md`) holds a settings guard: `wrangler.jsonc` must equal the reviewed settings exactly, so a change to a cap, the model, Drive access or an address needs the guard changed in the same commit. The four Drive folder IDs come from the deploy machine's settings file and are checked against the live Worker before anything deploys.

## Live status

The record of what has been verified live is the table in `docs/SYSTEM_GUIDE.md` plus each deploy's run report. A full paid editorial review on production has not been separately verified.

## Known gaps

- No retention or expiry for job records in Durable Objects or reports in Drive.
- The three v4.1 tools are paid and sit outside the v5 daily budget limiter.
- `package.json` still carries the candidate version `5.0.0-candidate.1`; production reports `5.0.0-clean-workspace.1`.
