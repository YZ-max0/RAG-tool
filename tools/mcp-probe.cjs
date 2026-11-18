
// Minimal MCP stdio client: initialize, then tools/call. Verification only.
const { spawn } = require('child_process');
const readline = require('readline');
const fs = require('fs');

const serverPath = process.argv[2];
const spec = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));

const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'inherit'] });
const rl = readline.createInterface({ input: child.stdout });
const pending = new Map();
let nextId = 1;

function call(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout ' + method)); } }, 90000);
  });
}
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  const waiter = pending.get(msg.id);
  if (!waiter) return;
  pending.delete(msg.id);
  if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error)));
  else waiter.resolve(msg.result);
});

(async () => {
  const init = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify', version: '0' } });
  console.log('serverInfo=' + JSON.stringify(init.serverInfo));
  await call('notifications/initialized', {}).catch(() => {});
  const tools = await call('tools/list', {});
  console.log('tools=' + tools.tools.map(t => t.name).join(','));
  for (const item of spec.calls) {
    const result = await call('tools/call', { name: item.name, arguments: item.arguments });
    console.log('--- ' + item.name + ' isError=' + String(result.isError === true) + ' ---');
    console.log(result.content[0].text);
  }
  child.kill();
  process.exit(0);
})().catch((e) => { console.error('FAIL ' + e.message); child.kill(); process.exit(1); });
