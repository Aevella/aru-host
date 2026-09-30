// Observe only synthetic conversation files in the HTTP regression child.
const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
let reads = 0, directoryReads = 0;
function isHistory(file) {
  return /[\\/]collaborator-conversations(?:[\\/]|$)|[\\/]collaborator-conversation-attachments(?:[\\/]|$)/.test(String(file));
}
const originalRead = fs.readFileSync, originalReaddir = fs.readdirSync;
fs.readFileSync = function(file, ...args) {
  if (isHistory(file)) reads += 1;
  return originalRead.call(this, file, ...args);
};
fs.readdirSync = function(file, ...args) {
  if (isHistory(file)) directoryReads += 1;
  return originalReaddir.call(this, file, ...args);
};
syncBuiltinESMExports();
process.on('message', message => {
  if (message?.kind !== 'history-read-count') return;
  process.send?.({ kind: 'history-read-count', id: message.id, reads, directoryReads });
  reads = 0; directoryReads = 0;
});
