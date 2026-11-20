# Validation

Source candidate `5.1.0-candidate.1`, 18 November 2026. v5.1 has not been deployed or tested with paid services. Earlier live rollout records remain in the System Guide.

## Checked on every push (GitHub Actions, `.github/workflows/ci.yml`)

- `src/legacy-v4.1.mjs` is byte-for-byte as reviewed (SHA-256 `e3430357…f10a3950`; changed once, 18 November 2026, when two example strings in `review_illustration`'s input descriptions were made generic for publication).
- `npm test`: the existing editorial and Access checks, generated-wrapper integrity and successful legacy parity, private image validation, authorization, provenance races, budgets, durable replay, interruption and cleanup tests. All service calls are mocked.
- `npm run test:runtime`, dry-run builds with no Cloudflare login, no secrets, no deploy:
  - private PNG/JPEG requests, SQLite replay, original lettering normalization, cleanup, and measured image-memory ceilings;
  - the reviewer itself (authenticated MCP, SQLite jobs, alarms, saved reports), built from `test/runtime-entry/`;
  - the login end to end with the real bundle: public `/health` only; `/mcp` 401 with the OAuth challenge, and the inner key alone refused; discovery and registration; the sign-in page refusing a missing, wrong-address, wrong-app, wrong-team, expired, unknown-key or forged Access token; consent with `form-action` naming claude.ai; Allow once only; PKCE token exchange; `tools/list` through the bridge with a wrong caller key overwritten; the free `get_editorial_review` "not found" check; the reviewer's own Origin check still applied.
- `test/browser/consent_browser.py`: Allow clicked in a real Chromium reaches claude.ai's return address with a code (every other host blocked, so nothing reaches the real claude.ai); no horizontal scroll at 390px or 1366px, light and dark.

## Release-review verification (20 November 2026)

On Node 22.23.5, `npm ci` succeeded, all 158 unit tests passed and all 11 runtime tests passed. Both suites reported zero skips. The public-repository check passed locally. GitHub CI supplies the private-name and secret scans and the browser consent check.

Settlement tests cover fractional cents, full pre-submission release, retention after an uncertain paid submission, repeated release, delayed reservation, loss or mismatch of settlement acknowledgements, restarts, original-day credits across midnight and historical numeric records. Reserve replay tests cover matching and mismatched holds, closed IDs after every settlement outcome, and a same-ID settle/re-reserve race in SQLite. Workerd tests exercise a shared USD 5 test ledger with competing reservations and releases, while protecting the USD 1 private per-call limit. Accelerated offline deadlines exercise slow preparation, late admission, successful inference beyond the former fixed allocation, timeout, cleanup and replay.

The latest workerd run measured 59.81 MiB for the six-image batch and 46.98 MiB for JPEG validation and upload. The 96 MiB check samples V8 heap and backing storage. Production latency, provider charges and native isolate overhead still need live validation.

## v5.1 local evidence (19 November 2026)

- Node 22.23.5; `npm ci` completed successfully.
- `npm test`: 144 passed, zero failures or skipped tests.
- `npm run test:runtime`: five passed, including the unchanged OAuth flow, SQLite jobs, private images and memory assertions.
- The final memory run measured 65.53 MiB for the six-image PNG batch and 54.65 MiB for JPEG validation/upload, against a 96 MiB sampled V8 heap/backing-storage ceiling. Native runtime overhead is excluded.
- `node scripts/public-check.mjs`: clean locally; the private name list is available only in CI. Protected files remain unchanged.
- The browser consent test was attempted but Chromium is not installed in this environment. Its CI run remains required.
- No live service review, private material, paid API call, deployment or Cloudflare resource change was used.

Self-review added bounded multipart streaming to remove whole-image copies, cancellation ordering for stalled bodies, metadata checks after token counting, explicit ambiguous-reservation reporting, deletion-confirmation checks, and a deadline measured from request ingress.

## Deploys

`scripts/deploy.mjs` (see `docs/DEPLOY.md`) holds a settings guard: `wrangler.jsonc` must equal the reviewed settings exactly, so a change to a cap, the model, Drive access or an address needs the guard changed in the same commit. The four Drive folder IDs come from the deploy machine's settings file and are checked against the live Worker before anything deploys.

## Live status

The record of what has been verified live is the table in `docs/SYSTEM_GUIDE.md` plus each deploy's run report. A full paid editorial review on production has not been separately verified.

## Known gaps

- Whole-work job records and Drive reports retain their existing retention policy. Private visual results expire after 24 hours; minimal request-key tombstones remain.
- Legacy text and URL/data-image calls remain outside the daily budget limiter; private Drive images use it.
- Memory tests measure sampled V8 heap plus backing storage, excluding native runtime overhead. Live latency, provider file handling, expiry/deletion and account pricing remain unverified. See [private image acceptance notes](docs/PRIVATE_IMAGES.md).
