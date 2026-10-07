'use strict';
const vscode=require('vscode');
const path=require('node:path');
const C=require('./constants');
const {AccountStore,Accounts}=require('./auth/accounts');
const {Oidc}=require('./auth/oidc');
const {nativeTransport}=require('./openai/http');
const {OpenAIClient}=require('./openai/client');
const {Provider,configuration}=require('./vscode/provider');
const {AuthenticationProvider}=require('./vscode/authentication');
const {BridgeError}=require('./util');
async function activate(context){
  if(typeof vscode.lm?.registerLanguageModelChatProvider!=='function')throw new Error('Direct Plan Bridge requires VS Code with the stable LanguageModelChatProvider API.');
  const output=vscode.window.createOutputChannel('ChatGPT Direct');
  function log(e){output.appendLine(JSON.stringify({at:new Date().toISOString(),...(e instanceof BridgeError?e.diagnostic():{code:'local_error',type:e?.name||'Error'})}));}
  const store=new AccountStore(context.secrets,path.join(context.globalStorageUri.fsPath,'private-state'));await store.init();
  const accounts=new Accounts(store,nativeTransport,new Oidc(nativeTransport),url=>vscode.env.openExternal(vscode.Uri.parse(url)));
  const client=new OpenAIClient(nativeTransport,state=>output.appendLine(JSON.stringify(state)));
  async function signIn(id,consent=false){
    if(!vscode.workspace.isTrusted)throw new BridgeError('Trust this workspace before signing in.',{code:'workspace_untrusted'});
    if(!id){const state=await accounts.list();if(state.profiles.length||state.pending.length){
      const pick=await vscode.window.showQuickPick([
        ...state.profiles.map(p=>({label:p.label,description:p.state==='signedIn'?'Reauthorize this registration':'Sign in again',id:p.id})),
        ...state.pending.map(p=>({label:`Resume incomplete registration · ${p.clientId.slice(-8)}`,id:p.clientId})),
        {label:'Add another ChatGPT account / workspace',id:null}
      ],{title:'Continue with ChatGPT',placeHolder:'Reuse an existing registration or add an account'});
      if(!pick)return;id=pick.id;
    }}
    const result=await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:'Continue with ChatGPT — complete authorization in your browser',cancellable:true},async(_,token)=>{
      const c=new AbortController();const d=token.onCancellationRequested(()=>c.abort());
      try{return await accounts.signIn(id,consent,c.signal);}finally{d.dispose();}
    });
    if(result?.planEnabled)await vscode.window.showInformationMessage('ChatGPT connected. Select a model under “ChatGPT Plan · Direct” in the native Chat model picker.');
    else await vscode.window.showWarningMessage('Signed in, but plan usage is disabled. Open Manage Accounts → Enable Plan Usage.');
    return result;
  }
  const provider=new Provider(vscode,accounts,client,signIn,log,state=>output.appendLine(JSON.stringify(state)));
  const authentication=new AuthenticationProvider(vscode,accounts,signIn);
  const status=vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right,80);status.command='chatgptDirect.manage';
  async function updateStatus(){
    const a=await accounts.active();status.text=a?.state==='signedIn'?'$(account) ChatGPT Direct':'$(sign-in) ChatGPT Direct';
    status.tooltip=a?.state==='signedIn'?`${a.label}\n${a.planEnabled?'Public SIWC plan usage enabled':'Plan usage disabled'}\nDirect Plan Bridge is unofficial.`:'Continue with ChatGPT using the public SIWC API. No Codex credentials are imported.';status.show();
  }
  const onChanged=()=>{updateStatus().catch(log);};accounts.on('change',onChanged);
  function register(command,fn){context.subscriptions.push(vscode.commands.registerCommand(command,async()=>{
    try{return await fn();}catch(e){if(e?.name==='AbortError'||e?.name==='Canceled')return;log(e);await vscode.window.showErrorMessage(e instanceof BridgeError?e.message:'ChatGPT Direct encountered a local error. Open Show Diagnostics.');}
  }));}
  async function openUsage(){await vscode.env.openExternal(vscode.Uri.parse(C.USAGE_URL));}
  async function signOut(){provider.cancelAll();const {revoked}=await accounts.signOut();await vscode.window.showInformationMessage(revoked?'ChatGPT session revoked; local tokens cleared. Registration retained for future sign-in.':'Local tokens cleared. Remote revocation was not confirmed; disconnect the app in ChatGPT Settings.');}
  async function manage(){
    const state=await accounts.list();const active=state.profiles.find(p=>p.id===state.active);
    const pick=await vscode.window.showQuickPick([
      ...state.profiles.map(p=>({label:`${p.id===state.active?'$(check) ':''}${p.label}`,description:p.state==='signedIn'?(p.planEnabled?'Plan usage enabled':'Plan usage disabled'):'Signed out',action:'account',id:p.id,state:p.state})),
      {label:'Continue with ChatGPT / 添加或重新登录',action:'signin'},
      ...(active?[{label:'Reauthorize active registration / 重新授权',action:'reauth'},{label:'Enable Plan Usage / 授权套餐用量',action:'consent'},{label:'Sign out active account / 退出',action:'signout'}]:[]),
      {label:'Refresh Models / 刷新模型',action:'refresh'},
      {label:'Configure Reasoning Effort / 推理强度',action:'reasoning'},
      {label:'ChatGPT Settings → Usage',action:'usage'},
      {label:'Resume Requests After Reviewing Usage / 恢复请求',action:'resume'},
      {label:'Show Diagnostics / 诊断',action:'diagnostics'}
    ],{title:'Direct Plan Bridge — ChatGPT accounts',placeHolder:'Accounts/workspaces have separate OAuth registrations'});
    if(!pick)return;
    if(pick.action==='account'){if(pick.state==='signedIn')await accounts.select(pick.id);else await signIn(pick.id);}
    else if(pick.action==='signin')await signIn();
    else if(pick.action==='reauth'||pick.action==='consent')await signIn(active.id,pick.action==='consent');
    else if(pick.action==='signout')await signOut();
    else if(pick.action==='refresh'){provider.refresh();await provider.provideLanguageModelChatInformation({silent:false});}
    else if(pick.action==='usage')await openUsage();
    else if(pick.action==='resume'){if(active){client.resume(active.id);await vscode.window.showInformationMessage('Local usage pause cleared. OpenAI account/app limits still apply.');}}
    else await vscode.commands.executeCommand(`chatgptDirect.${pick.action}`);
  }
  register('chatgptDirect.signIn',()=>signIn());register('chatgptDirect.manage',manage);register('chatgptDirect.signOut',signOut);register('chatgptDirect.usage',openUsage);
  register('chatgptDirect.refreshModels',async()=>{provider.refresh();const models=await provider.provideLanguageModelChatInformation({silent:false});await vscode.window.showInformationMessage(`Loaded ${models.length} ChatGPT models from the public account catalog.`);});
  register('chatgptDirect.reasoning',async()=>{
    const lease=await accounts.access();const models=await provider.catalogFor(lease);
    const rows=[{label:'model-default',description:'Use the backend default; works even when effort metadata is absent.'},...[...new Set(models.flatMap(m=>m.efforts))].map(x=>({label:x,description:`Advertised by: ${models.filter(m=>m.efforts.includes(x)).map(m=>m.name).join(', ')}`}))];
    const pick=await vscode.window.showQuickPick(rows,{title:'Reasoning Effort (global fallback)',placeHolder:'Unsupported combinations fail explicitly; no silent downgrade.'});
    if(pick)await vscode.workspace.getConfiguration('chatgptDirect').update('reasoningEffort',pick.label,vscode.ConfigurationTarget.Global);
  });
  register('chatgptDirect.utilitySettings',()=>vscode.commands.executeCommand('workbench.action.openSettings','@id:chat.utilityModel @id:chat.utilitySmallModel @id:chat.byokUtilityModelDefault'));
  register('chatgptDirect.diagnostics',async()=>{
    const a=await accounts.active();const report={extension:C.VERSION,vscode:vscode.version,route:'Public Sign in with ChatGPT → /v1/responses',signedIn:a?.state==='signedIn',planEnabled:a?.planEnabled??false,catalogModels:provider.catalog?.models.length??0,estimatedCapacityModels:provider.catalog?.models.filter(m=>m.limitsEstimated).length??0,tokenCounting:'ceil(UTF-8 bytes / 4) plus message overhead; not a model tokenizer',lastRequest:client.last,lastCatalog:client.lastCatalog,notes:['No Codex runtime, credential import, backend-api calls, or telemetry.','No live account test was performed during the offline build.','Detailed prompt bodies, OAuth URLs, tokens, account identity and tool arguments are excluded.']};
    output.appendLine(JSON.stringify(report,null,2));output.show(true);
  });
  register('chatgptDirect.testConnection',async()=>{
    const lease=await accounts.access();const models=await provider.catalogFor(lease);
    const pick=await vscode.window.showQuickPick(models.map(m=>({label:m.name,description:m.id,model:m})),{title:'Test connection — uses your ChatGPT plan'});if(!pick)return;
    if(await vscode.window.showWarningMessage('Send a small “Reply OK” request to this model? This consumes ChatGPT plan usage.',{modal:true},'Send test')!=='Send test')return;
    const result=await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:'Testing public SIWC inference',cancellable:true},async(_,token)=>{
      let text='';await provider.provideLanguageModelChatResponse(pick.model,[{role:1,content:[new vscode.LanguageModelTextPart('Reply with exactly OK.')]}],{toolMode:1},{report:p=>{if(p instanceof vscode.LanguageModelTextPart)text+=p.value;}},token);return text;
    });
    await vscode.window.showInformationMessage(`Public SIWC request completed. Response: ${result.slice(0,120)}`);
  });
  const secretsChange=context.secrets.onDidChange(e=>{if(e.key===C.SECRET_KEY)accounts.changed();});
  const configChange=vscode.workspace.onDidChangeConfiguration(e=>{if(e.affectsConfiguration('chatgptDirect'))provider.refresh();});
  context.subscriptions.push(output,status,provider,authentication,accounts,secretsChange,configChange,
    vscode.authentication.registerAuthenticationProvider(C.AUTH_PROVIDER,'ChatGPT · Direct Plan Bridge',authentication,{supportsMultipleAccounts:true}),
    vscode.lm.registerLanguageModelChatProvider(C.VENDOR,provider),{dispose:()=>accounts.off('change',onChanged)});
  await provider.accountChanged();await updateStatus();await authentication.publish();
  return{version:C.VERSION};
}
module.exports={activate,deactivate(){}};
