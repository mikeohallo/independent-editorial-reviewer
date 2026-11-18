# Security

This is a personal service with one user. If you find a security problem in the code, please report it privately through GitHub's **Report a vulnerability** button on this repository's Security tab rather than in a public issue.

Please don't test against the live service at `reviewer.mikeohalloran.au`: its review tools spend real money on the owner's account.

What's in scope: the OAuth and Access checks (`src/auth.mjs`, `src/access.mjs`), source and folder checks before Drive reads, and the budget reservations. No secrets, keys or account-specific IDs are in this repository; if you see one, that's worth reporting too.
