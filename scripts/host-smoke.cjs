'use strict';
// Optional real Extension Host validation. Never downloads VS Code or logs in.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
const executable=process.env.VSCODE_EXECUTABLE;
if(!executable||!fs.existsSync(executable)){console.error('NOT RUN: set VSCODE_EXECUTABLE to a local VS Code desktop executable. A real VS Code host is required; API mocks are not a substitute.');process.exit(2);}
const root=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-real-host-'));fs.mkdirSync(path.join(temp,'workspace'));
const args=['--no-sandbox','--disable-gpu','--skip-welcome','--skip-release-notes','--disable-updates','--disable-workspace-trust',`--user-data-dir=${path.join(temp,'user')}`,`--extensions-dir=${path.join(temp,'extensions')}`,`--extensionDevelopmentPath=${root}`,`--extensionTestsPath=${path.join(root,'test','host','index.cjs')}`,path.join(temp,'workspace')];
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const child=cp.spawn(executable,args,{stdio:'inherit',env});const timeout=setTimeout(()=>{console.error('Real host test timed out.');child.kill();},120000);timeout.unref();
child.on('error',e=>{console.error(e.message);fs.rmSync(temp,{recursive:true,force:true});process.exitCode=1;clearTimeout(timeout);});
child.on('exit',code=>{clearTimeout(timeout);fs.rmSync(temp,{recursive:true,force:true});process.exitCode=code??1;});
