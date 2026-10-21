import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
for (const [file,name,command] of [['install-macos.sh','start_instance','launchctl'],['install-linux-desktop.sh','start_service','systemctl']]) {
 test(`${file}: service registration failure cannot be hidden by a responding old process`,()=>{
  const source=readFileSync(new URL('../'+file,import.meta.url),'utf8');
  const body=source.slice(source.indexOf(name+'() {')).split('\n}\n')[0]+'\n}';
  const script=`${command}(){ return 1; }\ncurl(){ return 0; }\nlaunch_domain(){ echo synthetic; }\n${body}\nif ${name}; then exit 91; fi`;
  const result=spawnSync('/bin/bash',['-c',script],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
 });
}
