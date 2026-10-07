'use strict';
const crypto = require('node:crypto');
const { ISSUER, DISCOVERY_URL, AUTHORIZE_URL, TOKEN_URL } = require('../constants');
const { object, equalSecret, BridgeError } = require('../util');
const { checkedJson, assertAllowedUrl } = require('../openai/http');
function authEndpoint(value) {
  if (typeof value !== 'string') throw new BridgeError('OpenAI discovery omitted a required endpoint.',{code:'bad_discovery'});
  const u = assertAllowedUrl(value);
  if(u.origin !== ISSUER || u.search) throw new BridgeError('Untrusted OIDC endpoint.',{code:'bad_discovery'});
  return value;
}
function decodeSegment(s, maximum) {
  if(!/^[A-Za-z0-9_-]+$/.test(s) || s.length > maximum) throw new BridgeError('Malformed ID token.',{code:'invalid_id_token'});
  const b = Buffer.from(s,'base64url');
  if(b.toString('base64url') !== s) throw new BridgeError('Non-canonical ID token encoding.',{code:'invalid_id_token'});
  return b;
}
/** JWT verification uses Node/OpenSSL, not a home-made signature algorithm.
 * Only RS256 and ES256 signing keys are accepted; all identity claims are checked. */
function verifyJwt(token, keys, {clientId, nonce, subject, now = Date.now()/1000}) {
  function fail() { throw new BridgeError('OpenAI ID token signature or identity validation failed.',{code:'invalid_id_token'}); }
  if(typeof token !== 'string' || token.length > 65536) fail();
  const p=token.split('.'); if(p.length!==3) fail();
  let header, claims, signature;
  try {header=JSON.parse(decodeSegment(p[0],8192)); claims=JSON.parse(decodeSegment(p[1],60000)); signature=decodeSegment(p[2],8192);} catch {fail();}
  if(!object(header)||!object(claims)||!['RS256','ES256'].includes(header.alg)||typeof header.kid!=='string'||header.crit!==undefined||header.b64!==undefined) fail();
  const matching = keys.filter(k => object(k) && k.kid===header.kid && (!k.alg || k.alg===header.alg) && (!k.use || k.use==='sig') && (!k.key_ops || k.key_ops.includes('verify')));
  if(matching.length!==1) fail();
  const jwk = matching[0]; let key;
  try {
    if(header.alg==='RS256' && (jwk.kty!=='RSA' || Buffer.from(jwk.n,'base64url').length < 256)) fail();
    if(header.alg==='ES256' && (jwk.kty!=='EC'||jwk.crv!=='P-256')) fail();
    key=crypto.createPublicKey({key:jwk,format:'jwk'});
    if(!crypto.verify('sha256',Buffer.from(`${p[0]}.${p[1]}`),header.alg==='ES256'?{key,dsaEncoding:'ieee-p1363'}:key,signature)) fail();
  } catch {fail();}
  const aud=Array.isArray(claims.aud)?claims.aud:[claims.aud];
  if(claims.iss!==ISSUER||!aud.includes(clientId)||(aud.length>1&&claims.azp!==clientId)||(claims.azp!==undefined&&claims.azp!==clientId)) fail();
  if(typeof claims.sub!=='string'||!claims.sub||claims.sub.length>2048||!Number.isFinite(claims.exp)||claims.exp<=now-5||!Number.isFinite(claims.iat)||claims.iat>now+5||claims.iat>claims.exp) fail();
  if(claims.nbf!==undefined&&(!Number.isFinite(claims.nbf)||claims.nbf>now+5)) fail();
  if(nonce!==undefined&&!equalSecret(claims.nonce,nonce)) fail();
  if(subject!==undefined&&claims.sub!==subject) fail();
  return claims;
}
class Oidc {
  constructor(transport) {this.transport=transport; this.cached=null; this.keys=null; this.keysAt=0; this.lastUnknownRefresh=0;}
  async discovery(signal) {
    if(this.cached && Date.now()-this.cached.at<3600000) return this.cached.value;
    const d=await checkedJson(this.transport,DISCOVERY_URL,{signal});
    if(!object(d)||d.issuer!==ISSUER||d.authorization_endpoint!==AUTHORIZE_URL||d.token_endpoint!==TOKEN_URL) throw new BridgeError('OpenAI OIDC discovery does not match the documented public SIWC endpoints.',{code:'bad_discovery'});
    authEndpoint(d.jwks_uri); if(d.revocation_endpoint) authEndpoint(d.revocation_endpoint);
    this.cached={value:d,at:Date.now()}; return d;
  }
  async validate(token, expectation, signal) {
    const d=await this.discovery(signal);
    let kid;
    try {kid=JSON.parse(Buffer.from(token.split('.')[0],'base64url')).kid;} catch {throw new BridgeError('Malformed ID token.',{code:'invalid_id_token'});}
    const unknown=this.keys && !this.keys.some(k=>object(k)&&k.kid===kid);
    if(!this.keys || Date.now()-this.keysAt>3600000 || (unknown&&Date.now()-this.lastUnknownRefresh>30000)) {
      if(unknown) this.lastUnknownRefresh=Date.now();
      const j=await checkedJson(this.transport,d.jwks_uri,{signal});
      if(!Array.isArray(j?.keys)||j.keys.length>64) throw new BridgeError('Invalid OpenAI signing-key set.',{code:'invalid_jwks'});
      this.keys=j.keys; this.keysAt=Date.now();
    }
    return verifyJwt(token,this.keys,expectation);
  }
}
module.exports={Oidc,verifyJwt,authEndpoint};
