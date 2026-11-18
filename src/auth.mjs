// The reviewer's login: OAuth for claude.ai, with the sign-in page behind
// Cloudflare Access. src/legacy-v4.1.mjs and src/worker.mjs are unchanged; once
// a request's OAuth token has been checked, it is handed to them with the inner
// key (MCP_ACCESS_TOKEN) set server-side, so that key never leaves the Worker.

import {AuthorizationError, insufficientScope} from '@cloudflare/workers-oauth-provider';
import inner from './worker.mjs';
import {verifyAccess, AccessError} from './access.mjs';

export const HOST = 'reviewer.mikeohalloran.au';
export const SCOPE = 'reviewer:review';
const USER_ID = 'owner'; // never the address: it would sit in KV key names

const escape = v => String(v).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const text = (body, status) => new Response(body, {status, headers: {'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'}});

// After the OAuth check: hand the request to the unchanged reviewer with the inner key.
export const apiHandler = {
  async fetch(request, env, ctx) {
    if (!ctx?.auth || !(ctx.auth.scope || []).includes(SCOPE)) return ctx?.auth ? insufficientScope(ctx.auth, [SCOPE]) : text('Unauthorized.', 401);
    if (!env.MCP_ACCESS_TOKEN) return text('Server not configured.', 503);
    const headers = new Headers(request.headers);
    headers.delete('Authorization');
    headers.set('x-api-key', env.MCP_ACCESS_TOKEN); // always overwritten, never taken from the caller
    return inner.fetch(new Request(request, {headers}), env, ctx);
  },
};

function consentPage(details, handle) {
  const name = escape(details.clientName || 'An app');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect ${name} to the editorial reviewer</title>
<style>
:root{color-scheme:light dark;font:16px/1.5 system-ui,sans-serif}
body{margin:0;display:grid;place-items:center;min-height:100vh;padding:1rem;box-sizing:border-box}
main{max-width:30rem;width:100%}
h1{font-size:1.3rem}
.note{opacity:.8}
.buttons{display:flex;gap:.75rem;flex-wrap:wrap;margin-top:1.5rem}
button{font:inherit;min-height:44px;min-width:7rem;padding:.5rem 1rem;border-radius:.5rem;border:1px solid currentColor;cursor:pointer}
button[value=approve]{background:#1a56db;color:#fff;border-color:#1a56db}
</style></head><body><main>
<h1>Connect ${name} to the editorial reviewer?</h1>
<p>It will be able to run reviews on your OpenAI account, within the reviewer's limits, and read the review workspace in Drive.</p>
<p class="note">Access goes to <strong>${escape(details.redirectHost)}</strong>.${details.clientDomain ? '' : ' This app registered itself; its name is not verified.'}</p>
${details.redirectIsLoopback ? '<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>' : ''}
<form method="post">
<input type="hidden" name="handle" value="${escape(handle)}">
<div class="buttons"><button name="decision" value="approve">Allow</button><button name="decision" value="deny">Deny</button></div>
</form>
</main></body></html>`;
}

function consentSecurityHeaders(headers, redirectUri) {
  let redirectOrigin = '';
  try { redirectOrigin = new URL(redirectUri).origin; } catch {}
  // form-action must include where Allow sends the browser next (drover-4).
  headers.set('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${redirectOrigin ? ' ' + redirectOrigin : ''}; frame-ancestors 'none'; base-uri 'none'`);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Cache-Control', 'no-store');
  return headers;
}

async function authorize(request, env) {
  try { await verifyAccess(request, env); }
  catch (e) { if (e instanceof AccessError) return text(e.message, 403); throw e; }
  const oauth = env.OAUTH_PROVIDER;
  try {
    if (request.method === 'GET') {
      const authRequest = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(authRequest);
      const consent = await oauth.beginConsent(authRequest);
      consentSecurityHeaders(consent.headers, authRequest.redirectUri);
      consent.headers.set('Content-Type', 'text/html; charset=utf-8');
      return new Response(consentPage(details, consent.handle), {headers: consent.headers});
    }
    if (request.method === 'POST') {
      const form = await request.formData();
      const handle = String(form.get('handle') || '');
      if (form.get('decision') !== 'approve') {
        const denied = await oauth.denyConsent(request, handle);
        return new Response(null, {status: 302, headers: denied.headers});
      }
      const approved = await oauth.approveConsent(request, handle, {scope: [SCOPE]});
      const {redirectTo} = await oauth.completeAuthorization({
        request: approved.request,
        userId: USER_ID,
        metadata: {},
        scope: approved.request.scope,
        props: {user: USER_ID},
      });
      approved.headers.set('Location', redirectTo);
      return new Response(null, {status: 302, headers: approved.headers});
    }
    return text('Method not allowed.', 405);
  } catch (e) {
    if (e instanceof AuthorizationError && e.redirectTo) return Response.redirect(e.redirectTo, 302);
    if (e instanceof AuthorizationError) return text(e.description || 'This sign-in request is not valid. Start again from claude.ai.', 400);
    throw e;
  }
}

// Everything that isn't /mcp with a valid token: the sign-in page and /health.
export const defaultHandler = {
  async fetch(request, env, ctx) {
    const {pathname} = new URL(request.url);
    if (pathname === '/authorize') return authorize(request, env);
    if (pathname === '/' || pathname === '/health') {
      const r = await inner.fetch(new Request(request.url, {method: 'GET'}), env, ctx);
      return new Response(r.body, {status: r.status, headers: r.headers});
    }
    return text('Not found.', 404);
  },
};
