# Security

This is a personal service with one user. If you find a security problem in the code, please report it privately through GitHub's **Report a vulnerability** button on this repository's Security tab rather than in a public issue.

Please don't test against the live service at `reviewer.mikeohalloran.au`: its review tools spend real money on the owner's account.

What's in scope: the OAuth and Access checks (`src/auth.mjs`, `src/access.mjs`), source and folder checks before Drive reads, and the budget reservations. No secrets, keys or account-specific IDs are in this repository; if you see one, that's worth reporting too.

Private Drive image calls authorize the complete file set before media reads, reject redirects, validate PNG/JPEG payloads under byte/pixel/decoder bounds, and recheck source metadata before inference. They use the existing workspace authorization and budget ledger. A durable submission marker prevents automatic paid retries after interruption. Temporary OpenAI copies have requested expiry and bounded deletion recovery; cleanup failures are visible in results. See [the private image guide](docs/PRIVATE_IMAGES.md) for retention and memory-measurement limitations. Tests use synthetic inputs and mocked services only.
