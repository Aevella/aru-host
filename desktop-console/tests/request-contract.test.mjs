import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

// Fail closed on edits to call sites so a newly introduced route or query must
// be reviewed against the scenarios above. This complements the real caller
// execution tests for approval and sync; it is not a JavaScript parser.
test('Console request call sites are reviewed when they change', async () => {
  const files = ['renderer.mjs', 'conversation-sync.mjs', 'connection-settings.mjs', 'main.mjs'];
  const signatures = [];
  for (const file of files) {
    const source = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
    for (const line of source.split('\n')) {
      if (/\b(?:api\.request|api\.download|requestHost|submitConversationApproval)\s*\(/.test(line)
          || /\brequest\(['"](?:GET|POST|PUT|DELETE)['"]/.test(line)
          || /\b(?:const|let)\s+(?:id|path|root|method|kind|action|params)\b/.test(line)
          || /\bparams\.set\(/.test(line)
          || /\breturn\s+`\/aru\/v1\//.test(line)) {
        signatures.push(`${file}:${line.trim()}`);
      }
    }
  }
  const digest = createHash('sha256').update(signatures.join('\n')).digest('hex');
  assert.equal(digest, 'e32c7046d1108130c3ce588350bcbf34691fa6900dfa76a14be69354d486ab32',
    'Console request sites changed: review every method/path/query and update the route scenarios and digest');
});
