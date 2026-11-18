# Private images in v5.1

Candidate `5.1.0-candidate.1` extends `review_illustration` and `review_comic_lettering`. The five tool names, public endpoints, OAuth implementation, editorial prompts and scoring remain unchanged. This candidate has not been deployed or validated against paid services.

## Calling the tools

Each image has exactly one locator: `drive_file_id` or the existing `image_url`. Use one locator type for the entire request. A Drive request requires `request_key` and `max_cost_usd`. It returns the review synchronously; it does not create a whole-work editorial job or write a Drive report.

Synthetic example:

```json
{
  "request_key": "test-review-001",
  "max_cost_usd": 0.3,
  "images": [
    {"role": "page", "label": "Synthetic page", "drive_file_id": "test-image-001"},
    {"role": "reference", "label": "Synthetic context", "drive_file_id": "test-image-002"}
  ],
  "checklist": [{"id": "C1", "panel": "P1", "criterion": "The square is visible."}]
}
```

Use the existing `panels`, `balloons` and optional `focus_rules` arguments for lettering. Lettering supports only `page` and `crop`. Illustration also supports `reference`; contextual neighboring pages must use that role and an explicit context label. Exactly one `page` and at most six images are allowed.

Page and crop files must descend from the configured submissions folder. References must descend from the references folder. Both folders and the report folder must be immediate children of the approved workspace root. The shared authorization implementation is reused. Reports, external files, shortcuts, trashed files and ambiguous ancestry are rejected. All image metadata is authorized before any media download. No automatic context, folder listing, historical revision or thumbnail is fetched.

URL/data-image requests continue through the original engine, including its formats and limits. They do not acquire the new Drive budget protection. An HTTPS URL still has to be reachable by OpenAI.

## Resource limits

| Limit | Value |
| --- | --- |
| Private request JSON | 256 KiB, actual UTF-8 bytes |
| Images | 1–6, exactly one page |
| Encoded file / aggregate | 20 MiB / 30 MiB |
| Pixels per image / aggregate | 8,000,000 / 16,000,000 |
| Maximum width or height | 4096 |
| Formats | Static PNG and JPEG only |
| JPEG decoder allocation | 48 MiB conservative preflight plus decoder guard |
| Embedded image metadata | 256 KiB |
| External subrequests | 200 across preparation, inference and immediate cleanup |
| Admission | One private review per Worker isolate at a time; no waiting queue |
| Time budget | 120 seconds: up to 45 preparation, 65 inference, 10 cleanup |

These are upper bounds, not a guarantee every file below them is accepted. In particular, JPEG coefficient storage can exceed the decoder budget below the pixel limit; such files are rejected before decoding. PNG validation checks CRCs, chunk ordering, legal color/depth combinations, decompression, scanline filters, palette indices and interlaced passes. Inflater writes are bounded. JPEG validation checks structure, dimensions, sampling, EXIF orientation and bounded non-tolerant decoding with pinned `jpeg-js` 0.4.4. Animated PNG and unsupported encodings are rejected.

Images are processed sequentially and multipart uploads stream bounded chunks without materializing Blob/FormData copies. Only metadata and uploaded file IDs survive each iteration. No resizing, re-encoding, auto-rotation or base64 conversion occurs. Source MIME, current version, revision ID when present, names, parents, size and modification time are checked again after download and for the complete batch before inference, including after token counting. Provenance includes original bytes' SHA-256, dimensions and orientation. Model-side dimensions are not reported. Drive does not offer an atomic transaction spanning several files; a change after the final metadata check remains a race, but the review always refers to the uploaded snapshot hash.

## Cost and interruption behavior

The resolved vision model is `OPENAI_VISION_MODEL`, then `OPENAI_MODEL`, then `gpt-6.1-sol`. It must match the model validated by `priceConfig` and any configured pricing override. The built-in conservative rates remain USD 5 per million input tokens and USD 10 per million output tokens. Token counting uses the actual file-backed input, instructions and output schema. The input ceiling is `ceil(count × 1.1) + 5000`, at most 200,000. Output limits remain 7,000 for illustration and 8,000 for lettering. A count failure or estimated cost above authorization blocks inference.

After preflight, the existing shared budget object reserves the **entire** `max_cost_usd`, with a maximum private per-call and daily allowance of USD 1, or lower configured limits. Reservations share the existing UTC-day ledger with whole-work reviews. Unused capacity is not refunded. A reservation followed by an interruption can consume the allowance without producing a review. An ambiguous reservation response is reported as unknown. This is conservative admission control, not a guarantee about provider billing.

A separately tagged record in the existing jobs namespace binds the request key to the tool and all arguments. Completed identical requests replay the cached result for 24 hours. Changed arguments reject the key. In-progress, interrupted, uncertain and expired attempts never start another inference. A busy rejection before claiming a key can be retried with the same request. Do not create a new key just to poll or recover a lost response. After cache expiry, a minimal identity tombstone remains indefinitely. Whole-work job records are unaffected.

The `submitting` state is durable before the single paid POST. There is no automatic inference retry. Missing usage, incomplete/refused responses and malformed review JSON cannot produce a successful private review. If provider usage exceeds the estimate, the result reports the accounting problem and no retry occurs. Legacy editorial normalization remains authoritative; v5.1 does not change its known illustration-verdict reconciliation or lettering `off_panel` limitations.

## Temporary copies and output

OpenAI Files receives the original bytes with purpose `user_data` and requested expiry of 24 hours. The Responses request uses `input_image.file_id`, `detail: original`, `store: false`, `background: false`, default service tier and disabled truncation. Server-only placeholder URLs used to construct the legacy payload never reach OpenAI.

Known uploaded file IDs are persisted immediately and deletion is attempted on success and failure. Up to three further alarm rounds retry **deletions only**. A lost upload response has no recoverable ID; requested expiry is the fallback. Cleanup status is durable and appears in replayed results. Normal cache expiry removes review text and source metadata, retaining the request identity tombstone. These controls do not override OpenAI's own data retention policies.

Existing review fields are preserved, with additive `structuredContent.private_image_handling` containing provenance, attempt status, conservative cost accounting, cleanup status and limitations. Legacy `usage` pricing remains the legacy presentation; use the additive budget fields for the new conservative estimate. Legacy service-version fields identify the unchanged engine; application discovery and health identify v5.1.

## Implementation and verification

`scripts/generate-legacy-visual.mjs` verifies the protected module hash and mechanically encloses the complete source in a factory with an injected `fetch` parameter. It replaces only the single default export with a return statement. The checked-in generated file requires no install hook. No runtime source rewriting, global fetch replacement or separately maintained editorial rules are used. Tests check exact regeneration and compare successful URL/data calls and payloads against the original module.

The automated suite uses synthetic images and mocked services. Workerd tests cover SQLite replay, both private tools, file-backed images, cleanup, a nearly 30 MiB six-image batch and a JPEG near the decoder allocation ceiling. Memory assertions sample V8 used heap plus backing storage and require less than 96 MiB. Sampling is not a proof of all transient peaks and excludes native runtime overhead. Concurrent legacy calls and production account behavior still require release-owner validation.

Before a live acceptance run, the owner and release owner must separately authorize deployment and any paid synthetic review. Later checks should verify real Files acceptance/expiry/deletion, file-backed token counting and image detail for the configured model, actual account pricing, connector timeout behavior, the synchronous latency budget and total isolate memory. Do not use private creative material to validate this transport.
