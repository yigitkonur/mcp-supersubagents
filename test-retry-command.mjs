#!/usr/bin/env node

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function main() {
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['build/index.js'],
  });

  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);

  console.log('✓ Connected to MCP server');

  // Test 1: Spawn a task
  const spawnResult = await client.callTool('spawn_task', { prompt: 'echo test' });
  const taskId = JSON.parse(spawnResult.content[0].text).task_id;
  console.log(`✓ Spawned task: ${taskId}`);

  // Test 2: Check status (1st check - should get retry_command: "sleep 30")
  await new Promise(resolve => setTimeout(resolve, 100)); // Small delay
  const status1 = await client.callTool('get_status', { task_id: taskId });
  const result1 = JSON.parse(status1.content[0].text);
  console.log('\n1st check:');
  console.log(`  status: ${result1.status}`);
  console.log(`  retry_after_seconds: ${result1.retry_after_seconds}`);
  console.log(`  retry_command: ${result1.retry_command}`);

  if (result1.retry_command !== 'sleep 30') {
    throw new Error(`Expected retry_command 'sleep 30', got '${result1.retry_command}'`);
  }

  // Test 3: Check status again (2nd check - should get retry_command: "sleep 60")
  await new Promise(resolve => setTimeout(resolve, 100));
  const status2 = await client.callTool('get_status', { task_id: taskId });
  const result2 = JSON.parse(status2.content[0].text);
  console.log('\n2nd check:');
  console.log(`  status: ${result2.status}`);
  console.log(`  retry_after_seconds: ${result2.retry_after_seconds}`);
  console.log(`  retry_command: ${result2.retry_command}`);

  if (result2.retry_command !== 'sleep 60') {
    throw new Error(`Expected retry_command 'sleep 60', got '${result2.retry_command}'`);
  }

  // Test 4: Check status again (3rd check - should get retry_command: "sleep 120")
  await new Promise(resolve => setTimeout(resolve, 100));
  const status3 = await client.callTool('get_status', { task_id: taskId });
  const result3 = JSON.parse(status3.content[0].text);
  console.log('\n3rd check:');
  console.log(`  status: ${result3.status}`);
  console.log(`  retry_after_seconds: ${result3.retry_after_seconds}`);
  console.log(`  retry_command: ${result3.retry_command}`);

  if (result3.retry_command !== 'sleep 120') {
    throw new Error(`Expected retry_command 'sleep 120', got '${result3.retry_command}'`);
  }

  // Test 5: Batch check with array
  await new Promise(resolve => setTimeout(resolve, 100));
  const batchStatus = await client.callTool('get_status', { task_id: [taskId, 'nonexistent-99'] });
  const batchResult = JSON.parse(batchStatus.content[0].text);
  console.log('\nBatch check:');
  console.log(`  Found ${batchResult.tasks.length} tasks`);
  console.log(`  Task 1 retry_command: ${batchResult.tasks[0].retry_command}`);
  console.log(`  Task 2 status: ${batchResult.tasks[1].status}`);

  if (batchResult.tasks[0].retry_command !== 'sleep 180') {
    throw new Error(`Expected retry_command 'sleep 180', got '${batchResult.tasks[0].retry_command}'`);
  }

  console.log('\n✅ All retry_command tests passed!');
  
  await client.close();
  process.exit(0);
}

main().catch(err => {
  console.error('❌ Test failed:', err.message);
  process.exit(1);
});
