'use strict';
const https = require('node:https');
const { APP_NAME, VERSION, ISSUER, RESOURCE } = require('../constants');
const { BridgeError, checkAbort, remoteError } = require('../util');
function assertAllowedUrl(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || u.username || u.password || u.hash || ![ISSUER, new URL(RESOURCE).origin].includes(u.origin)) {
    throw new BridgeError('Refusing to send credentials outside the pinned OpenAI origins.', {code:'untrusted_endpoint'});
  }
  return u;
}
/** Native https is deliberately used instead of fetch, so VS Code's extension-host
 * HTTP proxy integration can apply. Redirects are never followed. */
function nativeTransport(url, { method = 'GET', headers = {}, body, signal, idleMs = 300000 } = {}) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const u = assertAllowedUrl(url);
    const request = https.request(u, {
      method, signal, headers: {'User-Agent': `${APP_NAME.replaceAll(' ','-')}/${VERSION}`, 'Accept-Encoding':'identity', ...headers},
    });
    let headerTimer = setTimeout(() => request.destroy(new BridgeError('OpenAI response headers timed out.', {code:'header_timeout'})), 30000);
    headerTimer.unref();
    request.once('error', e => { clearTimeout(headerTimer); reject(signal?.aborted ? signal.reason : new BridgeError('Network connection to OpenAI failed. Check VS Code HTTP proxy and connectivity.', {code:'network_error'})); });
    request.setTimeout(idleMs, () => request.destroy(new BridgeError('OpenAI stream idle timeout.', {code:'idle_timeout'})));
    request.once('response', response => {
      clearTimeout(headerTimer);
      const h = {get(name) { const value = response.headers[name.toLowerCase()]; return Array.isArray(value) ? value.join(', ') : value ?? null; }};
      resolve({status: response.statusCode || 0, headers:h, body:response, cancel:()=>response.destroy()});
    });
    request.end(body);
  });
}
async function readJson(response, maxBytes = 4 * 1024 * 1024) {
  const chunks = []; let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length; if (size > maxBytes) throw new BridgeError('OpenAI JSON response exceeded the size limit.',{code:'response_too_large'});
      chunks.push(Buffer.from(chunk));
    }
    if (!size) return null;
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (e) {
    response.cancel?.();
    if (e instanceof SyntaxError) throw new BridgeError('OpenAI returned invalid JSON.',{code:'invalid_json'});
    throw e;
  }
}
async function checkedJson(transport, url, options = {}) {
  assertAllowedUrl(url);
  const r = await transport(url, {...options, signal: AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(30000)])});
  let body;
  try { body = await readJson(r); } catch(e) {
    if (r.status < 200 || r.status >= 300) throw remoteError(r.status, {non_json:true}, r.headers.get('x-request-id'));
    throw e;
  }
  if (r.status < 200 || r.status >= 300) throw remoteError(r.status, body, r.headers.get('x-request-id'));
  return body;
}
module.exports = { assertAllowedUrl, nativeTransport, readJson, checkedJson };
