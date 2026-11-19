# Independent OpenAI Reviewer MCP — Complete System Guide

**Source candidate:** `5.1.0-candidate.1` (editorial rubric `independent-editorial-general-v1`)
**Legacy engine:** v4.1.0 (preserved)  
**Document date:** 18 November 2026  
**Status:** v5.1 is an undeployed candidate. Existing rollout notes below describe the earlier deployment, not validation of v5.1.
**Document purpose:** What the system does, how to use it, where information flows, its controls, and how to maintain it.

> This guide describes the inspected v5 source plus the deployment and live tests verified during rollout. It is documentation, not a guarantee of editorial accuracy or a substitute for the current deployed configuration. Do not put API keys, MCP tokens, OAuth refresh tokens, or customer manuscripts in this repository.

The [v5.1 private image guide](PRIVATE_IMAGES.md) supplements the two visual tools with private Drive locators, durable attempt tracking, budget enforcement and cleanup. Legacy URL/data calls retain their previous behavior. The deployment history below is unchanged.

## 1. At a glance

The Independent OpenAI Reviewer is a **Model Context Protocol (MCP) server** that lets Claude invoke a separate OpenAI model as an independent reviewer. It is hosted in a **Cloudflare Worker**. Claude can ask for targeted text, illustration or lettering critique, or initiate an asynchronous **whole-work editorial review** with evidence-linked findings and reports saved in a controlled Google Drive workspace.

This is a **review service, not a publishing or creation service**. It does not write replacement scripts, alter artwork, repair speech balloons, generate images, approve publication, or autonomously search old project materials. The human creator decides what to change.

The current deployment offers **five MCP tools**:

| Tool | Introduced | Purpose | Source transport | Paid? | Persistent Drive report? |
| --- | --- | --- | --- | --- | --- |
| `independent_review` | Legacy v4.1 | Critique text against a brief and focus | Text passed in MCP arguments | Yes, one OpenAI request | No |
| `review_illustration` | Legacy v4.1 | Inspect a page/panel and compare with references/checklist | Direct HTTPS image URLs or base64 data-image URLs | Yes, one OpenAI request | No |
| `review_comic_lettering` | Legacy v4.1 | Check exact dialogue, speakers, tails, reading order, placement and legibility | Direct HTTPS image URLs or base64 data-image URLs | Yes, one OpenAI request | No |
| `start_editorial_review` | v5 | Start a whole-script, illustrated-PDF, or revision-comparison assessment | Inline script text or approved Google Drive file IDs | Yes; two or three OpenAI inference passes | Yes, on completion |
| `get_editorial_review` | v5 | Retrieve the existing editorial job's status, findings, usage and report links | Existing job ID | No new inference initiated | Reads existing result |

**The important distinction:** the three legacy tools are **immediate specialist critiques**. The two v5 tools implement **a durable, asynchronous editorial-review workflow** with source validation, multi-pass analysis, cost reservations, saved reports and revision tracking.

## 2. How the pieces connect

```text
Claude (MCP client)
    |
    | MCP JSON-RPC over HTTPS + x-api-key
    v
Cloudflare Worker: claude-openai-reviewer
    |  /health   public status
    |  /mcp      authenticated tool discovery/calls
    |
    +-- Legacy v4.1 tools -----------------> OpenAI Responses API
    |                                          -> critique returned to Claude
    |
    +-- v5 start/get tools
           |-- validates request and budget
           |-- Cloudflare Durable Objects: job + daily reservation
           |-- Google OAuth -> approved Drive inputs
           |-- snapshots content, SHA-256 hashes
           |-- OpenAI Files + background Responses
           |-- cold read -> assessment [-> revision comparison]
           |-- validates coverage and structured findings
           |-- saves Markdown + JSON to Drive reports folder
           `-- status/results -> Claude via get_editorial_review
```

The job continues on the Cloudflare server between Claude polls. Claude must call `get_editorial_review` to obtain progress or the result; the service does **not** proactively message the user when work completes.

## 3. Tool reference — all five tools

### 3.1 `independent_review` — text critique

**Use it for:** A bounded second opinion on a document, draft, plan, argument, specification or other text. It is not restricted to comics.

**Inputs:**

- `material` — **required**; complete text; up to **32,000 characters**.
- `brief` — optional; rules, context, acceptance criteria; up to **8,000 characters**.
- `focus` — optional; review priorities; up to **4,000 characters**.

**Behaviour:** One paid Responses API call using `OPENAI_MODEL` (default `gpt-6.1-sol`). Instructions ask the model to be independent, evidence-led, critical and fair; to treat supplied material as evidence rather than overriding instructions; and not to pretend it saw images.

**Output:** Human-readable critique containing **PASS / REVISE / FAIL**, overall assessment, up to five prioritised findings, strengths, unverifiable items, next revision, model/token usage and estimated USD API cost. Returns structured content with the review and usage. It does not edit the material or archive a Drive report.

### 3.2 `review_illustration` — illustration/comic-page visual QA

**Use it for:** Reviewing a rendered illustration, panel or page against reference art, an expected script, and explicit visual acceptance criteria.

**Inputs:**

- `images` — **required**, 1–6 images: **exactly one** primary `page` plus optional `reference` or `crop` entries. Each has `role`, `label`, `image_url`, and optionally `panel`.
- `script` — optional expected action and dialogue, up to **12,000 characters**.
- `brief` — optional character/style/project rules, up to **8,000 characters**.
- `checklist` — optional, up to **30** `{id, panel, criterion}` entries.

**Behaviour:** One paid vision-model review (`OPENAI_VISION_MODEL`, falling back to `OPENAI_MODEL` then `gpt-6.1-sol`). The model compares actual rendered images against what the script, references and checklist require. It is directed to be explicit about what is visible, to mark uncertain tiny/occluded details **UNCLEAR**, and to separate panel-specific findings from lettering observations.

**Output:** Overall **PASS / FAIL / BLOCKED**, checklist marks of **PASS / FAIL / UNCLEAR** with evidence and actions, panel findings, lettering checks, strengths, limitations, next actions, usage/cost estimate and image-handling notes.

**Image requirements:** A direct publicly accessible HTTPS image URL or a `data:image/...;base64,...` value for PNG, JPEG, WebP or GIF. A normal Google Drive preview link or an image merely attached to Claude is **not** guaranteed to work. Worker does not resize input; it requests `detail=original`, but OpenAI's actual internal image resolution is not reported. Supply crops for small details.

### 3.3 `review_comic_lettering` — six-rule lettering QA

**Use it for:** Checking whether the final drawn speech balloons, captions and other lettering faithfully implement an authoritative balloon manifest.

**Inputs:**

- `images` — **required**; exactly one full `page` and up to five `crop` images (6 maximum), direct HTTPS/base64 as above.
- `panels` — **required**, 1–12 panels, with planned balloon entries in reading order, up to **30 balloons total**. Each balloon has `id`, `speaker`, and exact `text`; optional `kind` (`speech`, `off_panel`, `thought`, `shout`, `whisper`, `caption`, `sfx`) and notes.
- `script` — optional context, up to **12,000 characters**.
- `brief` — optional lettering style/reading direction/intentional exceptions, up to **8,000 characters**.
- `focus_rules` — optional subset of the six rule IDs below. Unselected rules must be **NOT_TESTED**, not automatic PASS.

**The six independently assessed rules:**

| Rule | Checks |
| --- | --- |
| **L01** Dialogue fidelity | Does printed wording match the authoritative expected balloon text? |
| **L02** Speaker attribution | Can the reader tell **who is speaking**? |
| **L03** Tail construction | Is the tail's origin, taper, trajectory and endpoint appropriate for the speaking region and context? |
| **L04** Reading order | Do panels and balloons create the intended reading sequence? |
| **L05** Balloon placement | Does the **balloon body** fit the scene without obscuring important visual information? Tail-tip faults alone belong to L03. |
| **L06** Legibility and expressive treatment | Is lettering readable, properly contained and appropriate to any specified expressive style? |

**Important separation:** A reader might correctly identify the speaker (L02 **PASS**) while the drawn tail incorrectly points to a hand (L03 **FAIL**). L05 does not automatically fail simply because a tail touches a character's outline. Thought chains and off-panel speech have their own conventions.

**Output:** Per-balloon rule results (**PASS, FAIL, UNCLEAR, N/A, NOT_TESTED**), evidence, severity, uncalibrated model confidence, targeted repair objectives, panel summaries/reading paths, additional findings, priorities, limitations, usage/cost and rulebook version `L01-L06-v1.1`. Overall result is advisory; it does not calculate exact geometric positions or repair the art.

### 3.4 `start_editorial_review` — v5 whole-work editorial assessment

**Use it for:** Independently assessing a **complete script**, an **illustrated comic supplied as a PDF**, or the **effect of revisions** across two versions. This is the principal v5 addition.

**Required arguments:**

| Field | Meaning |
| --- | --- |
| `request_key` | Unique idempotency key, 8–120 characters. Reuse **the same key** if a start request times out. |
| `mode` | `script`, `comic` or `revision`. |
| `artifact_kind` | `script` or `comic`; must match `mode` except in `revision` mode. |
| `revision` | A descriptive revision label (up to 120 characters). |
| `source` | Object with **exactly one** of `text` or `drive_file_id`; optional `expected_sha256`. Illustrated comics require a **PDF Drive file**, not a textual description. |
| `expected_pages` | Number of current pages, 1–60; for PDFs includes cover pages. |
| `max_cost_usd` | User-authorised **estimated** maximum for this job; must be positive and at most the configured server limit. |

**Optional arguments:**

- `panel_manifest`: declared `{page, panels: [panel ID, ...]}` entries; at most 30 panels per listed page, with unique IDs. Helps verify panel coverage.
- `script`: separately supplied authoritative script when reviewing artwork; uses the same text-or-Drive-file source format.
- `reference_file_ids`: up to eight explicitly selected reference files in the approved references folder.
- `editorial_brief`: audience, genre, tone, canon/requirements or review priorities, maximum 5,000 characters. **It is withheld from the initial cold read.**
- In `revision` mode: **required** `previous_source` and `previous_expected_pages` (1–60); optional `previous_review_job_id` for issue-by-issue reconciliation. A previous-review ID must correspond to the same previous-source SHA-256.

**Three modes:**

1. **Script:** Read and evaluate the supplied script's planned page/panel sequence. Do not score finished artwork, lettering or visual fidelity when none was supplied.
2. **Comic:** Read an actual illustrated PDF as a reader first, then evaluate it against any supplied script, references and brief; distinguish observable visual storytelling from explanations not apparent on the page.
3. **Revision:** Reassess the current work, compare it against the previous work, and track prior finding IDs when supplied. A local fix is **not** automatically a net improvement if it introduces new problems elsewhere.

**Multi-pass methodology:**

1. **Prepare:** Check workspace folders; validate source role/ancestry; download allowed files; verify revision stability and optional SHA-256; enforce file-size limits; upload temporary input snapshots to OpenAI.
2. **Cold read:** Analyze the current work *without* the companion script, project context, author commentary or previous verdict; record each declared page/panel and where understanding breaks.
3. **Editorial assessment:** Add the editorial brief, cold read, optional script and selected references; review the whole work and produce 13-area ratings, evidence-linked findings, strengths and revision priorities.
4. **Comparison (revision only):** Add previous source and optional previous report; judge net change, regressions and prior issue resolution, while maintaining the full current assessment.
5. **Save and finish:** Validate output completeness; render Markdown plus JSON; save both in `03_Reports`; record usage, source hashes and report links; clean up temporary OpenAI files where possible.

**Thirteen assessment areas:**

| # | Category | What it evaluates |
| --- | --- | --- |
| 1 | `story_logic` | Causality and internal coherence |
| 2 | `structure` | Setup, development, conflict and resolution |
| 3 | `pacing` | Sequence rhythm and allocation of attention |
| 4 | `character_agency` | Character decisions driving events |
| 5 | `character_relationships` | Interactions and relationship development |
| 6 | `humour_dialogue` | Dialogue effectiveness and humour where applicable |
| 7 | `emotional_payoff` | Whether climaxes and emotional outcomes are earned |
| 8 | `age_suitability` | Audience fit, only where an audience is given |
| 9 | `panel_sequence` | Sequential readability and transitions |
| 10 | `visual_continuity` | Visual consistency, when visuals exist |
| 11 | `art_composition` | Composition and communicative visual choices |
| 12 | `lettering` | Readability and narrative functioning of lettering |
| 13 | `script_fidelity` | Match to a separate supplied authoritative script |

Categories receive a model-judged **1–10 score**, or `null` if not assessable. Overall score is argued rather than a simple average. Findings are labelled **defect / uncertainty / preference**, with **critical / major / minor** severity, page/panel/source evidence, impact, a correction objective and dependent relationships to recheck. Verdicts are `REVISE`, `NO_MATERIAL_ISSUES_FOUND` or `INCONCLUSIVE`. Major/critical defects force `REVISE`; major/critical uncertainty or unreadable pages can force `INCONCLUSIVE`.

**Output when started:** `job_id`, state, phase, model, rubric, token/cost accounting, any report links, and recommended polling delay. The first response often says `queued`; it is **not** the finished report. Do not start the same review with a new key merely to check progress.

### 3.5 `get_editorial_review` — v5 status/result retrieval

**Input:** `{ "job_id": "<64-character lowercase hex job ID>" }`.

**Output:** Job status/phase, message, created time, model/rubric, per-pass token usage, estimated spending and reservation, API-call count, saved report names/links and cleanup warnings. Completed jobs additionally return the structured `review`, rendered Markdown text and current source hash.

**Expected statuses:** queued/preparing/running while active; `completed` if the assessment and both reports were saved; `completed_save_failed` if the assessment completed but Drive saving failed; `blocked` if safe continuation was not possible. The implementation also reserves a `failed` terminal designation. Retrieve and report the exact status/message; do not automatically resubmit the paid job.

**This tool starts no new inference.** It returns an intentional `Invalid job_id.` error for malformed IDs, which was used as the final Claude integration check.

## 4. Approved Google Drive workspace

The v5 service operates against an intentionally separated workspace owned/accessed through a **dedicated Google account**, not the user's primary personal Drive login:

```text
Independent Editorial Review Workspace/
├── 01_Submissions/   # Current works and previous revisions
├── 02_References/    # Explicit comparison scripts and supporting references
└── 03_Reports/       # Generated Markdown and JSON assessments
```

The actual folder IDs are configured at deploy time (from a settings file on the deploy machine, outside the repo; see [DEPLOY.md](DEPLOY.md)), not looked up through name searches. Allowed file placement is enforced by **Google Drive parent/ancestor checks before download**:

| File role | Allowed location |
| --- | --- |
| Current source | `01_Submissions` and descendants |
| Previous source | `01_Submissions` and descendants |
| Separately supplied script | `01_Submissions` or `02_References` and descendants |
| Explicit references / optional server context | `02_References` and descendants |
| Saved reports | **Written** into `03_Reports` only; reports are rejected as inputs |

The Worker **does not search or import old projects**, nor does it automatically consume everything in these folders. Input file IDs must be explicitly supplied. `PROJECT_CONTEXT_FILE_IDS` is currently blank; if configured in future, it may contain up to four specifically approved context-file IDs from `02_References`.

Google OAuth is configured in **full Drive access** mode for that dedicated account, with an explicit acknowledgement. **Important:** OAuth scope is account-wide for what that account can access; the Worker's folder-validation rules restrict *its own normal review requests* but do **not** make the Google OAuth grant itself folder-scoped. Keep unrelated private files out of the dedicated account, and protect the OAuth refresh token.

Supported v5 source types include plain text, Markdown, JSON, PDF, exportable native Google Docs and PNG/JPEG/WebP reference images. Illustrated primary comics must be PDF. A normal Claude chat attachment or pasted Google Drive browser URL does not automatically become a permitted file ID accessible to the Worker.

## 5. Authentication, security and privacy

> **Login (18 November 2026, step 2):** claude.ai now connects with OAuth at `https://reviewer.mikeohalloran.au/mcp`, signing in through Cloudflare Access (the owner only). The static `x-api-key` below is no longer given to any client: the Worker adds it itself after the OAuth check. No `workers.dev` address answers. See [DEPLOY.md](DEPLOY.md) and [ACCESS.md](ACCESS.md).

- The public health endpoint (`/health`, also `/`) exposes only online/version/enablement information.
- `/mcp` expects an **`x-api-key` header** matching the Cloudflare `MCP_ACCESS_TOKEN` secret. Invalid credentials return HTTP 401.
- When an HTTP `Origin` header is provided, only `https://claude.ai` and `https://claude.com` are permitted; this is an additional browser-origin check, not a substitute for the secret.
- The Worker stores `OPENAI_API_KEY`, `MCP_ACCESS_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` and `GOOGLE_OAUTH_SCOPE` as **Cloudflare secrets**. None belongs in Git or this guide.
- Source inputs are verified to be within approved Drive ancestry before reading. A file whose version or modification time changes during download is rejected. SHA-256 may be supplied for additional revision integrity.
- Prompts direct the reviewer to treat scripts, documents and references as **untrusted evidence**, not instructions that can override the reviewing role.
- The v5 start endpoint uses a deterministic hash of `request_key` and rejects key reuse with different arguments. This avoids accidental duplicate charges when retrying a timed-out start.
- Before each paid pass, v5 counts input tokens, estimates a conservative reservation and refuses a pass that would exceed the job's authorised amount. It does not silently truncate a large input or automatically repeat an uncertain paid submission.
- Completed report records and job metadata remain in Google Drive and Cloudflare Durable Objects **without automatic expiry** in the current implementation. OpenAI input files are deleted on normal cleanup, with a 24-hour expiration requested as fallback; cleanup warnings are exposed.
- **Security limitation:** anyone possessing the production MCP token can invoke permitted paid tools. The old v4.1 tools are **not** subject to the new editorial-review spending limiter. Restrict who holds the token and monitor API usage.
- **Operational item:** Cloudflare warned during rollout that Workers Preview URLs were enabled by default. Assess whether they should be disabled; do not treat a predictable health URL or an additional route as secret access control.

## 6. Limits and cost accounting

### Legacy v4.1 limits

| Limit | Value |
| --- | --- |
| Text review material / brief / focus | 32,000 / 8,000 / 4,000 characters |
| Illustration/lettering script / brief | 12,000 / 8,000 characters |
| Illustration checklist | 30 entries |
| Image inputs | 1 primary page + up to 5 references or crops (depending on tool) |
| Lettering scope | 12 panels, 30 balloons |
| Base64 images | Up to 8 million characters per data URL and 14 million total; total request max 16 million characters |
| API cost | Token-based **estimate**, no v5 job/daily reservation cap |

### v5 editorial limits

| Limit | Value |
| --- | --- |
| Declared pages | 1–60 current; 1–60 previous in revision comparisons |
| File bytes | 20 MiB per file; 45 MiB combined snapshots |
| Explicit references | Up to 8 file IDs |
| Optional configured context files | Up to 4 approved file IDs |
| OpenAI inference passes | 2 for a normal review; 3 for revision comparison |
| Review output format | Structured assessment + Markdown + JSON |
| Background execution guards | 2-hour overall limit; 45 minutes per model pass |
| Current production estimated ceilings | **US$1 per job** and **US$1 total daily reservations** |

**Whole-work job reservations:** `EDITORIAL_MAX_JOB_USD` is the maximum amount a user may *authorise* for one job; `max_cost_usd` is required on each request. `EDITORIAL_DAILY_USD` sets one UTC-day limit for both review types. Whole-work jobs reserve their entire authorization. Private image calls settle verified usage as described in [PRIVATE_IMAGES.md](PRIVATE_IMAGES.md). Whole-work jobs retain unused reservations after a cheap or blocked job. For example, one job authorised for US$1 consumes the full US$1 daily reservation allowance even if estimated usage ultimately comes to US$0.06. This is a conservative admission rule, not an OpenAI billing cap. These two settings should be revisited when regular usage begins.

Price estimates use configuration-defined rates and observed tokens; they are **not invoices or guaranteed maximum provider charges**. Google/Cloudflare hosting costs are separate. Model changes require checking price configuration and output compatibility.

## 7. Reports, verdicts and persistence

A successful v5 review produces two files in `03_Reports`:

1. **Markdown (`.md`)** — human-readable assessment, scores, evidence-linked findings, strengths, revision priorities, cold-read page/panel audit, limitations, source hashes and usage.
2. **JSON (`.json`)** — structured report and cold-read records, source snapshot metadata and API usage, suitable for future benchmarking, dashboards or regression checks.

Job state and the report are also retained in Cloudflare Durable Objects. `get_editorial_review` can return the result directly; there is no need to restart the paid assessment to retrieve it. A completed review is **advisory**, not publication sign-off.

**Retention gap:** there is no automatic deletion policy for completed jobs or Drive reports. Establish one before sustained use, particularly if reviewing confidential unpublished work.

## 8. What is verified versus still unproven

| Area | Evidence as of 18 Nov 2026 | Status |
| --- | --- | --- |
| Local code tests | 59/59 tests passed; Cloudflare runtime test passed on Windows | Verified |
| Google OAuth and workspace checks | Auth, approved folders, source reads, integrity checks and report-writing tests passed | Verified |
| Cloudflare staging | Five tools, Google secrets, MCP authentication and safe validation tests passed | Verified |
| End-to-end staging review | Original four-panel test: completed; 4 major causal/continuity findings; Markdown/JSON saved; estimated US$0.064475 | Verified **for one fixture** |
| Production Worker | v5 active, `/health` online; all six required secrets; legacy-tool validation tests passed | Verified |
| Claude connector | All five tools discovered; `get_editorial_review(invalid)` returned the expected error | Verified |
| Full paid editorial review on production | Not yet run; staging demonstrated the flow | **Not separately verified** |
| Broad editorial accuracy across real varied works | No benchmark suite yet | **Not established** |
| Finished-art/PDF and revision-comparison production performance | Functionality exists, but no comparable end-to-end evidence from rollout | **Not established** |

The first editorial test identified the deliberately seeded defects convincingly. Its cold-read appendix also contained a **minor audience-context inconsistency** that the later assessment corrected. Fixing this duplication is a candidate v5.1 improvement, not evidence of a full quality benchmark.

## 9. Known limitations and non-features

- AI judgement may be wrong; evidence and confidence are not calibrated measurements.
- A coverage manifest demonstrates that the **model reported** inspecting pages/panels, not that it perceived every visual detail accurately.
- Small lettering, subtle expression, anatomy and tails may require separately provided close-up crops.
- Finished art cannot be evaluated from script-only material; age fit cannot be scored responsibly without an audience brief.
- No direct conversion of arbitrary Claude attachments to Drive files; approved Drive file IDs/inline text are required for v5.
- No artwork creation, document rewrites, balloon repair, publishing approval or automated project-management workflow.
- No automatic alerts to Claude when a background review finishes; the caller polls an existing job ID.
- No provider-enforced hard dollar cap; daily budget reservations can be consumed more quickly than actual billed usage.
- No automatic archival/expiry policy for job records or finished reports.
- No general-purpose file search across Google Drive, and **no intended access to historical project material**.
- Existing legacy v4.1 calls do not produce v5 Drive reports and do not inherit the new v5 budget reservation scheme.

## 10. Operation and maintenance

### Production and staging addresses

> **Since step 2:** production is `https://reviewer.mikeohalloran.au` (custom domain); both `workers.dev` addresses below are off, and staging has no address and editorial off. The table is kept for history.

| Environment | Worker name | Health | MCP |
| --- | --- | --- | --- |
| Production | `claude-openai-reviewer` | `https://claude-openai-reviewer.<account>.workers.dev/health` | `https://claude-openai-reviewer.<account>.workers.dev/mcp` |
| Staging | `claude-openai-reviewer-v5-staging` | `https://claude-openai-reviewer-v5-staging.<account>.workers.dev/health` | `https://claude-openai-reviewer-v5-staging.<account>.workers.dev/mcp` |

The **same code tree** is deployed using different `--name` targets. Pay attention to the local `wrangler.jsonc` values: at the end of rollout, editorial reviews were enabled in production, and estimated cost ceilings were set to US$1/US$1. The original candidate ZIP's defaults are **outdated** (`EDITORIAL_ENABLED=0`, US$5/US$10, narrow Drive scope). Do not replace live configuration with that archived candidate without review.

> **Deploys (18 November 2026):** deploys now run only through `scripts/deploy.mjs` on the owner's commit line; see [DEPLOY.md](DEPLOY.md). The `npx wrangler deploy` lines below are kept for reference and are not how a deploy is done.

**Useful local commands (Windows PowerShell):**

```powershell
npm ci
npm test
npm run test:runtime

npx wrangler deployments list --name claude-openai-reviewer
npx wrangler secret list --name claude-openai-reviewer
npx wrangler secret list --name claude-openai-reviewer-v5-staging

# Deploy to staging FIRST after setting the intended staging variables
npx wrangler deploy --name claude-openai-reviewer-v5-staging

# Production deployment only after staging acceptance
npx wrangler deploy --name claude-openai-reviewer
```

**Safe update procedure:**

1. Create a Git branch, record the current production version and the intended change.
2. Update implementation, tests, rubric version if warranted, documentation and changelog together.
3. Run unit and runtime tests, including all three legacy tool contracts.
4. Deploy to staging by explicit name, verify secrets/config, then run a **bounded** fresh test with a fixed benchmark fixture.
5. Compare actual findings against reference expectations: detection, false positives, severity, evidence quality and regressions. Check cost and file cleanup.
6. Deploy production with the exact `--name` and reviewed budget settings, then verify health, secrets, MCP tool list, legacy calls and Claude connection.
7. Keep the previous working deployment/version and have a rollback plan. A Durable Object migration can make rollback more complex than merely selecting an old version.

**Do not** re-upload local OAuth client/refresh-token JSON into GitHub. Wrangler's `secret put`/`secret bulk` should be used only when a real credential change is needed. When parallel deployments or security tooling clear Wrangler login state, reauthenticate instead of changing working application tokens.

### Suggested v5.1 improvements

- Build a small public/synthetic **accuracy benchmark** of both broken and correct narratives, with expected findings and false-positive checks; run it across every editorial change.
- Prevent contradictory cold-read limitations from being repeated into final reports after the user supplies an editorial brief.
- Improve the daily budget reservation design if regular multi-job use is intended, while retaining conservative billing controls.
- Define retention/deletion rules for Drive reports and Durable Object data.
- Review Preview URLs and production access, and consider more granular per-client tokens/rate limiting.
- Test illustrated-PDF and revision-comparison paths end-to-end before relying on them in high-stakes publishing decisions.

## 11. GitHub documentation and source-of-truth policy

> **Public since November 2026:** the repository was made public after a publication and security review: fresh history, no secrets, no account-specific folder IDs or machine paths (those live in the deploy machine's settings file), MIT licence. The advice below to stay private predates that review.

**Recommended:** a **private GitHub repository** named `independent-editorial-reviewer` containing actual deployable source code and these versioned documents. The old candidate `README.md` and `VALIDATION.md` must be updated or replaced because they say v5 was not yet deployed; retaining them as current guidance would be misleading.

```text
independent-editorial-reviewer/
├── README.md                     # Short overview + link to this guide
├── docs/
│   ├── SYSTEM_GUIDE.md           # This complete functional/technical reference
│   ├── OPERATIONS.md             # Optional detailed runbooks and recovery plans
│   └── CHANGELOG.md              # Optional versioned release notes
├── src/                          # Worker and reviewer source
├── scripts/                      # OAuth helper, without credential files
├── test/                         # Unit and runtime verification
├── wrangler.jsonc                # Non-secret Worker configuration
├── package.json
└── .gitignore
```

**Never commit:** `google-client.json`, `google-secrets.json`, `.dev.vars`, `.env*`, raw API keys, MCP access tokens, refresh tokens, locally downloaded manuscripts, private reports or Wrangler local session/config files. Keep these in Cloudflare secrets and appropriate local secret storage. Preserve `.gitignore`, consider GitHub secret scanning and use a private repository until a deliberate publication/security review.

**Division of responsibilities:**

- **GitHub:** canonical source code, versioned documentation, change history, tests and future issue tracking.
- **Cloudflare:** execution and Durable Object job/budget state; secrets and deployments.
- **Google Drive:** explicitly submitted working sources, approved reference files and generated reports.
- **Password manager:** credentials and recovery notes, not source-control files.
- **Claude:** client interface to invoke the five MCP tools, subject to approval and token access.

## 12. Quick-start usage patterns

**Targeted text review:** Ask Claude to use `independent_review` with the complete text, brief and focus; approve the paid call.

**Illustration QA:** Provide one direct page-image URL or data URL, relevant references/crops, script and observable checklist. Ask Claude to use `review_illustration`; inspect PASS/FAIL/UNCLEAR evidence.

**Lettering QA:** Provide page/crops plus an authoritative panel/balloon manifest. Ask Claude to run `review_comic_lettering` for L01–L06 or a focused subset; don't conflate speaker attribution, tail construction and placement.

**Whole-script editorial review:** Place a source in `01_Submissions` or provide its full text, specify page count, revision, brief and a chosen estimated budget at or below the production ceiling. Claude starts one job; record its ID; retrieve progress/results with `get_editorial_review`; read the Drive Markdown report and use JSON for repeatable comparisons.

**Revision comparison:** Supply both versioned sources, their page counts, and optionally the prior review job ID. Ask for net effect across the **whole work**, not just disappearance of previous findings; read the `prior_issue_status` and `change_assessment` fields.

---

**Maintenance note:** This guide is a snapshot of the source inspected and the operations verified on 18 November 2026. Update it whenever the tool schemas, review rubric, access controls, cost model, hosting configuration or live rollout status changes. It is not evidence that every feature has been exhaustively field-tested.
