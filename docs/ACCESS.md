# Cloudflare Access for the reviewer

Two self-hosted Access applications on `reviewer.mikeohalloran.au`, the same shape as the owner's other connectors. They're made by the owner in the Cloudflare dashboard; the build chat reads them back and commits the main app's audience (AUD) tag to `wrangler.jsonc` (not a secret). Team domain: `mikeohalloran.cloudflareaccess.com` (read 18 Nov 2026).

| App | Destination | Policy | Login | Session |
| --- | --- | --- | --- | --- |
| Editorial reviewer | `reviewer.mikeohalloran.au` (whole host) | existing **Household** (Allow, the owner only) | One-time PIN, instant authentication | 1 month |
| Editorial reviewer connector | `reviewer.mikeohalloran.au/mcp`, `/oauth`, `/.well-known`, `/health` | existing **Connector** (Bypass, everyone) | — | 24 hours |

`/authorize` is deliberately not in the connector app, so the sign-in page stays behind the owner's login. `/mcp` still needs an OAuth token; Bypass only lets claude.ai reach it.

## Steps (Cloudflare dashboard → Zero Trust → Access controls → Applications)

**App 1, "Editorial reviewer"**
1. Create new application → **Self-hosted and private** → Continue with Self-hosted and private.
2. Destinations → Public hostnames: subdomain `reviewer`, domain `mikeohalloran.au`, path empty.
3. Access policies → Add existing policy → **Household**.
4. Authentication: choose the available identity providers → **One-time PIN** only; turn on **Apply instant authentication**.
5. Details: name `Editorial reviewer`; session duration **1 month**.
6. Save.

**App 2, "Editorial reviewer connector"**
1. Create new application → Self-hosted and private → Continue.
2. Destinations → Public hostnames, four rows (Add public hostname for each): subdomain `reviewer`, domain `mikeohalloran.au`, paths `mcp`, `oauth`, `.well-known`, `health`.
3. Access policies → Add existing policy → **Connector**.
4. Details: name `Editorial reviewer connector`; session duration 24 hours.
5. Save.

Then the build chat opens App 1's settings, copies its **Application Audience (AUD) Tag**, commits it as `ACCESS_AUD`, and gives the deploy line once CI is green.
