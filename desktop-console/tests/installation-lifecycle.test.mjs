import test from 'node:test';
import assert from 'node:assert/strict';
import { createInstallationLifecycle } from '../src/installation-lifecycle.mjs';
import { createWindowsPlatform } from '../src/platform/windows.mjs';
function fixture() {
  const calls = []; let installed = false; let denied = true;
  const manifest = {serverId:'synthetic', releaseVersion:'0.37.0'};
  const platform = {
    hostInstalled: async()=>installed,
    runInstaller: async()=>{calls.push('install'); if(denied) throw new Error('registration denied'); installed=true;},
    validateState: async()=>calls.push('validate'), startService:async()=>calls.push('start'),
    restartService:async()=>calls.push('restart'),
  };
  const args = {platform, consoleVersion:'0.37.0', hostCoreRoot:'synthetic',
    readRelease:async()=>({schema:'aru.host.release.v1',version:'0.37.0'}),
    readInstalled:async()=>'ARU_INSTALL_RELEASE_VERSION=0.37.0',
    readManifest:async()=>manifest, verify:async(read,options)=>{assert.equal(options.serverId,'synthetic');return read();}};
  return {args,calls,repair:()=>{denied=false;},installed:()=>{installed=true;}};
}
test('same-version partial installation fails, then normal restart repairs without losing identity',async()=>{
  const f=fixture(), owner=createInstallationLifecycle(f.args);
  await assert.rejects(owner.ensure(),/registration denied/);
  f.repair(); assert.equal((await owner.ensure({restart:true})).serverId,'synthetic');
  assert.deepEqual(f.calls,['install','install']);
  await owner.ensure({restart:true});assert.deepEqual(f.calls.slice(-2),['validate','restart']);
});
test('concurrent entries share activation, failure releases the next attempt',async()=>{
  const f=fixture();let reject;f.args.platform.runInstaller=()=>{f.calls.push('install');return new Promise((_,r)=>reject=r);};
  const owner=createInstallationLifecycle(f.args);const a=owner.ensure(), b=owner.ensure();assert.equal(a,b);
  await new Promise(setImmediate);reject(new Error('failed'));await assert.rejects(a,/failed/);
  f.args.platform.runInstaller=async()=>f.calls.push('repaired');await owner.ensure();
  assert.deepEqual(f.calls,['install','repaired']);
});
test('unreadable installation and wrong Host identity cannot authorize repair',async()=>{
  const f=fixture();f.args.readInstalled=async()=>{throw Object.assign(new Error('unreadable'),{code:'EACCES'});};
  await assert.rejects(createInstallationLifecycle(f.args).ensure(),/unreadable/);assert.deepEqual(f.calls,[]);
  const g=fixture();g.installed();g.args.verify=async()=>{throw Object.assign(new Error('identity'),{code:'host_identity_changed'});};
  await assert.rejects(createInstallationLifecycle(g.args).ensure(),/identity/);assert.deepEqual(g.calls,['validate','start']);
});
test('Windows service presence is independently checked and inspection errors are not absence',async()=>{
  let result='missing';const platform=createWindowsPlatform({homeDir:'/fixture',env:{},serviceName:'synthetic',credentialAccount:'home',fileExists:()=>true,
    execFile:async()=>{if(result==='denied')throw new Error('denied');return {stdout:result};}});
  assert.equal(await platform.hostInstalled(),false);result='ready';assert.equal(await platform.hostInstalled(),true);
  result='denied';await assert.rejects(platform.hostInstalled(),/denied/);
});
