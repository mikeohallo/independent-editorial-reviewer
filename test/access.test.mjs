import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, createSign} from 'node:crypto';
import {verifyAccess, accessSettings, AccessError, resetAccessKeyCache} from '../src/access.mjs';

const TEAM = 'unit.cloudflareaccess.com', AUD = 'c'.repeat(64), OWNER = 'Owner@Example.com';
const env = {ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ALLOWED_EMAIL: OWNER};
const {privateKey, publicKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
const jwk = {...publicKey.export({format: 'jwk'}), kid: 'k1'};
const b64u = s => Buffer.from(s).toString('base64url');
const NOW = 2_000_000_000;
const sign = (claims, {alg = 'RS256', kid = 'k1', key = privateKey} = {}) => {
  const h = b64u(JSON.stringify({alg, kid})), b = b64u(JSON.stringify(claims));
  return `${h}.${b}.${b64u(createSign('RSA-SHA256').update(`${h}.${b}`).sign(key))}`;
};
const good = {aud: [AUD], iss: `https://${TEAM}`, email: 'owner@example.com', exp: NOW + 60};
const req = token => new Request('https://reviewer.mikeohalloran.au/authorize', {headers: token ? {'Cf-Access-Jwt-Assertion': token} : {}});
let certFetches = 0;
const opts = {fetchFn: async url => { certFetches++; assert.equal(url, `https://${TEAM}/cdn-cgi/access/certs`); return Response.json({keys: [jwk]}); }, nowSeconds: () => NOW};

test('access: settings refuse placeholders and a missing address', () => {
  assert.throws(() => accessSettings({...env, ACCESS_TEAM_DOMAIN: 'SET-AFTER-ACCESS-APP'}), AccessError);
  assert.throws(() => accessSettings({...env, ACCESS_AUD: 'SET-AFTER-ACCESS-APP'}), AccessError);
  assert.throws(() => accessSettings({...env, ALLOWED_EMAIL: ''}), AccessError);
  assert.equal(accessSettings(env).allowed, 'owner@example.com');
});

test('access: the owner with a valid token gets through (address compared without case)', async () => {
  resetAccessKeyCache();
  assert.equal(await verifyAccess(req(sign(good)), env, opts), 'owner@example.com');
});

test('access: every wrong token is refused', async () => {
  resetAccessKeyCache();
  const other = generateKeyPairSync('rsa', {modulusLength: 2048}).privateKey;
  const cases = {
    none: null,
    garbage: 'a.b',
    otherAddress: sign({...good, email: 'someone@else.com'}),
    otherApp: sign({...good, aud: ['d'.repeat(64)]}),
    otherTeam: sign({...good, iss: 'https://other.cloudflareaccess.com'}),
    expired: sign({...good, exp: NOW - 1}),
    notYet: sign({...good, nbf: NOW + 3600}),
    hs256: sign(good, {alg: 'HS256'}),
    unknownKey: sign(good, {kid: 'k2'}),
    forged: sign(good, {key: other}),
  };
  for (const [name, token] of Object.entries(cases)) {
    await assert.rejects(verifyAccess(req(token), env, opts), AccessError, name);
  }
});

test('access: the team keys are cached between requests', async () => {
  resetAccessKeyCache(); certFetches = 0;
  await verifyAccess(req(sign(good)), env, opts);
  await verifyAccess(req(sign(good)), env, opts);
  assert.equal(certFetches, 1);
});
