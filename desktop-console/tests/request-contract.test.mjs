import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { validateHostRequest } from '../src/runtime.mjs';

// A synthetic example for every current Console request shape, including the
// branches behind dynamic method, action, object-kind, and download paths.
test('Console request shapes are admitted by the main-process boundary', () => {
  const uuid = '01234567-89ab-cdef-0123-456789abcdef';
  const collaborator = `/aru/v1/hosted-collaborators/hostcol_${uuid}`;
  const conversation = `${collaborator}/conversations/hostconv_${uuid}`;
  const routes = [
    ...['/.well-known/aru.json', ...['diagnostics', 'node-settings', 'devices', 'backups',
      'backups?includeSnapshots=1', 'backups/settings', 'plugins', 'plugin-workshop/drafts',
      'node-workspaces', 'jobs', 'jobs/policy', 'artifacts', 'agent-drivers',
      'hosted-collaborators', 'provider-profiles', 'container-runtime'].map(p => `/aru/v1/${p}`)]
      .map(path => ['GET', path]),
    ...['node-settings', 'backups/settings', 'jobs/policy'].map(p => ['PUT', `/aru/v1/${p}`]),
    ...['pair', 'devices/revoke', 'agent-drivers/refresh', 'hosted-collaborators',
      'provider-profiles', 'plugin-workshop/validate', 'plugin-workshop/apply',
      'node-workspaces', 'container-runtime/verify'].map(p => ['POST', `/aru/v1/${p}`]),
    ['GET', '/aru/v1/plugins/plugin.test/source'],
    ['DELETE', '/aru/v1/plugins/plugin.test?deleteData=false'],
    ...['enable', 'disable', 'rollback'].map(action => ['POST', `/aru/v1/plugins/plugin.test/${action}`]),
    ['POST', '/aru/v1/plugin-workshop/drafts/draft_123/apply'],
    ['DELETE', '/aru/v1/node-workspaces/workspace_123'],
    ...['cancel', 'retry'].map(action => ['POST', `/aru/v1/jobs/job_123/${action}`]),
    ...['backups', 'artifacts'].flatMap(kind => [
      ['GET', `/aru/v1/${kind}/item_123`], ['DELETE', `/aru/v1/${kind}/item_123`],
    ]),
    ['PUT', '/aru/v1/provider-profiles/provider_ab12-cd34'],
    ['POST', '/aru/v1/provider-profiles/provider_ab12-cd34/test'],
    ['DELETE', '/aru/v1/provider-profiles/provider_ab12-cd34'],
    ['PUT', collaborator], ['DELETE', collaborator],
    ...['conversations', 'surfaces', 'projects', 'cognition', 'initiative']
      .map(kind => ['GET', `${collaborator}/${kind}`]),
    ...['conversations', 'surfaces', 'projects', 'initiative']
      .map(kind => ['POST', `${collaborator}/${kind}`]),
    ['PUT', `${collaborator}/cognition`],
    ['PUT', `${collaborator}/initiative/rules/rule_123`],
    ...['run', 'archive', 'restore'].map(action => ['POST', `${collaborator}/initiative/rules/rule_123/${action}`]),
    ['GET', `${collaborator}/surfaces/surface_123`],
    ['PUT', `${collaborator}/surfaces/surface_123`],
    ['PUT', `${collaborator}/surfaces/surface_123/runtime`],
    ...['rollback', 'archive', 'restore'].map(action => ['POST', `${collaborator}/surfaces/surface_123/${action}`]),
    ['GET', `${collaborator}/projects/project_123`],
    ...['checkpoint', 'publish', 'archive', 'restore'].map(action => ['POST', `${collaborator}/projects/project_123/${action}`]),
    ...['memories', 'references'].flatMap(kind => [
      ['POST', `${collaborator}/cognition/${kind}`],
      ['PUT', `${collaborator}/cognition/${kind}/record_123`],
      ...['archive', 'restore'].map(action => ['POST', `${collaborator}/cognition/${kind}/record_123/${action}`]),
    ]),
    ['GET', conversation], ['POST', `${conversation}/messages`],
    ['POST', `${conversation}/turns/hostturn_${uuid}/cancel`],
    ['POST', `${conversation}/approvals/hostapproval_${uuid}?window=1`],
    ['GET', `${conversation}/sync?after=0`],
    ['GET', `${conversation}/sync?after=128&version=123-456-789`],
  ];
  for (const [method, path] of routes) {
    assert.deepEqual(validateHostRequest(method, path), { method, path }, `${method} ${path}`);
  }
});

// Capture request arguments and the small set of route-building declarations,
// leaving request bodies and unrelated local variables out of the review guard.
function requestSignatures(source) {
  const signatures = [];
  const calls = /\b(?:api\.request|api\.download|requestHost|submitConversationApproval|request)\s*\(/g;
  for (const match of source.matchAll(calls)) {
    if (/\bfunction\s+$/.test(source.slice(0, match.index))) continue;
    const name = match[0].replace(/\s*\($/, '');
    let i = match.index + match[0].length, start = i, depth = 0, quote = null;
    const args = [];
    for (; i < source.length; i++) {
      const c = source[i];
      if (quote) {
        if (c === '\\') { i++; continue; }
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) {
        if (depth === 0) { args.push(source.slice(start, i).trim()); break; }
        depth--;
      } else if (c === ',' && depth === 0) {
        args.push(source.slice(start, i).trim());
        if (args.length === (name === 'api.download' ? 1 : 2)) break;
        start = i + 1;
      }
    }
    if (name === 'request' && !/^['"](?:GET|POST|PUT|DELETE)['"]$/.test(args[0])) continue;
    signatures.push(`${name}(${args.join(', ')})`);
  }
  for (const line of source.split('\n')) {
    const declaration = line.match(/\b(?:const|let)\s+(?:path|root|method|params)\s*=\s*[^;]+/);
    if (declaration && /\/aru\/v1\/|conversationApiPath|\broot\b|\bprofile\b|\bsurface\b|URLSearchParams/.test(declaration[0])) {
      signatures.push(declaration[0].trim());
    }
    if (/\bparams\.set\(/.test(line) || /\breturn\s+`\/aru\/v1\//.test(line)) signatures.push(line.trim());
  }
  return signatures;
}

test('request review ignores unrelated variables and request bodies', () => {
  const original = 'const id = 1; api.request("POST", `/aru/v1/items/${id}`, { title: "one" });';
  assert.deepEqual(requestSignatures(original), requestSignatures(original.replace('id = 1', 'id = 2').replace('"one"', '"two"')));
  assert.notDeepEqual(requestSignatures(original), requestSignatures(original.replace('/items/', '/other/')));
});

// This static guard prompts review of changed call sites; it complements the
// route scenarios and real caller tests, but is not a full JavaScript parser.
test('Console request call sites are reviewed when they change', async () => {
  const files = (await readdir(new URL('../src/', import.meta.url))).filter(file => file.endsWith('.mjs')).sort();
  const signatures = [];
  for (const file of files) {
    const source = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
    signatures.push(...requestSignatures(source).map(signature => `${file}:${signature}`));
  }
  const digest = createHash('sha256').update(signatures.join('\n')).digest('hex');
  assert.equal(digest, 'b569696424534048ba98a08d704efd48e8deceee130bd672a6d31168c455be83',
    'Console request sites changed: review every method/path/query and update the route scenarios and digest');
});
