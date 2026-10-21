import test from 'node:test';
import assert from 'node:assert/strict';
import {createPluginSupervisor} from '../plugin-supervisor.mjs';
function fixture(runContainer) {
 const permissions={network:'none',persistentVolume:true,secretHandles:[],hostPaths:[],deviceAccess:false};
 const manifest={schema:'aru.selfhost.plugin-manifest.v1',pluginId:'synthetic',displayName:'Synthetic',version:'1',publisher:'Synthetic',source:'local',packageMode:'oci',image:'example/synthetic@sha256:'+'a'.repeat(64),protocols:[],permissions,resources:{memoryMiB:null,cpuMillis:null,pids:null}};
 const plugin={pluginId:'synthetic',manifest,grantedPermissions:permissions,desiredState:'enabled',rollback:null,events:[]};
 const state={plugins:[plugin],pluginDrafts:[]};
 const owner=createPluginSupervisor({state,containerRuntime:'synthetic',sourceRuntime:{},stopGraceSeconds:1,saveState:()=>{},log:()=>{},readJSONBody:async()=>{},sendJSON:()=>{},HttpError:class extends Error{constructor(status,code,message){super(message);this.code=code;}},runContainer});
 return {state,owner};
}
test('pending container control yields and conflicting mutation cannot delete its owner',async()=>{
 let release;let first=true;const f=fixture(async(_cmd,args)=>{if(args[0]==='stop'&&first){first=false;await new Promise(r=>release=r);}return {stdout:''};});
 const stopping=f.owner.disable('synthetic',{deviceId:'synthetic'});await new Promise(setImmediate);
 await assert.rejects(f.owner.uninstall('synthetic',true,{deviceId:'synthetic'}),e=>e.code==='plugin.busy');
 assert.equal(f.state.plugins.length,1);release();await stopping;assert.equal(f.state.plugins[0].desiredState,'disabled');
 await f.owner.uninstall('synthetic',true,{deviceId:'synthetic'});assert.equal(f.state.plugins.length,0);
});
test('unconfirmed stop retains installation and condition repair allows the same operation',async()=>{
 let broken=true;const f=fixture(async()=>{if(broken)throw Object.assign(new Error('engine unavailable'),{code:1});return {stdout:''};});
 await assert.rejects(f.owner.uninstall('synthetic',true,{deviceId:'synthetic'}),e=>e.code==='plugin.stop_unconfirmed');
 assert.equal(f.state.plugins.length,1);broken=false;await f.owner.uninstall('synthetic',true,{deviceId:'synthetic'});assert.equal(f.state.plugins.length,0);
});
test('failed data deletion is not reported as a completed uninstall',async()=>{
 const f=fixture(async(_cmd,args)=>{if(args[0]==='volume'&&args[1]==='rm')throw Object.assign(new Error('busy volume'),{code:1});return {stdout:''};});
 await assert.rejects(f.owner.uninstall('synthetic',true,{deviceId:'synthetic'}),e=>e.code==='plugin.volume_delete_failed');assert.equal(f.state.plugins.length,1);
});
