'use strict';
const assert=require('node:assert/strict');
exports.run=async()=>{
  const vscode=require('vscode'),pkg=require('../../package.json');
  const extension=vscode.extensions.getExtension(`${pkg.publisher}.${pkg.name}`);assert.ok(extension,'Development extension was discovered');
  const result=await extension.activate();assert.equal(result.version,pkg.version);
  const commands=await vscode.commands.getCommands(true);for(const c of pkg.contributes.commands)assert.ok(commands.includes(c.command),`Missing command ${c.command}`);
  await vscode.lm.selectChatModels({vendor:pkg.contributes.languageModelChatProviders[0].vendor});
  const {buildRequest}=require('../../src/openai/client');
  const {ResponseReplayCache}=require('../../src/protocol/history');
  const roles=vscode.LanguageModelChatMessageRole;
  const messages=[
    new vscode.LanguageModelChatMessage(roles.System,[new vscode.LanguageModelTextPart('Follow the host instructions.')]),
    vscode.LanguageModelChatMessage.User('Read the file.'),
    vscode.LanguageModelChatMessage.Assistant([new vscode.LanguageModelToolCallPart('host-call','read_file',{path:'example.txt'})]),
    vscode.LanguageModelChatMessage.User([new vscode.LanguageModelToolResultPart('host-call',[new vscode.LanguageModelTextPart('actual host result')])]),
  ];
  const model={id:'host-validation-model',capabilities:{imageInput:false,toolCalling:true},efforts:[]};
  const request=buildRequest(model,messages,{tools:[{name:'read_file'}]},{cache:new ResponseReplayCache(),scope:'host-validation'}).body;
  assert.deepEqual(request.input,[
    {role:'developer',content:[{type:'input_text',text:'Follow the host instructions.'}]},
    {role:'user',content:[{type:'input_text',text:'Read the file.'}]},
    {type:'function_call',call_id:'host-call',name:'read_file',namespace:'vscode',arguments:'{"path":"example.txt"}'},
    {type:'function_call_output',call_id:'host-call',output:'actual host result'},
  ]);
  const switched=buildRequest(model,[...messages.slice(0,2),vscode.LanguageModelChatMessage.Assistant('Previous model answer.'),vscode.LanguageModelChatMessage.User('Continue with Astra.')],{},{cache:new ResponseReplayCache(),scope:'switched-native-model'}).body;
  assert.deepEqual(switched.input[2],{role:'assistant',content:'Previous model answer.'});
  require('node:fs').writeFileSync(require('node:path').join(__dirname,'../../docs/ASSISTANT_HISTORY_VALIDATION.json'),JSON.stringify({extension:pkg.version,vscode:vscode.version,kind:'actual native messages, empty replay cache',input:switched.input},null,2)+'\n');
  console.log('REAL ASSISTANT HISTORY: native assistant text with an empty replay cache is encoded as a string; user and developer input parts remain input_text.');
  const {EventEmitter}=require('node:events');
  const {Readable}=require('node:stream');
  const {OpenAIClient}=require('../../src/openai/client');
  const {Provider}=require('../../src/vscode/provider');
  let samples=0;const requests=[];
  const progressItem={type:'message',id:'progress',role:'assistant',phase:'commentary',content:[{type:'output_text',text:'I will inspect the commit.'}]};
  const callItem={type:'function_call',id:'call-item',call_id:'native-call',name:'read_file',namespace:'vscode',arguments:'{"path":"example.txt"}'};
  const client=new OpenAIClient(async(_url,options)=>{
    requests.push(JSON.parse(options.body));samples++;
    assert.ok(samples<=2,'The native provider sampled past its tool handoff');
    const event={type:'response.completed',response:{id:`host-response-${samples}`,status:'completed',end_turn:false,output:samples===1?[progressItem]:[callItem]}};
    return{status:200,headers:{get:name=>name==='content-type'?'text/event-stream':null},body:Readable.from([Buffer.from(`data: ${JSON.stringify(event)}\n\n`)]),cancel(){this.body.destroy();}};
  });
  client.models=async()=>[model];
  const accounts=new EventEmitter(),lease={accountId:'host-fixture',sessionId:'host-session',accessToken:'synthetic-offline-fixture'};
  accounts.active=async()=>({id:lease.accountId,sessionId:lease.sessionId,state:'signedIn',planEnabled:true});
  accounts.access=async()=>lease;accounts.assertLease=async()=>{};
  const provider=new Provider(vscode,accounts,client,async()=>{},()=>{}),parts=[];
  try{
    const token={isCancellationRequested:false,onCancellationRequested:()=>({dispose(){}})};
    await provider.provideLanguageModelChatResponse(model,messages.slice(0,2),{tools:[{name:'read_file'}]},{report:part=>parts.push(part)},token);
    assert.equal(samples,2);assert.deepEqual(requests[1].input.at(-1),progressItem);
    assert.ok(parts[0] instanceof vscode.LanguageModelTextPart);assert.equal(parts[0].value,'I will inspect the commit.');
    assert.ok(parts[1] instanceof vscode.LanguageModelToolCallPart);assert.equal(parts[1].callId,'native-call');
    assert.equal(client.last.completionKind,'tool_calls');
  }finally{provider.dispose();}
  const {normalizeCatalog}=require('../../src/openai/models');
  const settingsModels=normalizeCatalog({models:[
    {slug:'gpt-host-astra',display_name:'Host GPT Astra',visibility:'list',supported_reasoning_efforts:['low','high']},
    {slug:'gpt-host-sol',display_name:'Host GPT Sol',visibility:'list',supported_reasoning_efforts:['low','high']},
    {slug:'gpt-host-luna',display_name:'Host GPT Luna',visibility:'list',supported_reasoning_efforts:['low']},
  ]});
  let settingsBody,receivedConfiguration;
  const settingsClient=new OpenAIClient(async(_url,options)=>{
    if(_url.endsWith('/models'))return{status:200,headers:{get:key=>key==='content-type'?'application/json':null},body:Readable.from([Buffer.from(JSON.stringify({models:settingsModels.map(model=>({slug:model.id,display_name:model.name,visibility:'list',supported_reasoning_efforts:model.efforts}))}))]),cancel(){this.body.destroy();}};
    settingsBody=JSON.parse(options.body);
    const event={type:'response.completed',response:{id:'host-settings-response',status:'completed',end_turn:true,output:[{type:'message',id:'host-settings-answer',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'OK'}]}]}};
    return{status:200,headers:{get:key=>key==='content-type'?'text/event-stream':null},body:Readable.from([Buffer.from(`data: ${JSON.stringify(event)}\n\n`)]),cancel(){this.body.destroy();}};
  });
  const settingsProvider=new Provider(vscode,accounts,settingsClient,async()=>{},()=>{});
  const originalProvide=settingsProvider.provideLanguageModelChatResponse.bind(settingsProvider);
  settingsProvider.provideLanguageModelChatResponse=(info,history,options,progress,token)=>{receivedConfiguration=options.modelConfiguration;return originalProvide(info,history,options,progress,token);};
  const registration=vscode.lm.registerLanguageModelChatProvider(pkg.contributes.languageModelChatProviders[0].vendor,settingsProvider);
  try{
    const selected=await vscode.lm.selectChatModels({vendor:pkg.contributes.languageModelChatProviders[0].vendor,id:'gpt-host-astra'});
    assert.equal(selected.length,1);
    const defaults=await selected[0].sendRequest([vscode.LanguageModelChatMessage.User('Check the schema default.')],{});
    for await(const _part of defaults.stream){}
    assert.equal(receivedConfiguration.reasoningEffort,'provider-default');
    const defaultConfiguration={...receivedConfiguration};
    const response=await selected[0].sendRequest([vscode.LanguageModelChatMessage.User('Use the Explore subagent.')],{configuration:{reasoningEffort:'high'},tools:[{name:'runSubagent',description:'Run a subagent',inputSchema:{type:'object',properties:{model:{type:'string'}}}}]});
    let answer='';for await(const part of response.stream)if(part instanceof vscode.LanguageModelTextPart)answer+=part.value;
    assert.equal(answer,'OK');assert.equal(receivedConfiguration.reasoningEffort,'high');
    assert.deepEqual(settingsBody.reasoning,{effort:'high'});
    const policy=settingsBody.input.find(item=>item.role==='developer').content[0].text;
    assert.ok(policy.includes('Sonnet -> "Host GPT Sol (l89669-chatgpt-direct)"'));
    assert.ok(policy.includes('explicitly set its model argument'));
    const fs=require('node:fs'),path=require('node:path');
    const information=await settingsProvider.provideLanguageModelChatInformation({silent:true},{isCancellationRequested:false,onCancellationRequested:()=>({dispose(){}})});
    fs.writeFileSync(path.join(__dirname,'../../docs/SETTINGS_VALIDATION.json'),JSON.stringify({kind:'real VS Code model registry with synthetic model transport',extension:pkg.version,vscode:vscode.version,configurationSchema:information[0].configurationSchema,defaultConfiguration,selectedConfiguration:receivedConfiguration,apiReasoning:settingsBody.reasoning,subagentPolicy:policy,inputBudget:information[0].maxInputTokens},null,2)+'\n');
    const setting=vscode.workspace.getConfiguration('chatgptDirect');
    const customPrompt='Host custom developer instruction. Parent: {{parentModel}}';
    await setting.update('subagentDeveloperPrompt',customPrompt,vscode.ConfigurationTarget.Global);
    const customResponse=await selected[0].sendRequest([vscode.LanguageModelChatMessage.User('Explore again.')],{tools:[{name:'runSubagent',inputSchema:{type:'object'}}]});
    for await(const _part of customResponse.stream){}
    const customText=settingsBody.input.find(item=>item.role==='developer').content[0].text;
    assert.equal(customText,'Host custom developer instruction. Parent: "Host GPT Astra (l89669-chatgpt-direct)"');
    await setting.update('subagentDeveloperPrompt','',vscode.ConfigurationTarget.Global);
    const disabledResponse=await selected[0].sendRequest([vscode.LanguageModelChatMessage.User('Explore without policy.')],{tools:[{name:'runSubagent',inputSchema:{type:'object'}}]});
    for await(const _part of disabledResponse.stream){}
    assert.equal(settingsBody.input.some(item=>item.role==='developer'),false);
    await setting.update('subagentDeveloperPrompt',undefined,vscode.ConfigurationTarget.Global);
    fs.writeFileSync(path.join(__dirname,'../../docs/PROMPT_VALIDATION.json'),JSON.stringify({extension:pkg.version,vscode:vscode.version,setting:'chatgptDirect.subagentDeveloperPrompt',customTemplate:customPrompt,renderedPrompt:customText,emptyDisablesInjection:true,updatedWithoutReload:true},null,2)+'\n');
    console.log('REAL MODEL CONFIGURATION: native model registry and sendRequest forwarded reasoningEffort=high to modelConfiguration; API payload used reasoning.effort=high and the available GPT subagent routing policy. Synthetic inference.');
    console.log('REAL PROMPT CONFIGURATION: native VS Code setting update replaced the developer prompt on the next request; empty setting disabled injection; no reload. Synthetic inference.');
    const snapshotModel=await vscode.lm.selectChatModels({vendor:pkg.contributes.languageModelChatProviders[0].vendor,id:'gpt-6.1-sol'});
    assert.equal(snapshotModel.length,1);
    const snapshotResponse=await snapshotModel[0].sendRequest([vscode.LanguageModelChatMessage.User('Verify snapshot model request.')],{configuration:{reasoningEffort:'high'}});
    for await(const _part of snapshotResponse.stream){}
    assert.equal(settingsBody.model,'gpt-6.1-sol');assert.deepEqual(settingsBody.reasoning,{effort:'high'});
    fs.writeFileSync(path.join(__dirname,'../../docs/SNAPSHOT_VALIDATION.json'),JSON.stringify({extension:pkg.version,vscode:vscode.version,kind:'native model registry with synthetic transport',selectedModel:settingsBody.model,reasoning:settingsBody.reasoning,catalogSources:settingsProvider.catalog.models.map(model=>({id:model.id,source:model.catalogSource}))},null,2)+'\n');
    console.log('REAL CATALOG SNAPSHOT: gpt-6.1-sol missing from synthetic live catalog was added from the bundled snapshot, discovered by the native model registry, and sent as the request model with effort high. Synthetic inference.');
  }finally{registration.dispose();settingsProvider.dispose();}
  console.log('REAL NATIVE PROVIDER: commentary with end_turn=false continued to a second model sample, then emitted the actual VS Code ToolCallPart before resolving. Synthetic model responses; no live inference.');
  console.log(`REAL EXTENSION HOST ${vscode.version}: System=${roles.System}, User=${roles.User}, Assistant=${roles.Assistant}; native messages converted to developer/user/tool-call/tool-result correctly. Activation, commands and unsigned discovery passed. Live OAuth/inference NOT tested.`);
};
