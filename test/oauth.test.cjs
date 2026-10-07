'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const crypto=require('node:crypto');
const {createTransaction,authorizeUrl,validateCallback,listenCallback,signInFlow}=require('../src/auth/oauth');
const {verifyJwt,Oidc}=require('../src/auth/oidc');
const {assertAllowedUrl}=require('../src/openai/http');
const {mockResponse}=require('./helpers.cjs');const C=require('../src/constants');
const pair=crypto.generateKeyPairSync('rsa',{modulusLength:2048});const jwk={...pair.publicKey.export({format:'jwk'}),kid:'key1',alg:'RS256',use:'sig'};
const now=Math.floor(Date.now()/1000);
function jwt(changes={},header={}){
  const h=Buffer.from(JSON.stringify({alg:'RS256',kid:'key1',...header})).toString('base64url');
  const p=Buffer.from(JSON.stringify({iss:C.ISSUER,aud:'oaiapp_test',sub:'subject',iat:now,exp:now+3600,nonce:'nonce',...changes})).toString('base64url');
  return`${h}.${p}.${crypto.sign('sha256',Buffer.from(h+'.'+p),pair.privateKey).toString('base64url')}`;
}
const expectation={clientId:'oaiapp_test',nonce:'nonce',now};
test('PKCE uses fresh random state, nonce, verifier and correct S256',()=>{const a=createTransaction(),b=createTransaction();assert.notEqual(a.state,b.state);assert.notEqual(a.nonce,a.state);assert.equal(a.challenge,crypto.createHash('sha256').update(a.verifier).digest('base64url'));assert.match(a.verifier,/^[\w-]{43,128}$/);});
test('new OAuth request contains the public direct scopes, resource and app hint',()=>{const tx={...createTransaction(),redirectUri:'http://127.0.0.1:1234/auth/callback'};const u=new URL(authorizeUrl(tx,{hostId:'urn:uuid:test'}));assert.equal(u.origin+u.pathname,C.AUTHORIZE_URL);assert.equal(u.searchParams.get('client_id'),C.BOOTSTRAP_CLIENT);assert.equal(u.searchParams.get('agent_name_hint'),C.APP_NAME);assert.equal(u.searchParams.get('resource'),C.RESOURCE);assert.equal(u.searchParams.get('scope'),C.SCOPES.join(' '));assert.equal(u.searchParams.get('redirect_uri'),tx.redirectUri);});
test('returning registration reuses client and host, and only explicit reconsent sets prompt',()=>{const tx={...createTransaction(),redirectUri:'http://127.0.0.1:1234/auth/callback'};const u=new URL(authorizeUrl(tx,{clientId:'oaiapp_saved',hostId:'host',email:'a@b.c',idToken:'hint',consent:true}));assert.equal(u.searchParams.get('client_id'),'oaiapp_saved');assert.equal(u.searchParams.get('agent_name_hint'),null);assert.equal(u.searchParams.get('id_token_hint'),'hint');assert.equal(u.searchParams.get('prompt'),'consent');});
for(const [name,suffix,expected] of [
  ['state mismatch','state=bad&code=x&client_id=oaiapp_t','state_mismatch'],
  ['duplicate state','state=ok&state=bad&code=x&client_id=oaiapp_t','state_mismatch'],
  ['missing issued client','state=ok&code=x','registration_incomplete'],
  ['bootstrap is not issued client','state=ok&code=x&client_id=dynamic_agent_client','registration_incomplete'],
  ['duplicate code','state=ok&code=x&code=y&client_id=oaiapp_t','bad_callback'],
  ['consent declined','state=ok&error=access_denied','access_denied']
])test(`callback rejects ${name}`,()=>assert.throws(()=>validateCallback(new URL('http://127.0.0.1/auth/callback?'+suffix),{state:'ok'}),{code:expected}));
test('returning callback may omit client ID but cannot replace it',()=>{assert.equal(validateCallback(new URL('http://127.0.0.1/?state=ok&code=x'),{state:'ok'},'oaiapp_saved').clientId,'oaiapp_saved');assert.throws(()=>validateCallback(new URL('http://127.0.0.1/?state=ok&code=x&client_id=oaiapp_other'),{state:'ok'},'oaiapp_saved'),{code:'client_mismatch'});});
test('real loopback listener rejects unrelated state then accepts correct one once',async()=>{const tx=createTransaction();const cb=await listenCallback(tx,{timeoutMs:3000});try{
  const bad=await fetch(tx.redirectUri+'?state=bad&code=x&client_id=oaiapp_test');assert.equal(bad.status,400);
  const good=await fetch(tx.redirectUri+`?state=${tx.state}&code=good&client_id=oaiapp_test`);assert.equal(good.status,200);assert.equal(good.headers.get('cache-control'),'no-store');assert.deepEqual(await cb.result,{code:'good',clientId:'oaiapp_test'});
}finally{cb.dispose();}});
test('real loopback listener validates Host to reject rebinding',async()=>{const tx=createTransaction();const cb=await listenCallback(tx,{timeoutMs:3000});try{const status=await new Promise((resolve,reject)=>{const req=require('node:http').get(tx.redirectUri+`?state=${tx.state}&code=x&client_id=oaiapp_test`,{headers:{Host:'attacker.invalid'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);});assert.equal(status,400);}finally{cb.dispose();}await assert.rejects(cb.result,{name:'AbortError'});});
test('loopback cancellation closes a pending attempt',async()=>{const c=new AbortController();const cb=await listenCallback(createTransaction(),{signal:c.signal});c.abort();await assert.rejects(cb.result,{name:'AbortError'});});
test('valid RSA ID token is accepted',()=>assert.equal(verifyJwt(jwt(),[jwk],expectation).sub,'subject'));
for(const [name,claims,header] of [
  ['wrong issuer',{iss:'https://evil.invalid'},{}],['wrong audience',{aud:'other'},{}],['expired',{exp:now-30},{}],['future iat',{iat:now+60},{}],['future nbf',{nbf:now+60},{}],['missing sub',{sub:''},{}],['wrong nonce',{nonce:'bad'},{}],['missing expiry',{exp:undefined},{}],['missing iat',{iat:undefined},{}],['multiple audience without azp',{aud:['oaiapp_test','other']},{}],['algorithm confusion',{}, {alg:'HS256'}],['alg none',{}, {alg:'none'}],['critical extension',{}, {crit:['unknown']}]
])test(`ID token rejects ${name}`,()=>assert.throws(()=>verifyJwt(jwt(claims,header),[jwk],expectation),{code:'invalid_id_token'}));
test('ID token rejects mutated signature and mismatched returning subject',()=>{const t=jwt().split('.');t[2]=(t[2][0]==='A'?'B':'A')+t[2].slice(1);assert.throws(()=>verifyJwt(t.join('.'),[jwk],expectation));assert.throws(()=>verifyJwt(jwt(),[jwk],{...expectation,subject:'another'}));});
test('ES256 signatures require EC P-256 and P1363 encoding',()=>{const p=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});const k={...p.publicKey.export({format:'jwk'}),kid:'ec1',alg:'ES256'};const h=Buffer.from(JSON.stringify({alg:'ES256',kid:'ec1'})).toString('base64url');const payload=jwt().split('.')[1];const sig=crypto.sign('sha256',Buffer.from(h+'.'+payload),{key:p.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');assert.equal(verifyJwt(`${h}.${payload}.${sig}`,[k],expectation).sub,'subject');});
test('discovery rejects malicious JWKS origin before fetching keys',async()=>{const oidc=new Oidc(async()=>mockResponse(200,{issuer:C.ISSUER,authorization_endpoint:C.AUTHORIZE_URL,token_endpoint:C.TOKEN_URL,jwks_uri:'https://evil.invalid/keys'}));await assert.rejects(oidc.validate(jwt(),expectation),{code:'untrusted_endpoint'});});
for(const url of ['http://api.openai.com/v1/responses','https://api.openai.com.evil.invalid/v1','https://u:p@api.openai.com/v1','https://api.openai.com/v1#secret','https://chatgpt.com/backend-api/codex/responses'])test(`network origin guard rejects ${url}`,()=>assert.throws(()=>assertAllowedUrl(url),{code:'untrusted_endpoint'}));
test('end-to-end mock authorization uses issued client, exact callback URI and validates signed identity',async()=>{
  let request,authorization,issued;
  const oidc={validate:async(t,e)=>{assert.equal(t,'issued-id-token');assert.equal(e.nonce,authorization.searchParams.get('nonce'));assert.equal(e.clientId,'oaiapp_dynamic');return{sub:'verified'};}};
  const result=await signInFlow({transport:async(url,options)=>{assert.equal(url,C.TOKEN_URL);request=new URLSearchParams(options.body);return mockResponse(200,{id_token:'issued-id-token'});},oidc,hostId:'urn:uuid:host',onIssued:async x=>{issued=x;},openBrowser:async url=>{
    authorization=new URL(url);const callback=authorization.searchParams.get('redirect_uri');await fetch(`${callback}?state=${authorization.searchParams.get('state')}&code=one-use-code&client_id=oaiapp_dynamic`);return true;
  }});
  assert.equal(result.identity.sub,'verified');assert.equal(issued,'oaiapp_dynamic');assert.equal(request.get('client_id'),'oaiapp_dynamic');assert.equal(request.get('redirect_uri'),authorization.searchParams.get('redirect_uri'));assert.equal(request.get('resource'),C.RESOURCE);assert.equal(request.has('client_secret'),false);
});
