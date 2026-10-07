'use strict';
const { createHash, timingSafeEqual } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
function object(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function sha256(v) { return createHash('sha256').update(v).digest('hex'); }
function equalSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function abortError() { const e = new Error('Operation cancelled.'); e.name = 'AbortError'; return e; }
function checkAbort(signal) { if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : abortError(); }
function positive(v, fallback) { return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback; }
function safeCode(v) { return typeof v === 'string' && /^[\w.:[\]-]{1,180}$/.test(v) ? v : undefined; }
function shape(v) {
  if (!object(v)) return Array.isArray(v) ? 'array' : typeof v;
  return Object.keys(v).slice(0,12).map(k => `${safeCode(k) || '?'}:${Array.isArray(v[k]) ? 'array' : typeof v[k]}`).join(',');
}
class BridgeError extends Error {
  constructor(message, { code = 'bridge_error', status, requestId, param, bodyShape } = {}) {
    super(message); this.name = 'BridgeError'; this.code = safeCode(code) || 'unknown_error';
    this.status = status; this.requestId = safeCode(requestId); this.param = safeCode(param); this.bodyShape = bodyShape;
  }
  diagnostic() { return { code: this.code, status: this.status, requestId: this.requestId, param: this.param, bodyShape: this.bodyShape }; }
}
const explanations = {
  subscription_sharing_usage_limit_exceeded: 'ChatGPT plan/app usage limit reached. Open ChatGPT Settings → Usage; no automatic billing fallback is performed.',
  subscription_sharing_user_not_eligible: 'This ChatGPT account/workspace is not eligible for direct plan usage.',
  subscription_sharing_usage_unavailable: 'OpenAI could not check plan usage. Credentials have been preserved.',
  subscription_sharing_unsupported_capability: 'OpenAI rejected a capability on the direct plan route. Check the error parameter and model selection.',
  subscription_sharing_route_not_supported: 'OpenAI did not admit this public direct route for the grant.',
  subscription_sharing_invalid_user: 'OpenAI could not validate the subscriber context. Check the account or reauthorize.',
  chatpass_v2_scope_not_authorized: 'The account grant does not authorize plan usage.',
  chatpass_v2_invalid_authorization_context: 'OpenAI rejected the signed permission context.',
  subscription_sharing_user_unavailable: 'OpenAI account/workspace information is temporarily unavailable.',
};
function remoteError(status, body, requestId) {
  const e = object(body?.error) ? body.error : {};
  const code = safeCode(e.code) || safeCode(typeof body?.error === 'string' ? body.error : '') || `http_${status}`;
  const help = explanations[code] || ({401:'OpenAI did not accept the identity or direct-use permission. Check the selected account and granted scopes.',403:'OpenAI blocked admission: account, workspace, policy, or serving-region restriction.',429:'OpenAI rate/usage limit reached.',503:'OpenAI direct routing is temporarily unavailable or not enabled.'}[status]) || 'OpenAI request failed.';
  const id = safeCode(requestId), param = safeCode(e.param);
  // Never copy upstream text into logs: it can contain prompts, credentials or private paths.
  return new BridgeError(`${help} [${status}; ${code}${param ? `; param=${param}` : ''}${id ? `; request=${id}` : ''}]`, {code,status,requestId:id,param,bodyShape:shape(body)});
}
module.exports = { object, sha256, equalSecret, abortError, checkAbort, positive, safeCode, shape, BridgeError, remoteError, delay };
