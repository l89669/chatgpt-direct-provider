'use strict';
const C=require('../constants');
const {checkedJson,readJson,assertAllowedUrl}=require('./http');
const {normalizeCatalog}=require('./models');
const catalogSnapshot=require('./catalog-snapshot.json');
const {inspectResponseFormat,consumeResponse}=require('../protocol/sse');
const {buildTools,parseCall}=require('../protocol/tools');
const {convertMessages}=require('../protocol/history');
const {subagentPolicy,hasSubagentTool}=require('../protocol/subagent-policy');
const {BridgeError,remoteError,checkAbort,delay,positive,safeCode,shape}=require('../util');
function buildRequest(model,messages,options,{cache,scope,config={},models=[model]}){
  const supplied=options.tools||[];
  const required=options.toolMode===2;
  if(required&&!supplied.length)throw new BridgeError('VS Code required a tool call but supplied no tools.',{code:'tool_mode_mismatch'});
  if(supplied.length&&!model.capabilities.toolCalling)throw new BridgeError('Selected model does not support agent tools.',{code:'unsupported_tools'});
  const {tools,mapping}=buildTools(supplied);
  const body={model:model.id,input:convertMessages(messages,{cache,scope,imageAllowed:model.capabilities.imageInput}),store:false,stream:true,include:['reasoning.encrypted_content']};
  if(hasSubagentTool(supplied)){
    const text=subagentPolicy(models,model,config.subagentDeveloperPrompt);
    if(text){
      const lastDeveloper=body.input.findLastIndex(item=>item.role==='developer');
      body.input.splice(lastDeveloper+1,0,{role:'developer',content:[{type:'input_text',text}]});
    }
  }
  if(tools.length){body.tools=tools;body.tool_choice=required?'required':'auto';}
  const explicit=options.modelOptions?.reasoningEffort??options.modelOptions?.reasoning_effort;
  const selected=options.modelConfiguration?.reasoningEffort;
  const useGlobal=selected===undefined||selected==='provider-default';
  const effort=explicit??(useGlobal?config.reasoningEffort??'model-default':selected);
  const effortSource=explicit!==undefined?'request':useGlobal?'extension-default':'model-configuration';
  if(effort!=='model-default'){
    if(typeof effort!=='string'||!model.efforts.includes(effort))throw new BridgeError(`Requested reasoning effort is not advertised by the selected model. Use model-default or Configure Reasoning Effort.`,{code:'unsupported_reasoning_effort'});
    body.reasoning={effort};
  }
  return{body,serialized:serializeRequest(body,config),mapping,required,reasoningEffort:effort,reasoningEffortSource:effortSource};
}
function serializeRequest(body,config={}){
  const serialized=JSON.stringify(body);
  if(Buffer.byteLength(serialized)>positive(config.maxRequestMiB,32)*1024*1024)throw new BridgeError('Request exceeds the configured local size limit. Reduce attachments/context or adjust maxRequestMiB.',{code:'request_too_large'});
  return serialized;
}
function numericUsage(usage){
  if(!usage)return null;
  const out={};for(const key of ['input_tokens','output_tokens','total_tokens'])if(Number.isFinite(usage[key]))out[key]=usage[key];
  if(Number.isFinite(usage.input_tokens_details?.cached_tokens))out.cached_tokens=usage.input_tokens_details.cached_tokens;
  if(Number.isFinite(usage.output_tokens_details?.reasoning_tokens))out.reasoning_tokens=usage.output_tokens_details.reasoning_tokens;
  return out;
}
function addUsage(total,current){
  const counts=numericUsage(current);if(!counts)return total;
  const sum={...total};for(const [key,value] of Object.entries(counts))sum[key]=(sum[key]||0)+value;
  return sum;
}
function continuationReason(result,calls){
  if(calls.length)return undefined;
  if(result.endTurn===false)return'end_turn_false';
  if(result.endTurn===true)return undefined;
  const messages=result.output.filter(item=>item.type==='message');
  if(messages.length&&messages.every(item=>item.phase==='commentary'||item.phase==='partial_answer'))return'intermediate_phase';
}
class OpenAIClient {
  #diagnostics;
  constructor(transport,diagnostics=()=>{}){this.transport=transport;this.#diagnostics=diagnostics;this.paused=new Set();this.last=null;this.lastCatalog=null;}
  #record(value){this.last={at:new Date().toISOString(),...value};this.#diagnostics(this.last);}
  #catalog(value){this.lastCatalog={at:new Date().toISOString(),event:'model_catalog',extension:C.VERSION,...value};this.#diagnostics(this.lastCatalog);}
  async models(accessToken,config,signal){
    for(let attempt=0;;attempt++){
      try{
        this.#catalog({stage:'request',url:C.MODELS_URL,attempt:attempt+1});
        const transport=async(url,options)=>{
          const response=await this.transport(url,options);
          this.#catalog({stage:'http_response',httpStatus:response.status,contentType:response.headers.get('content-type'),requestId:safeCode(response.headers.get('x-request-id'))});
          return response;
        };
        const json=await checkedJson(transport,C.MODELS_URL,{headers:{Authorization:`Bearer ${accessToken}`},signal});
        return normalizeCatalog(json,config,summary=>this.#catalog({stage:'normalized',snapshotFetchedAt:catalogSnapshot.fetched_at,...summary}),catalogSnapshot.models);
      }
      catch(e){this.#catalog({stage:'failed',...(e instanceof BridgeError?e.diagnostic():{code:'transport_failure'})});if(attempt>=1||!(e.status>=500)||signal?.aborted)throw e;await delay(400,undefined,{signal});}
    }
  }
  resume(accountId){this.paused.delete(accountId);}
  async infer(lease,model,messages,options,{signal,config,cache,scope,models=[model],onText}){
    if(this.paused.has(lease.accountId))throw new BridgeError('ChatGPT plan requests are paused after a usage-limit response. Review ChatGPT Usage, then use Manage Accounts → Resume Requests.',{code:'usage_paused'});
    checkAbort(signal);
    const request=buildRequest(model,messages,options,{cache,scope,config,models});
    assertAllowedUrl(C.RESPONSES_URL);
    const output=[];let response,responseInfo,serialized=request.serialized,usage=null,modelSamples=0;
    try{
      for(;;){
        checkAbort(signal);response=undefined;responseInfo=undefined;
        for(let attempt=0;;attempt++){
          response=await this.transport(C.RESPONSES_URL,{method:'POST',headers:{Authorization:`Bearer ${lease.accessToken}`,'Content-Type':'application/json',Accept:'text/event-stream'},body:serialized,signal});
          if(response.status>=200&&response.status<300)break;
          let body;try{body=await readJson(response);}catch{body={non_json:true};}
          const error=remoteError(response.status,body,response.headers.get('x-request-id'));
          // Only a rejected 503 is retried. A continuation below is a new sample
          // with completed output appended, rather than a replay of the POST.
          if(attempt<1&&response.status===503){await delay(500,undefined,{signal});continue;}
          throw error;
        }
        responseInfo={httpStatus:response.status,contentType:(response.headers.get('content-type')||'missing').split(';')[0].trim().toLowerCase(),contentEncoding:response.headers.get('content-encoding')||'identity',requestId:safeCode(response.headers.get('x-request-id'))};
        response=await inspectResponseFormat(response,signal);responseInfo.wireFormat=response.format;
        if(response.format!=='sse'){
          const body=response.format==='json'?await readJson(response):null;
          if(body?.error)throw remoteError(response.status,body,response.headers.get('x-request-id'));
          const state=safeCode(body?.status),objectType=safeCode(body?.object);
          throw new BridgeError(`OpenAI returned a non-SSE response [HTTP ${response.status}; Content-Type: ${responseInfo.contentType}; body: ${response.format}${objectType?`; object: ${objectType}`:''}${state?`; status: ${state}`:''}${responseInfo.contentEncoding!=='identity'?`; encoding: ${responseInfo.contentEncoding}`:''}].`,{code:'unexpected_content_type',status:response.status,requestId:responseInfo.requestId,bodyShape:shape(body)});
        }
        const result=await consumeResponse(response,{signal,onText,remoteError});
        const calls=result.output.filter(item=>item.type==='function_call').map(item=>parseCall(item,request.mapping));
        const ids=new Set();for(const call of calls){if(ids.has(call.callId))throw new BridgeError('Duplicate tool call ID in a completed response.',{code:'invalid_tool_call'});ids.add(call.callId);}
        output.push(...result.output);usage=addUsage(usage,result.usage);modelSamples++;
        const reason=continuationReason(result,calls);
        const state={...responseInfo,model:model.id,reasoningEffort:request.reasoningEffort,reasoningEffortSource:request.reasoningEffortSource,modelSamples,responseId:safeCode(result.responseId),endTurn:result.endTurn,messagePhases:result.output.filter(item=>item.type==='message').map(item=>safeCode(item.phase)||'unspecified'),toolCalls:calls.length,usage};
        if(reason){
          this.#record({...state,status:'continuing',continuationReason:reason});
          serialized=serializeRequest({...request.body,input:[...request.body.input,...output]},config);
          continue;
        }
        if(request.required&&!calls.length)throw new BridgeError('The model completed without the required tool call.',{code:'tool_mode_mismatch'});
        // The host sees one assistant block even when the model needed several
        // samples. Replay that block as its complete ordered Responses output.
        cache.remember(scope,messages,output,request.mapping);
        this.#record({...state,status:'completed',completionKind:calls.length?'tool_calls':'turn_end'});
        return{calls,usage};
      }
    }catch(e){
      if(e.code==='subscription_sharing_usage_limit_exceeded')this.paused.add(lease.accountId);
      const inputIndex=/^input\[(\d+)\]/.exec(e.param||'')?.[1];
      const rejected=inputIndex===undefined?undefined:JSON.parse(serialized).input[Number(inputIndex)];
      const rejectedInput=rejected?{index:Number(inputIndex),role:rejected.role,type:rejected.type,contentType:typeof rejected.content,partTypes:Array.isArray(rejected.content)?rejected.content.map(part=>part.type):undefined}:undefined;
      this.#record({...(e instanceof BridgeError?e.diagnostic():{code:'transport_failure'}),...responseInfo,model:model.id,reasoningEffort:request.reasoningEffort,reasoningEffortSource:request.reasoningEffortSource,rejectedInput,modelSamples,usage,status:signal?.aborted?'cancelled':'failed',httpStatus:response?.status??e.status,requestId:responseInfo?.requestId||e.requestId});
      throw e;
    }finally{response?.cancel?.();}
  }
}
module.exports={OpenAIClient,buildRequest,numericUsage};
