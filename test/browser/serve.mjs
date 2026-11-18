// Serves the real bundle on https://127.0.0.1:<port> for the browser test, and
// prints one JSON line: the authorize URL, an Access token, the PKCE verifier.
import {createHash, randomBytes} from 'node:crypto';
import {startWorker, accessJwt, HOST, REDIRECT} from '../oauth-helpers.mjs';

const port = Number(process.argv[2] || 8443);
const mf = await startWorker({port});
await mf.ready;
const reg = await (await mf.dispatchFetch(`${HOST}/oauth/register`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({client_name: 'Claude', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none'})})).json();
const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const q = new URLSearchParams({response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, scope: 'reviewer:review', state: 'browser-1', code_challenge: challenge, code_challenge_method: 'S256', resource: `${HOST}/mcp`});
console.log(JSON.stringify({authorize: `${HOST}/authorize?${q}`, jwt: accessJwt(), verifier, client_id: reg.client_id}));
process.on('SIGTERM', async () => { await mf.dispose(); process.exit(0); });
