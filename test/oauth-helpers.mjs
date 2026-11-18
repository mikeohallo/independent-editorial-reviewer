// Shared by the login runtime test and the browser test.
import {readFile} from 'node:fs/promises';
import {generateKeyPairSync, createSign} from 'node:crypto';
import miniflare from 'miniflare';
const {Miniflare, convertV4MiniflareOptions} = miniflare;

export const HOST = 'https://reviewer.mikeohalloran.au';
export const TEAM = 'testteam.cloudflareaccess.com';
export const AUD = 'a'.repeat(64);
export const OWNER = 'owner@example.com';
export const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

const {privateKey, publicKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
const jwk = {...publicKey.export({format: 'jwk'}), kid: 'test-key', alg: 'RS256', use: 'sig'};
const b64u = b => Buffer.from(b).toString('base64url');
export function accessJwt({email = OWNER, aud = AUD, iss = `https://${TEAM}`, exp = Math.floor(Date.now() / 1000) + 600, kid = 'test-key', key = privateKey} = {}) {
  const head = b64u(JSON.stringify({alg: 'RS256', kid, typ: 'JWT'}));
  const body = b64u(JSON.stringify({aud: [aud], email, iss, exp, iat: exp - 900, sub: 'x'}));
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(key);
  return `${head}.${body}.${b64u(sig)}`;
}

export async function startWorker({port} = {}) {
  const script = await readFile(new URL('../.test-build-oauth/index.js', import.meta.url), 'utf8');
  const config = {
    modules: true, script, compatibilityDate: '2026-11-17', cf: false,
    ...(port !== undefined ? {port, host: '127.0.0.1', https: true} : {}),
    kvNamespaces: ['OAUTH_KV'],
    durableObjects: {EDITORIAL_JOBS: {className: 'EditorialJob', useSQLite: true}, EDITORIAL_BUDGET: {className: 'EditorialBudget', useSQLite: true}},
    bindings: {EDITORIAL_ENABLED: '0', MCP_ACCESS_TOKEN: 'inner-key-for-tests', ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ALLOWED_EMAIL: OWNER},
    outboundService: async request => {
      const url = new URL(request.url);
      if (url.hostname === TEAM && url.pathname === '/cdn-cgi/access/certs') return Response.json({keys: [jwk]});
      throw Error('Network access not allowed in this test: ' + url.href);
    },
  };
  return new Miniflare(convertV4MiniflareOptions(config));
}

