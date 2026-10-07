'use strict';
const {VENDOR}=require('../constants');
const DEFAULT_SUBAGENT_PROMPT=require('../../package.json').contributes.configuration.properties['chatgptDirect.subagentDeveloperPrompt'].default;
function modelSelector(model){return `${model.name} (${VENDOR})`;}
/** Select only real catalog entries, in the account's preferred order. */
function subagentPolicy(models,parent,template=DEFAULT_SUBAGENT_PROMPT){
  const routes=[['Haiku','luna'],['Sonnet','sol'],['Opus','astra']].map(([claude,family])=>{
    const target=models.find(model=>model.capabilities.toolCalling&&new RegExp(`(?:^|[-\\s])${family}(?:$|[-\\s])`,'i').test(`${model.id} ${model.name}`))||parent;
    return `${claude} -> ${JSON.stringify(modelSelector(target))}`;
  });
  const values={modelRoutes:routes.join('\n'),parentModel:JSON.stringify(modelSelector(parent))};
  return template.replace(/\{\{(modelRoutes|parentModel)\}\}/g,(_match,key)=>values[key]);
}
function hasSubagentTool(tools){return tools.some(tool=>tool.name==='runSubagent'||tool.name.endsWith('/runSubagent'));}
module.exports={subagentPolicy,hasSubagentTool,DEFAULT_SUBAGENT_PROMPT};
