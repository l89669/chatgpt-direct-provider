'use strict';
const {EventEmitter}=require('node:events');
const {ResponseReplayCache,estimateTokens}=require('../protocol/history');
const {modelInfo}=require('../openai/models');
const {BridgeError,checkAbort,abortError}=require('../util');
function configuration(vscode){
  const c=vscode.workspace.getConfiguration('chatgptDirect');
  return{subagentDeveloperPrompt:c.get('subagentDeveloperPrompt'),reasoningEffort:c.get('reasoningEffort','model-default'),requestTimeoutSeconds:c.get('requestTimeoutSeconds',1800),contextWindowFallback:c.get('contextWindowFallback',65536),outputReserveFallback:c.get('outputReserveFallback',8192),maxRequestMiB:c.get('maxRequestMiB',32)};
}
class Provider extends EventEmitter {
  constructor(vscode,accounts,client,signIn,log,diagnostics=()=>{}){
    super();Object.assign(this,{vscode,accounts,client,signIn,log,diagnostics});this.cache=new ResponseReplayCache();this.catalog=null;this.controllers=new Set();this.fingerprint=null;
    this.infoEmitter=new vscode.EventEmitter();this.onDidChangeLanguageModelChatInformation=this.infoEmitter.event;
    this.onAccount=()=>{this.accountChanged().catch(e=>log(e));};accounts.on('change',this.onAccount);
  }
  async accountChanged(){
    const a=await this.accounts.active();const f=a?`${a.id}:${a.sessionId}:${a.state}:${a.planEnabled}`:'';
    if(f!==this.fingerprint){this.fingerprint=f;this.cancelAll();this.cache.clear();this.catalog=null;this.infoEmitter.fire();this.emit('status',a);}
  }
  cancelAll(){for(const c of this.controllers)c.abort(abortError());this.controllers.clear();}
  catalogLog(value){this.diagnostics({at:new Date().toISOString(),event:'model_catalog_provider',...value});}
  refresh(){this.catalog=null;this.catalogLog({stage:'refresh',cache:'cleared'});this.infoEmitter.fire();}
  async catalogFor(lease,signal){
    const key=`${lease.accountId}:${lease.sessionId}`;
    if(this.catalog?.key===key&&Date.now()-this.catalog.at<60000){this.catalogLog({stage:'cache_hit',ageMs:Date.now()-this.catalog.at,models:this.catalog.models.map(model=>model.id)});return this.catalog.models;}
    this.catalogLog({stage:'cache_miss'});
    const models=await this.client.models(lease.accessToken,configuration(this.vscode),signal);
    await this.accounts.assertLease(lease);this.catalog={key,at:Date.now(),models};return models;
  }
  async provideLanguageModelChatInformation(options,token){
    const a=await this.accounts.active();
    if(!a||a.state!=='signedIn'){
      if(options.silent)return[];await this.signIn();
    }
    const controller=new AbortController();const sub=token?.onCancellationRequested(()=>controller.abort(abortError()));
    if(token?.isCancellationRequested)controller.abort(abortError());
    try{const lease=await this.accounts.access(undefined,controller.signal);const models=await this.catalogFor(lease,controller.signal);const information=models.map(model=>modelInfo(model,models,configuration(this.vscode)));this.catalogLog({stage:'published',silent:options.silent,models:information.map(model=>({id:model.id,name:model.name,capabilities:model.capabilities}))});return information;}
    catch(e){this.log(e);if(options.silent)return[];throw e;}
    finally{sub?.dispose();}
  }
  async provideLanguageModelChatResponse(info,messages,options,progress,token){
    if(!this.vscode.workspace.isTrusted)throw new BridgeError('Model access requires a trusted workspace.',{code:'workspace_untrusted'});
    await this.accountChanged();
    const c=new AbortController();this.controllers.add(c);
    const sub=token?.onCancellationRequested(()=>c.abort(abortError()));if(token?.isCancellationRequested)c.abort(abortError());
    const config=configuration(this.vscode);const seconds=Math.max(60,Math.min(7200,Number(config.requestTimeoutSeconds)||1800));
    const timeout=setTimeout(()=>c.abort(new BridgeError('Inference exceeded the configured total deadline.',{code:'request_timeout'})),seconds*1000);timeout.unref();
    try{
      const lease=await this.accounts.access(undefined,c.signal);await this.accounts.assertLease(lease);checkAbort(c.signal);
      const models=await this.catalogFor(lease,c.signal);const model=models.find(m=>m.id===info.id);
      if(!model)throw new BridgeError('Selected model is no longer available to this ChatGPT account. Refresh Models and select a listed model.',{code:'model_unavailable'});
      const scope=`${lease.accountId}:${lease.sessionId}:${model.id}`;
      const result=await this.client.infer(lease,model,messages,options,{signal:c.signal,config,cache:this.cache,scope,models,onText:text=>{checkAbort(c.signal);progress.report(new this.vscode.LanguageModelTextPart(text));}});
      await this.accounts.assertLease(lease);checkAbort(c.signal);
      // No tool is invoked here. All calls have been validated as a batch, and
      // response.completed was observed. VS Code owns their execution/approval.
      for(const call of result.calls)progress.report(new this.vscode.LanguageModelToolCallPart(call.callId,call.name,call.input));
      this.emit('usage',result.usage);
    }catch(e){
      if(c.signal.aborted&&!(c.signal.reason instanceof BridgeError))throw new this.vscode.CancellationError();
      this.log(e);throw c.signal.aborted?c.signal.reason:e;
    }finally{clearTimeout(timeout);sub?.dispose();this.controllers.delete(c);}
  }
  async provideTokenCount(_model,input,token){if(token?.isCancellationRequested)throw new this.vscode.CancellationError();return estimateTokens(input);}
  dispose(){this.cancelAll();this.cache.clear();this.accounts.off('change',this.onAccount);this.infoEmitter.dispose();this.removeAllListeners();}
}
module.exports={Provider,configuration};
