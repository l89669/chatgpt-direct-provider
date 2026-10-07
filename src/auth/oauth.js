'use strict';
const http=require('node:http');
const crypto=require('node:crypto');
const C=require('../constants');
const {equalSecret,BridgeError,checkAbort,abortError}=require('../util');
const {checkedJson}=require('../openai/http');
function createTransaction() {
  const verifier=crypto.randomBytes(48).toString('base64url');
  return {verifier,challenge:crypto.createHash('sha256').update(verifier).digest('base64url'),state:crypto.randomBytes(32).toString('base64url'),nonce:crypto.randomBytes(32).toString('base64url')};
}
function authorizeUrl(tx,{clientId,hostId,email,idToken,consent=false}) {
  const u=new URL(C.AUTHORIZE_URL);
  for(const [k,v] of Object.entries({client_id:clientId||C.BOOTSTRAP_CLIENT,ext_agent_host_id:hostId,response_type:'code',redirect_uri:tx.redirectUri,scope:C.SCOPES.join(' '),resource:C.RESOURCE,state:tx.state,nonce:tx.nonce,code_challenge_method:'S256',code_challenge:tx.challenge})) u.searchParams.set(k,v);
  if(!clientId) u.searchParams.set('agent_name_hint',C.APP_NAME);
  else {if(email)u.searchParams.set('login_hint',email); if(idToken)u.searchParams.set('id_token_hint',idToken);}
  if(consent)u.searchParams.set('prompt','consent');
  return u.toString();
}
function validateCallback(url,tx,clientId) {
  if(url.searchParams.getAll('state').length!==1||!equalSecret(url.searchParams.get('state'),tx.state)) throw new BridgeError('OAuth callback state mismatch.',{code:'state_mismatch'});
  for(const name of ['code','client_id','error']) if(url.searchParams.getAll(name).length>1) throw new BridgeError('Duplicate OAuth callback parameter.',{code:'bad_callback'});
  const error=url.searchParams.get('error');
  if(error)throw new BridgeError(error==='access_denied'?'ChatGPT authorization was declined.':'ChatGPT authorization failed.',{code:error});
  const returned=url.searchParams.get('client_id');
  if(clientId&&returned&&returned!==clientId)throw new BridgeError('OAuth callback changed the registered client.',{code:'client_mismatch'});
  const issued=clientId||returned;
  if(!issued||issued===C.BOOTSTRAP_CLIENT||!/^[A-Za-z0-9_-]{1,256}$/.test(issued))throw new BridgeError('New registration did not return an issued client ID.',{code:'registration_incomplete'});
  const code=url.searchParams.get('code');
  if(!code||code.length>16384)throw new BridgeError('OAuth callback omitted a valid authorization code.',{code:'bad_callback'});
  return {code,clientId:issued};
}
/** Starts the listener FIRST. Never accepts arbitrary callbacks copied from URLs. */
async function listenCallback(tx,{clientId,signal,timeoutMs=300000}={}) {
  checkAbort(signal);
  let settleResolve,settleReject,done=false;
  const result=new Promise((r,j)=>{settleResolve=r;settleReject=j;}); result.catch(()=>{});
  const server=http.createServer();
  function close() {clearTimeout(timer); signal?.removeEventListener('abort',cancel);server.close();server.closeAllConnections();}
  function finish(error,value){if(done)return;done=true;setImmediate(close);error?settleReject(error):settleResolve(value);}
  const cancel=()=>finish(signal?.reason instanceof Error?signal.reason:abortError());
  let timer;
  server.on('request',(req,res)=>{
    const base=tx.redirectUri;
    const headers={'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store','Pragma':'no-cache','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'",'X-Content-Type-Options':'nosniff','Connection':'close'};
    if(done){res.writeHead(410,headers);res.end('Sign-in attempt already consumed.');return;}
    if(req.method!=='GET'||req.headers.host!==new URL(base).host||!req.url?.startsWith('/')||req.url.startsWith('//')||req.url.length>32768){res.writeHead(400,headers);res.end('Invalid callback.');return;}
    const u=new URL(req.url,base);
    if(u.pathname!==C.CALLBACK_PATH){res.writeHead(404,headers);res.end('Not found.');return;}
    try{
      const value=validateCallback(u,tx,clientId);
      res.writeHead(200,headers);res.end('Authorization received. Return to VS Code to finish identity verification. You may close this tab.');finish(null,value);
    }catch(e){
      res.writeHead(400,headers);res.end('Authorization rejected. Return to VS Code.');
      // An unrelated request cannot cancel the valid browser flow.
      if(e.code!=='state_mismatch')finish(e);
    }
  });
  server.on('clientError',(_,socket)=>socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});});
  tx.redirectUri=`http://127.0.0.1:${server.address().port}${C.CALLBACK_PATH}`;
  timer=setTimeout(()=>finish(new BridgeError('ChatGPT sign-in timed out. Start a fresh sign-in.',{code:'sign_in_timeout'})),timeoutMs);timer.unref();
  signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
  return {result,dispose:()=>finish(abortError())};
}
async function signInFlow({transport,oidc,openBrowser,hostId,registration,consent=false,onIssued,signal}) {
  const tx=createTransaction(); const clientId=registration?.clientId;
  const callback=await listenCallback(tx,{clientId,signal});
  try {
    const url=authorizeUrl(tx,{clientId,hostId,email:registration?.email,idToken:registration?.tokens?.idToken,consent});
    if(!await openBrowser(url))throw new BridgeError('Could not open the system browser. Check VS Code external-browser configuration.',{code:'browser_failed'});
    const issued=await callback.result;checkAbort(signal);
    await onIssued?.(issued.clientId);
    const data=await checkedJson(transport,C.TOKEN_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:issued.clientId,code:issued.code,code_verifier:tx.verifier,redirect_uri:tx.redirectUri,resource:C.RESOURCE}).toString(),signal});
    const identity=await oidc.validate(data?.id_token,{clientId:issued.clientId,nonce:tx.nonce,subject:registration?.subject},signal);
    return {clientId:issued.clientId,identity,data};
  } finally {callback.dispose();}
}
module.exports={createTransaction,authorizeUrl,validateCallback,listenCallback,signInFlow};
