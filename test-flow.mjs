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
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg.result || msg.error);
    }
  } catch {}
});

function send(method, params = {}) {
  return new Promise((resolve) => {
    const id = requestId++;
    pending.set(id, { resolve });
    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    server.stdin.write(msg + '\n');
  });
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log('=== MCP Server Integration Test ===\n');

  // Initialize
  await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' }
  });
  console.log('✓ Server initialized\n');

  // List tools
  const tools = await send('tools/list', {});
  console.log(`✓ Found ${tools.tools.length} tools: ${tools.tools.map(t => t.name).join(', ')}\n`);

  // List tasks (should be empty)
  let listResult = await send('tools/call', { name: 'list_tasks', arguments: {} });
  const listData = JSON.parse(listResult.content[0].text);
  console.log(`✓ Initial tasks: ${listData.count}\n`);

  // Spawn a task
  console.log('Spawning Copilot CLI task...');
  const spawnResult = await send('tools/call', {
    name: 'spawn_copilot_task',
    arguments: { prompt: 'What is 2 + 2? Just answer with the number.' }
  });
  const spawnData = JSON.parse(spawnResult.content[0].text);
  console.log(`✓ Task spawned: ${spawnData.taskId}\n`);

  // Poll for status
  console.log('Polling task status...');
  let attempts = 0;
  let lastStatus = '';
  
  while (attempts < 30) {
    await sleep(2000);
    const statusResult = await send('tools/call', {
      name: 'get_task_status',
      arguments: { taskId: spawnData.taskId }
    });
    const statusData = JSON.parse(statusResult.content[0].text);
    
    if (statusData.status !== lastStatus) {
      console.log(`  Status: ${statusData.status} (lines: ${statusData.outputLines})`);
      lastStatus = statusData.status;
    }
    
    if (statusData.status === 'completed' || statusData.status === 'failed') {
      console.log(`\n✓ Task finished with status: ${statusData.status}`);
      console.log(`  Exit code: ${statusData.exitCode}`);
      console.log(`  Session ID: ${statusData.sessionId || 'N/A'}`);
      console.log(`  Output lines: ${statusData.outputLines}`);
      if (statusData.output) {
        console.log('\n--- Output (last 500 chars) ---');
        console.log(statusData.output.slice(-500));
        console.log('--- End Output ---\n');
      }
      break;
    }
    
    attempts++;
  }

  // List tasks again
  listResult = await send('tools/call', { name: 'list_tasks', arguments: {} });
  const finalList = JSON.parse(listResult.content[0].text);
  console.log(`✓ Final task count: ${finalList.count}`);

  console.log('\n=== Test Complete ===');
  server.kill();
  process.exit(0);
}

main().catch(err => {
  console.error('Test failed:', err);
  server.kill();
  process.exit(1);
});
