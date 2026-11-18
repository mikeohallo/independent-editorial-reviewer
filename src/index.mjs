import {DurableObject} from 'cloudflare:workers';
import {OAuthProvider} from '@cloudflare/workers-oauth-provider';
import {EditorialJobCore, EditorialBudgetCore} from './worker.mjs';
import {apiHandler, defaultHandler, HOST, SCOPE} from './auth.mjs';

export default new OAuthProvider({
  apiRoute: '/mcp',
  apiHandler,
  defaultHandler,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/oauth/token',
  clientRegistrationEndpoint: '/oauth/register',
  scopesSupported: [SCOPE],
  requiredScopes: [SCOPE],
  resourceMetadata: {
    resource: `https://${HOST}/mcp`,
    authorization_servers: [`https://${HOST}`],
    bearer_methods_supported: ['header'],
    resource_name: 'Independent Editorial Reviewer',
  },
  refreshTokenTTL: 90 * 24 * 60 * 60,
});

export class EditorialJob extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.core = new EditorialJobCore(ctx, env); }
  fetch(request) { return this.core.fetch(request); }
  alarm() { return this.core.alarm(); }
}
export class EditorialBudget extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.core = new EditorialBudgetCore(ctx, env); }
  fetch(request) { return this.core.fetch(request); }
}
