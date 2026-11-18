// The login layer end to end in the Workers runtime (Miniflare), with the real
// bundle: discovery, registration, the Access-guarded sign-in page, consent,
// PKCE token exchange, and the inner-key bridge to the unchanged reviewer.
// Nothing reaches OpenAI or Google: any outside call fails the test.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync, randomBytes} from 'node:crypto';
import {startWorker, accessJwt, HOST, REDIRECT} from './oauth-helpers.mjs';
const b64u = b => Buffer.from(b).toString('base64url');

const pkce = () => { const verifier = b64u(randomBytes(32)); return {verifier, challenge: b64u(createHash('sha256').update(verifier).digest())}; };
const rpc = (method, params = {}) => JSON.stringify({jsonrpc: '2.0', id: 1, method, params});

test('login layer: discovery, Access-guarded consent, PKCE, inner-key bridge', async () => {
  const mf = await startWorker();
  try {
    const get = (path, init) => mf.dispatchFetch(HOST + path, {redirect: 'manual', ...init});

    // Public: health only; everything else needs a token or Access.
    const health = await (await get('/health')).json();
    assert.equal(health.status, 'online'); assert.equal(health.legacy_engine, '4.1.0');
    assert.equal((await get('/nothing-here')).status, 404);

    // No token: 401 with a pointer to the resource metadata. The old static key alone is refused.
    const bare = await get('/mcp', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: rpc('tools/list')});
    assert.equal(bare.status, 401);
    assert.match(bare.headers.get('WWW-Authenticate') || '', /resource_metadata="https:\/\/reviewer\.mikeohalloran\.au\/\.well-known\/oauth-protected-resource\/mcp"/);
    const oldKey = await get('/mcp', {method: 'POST', headers: {'Content-Type': 'application/json', 'x-api-key': 'inner-key-for-tests'}, body: rpc('tools/list')});
    assert.equal(oldKey.status, 401, 'the inner key must not open /mcp from outside');

    const prm = await (await get('/.well-known/oauth-protected-resource/mcp')).json();
    assert.equal(prm.resource, `${HOST}/mcp`);
    const asm = await (await get('/.well-known/oauth-authorization-server')).json();
    assert.equal(asm.authorization_endpoint, `${HOST}/authorize`);
    assert.equal(asm.token_endpoint, `${HOST}/oauth/token`);
    assert.equal(asm.registration_endpoint, `${HOST}/oauth/register`);

    // Dynamic registration, as claude.ai does it.
    const reg = await (await get('/oauth/register', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({client_name: 'Claude', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code']})})).json();
    assert.ok(reg.client_id);

    const {verifier, challenge} = pkce();
    const q = new URLSearchParams({response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, scope: 'reviewer:review', state: 'st-1', code_challenge: challenge, code_challenge_method: 'S256', resource: `${HOST}/mcp`});
    const authorizePath = `/authorize?${q}`;

    // The sign-in page refuses anything but a valid Access token for the one address.
    assert.equal((await get(authorizePath)).status, 403);
    for (const bad of [{email: 'someone@else.com'}, {aud: 'b'.repeat(64)}, {iss: 'https://other.cloudflareaccess.com'}, {exp: Math.floor(Date.now() / 1000) - 5}, {kid: 'unknown'}, {key: generateKeyPairSync('rsa', {modulusLength: 2048}).privateKey}]) {
      const r = await get(authorizePath, {headers: {'Cf-Access-Jwt-Assertion': accessJwt(bad)}});
      assert.equal(r.status, 403, `refused: ${Object.keys(bad)[0]}`);
    }

    const access = {'Cf-Access-Jwt-Assertion': accessJwt()};
    const page = await get(authorizePath, {headers: access});
    assert.equal(page.status, 200);
    const csp = page.headers.get('Content-Security-Policy') || '';
    assert.match(csp, /form-action 'self' https:\/\/claude\.ai/);
    assert.match(csp, /frame-ancestors 'none'/);
    const html = await page.text();
    assert.match(html, /Connect Claude to the editorial reviewer/);
    assert.match(html, /claude\.ai/);
    const handle = html.match(/name="handle" value="([^"]+)"/)[1];
    const cookie = (page.headers.getSetCookie?.() || [page.headers.get('Set-Cookie')]).filter(Boolean).map(c => c.split(';')[0]).join('; ');

    // Allow, without Access on the POST: refused.
    const form = new URLSearchParams({handle, decision: 'approve'}).toString();
    const noAccessPost = await get('/authorize', {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie}, body: form});
    assert.equal(noAccessPost.status, 403);

    const allowed = await get('/authorize', {method: 'POST', headers: {...access, 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie}, body: form});
    assert.equal(allowed.status, 302);
    const back = new URL(allowed.headers.get('Location'));
    assert.equal(back.origin + back.pathname, REDIRECT);
    assert.equal(back.searchParams.get('state'), 'st-1');
    const code = back.searchParams.get('code');
    assert.ok(code);

    // The handle works once.
    const again = await get('/authorize', {method: 'POST', headers: {...access, 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie}, body: form});
    assert.equal(again.status, 400);

    const tok = await (await get('/oauth/token', {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: verifier, resource: `${HOST}/mcp`}).toString()})).json();
    assert.ok(tok.access_token, JSON.stringify(tok));
    assert.match(tok.scope || '', /reviewer:review/);
    assert.ok(tok.refresh_token);

    // Through the bridge: tools/list reaches the unchanged reviewer, with a wrong caller key overwritten.
    const call = (body, extra = {}) => get('/mcp', {method: 'POST', headers: {'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${tok.access_token}`, ...extra}, body});
    const list = await call(rpc('tools/list'), {'x-api-key': 'wrong-key-from-caller'});
    assert.equal(list.status, 200);
    const names = (await list.json()).result.tools.map(t => t.name).sort();
    assert.deepEqual(names, ['get_editorial_review', 'independent_review', 'review_comic_lettering', 'review_illustration', 'start_editorial_review']);

    // The free check used after go-live: a made-up job ID answers "not found", with no outside call.
    const fake = createHash('sha256').update('no-such-job').digest('hex');
    const got = await (await call(rpc('tools/call', {name: 'get_editorial_review', arguments: {job_id: fake}}))).json();
    assert.equal(got.result.isError, true);
    assert.match(got.result.content[0].text, /not found/i);

    // The reviewer's own Origin check still applies behind the token.
    assert.equal((await call(rpc('tools/list'), {Origin: 'https://evil.example'})).status, 403);

    // A token for another resource, or a broken one, is refused.
    assert.equal((await get('/mcp', {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer nope'}, body: rpc('tools/list')})).status, 401);
  } finally {
    await mf.dispose();
  }
});
