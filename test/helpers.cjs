'use strict';
const {EventEmitter:NodeEmitter}=require('node:events');
const {Readable}=require('node:stream');
const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');
const C=require('../src/constants');
const {AccountStore,Accounts}=require('../src/auth/accounts');
function mockResponse(status,body,headers={}){return{status,headers:{get:k=>headers[k.toLowerCase()]??null},body:Readable.from([Buffer.from(typeof body==='string'?body:JSON.stringify(body))]),cancel(){this.body.destroy();}};}
function sse(events,{chunkSize=7,status=200,headers={}}={}){
  const payload=Buffer.from(events.map(e=>typeof e==='string'?e:`data: ${JSON.stringify(e)}\r\n\r\n`).join(''));
  const chunks=[];for(let i=0;i<payload.length;i+=chunkSize)chunks.push(payload.subarray(i,i+chunkSize));
  return{status,headers:{get:k=>({'content-type':'text/event-stream',...headers})[k.toLowerCase()]??null},body:Readable.from(chunks),cancel(){this.body.destroy();}};
}
function done(output=[],usage){return{type:'response.completed',response:{id:'resp_test',status:'completed',output,usage}};}
function call(id='call_1',name='read_file',args='{"path":"a.txt"}'){return{type:'function_call',id:`fc_${id}`,call_id:id,name,namespace:'vscode',arguments:args,status:'completed'};}
const model={id:'test-model',name:'Test model',family:'test',version:'1',maxInputTokens:57344,maxOutputTokens:8192,capabilities:{imageInput:true,toolCalling:true},efforts:['low','high']};
const messages=[{role:1,content:[{value:'Hello'}]}];
const tools=[{name:'read_file',description:'Read a file',inputSchema:{type:'object',properties:{path:{type:'string'}},required:['path']}}];
const lease={accountId:'account-a',sessionId:'session-a',accessToken:'unit-test-access'};
class MemorySecrets{
  constructor(){this.values=new Map();this.events=new NodeEmitter();this.writes=[];}
  async get(k){return this.values.get(k);}
  async store(k,v){this.values.set(k,v);this.writes.push(v);this.events.emit('change',{key:k});}
  async delete(k){this.values.delete(k);this.events.emit('change',{key:k});}
  onDidChange(fn){this.events.on('change',fn);return{dispose:()=>this.events.off('change',fn)};}
}
async function createAccounts(t,transport,oidc={validate:async()=>({sub:'subject'}),discovery:async()=>({revocation_endpoint:C.ISSUER+'/api/accounts/oauth/revoke'})}){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'direct-bridge-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const secrets=new MemorySecrets();const store=new AccountStore(secrets,dir);await store.init();
  const accounts=new Accounts(store,transport,oidc,async()=>true);t.after(()=>accounts.dispose());
  return{accounts,secrets,store,dir};
}
async function seed(store,{expiresAt=Date.now()+3600000,scopes=C.SCOPES,state='signedIn',id='account-a',sessionId='session-a'}={}){
  const db=await store.read();db.active=id;db.profiles.push({id,clientId:`oaiapp_${id}`,subject:'subject',issuer:C.ISSUER,label:`Test · ${id}`,state,tokens:{accessToken:'old-access',refreshToken:'old-refresh',idToken:'old-id',scopes:[...scopes],expiresAt,earliestRefreshAt:0,sessionId}});await store.save(db);
}
function fakeVscode(){
  class Emitter{constructor(){this.e=new NodeEmitter();this.event=fn=>{this.e.on('e',fn);return{dispose:()=>this.e.off('e',fn)};};}fire(v){this.e.emit('e',v);}dispose(){this.e.removeAllListeners();}}
  class Text{constructor(value){this.value=value;}}
  class Call{constructor(callId,name,input){Object.assign(this,{callId,name,input});}}
  class Data{constructor(data,mimeType){Object.assign(this,{data,mimeType});}}
  class Cancelled extends Error{constructor(){super('Cancelled');this.name='Canceled';}}
  const commands=new Map(),registrations=[],notifications=[],config={};
  const vscode={version:'1.138.0',EventEmitter:Emitter,LanguageModelTextPart:Text,LanguageModelToolCallPart:Call,LanguageModelDataPart:Data,CancellationError:Cancelled,
    LanguageModelChatMessageRole:{User:1,Assistant:2,System:3},LanguageModelChatToolMode:{Auto:1,Required:2},
    workspace:{isTrusted:true,getConfiguration:()=>({get:(k,d)=>config[k]??d,update:async(k,v)=>{config[k]=v;}}),onDidChangeConfiguration:()=>({dispose(){}})},
    window:{createOutputChannel:()=>({appendLine:s=>notifications.push(s),show(){},dispose(){}}),createStatusBarItem:()=>({show(){},dispose(){}}),showInformationMessage:async s=>notifications.push(s),showWarningMessage:async s=>notifications.push(s),showErrorMessage:async s=>notifications.push(s),showQuickPick:async()=>undefined,withProgress:async(_,fn)=>fn({},token())},
    commands:{registerCommand:(id,fn)=>{commands.set(id,fn);return{dispose:()=>commands.delete(id)};},executeCommand:async(id,...args)=>commands.get(id)?.(...args)},
    lm:{registerLanguageModelChatProvider:(id,provider)=>{registrations.push({kind:'lm',id,provider});return{dispose(){}};}},
    authentication:{registerAuthenticationProvider:(id,label,provider)=>{registrations.push({kind:'auth',id,label,provider});return{dispose(){}};}},
    env:{openExternal:async()=>true},Uri:{parse:s=>({toString:()=>s})},ProgressLocation:{Notification:15},StatusBarAlignment:{Right:2},ConfigurationTarget:{Global:1}};
  return{vscode,commands,registrations,notifications,config};
}
function token(){const listeners=new Set();return{isCancellationRequested:false,onCancellationRequested(fn){listeners.add(fn);return{dispose:()=>listeners.delete(fn)};},cancel(){this.isCancellationRequested=true;for(const fn of listeners)fn();}};}
module.exports={mockResponse,sse,done,call,model,messages,tools,lease,MemorySecrets,createAccounts,seed,fakeVscode,token};
