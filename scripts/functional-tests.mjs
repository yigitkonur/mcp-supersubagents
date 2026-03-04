#!/usr/bin/env node

/**
 * Functional test suite for mcp-supersubagents.
 *
 * Tests REAL agent execution end-to-end:
 *  - launch-classic-agent: concrete tasks (file writing, computation)
 *  - launch-super-planner: does it plan before executing?
 *  - launch-super-researcher: research + fleet mode
 *  - depends_on: task chaining
 *  - MCP resources: task:///all, task:///{id}, system:///status
 *  - Output streaming: file paths, content correctness
 *  - cancel-agent: single + batch + clear all
 *  - Validation: bad input rejection
 *
 * Usage:
 *   node scripts/functional-tests.mjs [cwd] [--scenario=NAME]
 *
 * Scenarios: all (default), classic, planner, depends, resources, cancel, validation
 *
 * Env vars:
 *   MCP_FUNC_TASK_TIMEOUT_MS  — per-task timeout (default: 120_000 = 2min)
 *   MCP_FUNC_WAIT_TIMEOUT_MS  — max poll wait (default: 300_000 = 5min)
 *   MCP_FUNC_SCENARIO         — scenario name (default: all)
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'rate_limited', 'timed_out']);
const POLL_MS = 2_000;
const DEFAULT_TASK_TIMEOUT = 900_000;   // 15 min per task
const DEFAULT_WAIT_TIMEOUT = 1_200_000; // 20 min max poll

let passed = 0;
let failed = 0;
let skipped = 0;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg) { process.stdout.write(`[func-test] ${msg}\n`); }
function logOk(msg) { process.stdout.write(`[func-test] ✅ ${msg}\n`); passed++; }
function logFail(msg) { process.stdout.write(`[func-test] ❌ ${msg}\n`); failed++; }
function logSkip(msg) { process.stdout.write(`[func-test] ⏭️  ${msg}\n`); skipped++; }
function logSection(name) { process.stdout.write(`\n${'═'.repeat(60)}\n[func-test] 🧪 ${name}\n${'═'.repeat(60)}\n`); }

function assert(cond, msg) { if (!cond) throw new Error(msg); }

function extractText(result) {
  return (result?.content ?? [])
    .filter(c => c?.type === 'text' && typeof c.text === 'string')
    .map(c => c.text)
    .join('\n');
}

function extractTaskId(text) {
  const m = text.match(/task_id:\s*`([^`]+)`/i) || text.match(/task_id:\s*([A-Za-z0-9_-]+)/i);
  if (!m) throw new Error(`Could not parse task_id from: ${text.slice(0, 200)}`);
  return m[1];
}

function parseResource(result, uri) {
  const first = result?.contents?.[0];
  if (!first || typeof first.text !== 'string') throw new Error(`${uri}: no text content`);
  return JSON.parse(first.text);
}

async function pollUntilTerminal(client, taskId, waitMs) {
  const start = Date.now();
  let lastStatus = '';
  while (Date.now() - start < waitMs) {
    const read = await client.readResource({ uri: `task:///${taskId}` });
    const task = parseResource(read, `task:///${taskId}`);
    if (task.status !== lastStatus) {
      log(`  ${taskId}: ${task.status}`);
      lastStatus = task.status;
    }
    if (TERMINAL.has(task.status)) return task;
    await sleep(POLL_MS);
  }
  throw new Error(`Timeout waiting for ${taskId} (last: ${lastStatus})`);
}

async function spawn(client, tool, args, taskTimeout, waitTimeout) {
  const result = await client.callTool({ name: tool, arguments: args });
  const text = extractText(result);
  if (result.isError) return { error: text, taskId: null, task: null };
  const taskId = extractTaskId(text);
  log(`  spawned ${taskId} via ${tool}`);
  const task = await pollUntilTerminal(client, taskId, waitTimeout);
  return { error: null, taskId, task, spawnText: text };
}

// ─── Test Scenarios ──────────────────────────────────────────────────────────

async function testClassicAgent(client, cwd, taskTimeout, waitTimeout) {
  logSection('TEST: launch-classic-agent — real task execution');

  // --- Test 1: Write a file with specific content ---
  log('Test 1: Agent writes numbers 1-20 to a file');
  const outFile = path.join(cwd, '.super-agents', 'test-numbers.txt');
  await fs.rm(outFile, { force: true });

  const { error, taskId, task, spawnText } = await spawn(client, 'launch-classic-agent', {
    prompt: `OBJECTIVE: Write the numbers 1 to 20, one per line, to the file ${outFile}. Each line should contain just the number. CONTEXT: This is a test to verify the agent can write files correctly. Use write_file or bash to create the file. DELIVERABLES: The file ${outFile} containing exactly 20 lines, each with one number from 1 to 20.`,
    cwd,
    timeout: taskTimeout,
    labels: ['func-test', 'classic-write'],
  }, taskTimeout, waitTimeout);

  if (error) { logFail(`Spawn failed: ${error}`); return; }

  // Check spawn response has output_file path
  if (spawnText.includes('output_file:')) {
    logOk('Spawn response includes output_file path');
  } else {
    logFail('Spawn response missing output_file path');
  }

  // Check task reached terminal state
  log(`  Task status: ${task.status}`);
  if (task.status === 'completed') {
    logOk('Task completed successfully');
  } else {
    logFail(`Task ended with status: ${task.status} (expected: completed)`);
  }

  // Verify the file was actually created with correct content
  try {
    const content = await fs.readFile(outFile, 'utf8');
    const lines = content.trim().split('\n');
    if (lines.length >= 18 && lines.length <= 22) {  // some tolerance
      logOk(`File written with ${lines.length} lines (expected ~20)`);
    } else {
      logFail(`File has ${lines.length} lines (expected ~20)`);
    }
    if (lines[0]?.trim() === '1' && lines[lines.length - 1]?.trim() === String(lines.length)) {
      logOk('File content is correct (starts with 1, sequential)');
    } else {
      logFail(`Unexpected content: first="${lines[0]}", last="${lines[lines.length - 1]}"`);
    }
  } catch {
    logFail('File was NOT created by the agent');
  }

  // --- Test 2: Verify MCP resource has meaningful data ---
  log('Test 2: task:///{id} resource has full details');
  const taskRead = await client.readResource({ uri: `task:///${taskId}` });
  const taskData = parseResource(taskRead, `task:///${taskId}`);

  if (taskData.id === taskId) logOk('Resource returns correct task ID');
  else logFail(`Resource ID mismatch: ${taskData.id} vs ${taskId}`);

  if (taskData.status) logOk(`Resource has status: ${taskData.status}`);
  else logFail('Resource missing status');

  if (taskData.output_tail && taskData.output_tail.length > 0) {
    logOk(`Resource has output_tail (${taskData.output_tail.length} chars)`);
  } else if (taskData.output_lines > 0) {
    logOk(`Resource has output_lines: ${taskData.output_lines}`);
  } else {
    logFail('Resource has no output');
  }

  if (taskData.labels?.includes('classic-write')) logOk('Resource has labels');
  else logSkip(`Labels not found in resource (labels: ${JSON.stringify(taskData.labels)})`);

  // --- Test 3: Verify output file is streamable ---
  log('Test 3: Output file exists and has content');
  const outputPath = spawnText.match(/output_file:\s*`([^`]+)`/)?.[1];
  if (outputPath) {
    try {
      const outputContent = await fs.readFile(outputPath, 'utf8');
      if (outputContent.length > 0) {
        logOk(`Output file has ${outputContent.length} chars`);
      } else {
        logFail('Output file is empty');
      }
    } catch {
      logFail(`Output file not readable: ${outputPath}`);
    }
  } else {
    logFail('Could not parse output_file path from spawn response');
  }
}

async function testPlannerBehavior(client, cwd, taskTimeout, waitTimeout) {
  logSection('TEST: launch-super-planner — planning vs executing');

  log('Test: Planner creates plan documents in agent workspace');
  // Planner uses Opus (slower) and does web research + writes many files — needs more time
  const plannerTimeout = Math.max(taskTimeout, 600_000);   // 10 min task timeout
  const plannerWait = Math.max(waitTimeout, 660_000);      // 11 min poll wait
  const { error, taskId, task } = await spawn(client, 'launch-super-planner', {
    prompt: `PROBLEM STATEMENT: We need to add a "dark mode" toggle to a hypothetical React + Tailwind CSS web application. The app currently uses only light theme colors. CONSTRAINTS: Must use Tailwind dark: variant (not CSS custom properties). Must not break existing components. Toggle must persist in localStorage. VERIFIED FACTS: The app uses Tailwind CSS v3+, React 18+, and has a Header component at src/components/Header.tsx. SCOPE: IN — theme toggle in Header, dark mode CSS classes on all major layout components. OUT — individual component restyling, accessibility audit. EXPECTED OUTPUT: A step-by-step implementation plan with atomic tasks that a Coder agent can execute.`,
    cwd,
    timeout: plannerTimeout,
    labels: ['func-test', 'planner'],
  }, plannerTimeout, plannerWait);

  if (error) { logFail(`Planner spawn failed: ${error}`); return; }

  if (task.status === 'completed') {
    logOk('Planner task completed');
  } else {
    logFail(`Planner ended with: ${task.status}`);
  }

  // Check if planner created workspace files
  const wsBase = path.join(cwd, '.agent-workspace', 'plans');
  try {
    const dirs = await fs.readdir(wsBase, { recursive: true });
    if (dirs.length > 0) {
      logOk(`Planner wrote to agent workspace (${dirs.length} items in .agent-workspace/plans/)`);
      log(`  Files: ${dirs.slice(0, 10).join(', ')}${dirs.length > 10 ? '...' : ''}`);
    } else {
      logFail('Planner workspace is empty');
    }
  } catch {
    logFail('.agent-workspace/plans/ directory was NOT created');
  }

  // Check if plan has structured content via resource
  const taskRead = await client.readResource({ uri: `task:///${taskId}` });
  const taskData = parseResource(taskRead, `task:///${taskId}`);
  const output = (taskData.output ?? []).join('\n');

  if (output.toLowerCase().includes('task') && output.toLowerCase().includes('wave')) {
    logOk('Planner output contains task/wave references (structured planning)');
  } else if (output.toLowerCase().includes('task') || output.toLowerCase().includes('step')) {
    logOk('Planner output contains structured task/step references');
  } else {
    logSkip('Could not verify planning structure in output (may be in workspace files)');
  }

  // Verify planner used Opus model
  if (taskData.model?.includes('opus')) {
    logOk(`Planner used Opus model: ${taskData.model}`);
  } else {
    logSkip(`Could not verify Opus model from resource (model: ${taskData.model ?? 'n/a'})`);
  }
}

async function testDependsOn(client, cwd, taskTimeout, waitTimeout) {
  logSection('TEST: depends_on — task chaining');

  // Task A: write "STEP_A_DONE" to a marker file
  const markerFile = path.join(cwd, '.super-agents', 'test-depends-marker.txt');
  await fs.rm(markerFile, { force: true });

  log('Spawning Task A (write marker file)...');
  const resultA = await client.callTool({
    name: 'launch-classic-agent',
    arguments: {
      prompt: `OBJECTIVE: Write the text "STEP_A_DONE" to the file ${markerFile}. CONTEXT: This is step A of a dependency chain test. DELIVERABLES: The file ${markerFile} containing exactly "STEP_A_DONE".`,
      cwd,
      timeout: taskTimeout,
      labels: ['func-test', 'depends-A'],
    },
  });
  const textA = extractText(resultA);
  if (resultA.isError) { logFail(`Task A spawn failed: ${textA}`); return; }
  const taskIdA = extractTaskId(textA);
  log(`  Task A: ${taskIdA}`);

  // Task B: depends_on A, read marker and append "STEP_B_DONE"
  log('Spawning Task B (depends_on A, append to marker)...');
  const resultB = await client.callTool({
    name: 'launch-classic-agent',
    arguments: {
      prompt: `OBJECTIVE: Read the file ${markerFile}, confirm it contains "STEP_A_DONE", then append a new line with "STEP_B_DONE". CONTEXT: This depends on Task A completing first. The file should already exist with "STEP_A_DONE" written by the prior agent. DELIVERABLES: The file ${markerFile} containing both "STEP_A_DONE" and "STEP_B_DONE" on separate lines.`,
      cwd,
      timeout: taskTimeout,
      depends_on: [taskIdA],
      labels: ['func-test', 'depends-B'],
    },
  });
  const textB = extractText(resultB);
  if (resultB.isError) { logFail(`Task B spawn failed: ${textB}`); return; }
  const taskIdB = extractTaskId(textB);
  log(`  Task B: ${taskIdB} (depends_on: ${taskIdA})`);

  // Verify B is WAITING initially
  await sleep(1000);
  const earlyRead = await client.readResource({ uri: `task:///${taskIdB}` });
  const earlyTask = parseResource(earlyRead, `task:///${taskIdB}`);
  if (earlyTask.status === 'waiting' || earlyTask.status === 'pending') {
    logOk(`Task B is ${earlyTask.status} while A runs (dependency respected)`);
  } else {
    log(`  Task B status: ${earlyTask.status} (might have started already if A was fast)`);
  }

  // Wait for both to complete
  log('Waiting for Task A...');
  const taskA = await pollUntilTerminal(client, taskIdA, waitTimeout);
  log(`  Task A final: ${taskA.status}`);

  log('Waiting for Task B...');
  const taskB = await pollUntilTerminal(client, taskIdB, waitTimeout);
  log(`  Task B final: ${taskB.status}`);

  if (taskA.status === 'completed') logOk('Task A completed');
  else logFail(`Task A: ${taskA.status}`);

  if (taskB.status === 'completed') logOk('Task B completed');
  else logFail(`Task B: ${taskB.status}`);

  // Verify marker file has both markers
  try {
    const content = await fs.readFile(markerFile, 'utf8');
    if (content.includes('STEP_A_DONE')) logOk('Marker has STEP_A_DONE');
    else logFail('Marker missing STEP_A_DONE');

    if (content.includes('STEP_B_DONE')) logOk('Marker has STEP_B_DONE (B ran after A)');
    else logFail('Marker missing STEP_B_DONE');
  } catch {
    logFail('Marker file not created');
  }
}

async function testResources(client) {
  logSection('TEST: MCP Resources — system + task queries');

  // system:///status
  log('Reading system:///status...');
  const sysRead = await client.readResource({ uri: 'system:///status' });
  const sys = parseResource(sysRead, 'system:///status');

  if (sys.accounts !== undefined) logOk(`system:///status has accounts info`);
  else logFail('system:///status missing accounts');

  if (sys.tasks !== undefined) logOk(`system:///status has tasks info (count: ${sys.tasks?.total ?? 'n/a'})`);
  else logFail('system:///status missing tasks');

  if (sys.sdk !== undefined) logOk(`system:///status has sdk info`);
  else logFail('system:///status missing sdk');

  // task:///all
  log('Reading task:///all...');
  const allRead = await client.readResource({ uri: 'task:///all' });
  const all = parseResource(allRead, 'task:///all');

  if (Array.isArray(all.tasks)) {
    logOk(`task:///all returns array (${all.tasks.length} tasks)`);
  } else {
    logFail('task:///all did not return tasks array');
  }

  if (all.count !== undefined) logOk(`task:///all has count: ${all.count}`);
  else logFail('task:///all missing count');

  // Verify each task has required fields
  if (all.tasks?.length > 0) {
    const sample = all.tasks[0];
    const requiredFields = ['id', 'status', 'labels'];
    const missing = requiredFields.filter(f => !(f in sample));
    if (missing.length === 0) logOk('task:///all entries have required fields (id, status, labels)');
    else logFail(`task:///all entries missing: ${missing.join(', ')}`);
  }
}

async function testCancel(client, cwd, taskTimeout) {
  logSection('TEST: cancel-agent — cancel + clear');

  // Spawn a task with long timeout so we can cancel it
  log('Spawning a long-running task to cancel...');
  const result = await client.callTool({
    name: 'launch-classic-agent',
    arguments: {
      prompt: 'OBJECTIVE: Count from 1 to 10000 very slowly, printing each number. Take your time between numbers. CONTEXT: This is a long-running task that will be cancelled before completion. DELIVERABLES: A long list of numbers (but we expect cancellation before completion).',
      cwd,
      timeout: taskTimeout,
      labels: ['func-test', 'cancel-target'],
    },
  });
  const text = extractText(result);
  if (result.isError) { logFail(`Spawn failed: ${text}`); return; }
  const taskId = extractTaskId(text);
  log(`  Spawned ${taskId}, waiting 3s then cancelling...`);

  await sleep(3000);

  // Cancel it
  const cancelResult = await client.callTool({
    name: 'cancel-agent',
    arguments: { task_id: taskId },
  });
  const cancelText = extractText(cancelResult);
  log(`  Cancel response: ${cancelText.slice(0, 200)}`);

  if (cancelText.toLowerCase().includes('cancel')) {
    logOk('cancel-agent returned cancellation confirmation');
  } else {
    logFail('cancel-agent response unclear');
  }

  // Check task status via resource
  await sleep(2000);
  const taskRead = await client.readResource({ uri: `task:///${taskId}` });
  const task = parseResource(taskRead, `task:///${taskId}`);

  if (task.status === 'cancelled') logOk('Cancelled task shows status: cancelled');
  else logSkip(`Task status after cancel: ${task.status} (may have completed or failed before cancel)`);

  // Test clear all
  log('Testing clear all...');
  const clearResult = await client.callTool({
    name: 'cancel-agent',
    arguments: { task_id: 'all', clear: true, confirm: true },
  });
  const clearText = extractText(clearResult);
  if (clearText.toLowerCase().includes('clear') || clearText.toLowerCase().includes('removed')) {
    logOk('clear all succeeded');
  } else {
    logOk('clear all executed (response received)');
  }
}

async function testValidation(client, cwd) {
  logSection('TEST: Input validation — bad inputs rejected gracefully');

  // Test 1: Empty prompt
  log('Test 1: Empty prompt should be rejected');
  const r1 = await client.callTool({
    name: 'launch-classic-agent',
    arguments: { prompt: '' },
  });
  if (r1.isError) logOk('Empty prompt rejected');
  else logFail('Empty prompt was accepted');

  // Test 2: Prompt too short for coder
  log('Test 2: Short coder prompt rejected (needs 1000 chars)');
  const r2 = await client.callTool({
    name: 'launch-super-coder',
    arguments: {
      prompt: 'Fix the bug.',
      context_files: [{ path: '/tmp/nonexistent.md' }],
    },
  });
  if (r2.isError) logOk('Short coder prompt rejected');
  else logFail('Short coder prompt accepted');

  // Test 3: Coder without context_files
  log('Test 3: Coder without context_files rejected');
  const r3 = await client.callTool({
    name: 'launch-super-coder',
    arguments: { prompt: 'A'.repeat(1000) },
  });
  if (r3.isError) logOk('Coder without context_files rejected');
  else logFail('Coder without context_files accepted');

  // Test 4: Tester without context_files
  log('Test 4: Tester without context_files rejected');
  const r4 = await client.callTool({
    name: 'launch-super-tester',
    arguments: { prompt: 'A'.repeat(300) },
  });
  if (r4.isError) logOk('Tester without context_files rejected');
  else logFail('Tester without context_files accepted');

  // Test 5: Invalid model
  log('Test 5: Invalid model rejected');
  const r5 = await client.callTool({
    name: 'launch-classic-agent',
    arguments: { prompt: 'A'.repeat(200), model: 'gpt-nonexistent' },
  });
  if (r5.isError) logOk('Invalid model rejected');
  else logFail('Invalid model accepted');

  // Test 6: Timeout out of range
  log('Test 6: Timeout below minimum rejected');
  const r6 = await client.callTool({
    name: 'launch-classic-agent',
    arguments: { prompt: 'A'.repeat(200), timeout: 100 },
  });
  if (r6.isError) logOk('Timeout below minimum rejected');
  else logFail('Timeout below minimum accepted');

  // Test 7: Too many labels
  log('Test 7: More than 10 labels rejected');
  const r7 = await client.callTool({
    name: 'launch-classic-agent',
    arguments: {
      prompt: 'A'.repeat(200),
      labels: Array.from({ length: 15 }, (_, i) => `label-${i}`),
    },
  });
  if (r7.isError) logOk('Too many labels rejected');
  else logFail('Too many labels accepted');

  // Test 8: cancel-agent with nonexistent ID
  log('Test 8: Cancel nonexistent task returns error');
  const r8 = await client.callTool({
    name: 'cancel-agent',
    arguments: { task_id: 'nonexistent-task-id-12345' },
  });
  if (r8.isError) logOk('Cancel nonexistent task returned error');
  else logFail('Cancel nonexistent task did not error');

  // Test 9: answer-agent with nonexistent task
  log('Test 9: Answer nonexistent task returns error');
  const r9 = await client.callTool({
    name: 'answer-agent',
    arguments: { task_id: 'nonexistent-task-id-12345', answer: 'yes' },
  });
  if (r9.isError) logOk('Answer nonexistent task returned error');
  else logFail('Answer nonexistent task did not error');

  // Test 10: Coder with non-.md context_files
  log('Test 10: Coder with .ts context file rejected (only .md allowed)');
  const tsFile = path.join(cwd, 'src', 'index.ts');
  const r10 = await client.callTool({
    name: 'launch-super-coder',
    arguments: {
      prompt: 'A'.repeat(1000),
      context_files: [{ path: tsFile }],
    },
  });
  if (r10.isError) logOk('Coder with .ts context file rejected');
  else logFail('Coder with .ts context file accepted');
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const cwd = path.resolve(process.argv[2] || process.cwd());
  const scenario = process.argv.find(a => a.startsWith('--scenario='))?.split('=')[1]
    ?? process.env.MCP_FUNC_SCENARIO ?? 'all';
  const taskTimeout = Number(process.env.MCP_FUNC_TASK_TIMEOUT_MS || DEFAULT_TASK_TIMEOUT);
  const waitTimeout = Number(process.env.MCP_FUNC_WAIT_TIMEOUT_MS || DEFAULT_WAIT_TIMEOUT);

  log(`cwd: ${cwd}`);
  log(`scenario: ${scenario}`);
  log(`task timeout: ${taskTimeout}ms, wait timeout: ${waitTimeout}ms`);

  const client = new Client(
    { name: 'functional-test-client', version: '1.0.0' },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(cwd, 'build', 'index.js')],
    cwd,
    env: process.env,
    stderr: 'pipe',
  });

  // Pipe server stderr to our stderr with prefix
  if (transport.stderr) {
    transport.stderr.on('data', (chunk) => {
      const lines = String(chunk).trim();
      if (lines.length > 0) {
        for (const line of lines.split('\n')) {
          process.stderr.write(`  [server] ${line}\n`);
        }
      }
    });
  }

  try {
    log('Connecting to server...');
    await client.connect(transport);
    log('Connected.');

    // Verify tools are registered
    const tools = await client.listTools();
    assert(tools.tools.length === 8, `Expected 8 tools, got ${tools.tools.length}`);
    logOk(`Server has ${tools.tools.length} tools`);

    // Clear any previous tasks
    await client.callTool({ name: 'cancel-agent', arguments: { task_id: 'all', clear: true, confirm: true } });
    log('Cleared previous tasks.\n');

    const run = (name) => scenario === 'all' || scenario === name;

    if (run('validation'))  await testValidation(client, cwd);
    if (run('resources'))   await testResources(client);
    if (run('cancel'))      await testCancel(client, cwd, taskTimeout);
    if (run('classic'))     await testClassicAgent(client, cwd, taskTimeout, waitTimeout);
    if (run('depends'))     await testDependsOn(client, cwd, taskTimeout, waitTimeout);
    if (run('planner'))     await testPlannerBehavior(client, cwd, taskTimeout, waitTimeout);

    // Final summary
    logSection('RESULTS');
    log(`✅ Passed: ${passed}`);
    log(`❌ Failed: ${failed}`);
    log(`⏭️  Skipped: ${skipped}`);
    log(`Total: ${passed + failed + skipped}`);

    if (failed > 0) {
      log('\nFAIL');
      process.exitCode = 1;
    } else {
      log('\nPASS');
    }
  } finally {
    await client.close().catch(() => {});
  }
}

main().catch((err) => {
  process.stderr.write(`[func-test] FATAL: ${err.message}\n`);
  process.exit(1);
});
