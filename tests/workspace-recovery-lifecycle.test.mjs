import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createWorkspaceJobs} from '../src/server/workspace-jobs.mjs';
test('unconfirmed stale container fails only its job; a sibling can recover',async()=>{
 const root=mkdtempSync(join(tmpdir(),'job-recovery-'));const runtime=join(root,'engine');
 writeFileSync(runtime,'#!/bin/sh\ncase "$*" in *blocked*) exit 1;; esac\nexit 0\n',{mode:0o700});
 const state={jobs:[{jobId:'blocked',state:'running',events:[]},{jobId:'sibling',state:'running',events:[]}]};let saved=0;
 const owner=createWorkspaceJobs({config:{containerRuntime:runtime},state,saveState:()=>saved++,log:()=>{}});
 try{assert.deepEqual(await owner.recoverInterruptedJobs(),['sibling']);assert.equal(state.jobs[0].state,'failed');assert.equal(state.jobs[0].failureCode,'workspace.recovery_cleanup_failed');assert.equal(saved,1);}
 finally{rmSync(root,{recursive:true,force:true});}
});
