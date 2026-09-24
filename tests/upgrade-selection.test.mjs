import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const control = fileURLToPath(new URL('../aru-selfhostctl', import.meta.url));
for (const explicit of [false, true]) test(`upgrade resolves target independently of old ref and bundle (explicit=${explicit})`, () => {
  const root = mkdtempSync(join(tmpdir(), 'aru-upgrade-selection-'));
  try {
    writeFileSync(join(root, 'install.env'), 'ARU_INSTALL_SOURCE_REF=v0.31.4\nARU_INSTALL_BUNDLE_URL=https://example.test/old.tar.gz\nARU_INSTALL_BASE_URL=http://100.64.0.1:8787\nARU_INSTALL_TRANSPORT_KIND=tailscale\n');
    const script = `source "$CONTROL"
need_root() { :; }
curl() {
  if [[ "$*" == *api.github.com* ]]; then printf '{"tag_name":"v0.40.0","draft":false,"prerelease":false}'; return; fi
  printf '%s\\n' "$*" >> "$TRANSCRIPT"
  local previous="" destination="" value
  for value in "$@"; do [[ "$previous" != -o ]] || destination="$value"; previous="$value"; done
  printf '#!/bin/bash\\nprintf "%%s\\\\n" "$@" >> "$TRANSCRIPT"\\n' > "$destination"
}
upgrade_command ${explicit ? '--ref v0.39.0' : ''}
`;
    execFileSync('bash', ['-c', script], { env: { ...process.env, ARU_SELFHOST_CONFIG_DIR: root, CONTROL: control, TRANSCRIPT: join(root, 'out') } });
    const result = readFileSync(join(root, 'out'), 'utf8');
    assert.match(result, new RegExp(explicit ? 'v0.39.0/install.sh' : 'v0.40.0/install.sh'));
    assert.match(result, /--source-ref/); assert.doesNotMatch(result, /old.tar|v0.31.4/);
    assert.match(result, /100.64.0.1:8787/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('explicit key reset retires only credentials and leaves installation profile intact', () => {
  const root = mkdtempSync(join(tmpdir(), 'aru-key-reset-'));
  try {
    const secretRoot = join(root,'keys');
    const setup = `mkdir -p "$KEYROOT"; chmod 700 "$KEYROOT"; printf old > "$KEYROOT/master.key"`;
    execFileSync('bash',['-c',setup],{env:{...process.env,KEYROOT:secretRoot}});
    const config = `ARU_PROVIDER_SECRET_ROOT='${secretRoot}'\nARU_NODE_BINARY='${process.execPath}'\n`;
    writeFileSync(join(root,'node.env'),config);
    execFileSync('bash',['-c',`source "$CONTROL"
need_root() { :; }
systemctl() { printf '%s\\n' "$*" >> "$TRANSCRIPT"; }
runuser() { shift 3; "$@"; }
reset_provider_keys_command
`], {env:{...process.env,CONTROL:control,ARU_SELFHOST_CONFIG_DIR:root,TRANSCRIPT:join(root,'out')}});
    assert.equal(readFileSync(join(secretRoot,'master.key')).length,32);
    assert.equal(readFileSync(join(root,'node.env'),'utf8'),config);
    assert.match(readFileSync(join(root,'out'),'utf8'),/stop aru-selfhost.service\nrestart aru-selfhost.service/);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('release lookup failure leaves existing installation settings untouched', () => {
  const root = mkdtempSync(join(tmpdir(), 'aru-upgrade-offline-'));
  try {
    const config = 'ARU_INSTALL_SOURCE_REF=v0.31.4\nARU_INSTALL_BASE_URL=http://100.64.0.1:8787\n';
    writeFileSync(join(root, 'install.env'), config);
    assert.throws(() => execFileSync('bash', ['-c', `source "$CONTROL"
need_root() { :; }
curl() { return 22; }
upgrade_command
`], { stdio: 'pipe', env: { ...process.env, CONTROL: control, ARU_SELFHOST_CONFIG_DIR: root } }));
    assert.equal(readFileSync(join(root, 'install.env'), 'utf8'), config);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
