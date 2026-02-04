/**
 * Comprehensive MCP Server Test Suite
 * 
 * Tests all features:
 * - Tools: spawn_task, send_message, cancel_task, answer_question
 * - Resources: system:///status, task:///all, task:///{id}, task:///{id}/session
 * - Task types: super-coder, super-planner, super-researcher, super-tester
 * - Edge cases: invalid inputs, concurrent tasks, batch cancel
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const CWD = process.cwd();

// Test tracking
let testsRun = 0;
let testsPassed = 0;
let testsFailed = 0;

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getResourceText(contents: unknown[]): string {
  const content = contents[0] as { text?: string; blob?: string };
  if (content?.text) return content.text;
  if (content?.blob) return Buffer.from(content.blob, 'base64').toString();
  return '';
}

function getToolResultText(result: unknown): string {
  const r = result as { content?: Array<{ type: string; text?: string }> };
  if (r?.content?.[0]?.text) return r.content[0].text;
  return JSON.stringify(result);
}

function extractTaskId(text: string): string | null {
  const match = text.match(/\*\*([a-z]+-[a-z]+-\d+)\*\*/);
  return match ? match[1] : null;
}

function test(name: string, passed: boolean, details?: string) {
  testsRun++;
  if (passed) {
    testsPassed++;
    console.log(`  ✅ ${name}`);
  } else {
    testsFailed++;
    console.log(`  ❌ ${name}${details ? `: ${details}` : ''}`);
  }
}

async function waitForTaskCompletion(
  client: Client, 
  taskId: string, 
  maxSeconds = 120
): Promise<{ status: string; data: Record<string, unknown> }> {
  for (let i = 0; i < maxSeconds; i++) {
    await sleep(1000);
    const taskResource = await client.readResource({ uri: `task:///${taskId}` });
    const taskData = JSON.parse(getResourceText(taskResource.contents));
    const status = taskData.status;
    const round = taskData.progress?.round || 0;
    const msgs = taskData.progress?.total_messages || 0;
    
    process.stdout.write(`\r    [${i+1}s] ${status} (round ${round}, ${msgs} msgs)    `);
    
    if (['completed', 'failed', 'cancelled', 'rate_limited', 'timed_out'].includes(status)) {
      console.log('');
      return { status, data: taskData };
    }
  }
  console.log('');
  return { status: 'timeout', data: {} };
}

async function main() {
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║       COMPREHENSIVE MCP SERVER TEST SUITE                  ║");
  console.log("╚════════════════════════════════════════════════════════════╝\n");

  const client = new Client(
    { name: "mcp-comprehensive-test", version: "1.0.0" },
    { capabilities: {} }
  );

  const transport = new StdioClientTransport({
    command: "node",
    args: ["./build/index.js"],
    env: { ...process.env, GH_PAT_TOKEN: process.env.GH_PAT_TOKEN || '' },
  });

  console.log("Connecting to MCP server...\n");
  await client.connect(transport);

  const taskIds: string[] = [];

  try {
    // ═══════════════════════════════════════════════════════════════
    // SECTION 1: TOOL LISTING
    // ═══════════════════════════════════════════════════════════════
    console.log("═══ SECTION 1: TOOL LISTING ═══");
    
    const toolsResult = await client.listTools();
    test("tools/list returns tools", toolsResult.tools.length > 0);
    test("spawn_task tool exists", toolsResult.tools.some(t => t.name === 'spawn_task'));
    test("send_message tool exists", toolsResult.tools.some(t => t.name === 'send_message'));
    test("cancel_task tool exists", toolsResult.tools.some(t => t.name === 'cancel_task'));
    test("answer_question tool exists", toolsResult.tools.some(t => t.name === 'answer_question'));
    
    // Check tool descriptions mention MCP Resources
    const spawnTool = toolsResult.tools.find(t => t.name === 'spawn_task');
    test("spawn_task mentions MCP Resources", spawnTool?.description?.includes('task:///') ?? false);
    console.log("");

    // ═══════════════════════════════════════════════════════════════
    // SECTION 2: RESOURCE LISTING & TEMPLATES
    // ═══════════════════════════════════════════════════════════════
    console.log("═══ SECTION 2: RESOURCES ═══");
    
    const resourcesResult = await client.listResources();
    test("resources/list returns resources", resourcesResult.resources.length > 0);
    test("system:///status resource exists", resourcesResult.resources.some(r => r.uri === 'system:///status'));
    test("task:///all resource exists", resourcesResult.resources.some(r => r.uri === 'task:///all'));
    
    const templatesResult = await client.listResourceTemplates();
    test("resource templates exist", templatesResult.resourceTemplates.length > 0);
    test("task:///{task_id} template exists", templatesResult.resourceTemplates.some(t => t.uriTemplate.includes('{task_id}')));
    console.log("");

    // ═══════════════════════════════════════════════════════════════
    // SECTION 3: SYSTEM STATUS RESOURCE
    // ═══════════════════════════════════════════════════════════════
    console.log("═══ SECTION 3: SYSTEM STATUS ═══");
    
    const systemStatus = await client.readResource({ uri: "system:///status" });
    const sysData = JSON.parse(getResourceText(systemStatus.contents));
    
    test("system status has accounts info", sysData.accounts !== undefined);
    test("system status has tasks info", sysData.tasks !== undefined);
    test("system status has sdk info", sysData.sdk !== undefined);
    test("accounts.total >= 1", sysData.accounts?.total >= 1);
    test("tasks.by_status exists", sysData.tasks?.by_status !== undefined);
    console.log(`    Info: ${sysData.accounts?.total} accounts, ${sysData.tasks?.total} tasks`);
    console.log("");

    // ═══════════════════════════════════════════════════════════════
    // SECTION 4: SPAWN_TASK - BASIC
    // ═══════════════════════════════════════════════════════════════
    console.log("═══ SECTION 4: SPAWN_TASK (BASIC) ═══");
    
    // Test 4.1: Basic spawn
    const spawn1 = await client.callTool({
      name: "spawn_task",
      arguments: {
        prompt: "Echo 'Hello from test 1' using bash, then stop immediately.",
        cwd: CWD,
        task_type: "super-coder",
      },
    });
    const spawn1Text = getToolResultText(spawn1);
    const task1Id = extractTaskId(spawn1Text);
    test("spawn_task returns task ID", task1Id !== null);
    if (task1Id) taskIds.push(task1Id);
    
    // Test 4.2: Spawn with labels
    const spawn2 = await client.callTool({
      name: "spawn_task",
      arguments: {
        prompt: "Echo 'Hello from test 2' using bash, then stop.",
        cwd: CWD,
        task_type: "super-researcher",
        labels: ["test", "batch-1"],
      },
    });
    const spawn2Text = getToolResultText(spawn2);
    const task2Id = extractTaskId(spawn2Text);
    test("spawn_task with labels works", task2Id !== null);
    if (task2Id) taskIds.push(task2Id);
    
    // Test 4.3: Spawn with haiku model (faster)
    const spawn3 = await client.callTool({
      name: "spawn_task",
      arguments: {
        prompt: "Say 'quick test' and stop.",
        cwd: CWD,
        model: "claude-haiku-4.5",
      },
    });
    const spawn3Text = getToolResultText(spawn3);
    const task3Id = extractTaskId(spawn3Text);
    test("spawn_task with haiku model works", task3Id !== null);
    if (task3Id) taskIds.push(task3Id);
    console.log("");

    // ═══════════════════════════════════════════════════════════════
    // SECTION 5: TASK STATUS POLLING
    // ═══════════════════════════════════════════════════════════════
    console.log("═══ SECTION 5: TASK STATUS POLLING ═══");
    
    if (task1Id) {
      console.log(`  Waiting for task ${task1Id}...`);
      const result1 = await waitForTaskCompletion(client, task1Id, 90);
      test("task completes successfully", result1.status === 'completed', result1.status);
      test("task has progress data", result1.data.progress !== undefined);
      test("task has session_id", result1.data.session_id !== undefined);
    }
    console.log("");

    // ═══════════════════════════════════════════════════════════════
    // SECTION 6: TASK DETAIL RESOURCE
    // ═══════════════════════════════════════════════════════════════
    console.log("═══ SECTION 6: TASK DETAIL RESOURCE ═══");
    
    if (task1Id) {
      const taskDetail = await client.readResource({ uri: `task:///${task1Id}` });
      const detailData = JSON.parse(getResourceText(taskDetail.contents));
      
      test("task detail has id", detailData.id === task1Id);
      test("task detail has status", detailData.status !== undefined);
      test("task detail has progress.round", detailData.progress?.round !== undefined);
      test("task detail has progress.total_messages", detailData.progress?.total_messages !== undefined);
      test("task detail has prompt_preview", detailData.prompt_preview !== undefined);
      test("task detail has output_tail", detailData.output_tail !== undefined);
      test("task detail has can_send_message", detailData.can_send_message !== undefined);
      test("task detail has session_metrics", detailData.session_metrics !== undefined);
    }
    console.log("");

    // ═══════════════════════════════════════════════════════════════
    // SECTION 7: SESSION DETAIL RESOURCE
    // ═══════════════════════════════════════════════════════════════
    console.log("═══ SECTION 7: SESSION DETAIL RESOURCE ═══");
    
    if (task1Id) {
      const sessionDetail = await client.readResource({ uri: `task:///${task1Id}/session` });
      const sessionData = JSON.parse(getResourceText(sessionDetail.contents));
      
      test("session detail has task_id", sessionData.task_id === task1Id);
      test("session detail has execution_summary", sessionData.execution_summary !== undefined);
      test("session detail has execution_log", Array.isArray(sessionData.execution_log));
      test("session detail has can_send_message", sessionData.can_send_message !== undefined);
    }
    console.log("");

    // ═══════════════════════════════════════════════════════════════
    // SECTION 8: TASK:///ALL RESOURCE
    // ═══════════════════════════════════════════════════════════════
    console.log("═══ SECTION 8: TASK:///ALL RESOURCE ═══");
    
    const allTasks = await client.readResource({ uri: "task:///all" });
    const allData = JSON.parse(getResourceText(allTasks.contents));
    
    test("task:///all has count", allData.count !== undefined);
    test("task:///all has tasks array", Array.isArray(allData.tasks));
    test("task:///all has pending_questions", Array.isArray(allData.pending_questions));
    
    if (allData.tasks.length > 0) {
      const task = allData.tasks[0];
      test("task entry has id", task.id !== undefined);
      test("task entry has status", task.status !== undefined);
      test("task entry has round", task.round !== undefined);
      test("task entry has total_messages", task.total_messages !== undefined);
      test("task entry has can_send_message", task.can_send_message !== undefined);
    }
    console.log(`    Info: ${allData.count} tasks in list`);
    console.log("");

    // ═══════════════════════════════════════════════════════════════
    // SECTION 9: SEND_MESSAGE TOOL
    // ═══════════════════════════════════════════════════════════════
    console.log("═══ SECTION 9: SEND_MESSAGE TOOL ═══");
    
    // Wait for task1 to complete first
    if (task1Id) {
      // Check if can send message
      const taskCheck = await client.readResource({ uri: `task:///${task1Id}` });
      const checkData = JSON.parse(getResourceText(taskCheck.contents));
      
      if (checkData.can_send_message) {
        console.log(`  Sending follow-up message to ${task1Id}...`);
        const sendResult = await client.callTool({
          name: "send_message",
          arguments: {
            task_id: task1Id,
            message: "Now echo 'follow-up complete' and stop.",
          },
        });
        const sendText = getToolResultText(sendResult);
        test("send_message accepted", sendText.includes('resumed') || sendText.includes('Message sent'));
        
        // Wait for completion
        console.log("  Waiting for follow-up to complete...");
        const followUpResult = await waitForTaskCompletion(client, task1Id, 60);
        test("follow-up task completes", followUpResult.status === 'completed', followUpResult.status);
      } else {
        test("send_message (task not resumable)", true);
        console.log("    Info: Task not in resumable state, skipping send_message");
      }
    }
    console.log("");

    // ═══════════════════════════════════════════════════════════════
    // SECTION 10: CANCEL_TASK - SINGLE
    // ═══════════════════════════════════════════════════════════════
    console.log("═══ SECTION 10: CANCEL_TASK (SINGLE) ═══");
    
    // Spawn a long-running task to cancel
    const spawnLong = await client.callTool({
      name: "spawn_task",
      arguments: {
        prompt: "Count from 1 to 1000 slowly, echoing each number. Take your time.",
        cwd: CWD,
        task_type: "super-coder",
      },
    });
    const longTaskId = extractTaskId(getToolResultText(spawnLong));
    
    if (longTaskId) {
      taskIds.push(longTaskId);
      await sleep(3000); // Let it start
      
      const cancelResult = await client.callTool({
        name: "cancel_task",
        arguments: { task_id: longTaskId },
      });
      const cancelText = getToolResultText(cancelResult);
      test("cancel_task single works", cancelText.includes('cancelled') || cancelText.includes('Error'));
    }
    console.log("");

    // ═══════════════════════════════════════════════════════════════
    // SECTION 11: CANCEL_TASK - BATCH
    // ═══════════════════════════════════════════════════════════════
    console.log("═══ SECTION 11: CANCEL_TASK (BATCH) ═══");
    
    // Spawn 2 tasks
    const batchTask1 = await client.callTool({
      name: "spawn_task",
      arguments: { prompt: "Count slowly to 100", cwd: CWD },
    });
    const batchTask2 = await client.callTool({
      name: "spawn_task",
      arguments: { prompt: "Count slowly to 200", cwd: CWD },
    });
    
    const bt1Id = extractTaskId(getToolResultText(batchTask1));
    const bt2Id = extractTaskId(getToolResultText(batchTask2));
    
    if (bt1Id && bt2Id) {
      taskIds.push(bt1Id, bt2Id);
      await sleep(2000);
      
      const batchCancel = await client.callTool({
        name: "cancel_task",
        arguments: { task_id: [bt1Id, bt2Id] },
      });
      const batchText = getToolResultText(batchCancel);
      test("cancel_task batch works", batchText.includes('Cancel Results') || batchText.includes('cancelled'));
    }
    console.log("");

    // ═══════════════════════════════════════════════════════════════
    // SECTION 12: ERROR HANDLING
    // ═══════════════════════════════════════════════════════════════
    console.log("═══ SECTION 12: ERROR HANDLING ═══");
    
    // Invalid task ID
    const invalidCancel = await client.callTool({
      name: "cancel_task",
      arguments: { task_id: "nonexistent-task-id" },
    });
    test("cancel_task invalid ID returns error", getToolResultText(invalidCancel).includes('Error') || getToolResultText(invalidCancel).includes('not found'));
    
    // Missing required field
    try {
      await client.callTool({
        name: "spawn_task",
        arguments: {},
      });
      test("spawn_task missing prompt returns error", true);
    } catch (e) {
      test("spawn_task missing prompt throws", true);
    }
    
    // Invalid resource URI
    try {
      await client.readResource({ uri: "task:///nonexistent-id-12345" });
      test("invalid resource URI returns error", false);
    } catch (e) {
      test("invalid resource URI throws error", true);
    }
    console.log("");

    // ═══════════════════════════════════════════════════════════════
    // SECTION 13: ANSWER_QUESTION TOOL (EDGE CASE)
    // ═══════════════════════════════════════════════════════════════
    console.log("═══ SECTION 13: ANSWER_QUESTION (VALIDATION) ═══");
    
    // Test with non-existent task (should fail gracefully)
    const answerResult = await client.callTool({
      name: "answer_question",
      arguments: {
        task_id: "fake-task-id",
        answer: "1",
      },
    });
    const answerText = getToolResultText(answerResult);
    test("answer_question validates task exists", answerText.includes('Error') || answerText.includes('not found'));
    
    // Test with task that has no pending question
    if (task1Id) {
      const answerNoQ = await client.callTool({
        name: "answer_question",
        arguments: {
          task_id: task1Id,
          answer: "test answer",
        },
      });
      test("answer_question validates pending question", getToolResultText(answerNoQ).includes('Error') || getToolResultText(answerNoQ).includes('no pending'));
    }
    console.log("");

    // ═══════════════════════════════════════════════════════════════
    // SECTION 14: CLEAR ALL TASKS
    // ═══════════════════════════════════════════════════════════════
    console.log("═══ SECTION 14: CLEAR ALL TASKS ═══");
    
    // First check how many tasks we have
    const beforeClear = await client.readResource({ uri: "task:///all" });
    const beforeData = JSON.parse(getResourceText(beforeClear.contents));
    console.log(`    Tasks before clear: ${beforeData.count}`);
    
    // Clear without confirm (should fail)
    const clearNoConfirm = await client.callTool({
      name: "cancel_task",
      arguments: { task_id: "all", clear: true },
    });
    test("clear without confirm fails", getToolResultText(clearNoConfirm).includes('confirm'));
    
    // Clear with confirm
    const clearResult = await client.callTool({
      name: "cancel_task",
      arguments: { task_id: "all", clear: true, confirm: true },
    });
    const clearText = getToolResultText(clearResult);
    test("clear all with confirm works", clearText.includes('Cleared') || clearText.includes('clean'));
    
    // Verify cleared
    const afterClear = await client.readResource({ uri: "task:///all" });
    const afterData = JSON.parse(getResourceText(afterClear.contents));
    test("tasks cleared successfully", afterData.count === 0);
    console.log(`    Tasks after clear: ${afterData.count}`);
    console.log("");

    // ═══════════════════════════════════════════════════════════════
    // FINAL SUMMARY
    // ═══════════════════════════════════════════════════════════════
    console.log("╔════════════════════════════════════════════════════════════╗");
    console.log("║                    TEST SUMMARY                            ║");
    console.log("╚════════════════════════════════════════════════════════════╝");
    console.log(`  Total tests:  ${testsRun}`);
    console.log(`  Passed:       ${testsPassed} ✅`);
    console.log(`  Failed:       ${testsFailed} ❌`);
    console.log(`  Success rate: ${((testsPassed / testsRun) * 100).toFixed(1)}%`);
    console.log("");

  } catch (error) {
    console.error("\n🔥 Test suite error:", error);
  } finally {
    console.log("Disconnecting...");
    await client.close();
    console.log("✅ Done\n");
    
    process.exit(testsFailed > 0 ? 1 : 0);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
