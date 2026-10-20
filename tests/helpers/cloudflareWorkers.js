'use strict';

// The Worker module imports `cloudflare:workers`, which plain Node cannot
// resolve. Tests construct HubDO directly, so stand in for the one export it
// uses: a DurableObject base that keeps ctx and env, as the runtime's does.
const { registerHooks } = require('node:module');

const DURABLE_OBJECT = 'data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }';

registerHooks({
  resolve: (specifier, context, next) => (specifier === 'cloudflare:workers' ? { url: DURABLE_OBJECT, shortCircuit: true } : next(specifier, context)),
});
