'use strict';
const {TOOL_NAMESPACE}=require('../constants');
const {object,sha256,BridgeError}=require('../util');
function wireName(name){
  if(typeof name!=='string'||!name||name.length>2048)throw new BridgeError('Invalid VS Code tool name.',{code:'invalid_tool'});
  return /^[A-Za-z0-9_-]{1,64}$/.test(name)?name:`vsc_${name.replace(/[^A-Za-z0-9_-]/g,'_').slice(0,38)}_${sha256(name).slice(0,20)}`;
}
function buildTools(tools=[]){
  const mapping=new Map();const originals=new Set();
  const functions=tools.map(t=>{
    const name=wireName(t.name);
    if(mapping.has(name)||originals.has(t.name))throw new BridgeError('Duplicate or colliding tool names.',{code:'invalid_tool'});
    mapping.set(name,t.name);originals.add(t.name);
    if(t.inputSchema!==undefined&&!object(t.inputSchema))throw new BridgeError('Tool input schema must be a JSON object.',{code:'invalid_tool_schema'});
    return {type:'function',name,description:t.description||t.name,parameters:t.inputSchema||{type:'object',properties:{},additionalProperties:false},strict:false};
  });
  return {mapping,tools:functions.length?[{type:'namespace',name:TOOL_NAMESPACE,description:'Tools supplied and executed by the current VS Code agent, including its workspace and MCP tools.',tools:functions}]:[]};
}
function parseCall(item,mapping){
  if(item.type!=='function_call'||typeof item.call_id!=='string'||!item.call_id||item.call_id.length>256)throw new BridgeError('Invalid function-call identity.',{code:'invalid_tool_call'});
  if(item.namespace!=null&&item.namespace!==TOOL_NAMESPACE)throw new BridgeError('Model requested an unadvertised tool namespace.',{code:'unadvertised_tool'});
  const original=mapping.get(item.name);
  if(!original)throw new BridgeError('Model requested a tool not supplied by VS Code for this turn.',{code:'unadvertised_tool'});
  let input;
  try{if(typeof item.arguments!=='string'||item.arguments.length>1024*1024)throw 0;input=JSON.parse(item.arguments);}catch{throw new BridgeError('Model returned invalid or oversized tool arguments.',{code:'invalid_tool_arguments'});}
  if(!object(input))throw new BridgeError('Tool arguments must be a JSON object.',{code:'invalid_tool_arguments'});
  return {callId:item.call_id,name:original,input};
}
module.exports={wireName,buildTools,parseCall};
