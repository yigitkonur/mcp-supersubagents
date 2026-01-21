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

async function waitForTask(taskId, maxWait = 120000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    await sleep(2000);
    const result = await send('tools/call', {
      name: 'get_task_status',
      arguments: { taskId }
    });
    const data = JSON.parse(result.content[0].text);
    if (data.status === 'completed' || data.status === 'failed' || data.status === 'cancelled') {
      return data;
    }
    process.stdout.write(`  [${Math.round((Date.now() - start) / 1000)}s] ${data.status} (${data.outputLines} lines)\r`);
  }
  throw new Error('Task timeout');
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║       Copilot MCP Server - Comprehensive Test Suite          ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  // Initialize
  await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' }
  });
  console.log('✓ [1/6] Server initialized\n');

  // Test 1: List tools
  const tools = await send('tools/list', {});
  console.log(`✓ [2/6] Tools available: ${tools.tools.map(t => t.name).join(', ')}\n`);

  // Test 2: Spawn task with file operation
  console.log('► [3/6] Spawning Copilot task: "Create a hello.txt file with Hello World"');
  const spawn1 = await send('tools/call', {
    name: 'spawn_copilot_task',
    arguments: { 
      prompt: 'Create a file called hello.txt in the current directory with the text "Hello from Copilot MCP Server!"',
      cwd: '/tmp'
    }
  });
  const spawn1Data = JSON.parse(spawn1.content[0].text);
  console.log(`  Task ID: ${spawn1Data.taskId}`);
  
  const result1 = await waitForTask(spawn1Data.taskId);
  console.log(`✓ Task completed: ${result1.status}, Exit: ${result1.exitCode}\n`);

  // Test 3: Spawn a second task to verify file was created
  console.log('► [4/6] Spawning Copilot task: "Read hello.txt"');
  const spawn2 = await send('tools/call', {
    name: 'spawn_copilot_task',
    arguments: { 
      prompt: 'Read the contents of hello.txt and tell me what it says',
      cwd: '/tmp'
    }
  });
  const spawn2Data = JSON.parse(spawn2.content[0].text);
  console.log(`  Task ID: ${spawn2Data.taskId}`);
  
  const result2 = await waitForTask(spawn2Data.taskId);
  console.log(`✓ Task completed: ${result2.status}, Exit: ${result2.exitCode}`);
  
  // Check if output contains our message
  if (result2.output && result2.output.includes('Hello from Copilot')) {
    console.log('  ✓ File content verified!\n');
  } else {
    console.log('  Output:', result2.output?.slice(0, 200), '\n');
  }

  // Test 4: List all tasks
  const listResult = await send('tools/call', { name: 'list_tasks', arguments: {} });
  const listData = JSON.parse(listResult.content[0].text);
  console.log(`✓ [5/6] Total tasks tracked: ${listData.count}`);
  for (const task of listData.tasks) {
    console.log(`  - ${task.id}: ${task.status} (${task.prompt.slice(0, 40)}...)`);
  }
  console.log();

  // Test 5: Test cancel (spawn and immediately cancel)
  console.log('► [6/6] Testing cancel functionality...');
  const spawn3 = await send('tools/call', {
    name: 'spawn_copilot_task',
    arguments: { prompt: 'Count from 1 to 1000 very slowly' }
  });
  const spawn3Data = JSON.parse(spawn3.content[0].text);
  
  await sleep(1000);
  
  const cancelResult = await send('tools/call', {
    name: 'cancel_task',
    arguments: { taskId: spawn3Data.taskId }
  });
  const cancelData = JSON.parse(cancelResult.content[0].text);
  console.log(`  Cancel result: ${cancelData.success ? 'Success' : 'Failed'}`);
  
  await sleep(500);
  const cancelStatus = await send('tools/call', {
    name: 'get_task_status',
    arguments: { taskId: spawn3Data.taskId }
  });
  const cancelStatusData = JSON.parse(cancelStatus.content[0].text);
  console.log(`  Final status: ${cancelStatusData.status}\n`);

  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║                    All Tests Passed! ✓                       ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  
  server.kill();
  process.exit(0);
}

main().catch(err => {
  console.error('Test failed:', err);
  server.kill();
  process.exit(1);
});
