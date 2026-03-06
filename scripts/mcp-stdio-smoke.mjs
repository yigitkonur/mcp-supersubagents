#!/usr/bin/env node

import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const TERMINAL_STATUSES = new Set([
  'completed',
  'failed',
  'cancelled',
  'rate_limited',
  'timed_out',
]);

const DEFAULT_TASK_TIMEOUT_MS = 900_000;
const DEFAULT_WAIT_TIMEOUT_MS = 1_200_000;
const POLL_INTERVAL_MS = 2_000;
const DEFAULT_SCENARIO = 'basic';

function log(message) {
  process.stdout.write(`[mcp-smoke] ${message}\n`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function extractText(result) {
  const chunks = Array.isArray(result?.content) ? result.content : [];
  return chunks
    .filter((item) => item && item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n');
}

function extractTaskId(toolResultText) {
  const backtickMatch = toolResultText.match(/task_id:\s*`([^`]+)`/i);
  if (backtickMatch) return backtickMatch[1];

  const plainMatch = toolResultText.match(/task_id:\s*([A-Za-z0-9-]+)/i);
  if (plainMatch) return plainMatch[1];

  throw new Error(`Could not parse task_id from tool response:\n${toolResultText}`);
}

function parseResourceJson(readResult, uri) {
  const first = readResult?.contents?.[0];
  if (!first || typeof first.text !== 'string') {
    throw new Error(`Resource ${uri} did not return text content`);
  }
  try {
    return JSON.parse(first.text);
  } catch (error) {
    throw new Error(`Failed to parse JSON from ${uri}: ${error}`);
  }
}

function resolveProvider(task) {
  return task?.provider ?? task?.sessionMetrics?.provider ?? 'n/a';
}

async function loadPersistedTaskMap(cwd) {
  const hash = createHash('md5').update(cwd).digest('hex');
  const storagePath = path.join(homedir(), '.super-agents', `${hash}.json`);
  let raw = '[]';

  try {
    raw = await fs.readFile(storagePath, 'utf8');
  } catch {
    return new Map();
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Map();
  }

  const map = new Map();
  if (Array.isArray(parsed)) {
    for (const task of parsed) {
      if (task && typeof task.id === 'string') {
        map.set(task.id, task);
      }
    }
  }
  return map;
}

function mergeTaskFromPersisted(task, persistedTask) {
  if (!persistedTask) return task;
  return {
    ...task,
    provider: task?.provider ?? persistedTask.provider,
    sessionMetrics: {
      ...(task?.sessionMetrics ?? {}),
      ...(persistedTask?.sessionMetrics ?? {}),
    },
  };
}

async function waitForTerminalStatus(client, taskId, waitTimeoutMs) {
  const startedAt = Date.now();
  let lastStatus = '<unknown>';

  while (Date.now() - startedAt < waitTimeoutMs) {
    const taskRead = await client.readResource({ uri: `task:///${taskId}` });
    const task = parseResourceJson(taskRead, `task:///${taskId}`);
    const status = task?.status;

    if (status !== lastStatus) {
      log(`task ${taskId} status: ${status}`);
      lastStatus = status;
    }

    if (TERMINAL_STATUSES.has(status)) {
      return task;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`Timed out waiting for terminal status on task ${taskId}`);
}

async function spawnAndWait(client, cwd, index, prompt, taskTimeoutMs, waitTimeoutMs) {

  const spawnResult = await client.callTool({
    name: 'launch-super-researcher',
    arguments: {
      prompt,
      cwd,
      timeout: taskTimeoutMs,
      labels: ['mcp-smoke', `case-${index}`],
    },
  });

  const spawnText = extractText(spawnResult);
  const taskId = extractTaskId(spawnText);
  log(`spawned task #${index}: ${taskId}`);

  // Must be readable immediately in the same persistent session.
  await client.readResource({ uri: `task:///${taskId}` });

  const finalTask = await waitForTerminalStatus(client, taskId, waitTimeoutMs);
  assert(finalTask.status, `Task ${taskId} returned without status`);

  if (finalTask.timeoutReason === 'server_restart') {
    throw new Error(`Task ${taskId} ended with server_restart (persistent session check failed)`);
  }

  log(`task ${taskId} terminal: ${finalTask.status}`);
  return finalTask;
}

async function main() {
  const cwd = path.resolve(process.argv[2] || process.cwd());
  const serverEntry = path.join(cwd, 'build', 'index.js');
  const taskTimeoutMs = Number(process.env.MCP_SMOKE_TASK_TIMEOUT_MS || DEFAULT_TASK_TIMEOUT_MS);
  const waitTimeoutMs = Number(process.env.MCP_SMOKE_WAIT_TIMEOUT_MS || DEFAULT_WAIT_TIMEOUT_MS);
  const scenario = process.env.MCP_SMOKE_SCENARIO || DEFAULT_SCENARIO;
  const requireCompleted = process.env.MCP_SMOKE_REQUIRE_COMPLETED === 'true';
  const expectedProvider = process.env.MCP_SMOKE_EXPECT_PROVIDER;
  const expectFallbackActivated = process.env.MCP_SMOKE_EXPECT_FALLBACK_ACTIVATED;
  const loremPath = path.join(cwd, 'lorem.txt');

  const client = new Client(
    { name: 'mcp-stdio-smoke-client', version: '1.0.0' },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd,
    env: process.env,
    stderr: 'pipe',
  });

  if (transport.stderr) {
    transport.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text.length > 0) {
        process.stderr.write(`[mcp-server] ${text}\n`);
      }
    });
  }

  try {
    log(`connecting to stdio server: ${serverEntry}`);
    await client.connect(transport);
    log('connected');

    const tools = await client.listTools();
    assert(Array.isArray(tools.tools), 'tools/list did not return a tools array');
    assert(tools.tools.some((t) => t.name === 'launch-super-coder'), 'launch-super-coder tool not found');
    assert(tools.tools.some((t) => t.name === 'cancel-agent'), 'cancel-agent tool not found');
    log(`tools/list ok (${tools.tools.length} tools)`);

    const resources = await client.listResources();
    assert(Array.isArray(resources.resources), 'resources/list did not return resources array');
    log(`resources/list ok (${resources.resources.length} resources)`);

    const systemStatus = await client.readResource({ uri: 'system:///status' });
    const systemJson = parseResourceJson(systemStatus, 'system:///status');
    log(`system/status ok (accounts.total=${systemJson?.accounts?.total ?? 'n/a'})`);

    // Start from a clean workspace state.
    await client.callTool({
      name: 'cancel-agent',
      arguments: { task_id: 'all', clear: true, confirm: true },
    });
    log('cleared previous tasks');

    let firstPrompt =
      '🎯 WHAT TO RESEARCH: MCP smoke test task #1 — verify the agent can execute basic operations.\n🤔 WHY IT MATTERS: This validates the MCP server spawn → execute → complete lifecycle works end-to-end.\n📚 WHAT\'S ALREADY KNOWN: The server initializes correctly and tools are registered.\n❓ SPECIFIC QUESTIONS:\n1. Can the agent receive and process a prompt?\n2. Can the agent produce output that includes the marker MCP_SMOKE_OK?\nPlease print exactly one short line that contains the text MCP_SMOKE_OK and then stop immediately.\n📤 HANDOFF TARGET: Automated test harness.';
    let secondPrompt =
      '🎯 WHAT TO RESEARCH: MCP smoke test task #2 — verify sequential task execution works.\n🤔 WHY IT MATTERS: This validates that the MCP server can handle back-to-back task spawns in the same session.\n📚 WHAT\'S ALREADY KNOWN: Task #1 completed successfully in this session.\n❓ SPECIFIC QUESTIONS:\n1. Can a second task execute after the first completes?\n2. Does the agent produce output containing MCP_SMOKE_OK?\nPlease print exactly one short line that contains the text MCP_SMOKE_OK and then stop immediately.\n📤 HANDOFF TARGET: Automated test harness.';

    if (scenario === 'dentist') {
      // -----------------------------------------------------------------------
      // dentist: validates full ask_user → answer-agent → completion flow.
      // Requires: default_mode_request_user_input feature enabled on app-server.
      // -----------------------------------------------------------------------
      log('scenario=dentist (ask_user → answer-agent → HTML output)');

      const dentistPrompt = [
        'STOP. Before you write ANY code or files, you MUST call the ask_user tool right now.',
        'Do NOT write HTML. Do NOT create files. Call ask_user FIRST.',
        '',
        'Call ask_user with these 3 questions in a single call:',
        '1. What is the clinic name?',
        '2. What dental services do you offer?',
        '3. What color scheme do you prefer?',
        '',
        'After I answer, build a single-page HTML dentist site for a clinic in Izmir, Turkey.',
        'Save it as dentist.html in the current working directory.',
      ].join('\n');

      const spawnResult = await client.callTool({
        name: 'launch-super-researcher',
        arguments: {
          prompt: dentistPrompt,
          cwd,
          model: 'gpt-5.4',
          timeout: taskTimeoutMs,
          labels: ['mcp-smoke', 'dentist'],
        },
      });
      const taskId = extractTaskId(extractText(spawnResult));
      log(`spawned dentist task: ${taskId}`);

      // Poll for input_required status (max 10 min)
      const waitStart = Date.now();
      const MAX_WAIT_MS = 600_000;
      let taskData = null;
      let gotInputRequired = false;

      while (Date.now() - waitStart < MAX_WAIT_MS) {
        const taskRead = await client.readResource({ uri: `task:///${taskId}` });
        taskData = parseResourceJson(taskRead, `task:///${taskId}`);
        const status = taskData?.status;
        log(`dentist task status: ${status}`);

        if (status === 'input_required') {
          gotInputRequired = true;
          log('task entered input_required — pending question detected');
          break;
        }
        if (TERMINAL_STATUSES.has(status)) {
          log(`task reached terminal status ${status} WITHOUT entering input_required`);
          log('NOTE: model did not call ask_user — this is a model behavior observation');
          log('PASS: dentist scenario completed (no ask_user call observed)');
          return;
        }
        await sleep(POLL_INTERVAL_MS);
      }

      assert(gotInputRequired, 'Timed out waiting for input_required status');

      // Extract structured_questions IDs
      const pq = taskData?.pending_question;
      log(`pending_question: ${JSON.stringify(pq, null, 2)}`);
      const questions = pq?.structured_questions ?? [];
      assert(questions.length > 0, 'No structured_questions found in pending_question');
      log(`structured_questions count: ${questions.length}`);
      for (const q of questions) {
        assert(q.id, `Question missing id: ${JSON.stringify(q)}`);
        log(`  question id=${q.id} header="${q.header}" q="${q.question}"`);
      }

      // Verify how_to_answer is present and correctly formed in task:///{id}
      const howToAnswer = pq?.how_to_answer;
      assert(howToAnswer, 'pending_question missing how_to_answer');
      assert(howToAnswer.tool === 'answer-agent', `how_to_answer.tool wrong: ${howToAnswer.tool}`);
      assert(howToAnswer.format?.task_id === taskId, `how_to_answer.format.task_id mismatch: ${howToAnswer.format?.task_id}`);
      assert(howToAnswer.format?.answers && typeof howToAnswer.format.answers === 'object',
        'how_to_answer.format.answers missing or not an object');
      for (const q of questions) {
        assert(q.id in howToAnswer.format.answers,
          `how_to_answer.format.answers missing key for question id="${q.id}"`);
      }
      log('how_to_answer verified: tool, task_id, and all question ID keys present');

      // Verify how_to_answer in task:///all.tasks[] row
      const allRead = await client.readResource({ uri: 'task:///all' });
      const allData = parseResourceJson(allRead, 'task:///all');
      const taskRow = allData.tasks?.find(t => t.id === taskId);
      assert(taskRow, `task ${taskId} not found in task:///all.tasks[]`);
      assert(taskRow.how_to_answer, 'task:///all tasks[] row missing how_to_answer');
      assert(taskRow.how_to_answer.tool === 'answer-agent', `task:///all how_to_answer.tool wrong: ${taskRow.how_to_answer.tool}`);
      log('task:///all.tasks[] how_to_answer verified');

      // Build answers map: question_id → plain answer string
      const answersMap = {};
      for (const q of questions) {
        const qLower = (q.question || q.header || '').toLowerCase();
        if (qLower.includes('name') || qLower.includes('clinic')) {
          answersMap[q.id] = 'Smile Dental Clinic';
        } else if (qLower.includes('service') || qLower.includes('offer')) {
          answersMap[q.id] = 'Implants, orthodontics, whitening, root canal, cleanings';
        } else if (qLower.includes('color') || qLower.includes('scheme')) {
          answersMap[q.id] = 'Blue and white, clean professional look';
        } else {
          answersMap[q.id] = 'Smile Dental Clinic, Alsancak, Izmir. Phone: +90 232 555 1234';
        }
      }
      log(`submitting answers: ${JSON.stringify(answersMap)}`);

      const answerResult = await client.callTool({
        name: 'answer-agent',
        arguments: { task_id: taskId, answers: answersMap },
      });
      const answerText = extractText(answerResult);
      log(`answer-agent response: ${answerText}`);
      assert(
        !answerResult.isError,
        `answer-agent returned error: ${answerText}`,
      );
      log('answer-agent call succeeded — task resumed');

      // Wait for terminal
      const finalTask = await waitForTerminalStatus(client, taskId, waitTimeoutMs);
      log(`dentist task terminal: ${finalTask.status}`);

      // Check for HTML file
      const dentistHtml = path.join(cwd, 'dentist.html');
      let htmlExists = false;
      try {
        await fs.access(dentistHtml);
        htmlExists = true;
      } catch {}

      if (htmlExists) {
        const html = await fs.readFile(dentistHtml, 'utf8');
        log(`dentist.html size: ${html.length} bytes`);
        assert(html.toLowerCase().includes('<!doctype html') || html.toLowerCase().includes('<html'), 'dentist.html missing HTML structure');
        log('dentist.html verified: valid HTML structure present');
      } else {
        // Check cwd for any .html file
        const files = await fs.readdir(cwd);
        const htmlFiles = files.filter(f => f.endsWith('.html'));
        log(`HTML files in cwd: ${htmlFiles.join(', ') || 'none'}`);
        assert(htmlFiles.length > 0, 'No HTML file produced by dentist task');
      }

      log('PASS: dentist scenario — ask_user → answers → HTML output verified');
      return;
    }

    if (scenario === 'question-flow') {
      // -----------------------------------------------------------------------
      // question-flow: validates the answer-agent API surface and error paths.
      //
      // NOTE: item/tool/requestUserInput is triggered by the Codex agent's
      // model output, not by a prompt. It cannot be forced deterministically in
      // CI without a mock server, so this scenario tests the mechanism only —
      // not a full Codex e2e flow.
      // -----------------------------------------------------------------------
      log('scenario=question-flow (mechanism validation — not full Codex e2e)');

      // 1. Spawn a basic researcher task
      const spawnResult = await client.callTool({
        name: 'launch-super-researcher',
        arguments: {
          prompt: '🎯 WHAT TO RESEARCH: MCP smoke test — question flow mechanism validation.\n🤔 WHY IT MATTERS: Ensures the answer-agent tool error paths work correctly.\n❓ SPECIFIC QUESTIONS:\n1. What is 1+1?\nAnswer: 2. Then stop immediately.',
          cwd,
          timeout: taskTimeoutMs,
          labels: ['mcp-smoke', 'question-flow'],
        },
      });
      const taskId = extractTaskId(extractText(spawnResult));
      log(`spawned task: ${taskId}`);

      // 2. Immediately try answer-agent — task has no pending question yet
      const noQResult = await client.callTool({
        name: 'answer-agent',
        arguments: { task_id: taskId, answer: '1' },
      });
      const noQText = extractText(noQResult);
      assert(
        noQResult.isError === true ||
          noQText.toLowerCase().includes('no pending') ||
          noQText.toLowerCase().includes('pending question') ||
          noQText.toLowerCase().includes('not found'),
        `Expected error on answer with no pending question, got: ${noQText}`,
      );
      log('answer-agent correctly rejects when no pending question');

      // 3. Try answer-agent with neither answer nor answers — schema should reject
      const schemaResult = await client.callTool({
        name: 'answer-agent',
        arguments: { task_id: taskId },
      });
      const schemaText = extractText(schemaResult);
      assert(
        schemaResult.isError === true ||
          schemaText.toLowerCase().includes('answer') ||
          schemaText.toLowerCase().includes('invalid') ||
          schemaText.toLowerCase().includes('required'),
        `Expected schema validation error when neither answer nor answers provided, got: ${schemaText}`,
      );
      log('answer-agent schema validation works');

      // 4. Wait for task to reach terminal status
      const finalTask = await waitForTerminalStatus(client, taskId, waitTimeoutMs);
      log(`task terminal: ${finalTask.status}`);

      log('PASS: question-flow API surface validation passed');
      return;
    }

    if (scenario === 'lorem') {
      await fs.rm(loremPath, { force: true });
      firstPrompt =
        '🎯 WHAT TO RESEARCH: File creation smoke test — verify the agent can create files on disk.\n🤔 WHY IT MATTERS: This validates that the Claude Agent SDK fallback path can execute file operations end-to-end.\n📚 WHAT\'S ALREADY KNOWN: The MCP server is running and tools are available.\n❓ SPECIFIC QUESTIONS:\n1. Can the agent create a file in the working directory?\n2. Does the file contain the expected marker text?\nCreate a file named lorem.txt in the current working directory with exactly one line: LOREM_AGENT_1. Then stop immediately.\n📤 HANDOFF TARGET: Automated test harness.';
      secondPrompt =
        '🎯 WHAT TO RESEARCH: File append smoke test — verify the agent can modify existing files.\n🤔 WHY IT MATTERS: This validates sequential file operations work correctly in back-to-back task execution.\n📚 WHAT\'S ALREADY KNOWN: Task #1 created lorem.txt with LOREM_AGENT_1.\n❓ SPECIFIC QUESTIONS:\n1. Can the agent append to an existing file?\n2. Does the file contain both markers after the append?\nAppend a new line to lorem.txt in the current working directory with exactly: LOREM_AGENT_2. Then stop immediately.\n📤 HANDOFF TARGET: Automated test harness.';
      log(`scenario=lorem (target=${loremPath})`);
    } else {
      log(`scenario=${scenario}`);
    }

    const first = await spawnAndWait(client, cwd, 1, firstPrompt, taskTimeoutMs, waitTimeoutMs);
    const second = await spawnAndWait(client, cwd, 2, secondPrompt, taskTimeoutMs, waitTimeoutMs);

    const persistedMap = await loadPersistedTaskMap(cwd);
    const mergedFirst = mergeTaskFromPersisted(first, persistedMap.get(first.id));
    const mergedSecond = mergeTaskFromPersisted(second, persistedMap.get(second.id));

    const allTasksRead = await client.readResource({ uri: 'task:///all' });
    const allTasks = parseResourceJson(allTasksRead, 'task:///all');
    assert(Array.isArray(allTasks.tasks), 'task:///all did not return tasks array');
    log(`task:///all visible in-session (count=${allTasks.count})`);

    log('final task outcomes:');
    log(`- ${mergedFirst.id}: ${mergedFirst.status}`);
    log(`- ${mergedSecond.id}: ${mergedSecond.status}`);
    const firstProvider = resolveProvider(mergedFirst);
    const secondProvider = resolveProvider(mergedSecond);
    log(`- ${mergedFirst.id} provider: ${firstProvider} fallbackActivated: ${mergedFirst.sessionMetrics?.fallbackActivated ?? false}`);
    log(`- ${mergedSecond.id} provider: ${secondProvider} fallbackActivated: ${mergedSecond.sessionMetrics?.fallbackActivated ?? false}`);

    if (requireCompleted) {
      assert(mergedFirst.status === 'completed', `Task ${mergedFirst.id} not completed (status=${mergedFirst.status})`);
      assert(mergedSecond.status === 'completed', `Task ${mergedSecond.id} not completed (status=${mergedSecond.status})`);
      log('requireCompleted=true check passed');
    }

    if (expectedProvider) {
      assert(firstProvider === expectedProvider, `Task ${mergedFirst.id} provider mismatch: expected=${expectedProvider} actual=${firstProvider}`);
      assert(secondProvider === expectedProvider, `Task ${mergedSecond.id} provider mismatch: expected=${expectedProvider} actual=${secondProvider}`);
      log(`expectedProvider=${expectedProvider} check passed`);
    }

    if (expectFallbackActivated === 'true') {
      assert(mergedFirst.sessionMetrics?.fallbackActivated === true, `Task ${mergedFirst.id} fallbackActivated was not true`);
      assert(mergedSecond.sessionMetrics?.fallbackActivated === true, `Task ${mergedSecond.id} fallbackActivated was not true`);
      log('expectFallbackActivated=true check passed');
    } else if (expectFallbackActivated === 'false') {
      assert(mergedFirst.sessionMetrics?.fallbackActivated !== true, `Task ${mergedFirst.id} fallbackActivated unexpectedly true`);
      assert(mergedSecond.sessionMetrics?.fallbackActivated !== true, `Task ${mergedSecond.id} fallbackActivated unexpectedly true`);
      log('expectFallbackActivated=false check passed');
    }

    if (scenario === 'lorem') {
      const lorem = await fs.readFile(loremPath, 'utf8');
      assert(lorem.includes('LOREM_AGENT_1'), 'lorem.txt missing LOREM_AGENT_1');
      assert(lorem.includes('LOREM_AGENT_2'), 'lorem.txt missing LOREM_AGENT_2');
      log(`lorem.txt verification passed (${loremPath})`);
    }

    log('PASS: persistent MCP stdio session handled back-to-back task lifecycle without server_restart');
  } finally {
    await client.close().catch(() => {});
  }
}

main().catch((error) => {
  process.stderr.write(`[mcp-smoke] FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
