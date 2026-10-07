'use strict';
const {StringDecoder}=require('node:string_decoder');
const {BridgeError,checkAbort,object}=require('../util');
/** Headers describe the wire format; the body can confirm an SSE stream even
 * when an intermediary returns a different content type. Keep inspected bytes
 * so the normal parser still validates every event and completion. */
async function inspectResponseFormat(response,signal){
  const type=(response.headers.get('content-type')||'').toLowerCase();
  if(type.includes('text/event-stream'))return{...response,format:'sse',cancel:()=>response.cancel?.()};
  const iterator=response.body[Symbol.asyncIterator](),chunks=[],decoder=new StringDecoder('utf8');
  const fields=['data:','event:','id:','retry:'];let prefix='',bytes=0,format='other';
  while(bytes<4096){
    checkAbort(signal);const next=await iterator.next();if(next.done)break;
    const chunk=Buffer.from(next.value);chunks.push(chunk);bytes+=chunk.length;prefix+=decoder.write(chunk);
    const start=prefix.trimStart();
    if(start.startsWith(':')||fields.some(field=>start.startsWith(field))){format='sse';break;}
    if(start.startsWith('{')||start.startsWith('[')){format='json';break;}
    if(start&&!fields.some(field=>field.startsWith(start)))break;
  }
  const body=(async function*(){
    yield*chunks;
    for(;;){checkAbort(signal);const next=await iterator.next();if(next.done)return;yield next.value;}
  })();
  return{...response,format,body,cancel:()=>response.cancel?.()};
}
/** Incremental SSE parser. Supports UTF-8/chunk splits, CR, LF, CRLF,
 * comments and multi-line data without assuming one JSON event per TCP chunk. */
async function* parseSSE(body,signal,maxFrame=16*1024*1024){
  const decoder=new StringDecoder('utf8');let buffer='',lines=[],event='',frameBytes=0;
  function parseLine(line){
    if(!line){
      const data=lines.join('\n');const name=event;lines=[];event='';frameBytes=0;
      return data?{event:name,data}:null;
    }
    if(line.startsWith(':'))return null;
    const i=line.indexOf(':');const field=i<0?line:line.slice(0,i);let value=i<0?'':line.slice(i+1);if(value.startsWith(' '))value=value.slice(1);
    if(field==='data'){frameBytes+=Buffer.byteLength(value);if(frameBytes>maxFrame)throw new BridgeError('SSE frame exceeds the local bound.',{code:'stream_too_large'});lines.push(value);}else if(field==='event')event=value;
    return null;
  }
  function* drain(final){
    for(;;){const m=/[\r\n]/.exec(buffer);if(!m)break;const i=m.index;if(buffer[i]==='\r'&&i===buffer.length-1&&!final)break;
      const line=buffer.slice(0,i);const count=buffer[i]==='\r'&&buffer[i+1]==='\n'?2:1;buffer=buffer.slice(i+count);const item=parseLine(line);if(item)yield item;}
    if(Buffer.byteLength(buffer)>maxFrame)throw new BridgeError('SSE line exceeds the local bound.',{code:'stream_too_large'});
  }
  for await(const chunk of body){checkAbort(signal);buffer+=decoder.write(Buffer.from(chunk));yield* drain(false);}
  buffer+=decoder.end();yield* drain(true);
  // The caller rejects EOF without response.completed; unfinished frames are not invented.
}
async function consumeResponse(response,{signal,onText,onSummary,remoteError}){
  const items=new Map(),textLengths=new Map();let completed=false,output=[],usage=null,responseId,endTurn;
  const keyFor=(id,index)=>`${id??''}:${index??0}`;
  function acceptItem(item,index){
    if(!object(item)||typeof item.type!=='string')throw new BridgeError('Malformed Responses output item.',{code:'invalid_stream'});
    items.set(index,item);
    if(item.type==='message')for(const [i,c] of (item.content||[]).entries()){
      const text=c.type==='output_text'?c.text:c.type==='refusal'?c.refusal:null;
      if(typeof text==='string'){
        const key=keyFor(item.id,i);const seen=textLengths.get(key)||0;
        if(text.length>seen)onText(text.slice(seen));textLengths.set(key,text.length);
      }
    }
  }
  try{
    for await(const frame of parseSSE(response.body,signal)){
      checkAbort(signal);if(frame.data==='[DONE]')continue;
      let e;try{e=JSON.parse(frame.data);}catch{throw new BridgeError('Malformed JSON inside the OpenAI event stream.',{code:'invalid_stream'});}
      if(!object(e))throw new BridgeError('Invalid Responses event.',{code:'invalid_stream'});
      if(e.type==='response.output_text.delta'||e.type==='response.refusal.delta'){
        if(typeof e.delta!=='string')throw new BridgeError('Invalid text delta.',{code:'invalid_stream'});
        onText(e.delta);const key=keyFor(e.item_id,e.content_index);textLengths.set(key,(textLengths.get(key)||0)+e.delta.length);
      }else if(e.type==='response.reasoning_summary_text.delta'){if(typeof e.delta==='string')onSummary?.(e.delta);}
      else if(e.type==='response.output_item.done')acceptItem(e.item,e.output_index??items.size);
      else if(e.type==='response.failed'||e.type==='error'){
        const body=e.type==='response.failed'?{error:e.response?.error}:(e.error?e:{error:e});
        throw remoteError(response.status,body,response.headers.get('x-request-id'));
      }else if(e.type==='response.incomplete')throw new BridgeError('OpenAI returned response.incomplete. No staged tool calls were emitted.',{code:'response_incomplete',requestId:response.headers.get('x-request-id')});
      else if(e.type==='response.completed'){
        if(e.response?.status && e.response.status!=='completed')throw new BridgeError('Inconsistent completion status.',{code:'invalid_stream'});
        if(Array.isArray(e.response?.output))e.response.output.forEach((item,i)=>acceptItem(item,i));
        output=[...items].sort((a,b)=>a[0]-b[0]).map(x=>x[1]);
        usage=e.response?.usage??null;responseId=e.response?.id;endTurn=typeof e.response?.end_turn==='boolean'?e.response.end_turn:undefined;completed=true;break;
      }
    }
  }finally{response.cancel?.();}
  checkAbort(signal);
  if(!completed)throw new BridgeError('OpenAI stream ended without response.completed. No staged tool calls were emitted.',{code:'stream_interrupted'});
  // Hosted tool execution was never advertised. A backend must not introduce it.
  if(output.some(item=>!['message','reasoning','function_call'].includes(item.type)))throw new BridgeError('OpenAI returned an unsupported output/execution item.',{code:'unsupported_output'});
  return{output,usage,responseId,endTurn};
}
module.exports={inspectResponseFormat,parseSSE,consumeResponse};
