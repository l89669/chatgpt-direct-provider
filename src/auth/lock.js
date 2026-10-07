'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { BridgeError, checkAbort, delay } = require('../util');
/** Cross-process mkdir mutex, not just an in-memory refresh promise. Never steal
 * a live owner's lock. A crashed process can be recovered without a token race. */
async function withFileLock(directory, fn, signal, timeoutMs = 90000) {
  await fs.mkdir(path.dirname(directory), {recursive:true, mode:0o700});
  const owner = {pid:process.pid, nonce:randomUUID()}; const started = Date.now();
  for (;;) {
    checkAbort(signal);
    try {
      await fs.mkdir(directory, {mode:0o700});
      try { await fs.writeFile(path.join(directory,'owner.json'), JSON.stringify(owner), {flag:'wx', mode:0o600}); }
      catch(e) { await fs.rm(directory,{recursive:true,force:true}); throw e; }
      break;
    } catch (e) {
      if(e.code !== 'EEXIST') throw e;
      // Only one reaper may inspect/remove a crashed owner's lock. Re-read
      // under this guard; otherwise two waiters could remove a new live lock.
      const recovery=directory+'.recovery';let ownsRecovery=false;
      try {
        await fs.mkdir(recovery,{mode:0o700});ownsRecovery=true;
        const raw=await fs.readFile(path.join(directory,'owner.json'),'utf8');
        const p=JSON.parse(raw);
        if(Number.isInteger(p.pid)&&p.pid>0){
          let dead=false;try{process.kill(p.pid,0);}catch(k){dead=k.code==='ESRCH';}
          if(dead)await fs.rm(directory,{recursive:true,force:true});
        }
      } catch(readError) {
        // Missing owner can be a lock creator between mkdir and writeFile.
        // An unreadable/corrupt recovery lock fails closed rather than stealing.
      } finally {if(ownsRecovery)await fs.rm(recovery,{recursive:true,force:true});}
      if (Date.now()-started > timeoutMs) throw new BridgeError('Another VS Code window is updating ChatGPT credentials. Retry after that operation completes.',{code:'credential_lock_timeout'});
      await delay(60 + Math.random()*60, undefined, {signal});
    }
  }
  try { return await fn(); }
  finally {
    try {
      const current = JSON.parse(await fs.readFile(path.join(directory,'owner.json'),'utf8'));
      if(current.nonce === owner.nonce) await fs.rm(directory,{recursive:true,force:true});
    } catch { /* A stale lock is recovered using the recorded owner PID. */ }
  }
}
module.exports = { withFileLock };
