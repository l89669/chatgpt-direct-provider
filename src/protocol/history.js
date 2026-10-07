'use strict';
const {createHash}=require('node:crypto');
const {TOOL_NAMESPACE}=require('../constants');
const {BridgeError,object,sha256}=require('../util');
const {wireName}=require('./tools');
const IMAGE_TYPES=new Set(['image/png','image/jpeg','image/webp','image/gif']);
/** Owns complete Responses output while the host owns visible history.
 * A record matches its preceding conversation and emitted text/tool calls.
 * Streaming chunks and mutable developer instructions are not response identity. */
class ResponseReplayCache {
  constructor(maxBytes=16*1024*1024,ttl=3600000){this.maxBytes=maxBytes;this.ttl=ttl;this.entries=new Map();this.bytes=0;}
  clear(){this.entries.clear();this.bytes=0;}
  key(scope,prefix,content){return `${scope}\0${prefix}\0${sha256(JSON.stringify(visibleParts(content)))}`;}
  remember(scope,messages,output,mapping){
    let text='';const calls=[];
    for(const item of output){
      if(item.type==='message')for(const part of item.content||[])text+=part.type==='output_text'?part.text:part.type==='refusal'?part.refusal:'';
      if(item.type==='function_call')calls.push({callId:item.call_id,name:mapping.get(item.name),input:JSON.parse(item.arguments)});
    }
    const content=[...(text?[{value:text}]:[]),...calls];if(!content.length)return;
    const bytes=Buffer.byteLength(JSON.stringify(output));if(bytes>this.maxBytes)return;
    const prefix=createHash('sha256');for(const block of historyBlocks(messages))appendVisibleBlock(prefix,block);
    const key=this.key(scope,prefix.digest('hex'),content),prev=this.entries.get(key);
    if(prev){this.bytes-=prev.bytes;this.entries.delete(key);}
    this.entries.set(key,{output,bytes,at:Date.now()});this.bytes+=bytes;
    for(const [key,entry] of this.entries){if(this.bytes<=this.maxBytes&&Date.now()-entry.at<this.ttl)break;this.entries.delete(key);this.bytes-=entry.bytes;}
  }
  get(scope,prefix,content){
    const e=this.entries.get(this.key(scope,prefix,content));
    return e&&Date.now()-e.at<this.ttl?e.output:undefined;
  }
}
function historyBlocks(messages){
  const blocks=[];
  for(const message of messages){
    const role=roleName(message.role),previous=blocks.at(-1);
    if(role==='assistant'&&previous?.role===role)previous.content.push(...message.content);
    else blocks.push({role,content:[...message.content]});
  }
  return blocks;
}
function visibleParts(content){
  const parts=[];
  for(const part of content){
    const kind=partKind(part);
    if(kind==='text'){
      const previous=parts.at(-1);
      if(previous?.[0]==='text')previous[1]+=part.value;else if(part.value)parts.push(['text',part.value]);
    }else if(kind==='call')parts.push(['call',part.callId,part.name,part.input]);
    else if(kind==='result')parts.push(['result',part.callId,visibleParts(part.content)]);
    else parts.push(['data',part.mimeType,sha256(part.data)]);
  }
  return parts;
}
function appendVisibleBlock(prefix,block){
  if(block.role!=='developer')prefix.update(JSON.stringify([block.role,visibleParts(block.content)])).update('\0');
}
function dataContent(part,imageAllowed){
  const mime=part.mimeType;
  if(!(part.data instanceof Uint8Array)||typeof mime!=='string')throw new BridgeError('Malformed data attachment.',{code:'unsupported_input'});
  if(part.data.byteLength>20*1024*1024)throw new BridgeError('A single attachment exceeds the local 20 MiB limit.',{code:'attachment_too_large'});
  if(IMAGE_TYPES.has(mime)){
    if(!imageAllowed)throw new BridgeError('The model catalog does not advertise image input. Select an image-capable model.',{code:'unsupported_image'});
    return{type:'input_image',image_url:`data:${mime};base64,${Buffer.from(part.data).toString('base64')}`,detail:'auto'};
  }
  if(mime.startsWith('text/')||mime==='application/json')return{type:'input_text',text:Buffer.from(part.data).toString('utf8')};
  // File upload and arbitrary data are deliberately not guessed or silently discarded.
  throw new BridgeError('Unsupported attachment type. This release accepts text, JSON and catalog-supported images.',{code:'unsupported_input'});
}
function roleName(role){if(role===1||role==='user')return'user';if(role===2||role==='assistant')return'assistant';if(role===3||role==='system'||role==='developer')return'developer';throw new BridgeError('Unknown VS Code message role.',{code:'unsupported_message'});}
function partKind(part){
  if(!object(part))throw new BridgeError('Unknown VS Code message part.',{code:'unsupported_input'});
  if(typeof part.callId==='string'&&typeof part.name==='string'&&object(part.input))return'call';
  if(typeof part.callId==='string'&&Array.isArray(part.content))return'result';
  if(part.data instanceof Uint8Array&&typeof part.mimeType==='string')return'data';
  if(typeof part.value==='string')return'text';
  // Stable APIs do not yet expose all proposed thinking/PromptTSX representations.
  throw new BridgeError('Unsupported VS Code message part. No context was silently removed; check diagnostics and host version.',{code:'unsupported_input'});
}
function convertMessages(messages,{cache,scope,imageAllowed=false}={}){
  const input=[],calls=new Set(),results=new Set(),prefix=createHash('sha256');
  for(const block of historyBlocks(messages)){
    const role=block.role,converted=[];let content=[];
    function flush(){if(content.length){converted.push({role,content:role==='assistant'?content.map(part=>part.text).join(''):content});content=[];}}
    for(const part of block.content){
      const kind=partKind(part);
      if(kind==='text')content.push({type:'input_text',text:part.value});
      else if(kind==='data'){
        if(role==='assistant')throw new BridgeError('Assistant binary history is not supported on this route.',{code:'unsupported_input'});
        content.push(dataContent(part,imageAllowed));
      }else if(kind==='call'){
        flush();if(role!=='assistant'||calls.has(part.callId))throw new BridgeError('Invalid or duplicate tool-call history.',{code:'invalid_tool_history'});
        calls.add(part.callId);
        converted.push({type:'function_call',call_id:part.callId,name:wireName(part.name),namespace:TOOL_NAMESPACE,arguments:JSON.stringify(part.input)});
      }else{
        flush();if(role!=='user'||!calls.has(part.callId)||results.has(part.callId))throw new BridgeError('Tool-result history has no unique preceding call. Start a new chat rather than sending broken context.',{code:'invalid_tool_history'});
        results.add(part.callId);
        const out=part.content.map(p=>{const k=partKind(p);if(k==='text')return{type:'input_text',text:p.value};if(k==='data')return dataContent(p,imageAllowed);throw new BridgeError('Nested tool-call results are not supported.',{code:'invalid_tool_history'});});
        const output=out.every(p=>p.type==='input_text')?out.map(p=>p.text).join('\n'):out;
        converted.push({type:'function_call_output',call_id:part.callId,output});
      }
    }
    flush();
    const saved=role==='assistant'?cache?.get(scope,prefix.copy().digest('hex'),block.content):undefined;
    // Restore the original ordered output, including phase and reasoning before
    // or after any visible message/call. Host-provided tool results stay below it.
    input.push(...(saved||converted));appendVisibleBlock(prefix,block);
  }
  for(const id of calls)if(!results.has(id))throw new BridgeError('A prior tool call has no result. Wait for the VS Code tool to finish.',{code:'invalid_tool_history'});
  return input;
}
/** Matches the Codex CLI heuristic: ceil(UTF-8 bytes / 4), plus message overhead.
 * Images have a separate estimate. This is not a model tokenizer. */
function estimateTokens(input){
  if(typeof input==='string')return Math.ceil(Buffer.byteLength(input,'utf8')/4);
  let n=16;
  for(const part of input.content||[]){
    const k=partKind(part);
    if(k==='text')n+=estimateTokens(part.value)+8;
    else if(k==='call')n+=estimateTokens(part.name+JSON.stringify(part.input))+24;
    else if(k==='result')n+=estimateTokens({content:part.content})+16;
    else n+=part.mimeType.startsWith('image/')?16384:Math.ceil(part.data.byteLength/4)+16;
  }
  return n;
}
module.exports={ResponseReplayCache,convertMessages,estimateTokens,roleName,partKind,dataContent};
