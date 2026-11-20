# Independent Editorial Reviewer

An MCP server on Cloudflare Workers that gives Claude a second opinion from a different model. Claude sends text, an illustration or a whole script or comic; OpenAI reviews it independently; Claude gets back structured findings it didn't write itself.

It's a personal tool, built and run for one owner's creative projects, and published as an example of a small, production-run AI service: paid calls behind budgets, sign-in behind OAuth, and deploys only from a reviewed commit.

**Source candidate:** `5.1.1-candidate.1`. The protected v4.1.0 engine is unchanged. v5.1 was first deployed on 20 November 2026 as `5.1.0-candidate.1`; this candidate also prints the private-image evidence in the review text. See [private image support](docs/PRIVATE_IMAGES.md) for the new Drive path and its limits.

## Tools

| MCP tool | What it does | Cost |
| --- | --- | --- |
| `independent_review` | Critique of a document, draft or plan | Paid |
| `review_illustration` | Visual QA of a page or illustration against a script and a checklist | Paid |
| `review_comic_lettering` | Six checks on speech balloons: dialogue, speaker, tails, reading order, placement, legibility | Paid |
| `start_editorial_review` | Starts a whole-work review of a script, an illustrated PDF, or two revisions, as a background job | Paid, within a per-job and daily cap |
| `get_editorial_review` | Reads a job's status and findings | Free |

The [System Guide](docs/SYSTEM_GUIDE.md) has the inputs, outputs, the 13 editorial criteria, cost controls and source rules.

## How it fits together

```
Claude ──OAuth 2.1──▶ Worker (/mcp) ──▶ OpenAI
          ▲                │
          │                ├─ Durable Objects: job state, daily budget reservations
 sign-in behind            └─ Google Drive: approved input folders, saved reports
 Cloudflare Access
```

- **Sign-in:** claude.ai connects with OAuth 2.1 (dynamic client registration, PKCE) through `@cloudflare/workers-oauth-provider`. The consent page sits behind Cloudflare Access, and the Worker checks the Access token itself (signature, audience, issuer, expiry and the one allowed email).
- **One door:** after the OAuth check, the request goes to the reviewer with its inner key set server-side, so callers never hold it. Only `/mcp`, `/health` and the OAuth endpoints exist; there's no `workers.dev` address.
- **Money:** whole-work reviews reserve an estimated cost against a per-job and daily cap before they start. Private Drive image calls reserve their full authorization against the same configured daily cap. Completion with verified usage releases the unused amount after rounding cost up to a cent. An uncertain paid submission retains the full reservation. Legacy text and URL/data-image calls remain outside that limiter (a known gap).
- **Sources:** the Worker reads only files explicitly passed by ID, and only from approved Drive folders, checked by parent before download. Reports are written to their own folder and refused as inputs.

## Built and shipped

- **Tests run on every push** in GitHub Actions: unit tests and runtime tests on the real bundle (the reviewer, private image handling and memory bounds, and sign-in end to end), a real-browser test of the consent page, and a check that the older engine is byte-for-byte as reviewed. See [VALIDATION.md](VALIDATION.md).
- **Deploys only from a commit the owner names, staging first,** through [`scripts/deploy.mjs`](scripts/deploy.mjs): a settings guard, install and test while logged out, one Cloudflare login with seven scopes, unpaid live checks, and a logout that always runs. See [docs/DEPLOY.md](docs/DEPLOY.md).
- Account-specific values (Drive folder IDs, the `workers.dev` subdomain, machine paths) live in a settings file on the deploy machine, not here. Secrets live only in Cloudflare.

## Running the tests

Node.js 22 or later:

```
npm ci
npm test
npm run test:runtime
node scripts/public-check.mjs
python test/browser/consent_browser.py   # needs Playwright with Chromium
```

Nothing here needs a Cloudflare login, a key or a network service.

## Contributing

Everything here is public. Read [AGENTS.md](AGENTS.md) before opening an issue or pull request: it applies to people and AI agents alike.

## Licence

[MIT](LICENSE). Security reports: see [SECURITY.md](SECURITY.md).
