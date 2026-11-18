// Cloudflare Access check for the sign-in page.
// Access sits in front of /authorize; this verifies its token again inside the
// Worker (RS256, the team's published keys, audience, issuer, time) and that the
// signed-in address is the one allowed address, so a mistake in the Access app
// still lets nobody through.

const KEY_CACHE_MS = 10 * 60 * 1000;
let keyCache = {url: '', at: 0, keys: new Map()};

const b64urlBytes = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0));
const b64urlJson = s => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

export class AccessError extends Error {}

export function accessSettings(env) {
  const team = String(env.ACCESS_TEAM_DOMAIN || '').trim().toLowerCase();
  const aud = String(env.ACCESS_AUD || '').trim();
  const allowed = String(env.ALLOWED_EMAIL || '').trim().toLowerCase();
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(team)) throw new AccessError('Access is not set up (team domain).');
  if (!/^[0-9a-f]{64}$/.test(aud)) throw new AccessError('Access is not set up (application audience).');
  if (!allowed || !allowed.includes('@')) throw new AccessError('Access is not set up (allowed address).');
  return {team, aud, allowed, issuer: `https://${team}`, certs: `https://${team}/cdn-cgi/access/certs`};
}

async function signingKey(certsUrl, kid, fetchFn) {
  const now = Date.now();
  if (keyCache.url !== certsUrl || now - keyCache.at > KEY_CACHE_MS || !keyCache.keys.has(kid)) {
    const r = await fetchFn(certsUrl);
    if (!r.ok) throw new AccessError('Access keys could not be read.');
    const body = await r.json();
    const keys = new Map();
    for (const jwk of body.keys || []) {
      if (jwk.kty !== 'RSA' || !jwk.kid) continue;
      keys.set(jwk.kid, await crypto.subtle.importKey('jwk', {kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true}, {name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256'}, false, ['verify']));
    }
    keyCache = {url: certsUrl, at: now, keys};
  }
  const key = keyCache.keys.get(kid);
  if (!key) throw new AccessError('Access token signed with an unknown key.');
  return key;
}

// Returns the signed-in address, or throws AccessError.
export async function verifyAccess(request, env, {fetchFn = (i, init) => fetch(i, init), nowSeconds = () => Math.floor(Date.now() / 1000)} = {}) {
  const s = accessSettings(env);
  const token = request.headers.get('Cf-Access-Jwt-Assertion') || '';
  const parts = token.split('.');
  if (parts.length !== 3) throw new AccessError('Not signed in through Access.');
  let header, claims;
  try { header = b64urlJson(parts[0]); claims = b64urlJson(parts[1]); } catch { throw new AccessError('Access token unreadable.'); }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new AccessError('Access token uses an unexpected algorithm.');
  const key = await signingKey(s.certs, header.kid, fetchFn);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) throw new AccessError('Access token signature is not valid.');
  const now = nowSeconds();
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(s.aud)) throw new AccessError('Access token is for another application.');
  if (claims.iss !== s.issuer) throw new AccessError('Access token is from another team.');
  if (typeof claims.exp !== 'number' || claims.exp <= now) throw new AccessError('Access token has expired.');
  if (typeof claims.nbf === 'number' && claims.nbf > now + 60) throw new AccessError('Access token is not valid yet.');
  const email = String(claims.email || '').trim().toLowerCase();
  if (!email || email !== s.allowed) throw new AccessError('This address is not allowed.');
  return email;
}

export function resetAccessKeyCache() { keyCache = {url: '', at: 0, keys: new Map()}; }
