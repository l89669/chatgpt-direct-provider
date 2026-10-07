'use strict';
const {object,positive,BridgeError}=require('../util');
const {estimateTokens}=require('../protocol/history');
const {subagentPolicy}=require('../protocol/subagent-policy');
function normalizeCatalog(json,config={},report=()=>{},snapshot=[]){
  if(!object(json)||!Array.isArray(json.models))throw new BridgeError('Expected the SIWC account-specific {models:[...]} catalog, not an API-key model list.',{code:'invalid_model_catalog'});
  const seen=new Set(),models=[],entries=[];
  const liveIds=new Set(json.models.map(model=>model?.slug));
  const supplements=snapshot.filter(model=>model.visibility==='list'&&!liveIds.has(model.slug));
  for(const raw of [...json.models,...supplements]){
    const source=liveIds.has(raw?.slug)?'live':'snapshot';
    const slug=raw?.slug;
    const reason=!object(raw)?'invalid_entry':raw.visibility!=='list'?'visibility_not_list':typeof slug!=='string'||!slug||slug.length>256?'invalid_slug':seen.has(slug)?'duplicate_slug':'included';
    entries.push({source,slug:typeof slug==='string'?slug:null,displayName:typeof raw?.display_name==='string'?raw.display_name:null,visibility:typeof raw?.visibility==='string'?raw.visibility:null,supportedInApi:typeof raw?.supported_in_api==='boolean'?raw.supported_in_api:null,reason});
    if(reason!=='included')continue;
    seen.add(slug);
    const knownContext=positive(raw.context_window,positive(raw.context_length,0));
    const context=knownContext||positive(config.contextWindowFallback,65536);
    const knownOutput=positive(raw.max_output_tokens,0);
    const reserve=Math.min(knownOutput||positive(config.outputReserveFallback,8192),Math.floor(context/2));
    const maxInput=Math.min(positive(raw.max_input_tokens,context-reserve),context-reserve);
    const levels=raw.supported_reasoning_levels||raw.supported_reasoning_efforts||[];
    const efforts=Array.isArray(levels)?[...new Set(levels.map(x=>typeof x==='string'?x:x?.effort).filter(x=>typeof x==='string'&&/^[a-z][a-z0-9_-]{0,31}$/.test(x)))]:[];
    const modalities=Array.isArray(raw.input_modalities)?raw.input_modalities:[];
    models.push({id:slug,name:(typeof raw.display_name==='string'&&raw.display_name)||slug,
      family:typeof raw.family==='string'?raw.family:slug,version:typeof raw.version==='string'?raw.version:slug,
      maxInputTokens:maxInput,maxOutputTokens:reserve,
      capabilities:{imageInput:modalities.includes('image')||raw.capabilities?.imageInput===true,toolCalling:raw.supports_tool_calling!==false&&raw.capabilities?.toolCalling!==false},
      catalogSource:source,detail:source==='snapshot'?'ChatGPT plan · Codex catalog snapshot':'ChatGPT plan · Public SIWC API',tooltip:source==='snapshot'?'From bundled Codex catalog snapshot. Availability through the public SIWC inference endpoint is determined by the server.':'Direct Plan Bridge (unofficial). Model capacity uses conservative fallbacks when missing from the catalog.',
      efforts,defaultEffort:raw.default_reasoning_level||raw.default_reasoning_effort,limitsEstimated:!knownContext||!knownOutput});
  }
  report({receivedCount:json.models.length,snapshotAddedCount:supplements.length,includedCount:models.length,entries});
  if(!models.length)throw new BridgeError('The selected ChatGPT account returned no visible models.',{code:'no_visible_models'});
  return models;
}
function modelInfo(model,models=[model],config={}){
  const{id,name,family,version,maxInputTokens,maxOutputTokens,capabilities,detail,tooltip}=model;
  const prompt=subagentPolicy(models,model,config.subagentDeveloperPrompt);
  const promptTokens=prompt?estimateTokens({content:[{value:prompt}]}):0;
  const info={id,name,family,version,maxInputTokens:maxInputTokens-promptTokens,maxOutputTokens,capabilities,detail,tooltip};
  if(model.efforts.length)info.configurationSchema={properties:{reasoningEffort:{type:'string',title:'Thinking Effort',group:'navigation',enum:['provider-default','model-default',...model.efforts],enumItemLabels:['Extension default','Model default',...model.efforts.map(effort=>effort==='xhigh'?'Extra high':effort[0].toUpperCase()+effort.slice(1))],default:'provider-default'}}};
  return info;
}
module.exports={normalizeCatalog,modelInfo};
