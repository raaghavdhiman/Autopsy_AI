// Starts the sample target app and the ProofGraph backend as separate processes.
const { spawn } = require('child_process');
const path = require('path');

const procs = [
  ['sample-app', path.join(__dirname, 'sample-app', 'server.js')],
  ['proofgraph', path.join(__dirname, 'server', 'index.js')],
].map(([name, file]) => {
  const p = spawn(process.execPath, [file], { stdio: 'inherit', env: process.env });
  p.on('exit', (code) => { console.log(`[${name}] exited (${code})`); shutdown(); });
  return p;
});

function shutdown() { procs.forEach((p) => p.exitCode == null && p.kill()); process.exit(); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
