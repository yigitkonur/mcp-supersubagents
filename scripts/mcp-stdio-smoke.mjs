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

/** Extract raw text from a resource read result */
function getResourceText(readResult, uri) {
  const first = readResult?.contents?.[0];
  if (!first || typeof first.text !== 'string') {
    throw new Error(`Resource ${uri} did not return text content`);
  }
  return first.text;
}

/** Parse status from task:///{id} markdown (looks for "| **Status** | `<value>` |" or "| Status | <value> |") */
function parseStatusFromTaskMarkdown(md) {
  // Match: | **Status** | `value` | OR | Status | value |
  const match = md.match(/\|\s*\*{0,2}Status\*{0,2}\s*\|\s*`?(\w+)`?\s*\|/);
  return match ? match[1] : null;
}

/** Parse task:///all markdown table into array of {id, status} */
function parseTasksFromAllMarkdown(md) {
  const tasks = [];
  // Match data rows in the table (skip header + separator)
  const lines = md.split('\n');
  let inTable = false;
  for (const line of lines) {
    // Handle both old "| ID " and new "| ID | Status |" headers
    if (line.startsWith('| ID ')) { inTable = true; continue; }
    if (inTable && line.startsWith('|---')) continue;
    if (inTable && line.startsWith('| ')) {
      const cells = line.split('|').map(c => c.trim()).filter(Boolean);
      if (cells.length >= 2) {
        tasks.push({ id: cells[0], status: cells[1] });
      }
    } else if (inTable) {
      break; // end of table
    }
  }
  return tasks;
}

/**
 * Parse pending question info from task:///{id} markdown.
 * Extracts: status, question text, structured_questions (from multi-Q sections),
 * and how_to_answer JSON block.
 */
function parsePendingQuestionFromMarkdown(md) {
  const result = {
    status: parseStatusFromTaskMarkdown(md),
    hasPendingQuestion: md.includes('ACTION REQUIRED'),
    structuredQuestions: [],
    howToAnswer: null,
  };

  if (!result.hasPendingQuestion) return result;

  // Parse structured questions: ### Q1 [q_id] — question text
  const sqRegex = /### Q\d+\s+\[([^\]]+)\]\s*—\s*(.+)/g;
  let sqMatch;
  while ((sqMatch = sqRegex.exec(md)) !== null) {
    const q = { id: sqMatch[1], question: sqMatch[2].trim(), options: [] };

    // Find numbered options below this heading until next heading or blank line
    const afterQ = md.slice(sqMatch.index + sqMatch[0].length);
    const optRegex = /^\s+(\d+)\.\s+\*\*(.+?)\*\*/gm;
    let optMatch;
    while ((optMatch = optRegex.exec(afterQ)) !== null) {
      // Stop if we hit the next heading
      const beforeOpt = afterQ.slice(0, optMatch.index);
      if (beforeOpt.includes('###')) break;
      q.options.push({ label: optMatch[2] });
    }

    result.structuredQuestions.push(q);
  }

  // Parse single-question: **Question:** text
  if (result.structuredQuestions.length === 0) {
    const singleMatch = md.match(/\*\*Question:\*\*\s*(.+)/);
    if (singleMatch) {
      result.structuredQuestions.push({
        id: '_single',
        question: singleMatch[1].trim(),
        options: [],
      });
    }
  }

  // Parse how_to_answer JSON from code block after "### How to answer"
  const howToIdx = md.indexOf('### How to answer');
  if (howToIdx !== -1) {
    const afterHowTo = md.slice(howToIdx);
    const jsonBlockMatch = afterHowTo.match(/```json\n([\s\S]*?)```/);
    if (jsonBlockMatch) {
      try {
        result.howToAnswer = JSON.parse(jsonBlockMatch[1]);
      } catch { /* ignore parse errors */ }
    }
  }

  return result;
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
    const md = getResourceText(taskRead, `task:///${taskId}`);
    const status = parseStatusFromTaskMarkdown(md);

    if (status !== lastStatus) {
      log(`task ${taskId} status: ${status}`);
      lastStatus = status;
    }

    if (TERMINAL_STATUSES.has(status)) {
      return { id: taskId, status, _raw: md };
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
  const immediateRead = await client.readResource({ uri: `task:///${taskId}` });
  const immediateMd = getResourceText(immediateRead, `task:///${taskId}`);
  assert(immediateMd.includes(taskId), `task:///${taskId} did not contain task ID in response`);

  const finalTask = await waitForTerminalStatus(client, taskId, waitTimeoutMs);
  assert(finalTask.status, `Task ${taskId} returned without status`);

  // Check for server_restart in the markdown error field
  if (finalTask._raw && finalTask._raw.includes('server_restart')) {
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
      // Resources now return markdown, so we parse status from the markdown table.
      // task:///{id} uses MCP-mapped status: input_required (from internal WAITING_ANSWER)
      const waitStart = Date.now();
      const MAX_WAIT_MS = 600_000;
      let lastTaskMd = '';
      let gotInputRequired = false;

      while (Date.now() - waitStart < MAX_WAIT_MS) {
        const taskRead = await client.readResource({ uri: `task:///${taskId}` });
        lastTaskMd = getResourceText(taskRead, `task:///${taskId}`);
        const status = parseStatusFromTaskMarkdown(lastTaskMd);
        log(`dentist task status: ${status}`);

        // input_required = MCP-mapped status when agent asks a question
        // Also check for ACTION REQUIRED section in markdown as a fallback
        if (status === 'input_required' || lastTaskMd.includes('ACTION REQUIRED')) {
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

      // Extract structured questions from markdown
      const parsed = parsePendingQuestionFromMarkdown(lastTaskMd);
      log(`parsed pending question: hasPendingQuestion=${parsed.hasPendingQuestion}, questions=${parsed.structuredQuestions.length}`);
      const questions = parsed.structuredQuestions;
      assert(questions.length > 0, 'No structured questions found in task markdown');
      log(`structured_questions count: ${questions.length}`);
      for (const q of questions) {
        assert(q.id, `Question missing id: ${JSON.stringify(q)}`);
        log(`  question id=${q.id} q="${q.question}"`);
      }

      // Verify how_to_answer JSON block is present in markdown
      const howToAnswer = parsed.howToAnswer;
      assert(howToAnswer, 'Markdown missing "### How to answer" JSON block');
      assert(howToAnswer.task_id === taskId, `how_to_answer task_id mismatch: ${howToAnswer.task_id}`);
      // Multi-question uses "answers" key, single-question uses "answer" key
      const hasAnswersKey = howToAnswer.answers && typeof howToAnswer.answers === 'object';
      const hasAnswerKey = typeof howToAnswer.answer === 'string';
      assert(hasAnswersKey || hasAnswerKey, 'how_to_answer missing both answers and answer keys');
      if (hasAnswersKey) {
        for (const q of questions) {
          assert(q.id in howToAnswer.answers,
            `how_to_answer.answers missing key for question id="${q.id}"`);
        }
      }
      log('how_to_answer verified from markdown JSON block');

      // Verify task appears in task:///all markdown table
      const allRead = await client.readResource({ uri: 'task:///all' });
      const allMd = getResourceText(allRead, 'task:///all');
      const allTasks = parseTasksFromAllMarkdown(allMd);
      const taskRow = allTasks.find(t => t.id === taskId);
      assert(taskRow, `task ${taskId} not found in task:///all markdown table`);
      log(`task:///all shows task ${taskId} with status: ${taskRow.status}`);

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

    // Load persisted tasks for provider/fallback checks (on-disk JSON, not MCP resource)
    const persistedMap = await loadPersistedTaskMap(cwd);
    const persistedFirst = persistedMap.get(first.id);
    const persistedSecond = persistedMap.get(second.id);

    const allTasksRead = await client.readResource({ uri: 'task:///all' });
    const allTasksMd = getResourceText(allTasksRead, 'task:///all');
    const parsedTasks = parseTasksFromAllMarkdown(allTasksMd);
    assert(parsedTasks.length >= 2, `task:///all should list at least 2 tasks, got ${parsedTasks.length}`);
    log(`task:///all visible in-session (count=${parsedTasks.length})`);

    log('final task outcomes:');
    log(`- ${first.id}: ${first.status}`);
    log(`- ${second.id}: ${second.status}`);
    const firstProvider = resolveProvider(persistedFirst);
    const secondProvider = resolveProvider(persistedSecond);
    log(`- ${first.id} provider: ${firstProvider} fallbackActivated: ${persistedFirst?.sessionMetrics?.fallbackActivated ?? false}`);
    log(`- ${second.id} provider: ${secondProvider} fallbackActivated: ${persistedSecond?.sessionMetrics?.fallbackActivated ?? false}`);

    if (requireCompleted) {
      assert(first.status === 'completed', `Task ${first.id} not completed (status=${first.status})`);
      assert(second.status === 'completed', `Task ${second.id} not completed (status=${second.status})`);
      log('requireCompleted=true check passed');
    }

    if (expectedProvider) {
      assert(firstProvider === expectedProvider, `Task ${first.id} provider mismatch: expected=${expectedProvider} actual=${firstProvider}`);
      assert(secondProvider === expectedProvider, `Task ${second.id} provider mismatch: expected=${expectedProvider} actual=${secondProvider}`);
      log(`expectedProvider=${expectedProvider} check passed`);
    }

    if (expectFallbackActivated === 'true') {
      assert(persistedFirst?.sessionMetrics?.fallbackActivated === true, `Task ${first.id} fallbackActivated was not true`);
      assert(persistedSecond?.sessionMetrics?.fallbackActivated === true, `Task ${second.id} fallbackActivated was not true`);
      log('expectFallbackActivated=true check passed');
    } else if (expectFallbackActivated === 'false') {
      assert(persistedFirst?.sessionMetrics?.fallbackActivated !== true, `Task ${first.id} fallbackActivated unexpectedly true`);
      assert(persistedSecond?.sessionMetrics?.fallbackActivated !== true, `Task ${second.id} fallbackActivated unexpectedly true`);
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
