'use strict';
// Explicit file discovery keeps npm test portable to Windows (no shell globbing).
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..');const files=fs.readdirSync(path.join(root,'test')).filter(f=>f.endsWith('.test.cjs')).sort().map(f=>path.join(root,'test',f));
const args=['--test',...(process.argv.includes('--coverage')?['--experimental-test-coverage']:[]),...files];
const r=cp.spawnSync(process.execPath,args,{cwd:root,stdio:'inherit'});if(r.error){console.error(r.error.message);process.exit(1);}process.exit(r.status??1);
