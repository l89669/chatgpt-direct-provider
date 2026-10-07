'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {OpenAIClient,buildRequest}=require('../src/openai/client');
const {ResponseReplayCache}=require('../src/protocol/history');
const {sse,done,call,model,messages,tools,lease}=require('./helpers.cjs');
const message=(id,text,phase)=>({type:'message',id,role:'assistant',phase,content:[{type:'output_text',text,annotations:[]}],status:'completed'});
const reasoning=id=>({type:'reasoning',id,summary:[],encrypted_content:`encrypted-${id}`});
function completed(output,endTurn,usage){const event=done(output,usage);if(endTurn!==undefined)event.response.end_turn=endTurn;return event;}
function fixture(responses){
  const requests=[],states=[],cache=new ResponseReplayCache();let text='';
  const client=new OpenAIClient(async(_url,options)=>{requests.push(JSON.parse(options.body));assert.ok(requests.length<=responses.length,'Unexpected extra sample');const events=responses[requests.length-1];return sse(Array.isArray(events)?events:[events]);},state=>states.push(state));
  const context={cache,scope:'test-scope',config:{},onText:value=>{text+=value;}};
  return{client,requests,states,cache,context,text:()=>text};
}

test('end_turn=false preamble continues to a tool call before returning to the host',async()=>{
  const preamble=[reasoning('plan'),message('progress','I will inspect the remote commit.','commentary')];
  const handoff=[reasoning('action'),call()];
  const f=fixture([completed(preamble,false),completed(handoff,false)]);
  const result=await f.client.infer(lease,model,messages,{tools,toolMode:2},f.context);
  assert.equal(f.requests.length,2);
  assert.deepEqual(f.requests[1].input.slice(1),preamble);
  assert.deepEqual(result.calls,[{callId:'call_1',name:'read_file',input:{path:'a.txt'}}]);
  assert.equal(f.text(),'I will inspect the remote commit.');
  assert.deepEqual(f.states.map(state=>[state.status,state.completionKind]),[['continuing',undefined],['completed','tool_calls']]);
});

test('commentary without an end-turn flag continues to the final answer',async()=>{
  const progress=[message('progress','I will review it.','commentary')];
  const answer=[message('answer','The commit fixes the role mapping.','final_answer')];
  const f=fixture([completed(progress,undefined),completed(answer,true)]);
  const result=await f.client.infer(lease,model,messages,{},f.context);
  assert.equal(result.calls.length,0);
  assert.equal(f.requests.length,2);
  assert.deepEqual(f.requests[1].input.slice(1),progress);
  assert.equal(f.text(),'I will review it.The commit fixes the role mapping.');
  assert.equal(f.states[0].continuationReason,'intermediate_phase');
  assert.equal(f.client.last.completionKind,'turn_end');
});

test('continued samples replay as one complete host answer with both phases and reasoning',async()=>{
  const progress=[reasoning('first'),message('progress','Inspecting.','commentary')];
  const answer=[reasoning('second'),message('answer','Inspection complete.','final_answer')];
  const f=fixture([completed(progress,false,{input_tokens:10,output_tokens:3,total_tokens:13}),completed(answer,true,{input_tokens:15,output_tokens:4,total_tokens:19})]);
  const result=await f.client.infer(lease,model,messages,{},f.context);
  const history=[...messages,{role:2,content:[{value:f.text()}]},{role:1,content:[{value:'Explain the tradeoff.'}]}];
  const input=buildRequest(model,history,{},f.context).body.input;
  assert.deepEqual(input.slice(1,-1),[...progress,...answer]);
  assert.deepEqual(result.usage,{input_tokens:25,output_tokens:7,total_tokens:32});
});

test('an explicit end-turn flag ends the sample without text-based guesses',async()=>{
  const f=fixture([completed([message('answer','Awaiting your decision.','final_answer')],true)]);
  await f.client.infer(lease,model,messages,{},f.context);
  assert.equal(f.requests.length,1);
  assert.equal(f.client.last.endTurn,true);
  assert.equal(f.client.last.completionKind,'turn_end');
});

test('tool calls immediately hand off even when the model has not ended its turn',async()=>{
  const f=fixture([completed([message('progress','Reading.','commentary'),call()],false)]);
  const result=await f.client.infer(lease,model,messages,{tools},f.context);
  assert.equal(f.requests.length,1);
  assert.equal(result.calls[0].name,'read_file');
  assert.equal(f.client.last.completionKind,'tool_calls');
});

test('reasoning-only non-final samples retain their state before the next answer',async()=>{
  const first=[reasoning('thinking')];
  const f=fixture([completed(first,false),completed([message('answer','Ready.','final_answer')],true)]);
  await f.client.infer(lease,model,messages,{},f.context);
  assert.deepEqual(f.requests[1].input.slice(1),first);
  assert.equal(f.text(),'Ready.');
});

test('thin completion metadata preserves the streamed commentary needed for continuation',async()=>{
  const progress=message('progress','I will inspect it.','commentary');
  const first=[{type:'response.output_item.done',output_index:0,item:progress},completed([],undefined)];
  const f=fixture([first,completed([call()],false)]);
  const result=await f.client.infer(lease,model,messages,{tools},f.context);
  assert.equal(f.requests.length,2);
  assert.deepEqual(f.requests[1].input.slice(1),[progress]);
  assert.equal(result.calls[0].name,'read_file');
  assert.equal(f.text(),'I will inspect it.');
});
