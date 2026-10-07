'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {EventEmitter}=require('node:events');
const C=require('../constants');
const {BridgeError,object,sha256,checkAbort,delay}=require('../util');
const {withFileLock}=require('./lock');
const {checkedJson}=require('../openai/http');
const {signInFlow}=require('./oauth');
const terminalRefresh=new Set(['invalid_grant','invalid_refresh_token','token_expired','refresh_token_expired','refresh_token_invalidated','refresh_token_reused']);
function planAllowed(tokens){return !!tokens?.accessToken && ['resource.invoke','chatgpt.tokens.use.direct'].every(x=>tokens.scopes.includes(x));}
function earliestMillis(v){
  if(typeof v==='number'&&Number.isFinite(v))return v>1e12?v:v*1000;
  if(typeof v==='string'){const n=Number(v);if(Number.isFinite(n))return n>1e12?n:n*1000;const d=Date.parse(v);if(Number.isFinite(d))return d;}
  return 0;
}
function tokensFromReply(data,prior,now=Date.now()){
  if(!object(data))throw new BridgeError('Invalid OAuth token response.',{code:'bad_token_response'});
  if(data.access_token!==undefined&&(typeof data.access_token!=='string'||!data.access_token||data.access_token.length>65536))throw new BridgeError('Invalid OAuth access token.',{code:'bad_token_response'});
  if(data.access_token&&String(data.token_type).toLowerCase()!=='bearer')throw new BridgeError('OpenAI returned a non-Bearer token.',{code:'bad_token_response'});
  if(data.access_token&&(!Number.isFinite(data.expires_in)||data.expires_in<=0))throw new BridgeError('OpenAI omitted token expiration.',{code:'bad_token_response'});
  if(data.refresh_token!==undefined&&(typeof data.refresh_token!=='string'||!data.refresh_token||data.refresh_token.length>65536))throw new BridgeError('Invalid OAuth refresh token.',{code:'bad_token_response'});
  return {accessToken:data.access_token,refreshToken:data.refresh_token,idToken:data.id_token??prior?.idToken,
    scopes:typeof data.scope==='string'?[...new Set(data.scope.split(/\s+/).filter(Boolean))]:(prior?.scopes||[]),
    expiresAt:data.access_token?now+data.expires_in*1000:0,earliestRefreshAt:earliestMillis(data.earliest_refresh_at),
    sessionId:prior?.sessionId||randomUUID()};
}
class AccountStore {
  constructor(secrets,directory){this.secrets=secrets;this.directory=directory;this.lockPath=path.join(directory,'credentials.lock');}
  async init(){
    await fs.mkdir(this.directory,{recursive:true,mode:0o700});
    return withFileLock(this.lockPath,async()=>{
      const file=path.join(this.directory,'host.json');
      let host;
      try{host=JSON.parse(await fs.readFile(file,'utf8')).hostId;}catch(e){
        if(e.code!=='ENOENT')throw new BridgeError('Host identity file is unreadable. Do not overwrite it while credentials exist.',{code:'host_state_error'});
        const existing=await this.read();
        if(existing.profiles.length||existing.pending.length)throw new BridgeError('The stable host identity is missing while saved registrations still exist. Restore host.json from this installation; do not silently regenerate it or reuse registrations on another host.',{code:'host_state_error'});
        host=`urn:uuid:${randomUUID()}`;await fs.writeFile(file,JSON.stringify({hostId:host}),{flag:'wx',mode:0o600});
      }
      if(!/^urn:uuid:[a-f0-9-]{36}$/.test(host))throw new BridgeError('Stored host identity is invalid.',{code:'host_state_error'});
      this.hostId=host;return host;
    });
  }
  async read(){
    const raw=await this.secrets.get(C.SECRET_KEY);if(!raw)return{version:1,active:null,profiles:[],pending:[]};
    let db;try{db=JSON.parse(raw);}catch{throw new BridgeError('Protected ChatGPT account storage is corrupt.',{code:'credential_store_error'});}
    if(db.version!==1||!Array.isArray(db.profiles)||!Array.isArray(db.pending))throw new BridgeError('Unsupported account storage format.',{code:'credential_store_error'});
    return db;
  }
  async save(db){await this.secrets.store(C.SECRET_KEY,JSON.stringify(db));}
  lock(fn,signal){return withFileLock(this.lockPath,fn,signal);}
}
class Accounts extends EventEmitter {
  constructor(store,transport,oidc,openBrowser){super();Object.assign(this,{store,transport,oidc,openBrowser});this.signingIn=false;this.shutdown=new AbortController();}
  changed(){this.emit('change');}
  async list(){return this.store.lock(async()=>{const db=await this.store.read();return {active:db.active,profiles:db.profiles.map(p=>({id:p.id,clientId:p.clientId,label:p.label,state:p.state,planEnabled:planAllowed(p.tokens),scopes:p.tokens?.scopes||[],sessionId:p.tokens?.sessionId})),pending:db.pending.map(p=>({clientId:p.clientId}))};});}
  async active(){const db=await this.store.read();const p=db.profiles.find(x=>x.id===db.active);return p?{id:p.id,label:p.label,state:p.state,planEnabled:planAllowed(p.tokens),sessionId:p.tokens?.sessionId}:null;}
  async signIn(registrationId,consent=false,signal){
    if(this.signingIn)throw new BridgeError('A ChatGPT sign-in is already in progress in this window.',{code:'sign_in_in_progress'});
    this.signingIn=true;const combined=AbortSignal.any([this.shutdown.signal,...(signal?[signal]:[])]);
    try{
      const registration=await this.store.lock(async()=>{
        const db=await this.store.read();
        if(!registrationId)return undefined;
        return db.profiles.find(p=>p.id===registrationId)||db.pending.find(p=>p.clientId===registrationId);
      },combined);
      if(registrationId&&!registration)throw new BridgeError('Saved registration was not found.',{code:'registration_not_found'});
      const reply=await signInFlow({transport:this.transport,oidc:this.oidc,openBrowser:this.openBrowser,hostId:this.store.hostId,registration,consent,signal:combined,
        onIssued:async clientId=>this.store.lock(async()=>{
          const db=await this.store.read();
          if(!db.profiles.some(p=>p.clientId===clientId)&&!db.pending.some(p=>p.clientId===clientId)){
            db.pending.push({clientId,createdAt:Date.now()});await this.store.save(db);
          }
        },combined)});
      const tokens=tokensFromReply(reply.data);
      const id=sha256(`${C.ISSUER}\0${reply.clientId}\0${reply.identity.sub}`).slice(0,32);
      await this.store.lock(async()=>{
        checkAbort(combined);const db=await this.store.read();
        if(db.profiles.some(p=>p.clientId===reply.clientId&&p.subject!==reply.identity.sub))throw new BridgeError('Registration identity changed. Existing credentials were not replaced.',{code:'account_mismatch'});
        const email=typeof reply.identity.email==='string'?reply.identity.email:undefined;
        const account={id,clientId:reply.clientId,subject:reply.identity.sub,email,issuer:C.ISSUER,
          label:`${email||'ChatGPT account'} · ${reply.clientId.slice(-8)}`,tokens,state:'signedIn'};
        db.profiles=db.profiles.filter(p=>p.id!==id);db.profiles.push(account);db.pending=db.pending.filter(p=>p.clientId!==reply.clientId);db.active=id;
        await this.store.save(db);
      },combined);
      this.changed();return await this.active();
    }finally{this.signingIn=false;}
  }
  async select(id){await this.store.lock(async()=>{const db=await this.store.read();if(!db.profiles.some(p=>p.id===id&&p.state==='signedIn'))throw new BridgeError('This account needs to sign in again.',{code:'sign_in_required'});db.active=id;await this.store.save(db);});this.changed();}
  async access(id,signal){
    return this.store.lock(async()=>{
      checkAbort(signal);const db=await this.store.read();const p=db.profiles.find(p=>p.id===(id||db.active));
      if(!p||p.state!=='signedIn'||!p.tokens)throw new BridgeError('Run “ChatGPT Direct: Continue with ChatGPT” first.',{code:'sign_in_required'});
      if(!planAllowed(p.tokens))throw new BridgeError('Signed in, but ChatGPT plan usage is not enabled. Use Manage Accounts → Enable Plan Usage.',{code:'plan_permission_missing'});
      let t=p.tokens;const now=Date.now();
      if(now+60000>=t.expiresAt&&now>=t.earliestRefreshAt){
        if(!t.refreshToken){if(now>=t.expiresAt)throw new BridgeError('ChatGPT access expired without a renewable session. Reauthorize this saved registration.',{code:'sign_in_required'});}
        else{
          let data;
          try{
            // A token exchange is never blindly retried: the server may already have rotated it.
            data=await checkedJson(this.transport,C.TOKEN_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:p.clientId,refresh_token:t.refreshToken,resource:C.RESOURCE}).toString(),signal});
          }catch(e){
            if(terminalRefresh.has(e.code)){p.tokens=null;p.state='signedOut';await this.store.save(db);this.changed();}
            throw e;
          }
          if(!data?.access_token||!data?.refresh_token)throw new BridgeError('Refresh response omitted rotated credentials. Reauthorize the saved registration.',{code:'bad_token_response'});
          if(data.id_token)await this.oidc.validate(data.id_token,{clientId:p.clientId,subject:p.subject},signal);
          t=tokensFromReply(data,t);p.tokens=t;await this.store.save(db);this.changed();
          if(!planAllowed(t))throw new BridgeError('ChatGPT plan permission was removed from the refreshed grant.',{code:'plan_permission_missing'});
        }
      }
      if(Date.now()>=t.expiresAt)throw new BridgeError('Access token expired before it could be refreshed. Reauthorize this account.',{code:'sign_in_required'});
      return {accountId:p.id,label:p.label,sessionId:t.sessionId,accessToken:t.accessToken,scopes:t.scopes,active:db.active===p.id};
    },signal);
  }
  async assertLease(lease){const active=await this.active();if(!active||active.id!==lease.accountId||active.sessionId!==lease.sessionId||active.state!=='signedIn'||!active.planEnabled)throw new BridgeError('The active ChatGPT account changed. This response was cancelled.',{code:'account_changed'});}
  async signOut(id){
    let revoked=false;
    await this.store.lock(async()=>{
      const db=await this.store.read();const p=db.profiles.find(p=>p.id===(id||db.active));if(!p)return;
      const token=p.tokens?.refreshToken;
      p.state='signingOut';await this.store.save(db);this.changed();
      try{
        if(token){
          const d=await this.oidc.discovery();
          if(d.revocation_endpoint){
            for(let i=0;i<2;i++){
              try{await checkedJson(this.transport,d.revocation_endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token,token_type_hint:'refresh_token',client_id:p.clientId}).toString()});revoked=true;break;}
              catch(e){if(i===1||!(e.status>=500||e.code==='network_error'))break;await delay(300);}
            }
          }
        }
      }catch{/* Local sign-out still completes when discovery/revocation is unavailable. */}
      finally{p.tokens=null;p.state='signedOut';await this.store.save(db);this.changed();}
    });
    return {revoked};
  }
  dispose(){this.shutdown.abort();this.removeAllListeners();}
}
module.exports={AccountStore,Accounts,tokensFromReply,planAllowed,earliestMillis,terminalRefresh};
