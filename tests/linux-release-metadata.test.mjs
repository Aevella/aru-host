import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('Linux release payload retains the requested enclosing release identity', t => {
  const root=mkdtempSync(join(tmpdir(),'aru-linux-release-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const script=fileURLToPath(new URL('../package-release.sh',import.meta.url));
  const archive=join(root,'host.tar.gz');
  const packaged=spawnSync('bash',[script,archive],{env:{...process.env,ARU_RELEASE_VERSION:'0.34.0'},encoding:'utf8'});
  assert.equal(packaged.status,0,packaged.stderr);
  const metadata=spawnSync('tar',['-xOf',archive,'release.json'],{encoding:'utf8'});
  assert.equal(metadata.status,0,metadata.stderr);
  assert.deepEqual(JSON.parse(metadata.stdout),{schema:'aru.host.release.v1',version:'0.34.0'});
});
