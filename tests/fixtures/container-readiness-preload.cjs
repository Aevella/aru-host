// Test-only CLI fixture. Node itself is the native executable on every OS;
// preload intercepts only the container commands, never the Host entrypoint.
const command = require('node:path').basename(process.argv[1] ?? '');
if (command === 'info' || command === 'run') {
  if (process.env.ARU_TEST_ENGINE_FAILURE === '1') { process.stderr.write('synthetic Podman socket failure\n'); process.exit(1); }
  if (command === 'run') {
    const fs = require('node:fs');
    const path = require('node:path');
    const args = process.argv.slice(2);
    const mount = args[args.indexOf('--mount') + 1];
    const match = /^type=bind,src=(.*),dst=\/workspace$/.exec(mount ?? '');
    if (!match || fs.readFileSync(path.join(match[1], 'input.txt'), 'utf8') !== 'aru-runtime-check') process.exit(2);
    const name = args.includes('node') ? 'node' : args.includes('python3') ? 'python' : 'shell';
    fs.writeFileSync(path.join(match[1], `${name}.txt`), 'ok');
  }
  process.stdout.write('fake-container-runtime\n');
  process.exit(0);
}
