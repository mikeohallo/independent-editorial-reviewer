export const LIMITS = Object.freeze({fileBytes: 20 * 1024 ** 2, totalBytes: 30 * 1024 ** 2,
  pixels: 8_000_000, totalPixels: 16_000_000, side: 4096, jsonBytes: 256 * 1024,
  decoderMiB: 48, subrequests: 200, totalMs: 120_000, prepareMs: 45_000,
  minInferenceMs: 65_000, cleanupMs: 10_000, cacheMs: 24 * 60 * 60 * 1000});

// Deadlines cover response bodies as well as response headers. Cancelling also
// releases the upstream stream when a peer ignores AbortSignal after headers.
export async function readBounded(response, max, signal, exact = false) {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > max)) {
    await response.body?.cancel(); throw Error('Response exceeds its byte limit.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw Error('Empty response body.');
  const bytes = new Uint8Array(max); let size = 0;
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const abort = () => { rejectAbort(Error('Request deadline exceeded.')); void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, {once: true});
  if (signal?.aborted) abort();
  try {
    for (;;) {
      const {done, value} = await Promise.race([reader.read(), aborted]);
      if (done) break;
      if (size + value.byteLength > max) throw Error('Response exceeds its byte limit.');
      bytes.set(value, size); size += value.byteLength;
    }
    if (!size || (exact && size !== max)) throw Error('Image size differs from Drive metadata.');
    return bytes.subarray(0, size);
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
  }
}
export async function boundedJSON(response, signal, max = LIMITS.jsonBytes) {
  return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(await readBounded(response, max, signal)));
}
export function networkContext(deadline, counter = {count: 0}) {
  const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
  return {signal, counter, cache: new Map(), async fetch(url, options = {}) {
    signal.throwIfAborted();
    if (++counter.count > LIMITS.subrequests) throw Error('Private review subrequest limit reached.');
    return fetch(url, {...options, redirect: 'manual', signal});
  }};
}
export async function visualAPI(env, context, path, options = {}) {
  const response = await context.fetch('https://api.openai.com/v1' + path, {
    ...options, headers: {Authorization: `Bearer ${env.OPENAI_API_KEY}`, ...options.headers},
  });
  if (!response.ok) { await response.body?.cancel(); throw Error(`OpenAI HTTP ${response.status}; no inference retry.`); }
  return response.status === 204 ? {} : boundedJSON(response, context.signal, 1024 * 1024);
}
