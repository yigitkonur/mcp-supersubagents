#!/usr/bin/env node
import { spawn } from 'child_process';
import { createInterface } from 'readline';

const server = spawn('node', ['build/index.js'], {
  stdio: ['pipe', 'pipe', 'inherit'],
  cwd: process.cwd(),
});

let requestId = 1;
const pending = new Map();

const rl = createInterface({ input: server.stdout });
rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id).resolve(msg.result || msg.error);
      pending.delete(msg.id);
    }
  } catch {}
});

function send(method, params = {}) {
  return new Promise((resolve) => {
    const id = requestId++;
    pending.set(id, { resolve });
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  const model = process.argv[2] || 'gpt-5.2-codex';
  const prompt = process.argv[3] || 'Explain what the Fibonacci sequence is in one sentence';
  
  console.log(`\n🧪 Testing Model: ${model}`);
  console.log(`📝 Prompt: "${prompt}"\n`);

  await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'model-test', version: '1.0.0' }
  });

  const spawnResult = await send('tools/call', {
    name: 'spawn_copilot_task',
    arguments: { prompt, model, autonomous: true }
  });
  const { taskId } = JSON.parse(spawnResult.content[0].text);
  console.log(`✓ Task spawned: ${taskId}\n`);

  let done = false;
  const start = Date.now();
  while (!done && Date.now() - start < 120000) {
    await sleep(2000);
    const statusResult = await send('tools/call', {
      name: 'get_task_status',
      arguments: { taskId }
    });
    const status = JSON.parse(statusResult.content[0].text);
    
    if (status.status === 'completed' || status.status === 'failed') {
      done = true;
      console.log(`\n✓ Task ${status.status} (${Math.round((Date.now() - start) / 1000)}s)`);
      console.log(`  Model: ${model}`);
      console.log(`  Exit Code: ${status.exitCode}`);
      console.log(`  Output Lines: ${status.outputLines}`);
      console.log(`\n--- Response ---`);
      console.log(status.output);
      console.log(`--- End ---\n`);
    } else {
      process.stdout.write(`  ⏳ ${status.status} (${status.outputLines} lines)...\r`);
    }
  }

  server.kill();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
