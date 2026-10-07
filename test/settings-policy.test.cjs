'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {normalizeCatalog,modelInfo}=require('../src/openai/models');
const {buildRequest}=require('../src/openai/client');
const {ResponseReplayCache,estimateTokens}=require('../src/protocol/history');
const {subagentPolicy}=require('../src/protocol/subagent-policy');
const models=normalizeCatalog({models:[
  {slug:'gpt-6-astra',display_name:'GPT-6-Astra',visibility:'list',supported_reasoning_efforts:['medium','high','xhigh']},
  {slug:'gpt-6.1-sol',display_name:'GPT-6.1-Sol',visibility:'list',supported_reasoning_efforts:['low','medium','high']},
  {slug:'gpt-6-luna',display_name:'GPT-6-Luna',visibility:'list',supported_reasoning_efforts:['low','high']},
]});
const model=models[0],history=[{role:3,content:[{value:'Use Sonnet for Explore.'}]},{role:1,content:[{value:'Explore the code.'}]}];
const tool={name:'runSubagent',inputSchema:{type:'object',properties:{model:{type:'string'},prompt:{type:'string'},description:{type:'string'}}}};
const context=config=>({cache:new ResponseReplayCache(),scope:'settings-fixture',models,config});

test('catalog diagnostics distinguish server entries from models returned to the host',async()=>{
  const {OpenAIClient}=require('../src/openai/client');
  const {Readable}=require('node:stream');
  const events=[];
  const json={models:[{slug:'gpt-6-astra',display_name:'GPT-6-Astra',visibility:'list'},{slug:'gpt-6-sol',display_name:'GPT-6-Sol',visibility:'hide'},{slug:'gpt-6-luna',display_name:'GPT-6-Luna',visibility:'list'}]};
  const client=new OpenAIClient(async()=>({status:200,headers:{get:key=>key==='content-type'?'application/json':key==='x-request-id'?'catalog-fixture':null},body:Readable.from([Buffer.from(JSON.stringify(json))])}),event=>events.push(event));
  const result=await client.models('fixture-secret',{});
  assert.deepEqual(result.filter(model=>model.catalogSource==='live').map(model=>model.id),['gpt-6-astra','gpt-6-luna']);
  assert.ok(result.some(model=>model.id==='gpt-6.1-sol'&&model.catalogSource==='snapshot'));
  assert.equal(result.some(model=>model.id==='gpt-6-sol'),false);
  assert.deepEqual(events.map(event=>event.stage),['request','http_response','normalized']);
  assert.equal(events[1].httpStatus,200);
  assert.equal(client.lastCatalog.receivedCount,3);assert.equal(client.lastCatalog.includedCount,result.length);
  assert.deepEqual(client.lastCatalog.entries.filter(entry=>entry.source==='live').map(entry=>[entry.slug,entry.reason]),[['gpt-6-astra','included'],['gpt-6-sol','visibility_not_list'],['gpt-6-luna','included']]);
  assert.equal(JSON.stringify(events).includes('fixture-secret'),false);
});

test('catalog snapshot fills missing models while the live entry owns name and effort',()=>{
  const snapshot=require('../src/openai/catalog-snapshot.json');
  const result=normalizeCatalog({models:[{slug:'gpt-6-astra',display_name:'Current Astra',visibility:'list',supported_reasoning_efforts:['medium']}]},{},()=>{},snapshot.models);
  assert.equal(result[0].name,'Current Astra');assert.deepEqual(result[0].efforts,['medium']);
  assert.equal(result.filter(model=>model.id==='gpt-6-astra').length,1);
  const sol=result.find(model=>model.id==='gpt-6.1-sol');
  assert.equal(sol.catalogSource,'snapshot');assert.ok(sol.efforts.includes('high'));
  const body=buildRequest(sol,history,{modelConfiguration:{reasoningEffort:'high'}},{...context({}),models:result}).body;
  assert.equal(body.model,'gpt-6.1-sol');assert.deepEqual(body.reasoning,{effort:'high'});
});
test('an explicitly hidden live model remains hidden when the snapshot lists it',()=>{
  const snapshot=require('../src/openai/catalog-snapshot.json');
  const result=normalizeCatalog({models:[{slug:'gpt-6-astra',visibility:'list'},{slug:'gpt-5.5',visibility:'hide'}]},{},()=>{},snapshot.models);
  assert.equal(result.some(model=>model.id==='gpt-5.5'),false);
});

test('a custom developer prompt replaces the default policy in the outgoing request',()=>{
  const prompt='Use Sol to explore. Keep the requested task unchanged.';
  const input=buildRequest(model,history,{tools:[tool]},context({subagentDeveloperPrompt:prompt})).body.input;
  assert.equal(input[1].content[0].text,prompt);
  assert.equal(input.filter(item=>item.role==='developer').length,2);
  assert.equal(modelInfo(model,models,{subagentDeveloperPrompt:prompt}).maxInputTokens,model.maxInputTokens-estimateTokens({content:[{value:prompt}]}));
});
test('custom prompt placeholders resolve current catalog routes and parent selector',()=>{
  const text=subagentPolicy(models,model,'Routes:\n{{modelRoutes}}\nParent: {{parentModel}}');
  assert.match(text,/Sonnet -> "GPT-6\.1-Sol \(l89669-chatgpt-direct\)"/);
  assert.ok(text.endsWith('Parent: "GPT-6-Astra (l89669-chatgpt-direct)"'));
});
test('an empty developer prompt disables injection and releases its input budget',()=>{
  const config={subagentDeveloperPrompt:''};
  const input=buildRequest(model,history,{tools:[tool]},context(config)).body.input;
  assert.equal(input.length,2);
  assert.equal(modelInfo(model,models,config).maxInputTokens,model.maxInputTokens);
});

test('native model configuration advertises exactly the catalog efforts and default choices',()=>{
  const property=modelInfo(model,models).configurationSchema.properties.reasoningEffort;
  assert.equal(property.title,'Thinking Effort');assert.equal(property.group,'navigation');
  assert.deepEqual(property.enum,['provider-default','model-default','medium','high','xhigh']);
  assert.deepEqual(property.enumItemLabels,['Extension default','Model default','Medium','High','Extra high']);
  assert.equal(property.default,'provider-default');
});
test('models without advertised efforts do not invent a thinking-effort menu',()=>{
  const plain=normalizeCatalog({models:[{slug:'gpt-plain',visibility:'list'}]})[0];
  assert.equal(modelInfo(plain).configurationSchema,undefined);
});
test('the chat-selected effort overrides the global fallback in the actual API payload',()=>{
  const request=buildRequest(model,history,{modelConfiguration:{reasoningEffort:'xhigh'}},context({reasoningEffort:'medium'}));
  assert.deepEqual(request.body.reasoning,{effort:'xhigh'});
  assert.equal(request.reasoningEffortSource,'model-configuration');
});
test('extension-default selection retains the existing global effort command',()=>{
  const request=buildRequest(model,history,{modelConfiguration:{reasoningEffort:'provider-default'}},context({reasoningEffort:'high'}));
  assert.deepEqual(request.body.reasoning,{effort:'high'});
  assert.equal(request.reasoningEffortSource,'extension-default');
});
test('model-default selection omits effort even when the global fallback is high',()=>{
  const request=buildRequest(model,history,{modelConfiguration:{reasoningEffort:'model-default'}},context({reasoningEffort:'high'}));
  assert.equal(request.body.reasoning,undefined);
});
test('an explicit request option takes priority over the chat configuration',()=>{
  const request=buildRequest(model,history,{modelOptions:{reasoningEffort:'medium'},modelConfiguration:{reasoningEffort:'high'}},context({reasoningEffort:'xhigh'}));
  assert.deepEqual(request.body.reasoning,{effort:'medium'});assert.equal(request.reasoningEffortSource,'request');
});
test('chat configuration still rejects an effort absent from this model catalog',()=>{
  assert.throws(()=>buildRequest(model,history,{modelConfiguration:{reasoningEffort:'invented'}},context({})),{code:'unsupported_reasoning_effort'});
});
test('delegation receives a later developer policy with concrete available GPT selectors',()=>{
  const input=buildRequest(model,history,{tools:[tool]},context({})).body.input;
  assert.equal(input[0].content[0].text,'Use Sonnet for Explore.');
  assert.equal(input[1].role,'developer');
  const policy=input[1].content[0].text;
  assert.match(policy,/Sonnet -> "GPT-6\.1-Sol \(l89669-chatgpt-direct\)"/);
  assert.match(policy,/Haiku -> "GPT-6-Luna \(l89669-chatgpt-direct\)"/);
  assert.match(policy,/Opus -> "GPT-6-Astra \(l89669-chatgpt-direct\)"/);
  assert.match(policy,/explicitly set its model argument/);
  assert.equal(input.at(-1).content[0].text,'Explore the code.');
});
test('missing family substitutes the available main model without fabricating a selector',()=>{
  const policy=subagentPolicy([model],model);
  assert.match(policy,/Sonnet -> "GPT-6-Astra \(l89669-chatgpt-direct\)"/);
  assert.match(policy,/Haiku -> "GPT-6-Astra \(l89669-chatgpt-direct\)"/);
  assert.doesNotMatch(policy,/GPT-6\.1-Sol|GPT-6-Luna/);
});
test('subagent routing selects only catalog models that support agent tools',()=>{
  const noTools={...models[1],capabilities:{...models[1].capabilities,toolCalling:false}};
  assert.match(subagentPolicy([model,noTools],model),/Sonnet -> "GPT-6-Astra \(l89669-chatgpt-direct\)"/);
});
test('non-delegation requests keep the host message history unchanged',()=>{
  const input=buildRequest(model,history,{tools:[{name:'read_file'}]},context({})).body.input;
  assert.equal(input.length,2);assert.equal(input[0].content[0].text,'Use Sonnet for Explore.');
});
test('model input capacity reserves the hidden developer policy once',()=>{
  const reserve=estimateTokens({content:[{value:subagentPolicy(models,model)}]});
  assert.equal(modelInfo(model,models).maxInputTokens,model.maxInputTokens-reserve);
});
