'use strict';
// Dependency-free syntax, manifest and runtime-boundary validation.
const fs=require('node:fs');const path=require('node:path');const cp=require('node:child_process');const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
function walk(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)]);}
const source=walk(path.join(root,'src')),scripts=walk(path.join(root,'scripts')),tests=walk(path.join(root,'test'));
const files=[...source,...scripts,...tests].filter(f=>/\.(?:js|cjs)$/.test(f));
for(const file of files){const r=cp.spawnSync(process.execPath,['--check',file],{encoding:'utf8'});if(r.status!==0)throw new Error(`${path.relative(root,file)} syntax failed\n${r.stderr}`);}
const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')),C=require('../src/constants');
assert.equal(pkg.version,C.VERSION);assert.equal(pkg.contributes.languageModelChatProviders[0].vendor,C.VENDOR);assert.equal(pkg.contributes.authentication[0].id,C.AUTH_PROVIDER);
assert.ok(fs.existsSync(path.resolve(root,pkg.main)));assert.equal(Object.keys(pkg.dependencies||{}).length,0);assert.equal(pkg.enabledApiProposals,undefined);assert.equal(pkg.browser,undefined);
assert.ok(pkg.extensionKind.includes('ui'));assert.equal(pkg.capabilities.untrustedWorkspaces.supported,false);
const patterns=[[/chatgpt\.com\/backend-api/i,'private ChatGPT backend'],[/\.codex[\\/]|auth\.json/i,'external credential import'],[/require\(['"](?:node:)?child_process['"]\)/,'runtime child process'],[/registerChatParticipant|createChatParticipant/,'custom chat participant'],[/\.invokeTool\s*\(/,'provider-owned tool execution'],[/NODE_TLS_REJECT_UNAUTHORIZED|rejectUnauthorized\s*:\s*false/,'disabled TLS verification'],[/process\.env\.(?:OPENAI_API_KEY|CODEX_API_KEY)/,'API-key fallback']];
for(const f of source){const text=fs.readFileSync(f,'utf8');for(const[pattern,label]of patterns)assert.equal(pattern.test(text),false,`${path.relative(root,f)} contains ${label}`);for(const match of text.matchAll(/require\(['"]([^'"]+)['"]\)/g)){const name=match[1];if(name.startsWith('.'))assert.ok(fs.existsSync(path.resolve(path.dirname(f),name+'.js'))||fs.existsSync(path.resolve(path.dirname(f),name)),`Missing runtime module ${name}`);else assert.ok(name==='vscode'||name.startsWith('node:'),`Unexpected external dependency ${name}`);}}
for(const f of ['README.md','PRIVACY.md','SECURITY.md','CHANGELOG.md'])assert.ok(fs.existsSync(path.join(root,f)),`Missing ${f}`);
console.log(`PASS: ${files.length} JavaScript files parse; manifest, module graph, pinned-route and passive-provider checks passed.`);
