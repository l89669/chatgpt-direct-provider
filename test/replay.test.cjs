'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {ResponseReplayCache,estimateTokens}=require('../src/protocol/history');
const {buildRequest}=require('../src/openai/client');
const {buildTools,wireName}=require('../src/protocol/tools');
const {model,tools,call}=require('./helpers.cjs');
const scope='account:session:model';
const user=text=>({role:1,content:[{value:text}]});
const assistant=text=>({role:2,content:[{value:text}]});
const reasoning=id=>({type:'reasoning',id,summary:[],encrypted_content:`encrypted-${id}`});
const message=(id,text,phase='final_answer')=>({type:'message',id,role:'assistant',phase,status:'completed',content:[{type:'output_text',text,annotations:[]}]});
function request(history,cache){return buildRequest(model,history,{tools},{cache,scope}).body.input;}

test('a plain-text reply retains all reasoning and final phase in the follow-up request',()=>{
  const cache=new ResponseReplayCache(),initial=[user('Explain the design.')];
  const output=[reasoning('before-text'),message('answer','Use one history owner.'),reasoning('after-text')];
  cache.remember(scope,initial,output,buildTools(tools).mapping);
  const input=request([...initial,assistant('Use one history owner.'),user('Now implement it.')],cache);
  assert.deepEqual(input.slice(1,-1),output);
  assert.equal(input.at(-1).content[0].text,'Now implement it.');
});

test('a tool continuation preserves commentary and reasoning after the last call',()=>{
  const cache=new ResponseReplayCache(),initial=[user('Read the file.')];
  const output=[reasoning('before-call'),message('preamble','Reading the file.','commentary'),call(),reasoning('after-call')];
  cache.remember(scope,initial,output,buildTools(tools).mapping);
  const history=[...initial,{role:2,content:[{value:'Reading '},{value:'the file.'},{callId:'call_1',name:'read_file',input:{path:'a.txt'}}]},
    {role:1,content:[{callId:'call_1',content:[{value:'The host read this text.'}]}]}];
  const input=request(history,cache);
  assert.deepEqual(input.slice(1,-1),output);
  assert.deepEqual(input.at(-1),{type:'function_call_output',call_id:'call_1',output:'The host read this text.'});
});

test('merged host text restores distinct commentary and final-answer messages',()=>{
  const cache=new ResponseReplayCache(),initial=[user('Describe the change.')];
  const output=[reasoning('analysis'),message('progress','I checked it.','commentary'),message('final','The change is ready.')];
  cache.remember(scope,initial,output,new Map());
  const input=request([...initial,assistant('I checked it.The change is ready.'),user('Continue.')],cache);
  assert.deepEqual(input.slice(1,-1),output);
  assert.deepEqual(input.filter(item=>item.role==='assistant').map(item=>item.phase),['commentary','final_answer']);
});

test('separate assistant messages and different stream chunks restore the same response',()=>{
  const cache=new ResponseReplayCache(),initial=[user('Give a brief answer.')];
  const output=[reasoning('answer'),message('m','Ready to proceed.')];
  cache.remember(scope,initial,output,new Map());
  const input=request([...initial,assistant('Ready '),{role:2,content:[{value:'to '},{value:'proceed.'}]},user('Proceed.')],cache);
  assert.deepEqual(input.slice(1,-1),output);
});

test('identical visible answers in successive turns retain their own reasoning',()=>{
  const cache=new ResponseReplayCache(),initial=[user('Check A.')];
  const first=[reasoning('A'),message('answer-A','Done.')];
  cache.remember(scope,initial,first,new Map());
  const secondHistory=[...initial,assistant('Done.'),user('Check B.')];
  const second=[reasoning('B'),message('answer-B','Done.')];
  cache.remember(scope,secondHistory,second,new Map());
  const input=request([...secondHistory,assistant('Done.'),user('Compare A and B.')],cache);
  assert.deepEqual(input.filter(item=>item.type==='reasoning'),[first[0],second[0]]);
  assert.deepEqual(input.filter(item=>item.role==='assistant'),[first[1],second[1]]);
});

test('current developer instructions coexist with preserved prior response state',()=>{
  const cache=new ResponseReplayCache(),initial=[{role:3,content:[{value:'Initial instructions.'}]},user('Inspect it.')];
  const output=[reasoning('inspection'),message('m','Inspected.')];
  cache.remember(scope,initial,output,new Map());
  const input=request([{role:3,content:[{value:'Updated instructions.'}]},initial[1],assistant('Inspected.'),user('Continue.')],cache);
  assert.equal(input[0].content[0].text,'Updated instructions.');
  assert.deepEqual(input.slice(2,-1),output);
});

test('edited visible answers remain authoritative instead of restoring the cached response',()=>{
  const cache=new ResponseReplayCache(),initial=[user('Explain it.')];
  cache.remember(scope,initial,[reasoning('old'),message('m','Original answer.')],new Map());
  const input=request([...initial,assistant('Edited answer.'),user('Continue.')],cache);
  assert.equal(input.some(item=>item.type==='reasoning'),false);
  assert.equal(input[1].content,'Edited answer.');
});

test('rewritten conversation history does not resurrect reasoning discarded by compaction',()=>{
  const cache=new ResponseReplayCache(),initial=[user('Read the original conversation.')];
  cache.remember(scope,initial,[reasoning('old-context'),message('m','Done.')],new Map());
  const input=request([user('Summary of the previous work.'),assistant('Done.'),user('Continue.')],cache);
  assert.equal(input.some(item=>item.type==='reasoning'),false);
  assert.equal(input[0].content[0].text,'Summary of the previous work.');
});

test('replayed calls retain wire aliases while the host history uses original tool names',()=>{
  const cache=new ResponseReplayCache(),initial=[user('Use the MCP tool.')],name='mcp.tools/read';
  const supplied=[{name}],output=[reasoning('mcp'),call('mcp-call',wireName(name))];
  cache.remember(scope,initial,output,buildTools(supplied).mapping);
  const history=[...initial,{role:2,content:[{callId:'mcp-call',name,input:{path:'a.txt'}}]},
    {role:1,content:[{callId:'mcp-call',content:[{value:'MCP result'}]}]}];
  const input=request(history,cache);
  assert.deepEqual(input.slice(1,-1),output);
  assert.equal(input.at(-1).output,'MCP result');
});

test('40 KiB text, text attachments and tool arguments use the same byte-to-token scale',()=>{
  const text='x'.repeat(40960);
  assert.equal(estimateTokens(text),10240);
  assert.equal(estimateTokens({content:[{value:text}]}),10264);
  assert.equal(estimateTokens({content:[{mimeType:'text/plain',data:Buffer.from(text)}]}),10272);
  assert.equal(estimateTokens({content:[{callId:'call_1',name:'read_file',input:{path:'a.txt'}}]}),47);
  assert.equal(estimateTokens('中文🙂'),3);
});
