'use strict';
const C=require('../constants');
const {BridgeError}=require('../util');
class AuthenticationProvider {
  constructor(vscode,accounts,interactiveSignIn){this.vscode=vscode;this.accounts=accounts;this.interactiveSignIn=interactiveSignIn;this.emitter=new vscode.EventEmitter();this.onDidChangeSessions=this.emitter.event;this.previous=new Map();this.onChange=()=>{this.publish().catch(()=>{});};accounts.on('change',this.onChange);}
  async sessions(scopes){
    const db=await this.accounts.store.read();
    return db.profiles.filter(p=>p.state==='signedIn'&&p.tokens?.accessToken&&(!scopes||scopes.every(s=>p.tokens.scopes.includes(s))))
      .map(p=>({id:p.id,account:{id:p.id,label:p.label},accessToken:p.tokens.accessToken,scopes:p.tokens.scopes}));
  }
  async getSessions(scopes,options){
    let sessions=await this.sessions(scopes);
    if(options?.account)sessions=sessions.filter(s=>s.account.id===options.account.id);
    for(const s of sessions){
      // Refresh only renewable, plan-enabled sessions. Missing plan permission
      // stays visible in the extension's account manager, never grants inference.
      if(['resource.invoke','chatgpt.tokens.use.direct'].every(x=>s.scopes.includes(x))){try{s.accessToken=(await this.accounts.access(s.id)).accessToken;}catch{s.accessToken='';}}
    }
    return sessions.filter(s=>s.accessToken);
  }
  async createSession(scopes,options){
    if(scopes.some(s=>!C.SCOPES.includes(s)))throw new BridgeError('Unsupported authentication scope.',{code:'unsupported_scope'});
    const a=await this.interactiveSignIn(options?.account?.id);
    const s=(await this.getSessions(scopes)).find(s=>s.id===a?.id);
    if(!s)throw new BridgeError('ChatGPT did not grant all requested permissions. Open Manage Accounts to enable plan usage.',{code:'plan_permission_missing'});
    return s;
  }
  async removeSession(id){const {revoked}=await this.accounts.signOut(id);if(!revoked)await this.vscode.window.showWarningMessage('Local credentials cleared. Remote revocation was not confirmed; disconnect Direct Plan Bridge in ChatGPT Settings.');}
  async publish(){const current=new Map((await this.sessions()).map(s=>[s.id,s]));const added=[],removed=[],changed=[];for(const[id,s]of current){if(!this.previous.has(id))added.push(s);else if(this.previous.get(id).accessToken!==s.accessToken)changed.push(s);}for(const[id,s]of this.previous)if(!current.has(id))removed.push(s);this.previous=current;if(added.length||removed.length||changed.length)this.emitter.fire({added,removed,changed});}
  dispose(){this.accounts.off('change',this.onChange);this.emitter.dispose();}
}
module.exports={AuthenticationProvider};
