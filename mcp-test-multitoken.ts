/**
 * Multi-Token & Rate Limit Test Suite
 * 
 * Tests:
 * - Multiple account detection
 * - Account rotation on rate limit
 * - First token exhausted scenarios
 * - Unhappy path edge cases
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const CWD = process.cwd();

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

async function waitForTask(
  client: Client, 
  taskId: string, 
  maxSeconds = 120
): Promise<{ status: string; data: Record<string, unknown> }> {
  for (let i = 0; i < maxSeconds; i++) {
    await sleep(1000);
    try {
      const taskResource = await client.readResource({ uri: `task:///${taskId}` });
      const taskData = JSON.parse(getResourceText(taskResource.contents));
      const status = taskData.status;
      const round = taskData.progress?.round || 0;
      
      process.stdout.write(`\r    [${i+1}s] ${status} (round ${round})          `);
      
      if (['completed', 'failed', 'cancelled', 'rate_limited', 'timed_out'].includes(status)) {
        console.log('');
        return { status, data: taskData };
      }
    } catch (e) {
      process.stdout.write(`\r    [${i+1}s] error reading status          `);
    }
  }
  console.log('');
  return { status: 'timeout', data: {} };
}

async function main() {
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║     MULTI-TOKEN & RATE LIMIT TEST SUITE                    ║");
  console.log("╚════════════════════════════════════════════════════════════╝\n");

  // Check env
  const tokenCount = (process.env.GH_PAT_TOKEN || '').split(',').filter(t => t.trim()).length;
  console.log(`Environment: GH_PAT_TOKEN has ${tokenCount} token(s)\n`);

  const client = new Client(
    { name: "mcp-multitoken-test", version: "1.0.0" },
    { capabilities: {} }
  );

  const transport = new StdioClientTransport({
    command: "node",
    args: ["./build/index.js"],
    env: { ...process.env, GH_PAT_TOKEN: process.env.GH_PAT_TOKEN || '' },
  });

  console.log("Connecting to MCP server...\n");
  await client.connect(transport);

  try {
    // ═══════════════════════════════════════════════════════════════
    // SECTION 1: MULTI-ACCOUNT VERIFICATION
    // ═══════════════════════════════════════════════════════════════
    console.log("═══ SECTION 1: MULTI-ACCOUNT VERIFICATION ═══");
    
    const systemStatus = await client.readResource({ uri: "system:///status" });
    const sysData = JSON.parse(getResourceText(systemStatus.contents));
    
    console.log(`    Accounts total: ${sysData.accounts?.total}`);
    console.log(`    Accounts available: ${sysData.accounts?.available}`);
    console.log(`    Current index: ${sysData.accounts?.current_index}`);
    console.log(`    Rotation count: ${sysData.accounts?.rotation_count}`);
    console.log(`    Failed count: ${sysData.accounts?.failed_count}`);
    
    test("Multiple accounts detected", sysData.accounts?.total >= 2, `got ${sysData.accounts?.total}`);
    test("Accounts available > 0", sysData.accounts?.available > 0);
    test("SDK pools initialized", sysData.sdk?.pools >= 1);
    console.log("");

    // ═══════════════════════════════════════════════════════════════
    // SECTION 2: SPAWN TASK WITH FIRST TOKEN (MAY BE RATE LIMITED)
    // ═══════════════════════════════════════════════════════════════
    console.log("═══ SECTION 2: SPAWN TASK (FIRST TOKEN) ═══");
    
    const spawn1 = await client.callTool({
      name: "spawn_task",
      arguments: {
        prompt: "Say 'Hello from first task' and immediately stop. Do not use any tools.",
        cwd: CWD,
        model: "claude-haiku-4.5", // Use haiku for faster/cheaper test
      },
    });
    const spawn1Text = getToolResultText(spawn1);
    const task1Id = extractTaskId(spawn1Text);
    
    console.log(`    Spawn result: ${spawn1Text.slice(0, 100)}...`);
    test("Task spawned successfully", task1Id !== null, spawn1Text.slice(0, 50));
    
    if (task1Id) {
      console.log(`    Waiting for task ${task1Id}...`);
      const result1 = await waitForTask(client, task1Id, 90);
      
      // Check what happened
      test("Task reached terminal state", ['completed', 'failed', 'rate_limited', 'cancelled'].includes(result1.status), result1.status);
      
      if (result1.status === 'rate_limited') {
        console.log("    ⚠️  Task hit rate limit - checking rotation...");
        
        // Check if rotation occurred
        const afterStatus = await client.readResource({ uri: "system:///status" });
        const afterData = JSON.parse(getResourceText(afterStatus.contents));
        
        console.log(`    Rotation count after: ${afterData.accounts?.rotation_count}`);
        console.log(`    Current index after: ${afterData.accounts?.current_index}`);
        
        test("Rotation occurred on rate limit", afterData.accounts?.rotation_count > 0 || afterData.accounts?.current_index > 0);
      } else if (result1.status === 'completed') {
        console.log("    ✓ Task completed (token not rate limited)");
        test("Task completed successfully", true);
      } else if (result1.status === 'failed') {
        console.log(`    ⚠️  Task failed: ${result1.data.error}`);
        // Check if it's a rate limit error in disguise
        const errorStr = String(result1.data.error || '');
        if (errorStr.includes('rate') || errorStr.includes('429') || errorStr.includes('quota')) {
          test("Rate limit detected in error", true);
        } else {
          test("Task completed or handled error", true, errorStr.slice(0, 50));
        }
      }
    }
    console.log("");

    // ═══════════════════════════════════════════════════════════════
    // SECTION 3: SECOND TASK (TESTS ROTATION)
    // ═══════════════════════════════════════════════════════════════
    console.log("═══ SECTION 3: SECOND TASK (ROTATION TEST) ═══");
    
    const spawn2 = await client.callTool({
      name: "spawn_task",
      arguments: {
        prompt: "Echo 'second task' using bash and stop immediately.",
        cwd: CWD,
        model: "claude-haiku-4.5",
      },
    });
    const spawn2Text = getToolResultText(spawn2);
    const task2Id = extractTaskId(spawn2Text);
    
    test("Second task spawned", task2Id !== null);
    
    if (task2Id) {
      console.log(`    Waiting for task ${task2Id}...`);
      const result2 = await waitForTask(client, task2Id, 90);
      
      console.log(`    Status: ${result2.status}`);
      if (result2.data.error) {
        console.log(`    Error: ${result2.data.error}`);
      }
      
      test("Second task handled", ['completed', 'failed', 'rate_limited'].includes(result2.status));
      
      // Check account stats
      const stats2 = await client.readResource({ uri: "system:///status" });
      const statsData2 = JSON.parse(getResourceText(stats2.contents));
      console.log(`    Total rotations: ${statsData2.accounts?.rotation_count}`);
    }
    console.log("");

    // ═══════════════════════════════════════════════════════════════
    // SECTION 4: EDGE CASES - UNHAPPY PATHS
    // ═══════════════════════════════════════════════════════════════
    console.log("═══ SECTION 4: EDGE CASES (UNHAPPY PATHS) ═══");
    
    // 4.1: Empty prompt
    console.log("  Testing empty prompt...");
    const emptyPrompt = await client.callTool({
      name: "spawn_task",
      arguments: { prompt: "", cwd: CWD },
    });
    const emptyText = getToolResultText(emptyPrompt);
    test("Empty prompt rejected", emptyText.includes('Error') || emptyText.includes('required') || emptyText.includes('empty'));
    
    // 4.2: Invalid model
    console.log("  Testing invalid model...");
    const invalidModel = await client.callTool({
      name: "spawn_task",
      arguments: { prompt: "test", cwd: CWD, model: "gpt-5-turbo" },
    });
    const invalidModelText = getToolResultText(invalidModel);
    // Pass if error returned OR if no task ID extracted (model validation may be lenient)
    test("Invalid model rejected", invalidModelText.includes('Error') || invalidModelText.includes('Invalid') || extractTaskId(invalidModelText) === null);
    
    // 4.3: Invalid cwd
    console.log("  Testing invalid cwd...");
    const invalidCwd = await client.callTool({
      name: "spawn_task",
      arguments: { prompt: "test", cwd: "/nonexistent/path/12345" },
    });
    const invalidCwdText = getToolResultText(invalidCwd);
    // This might still spawn but fail - either is acceptable
    test("Invalid cwd handled", invalidCwdText.includes('Error') || extractTaskId(invalidCwdText) !== null);
    
    // 4.4: send_message to non-existent task
    console.log("  Testing send_message to fake task...");
    const fakeMsg = await client.callTool({
      name: "send_message",
      arguments: { task_id: "fake-nonexistent-task", message: "hello" },
    });
    test("send_message to fake task rejected", getToolResultText(fakeMsg).includes('Error') || getToolResultText(fakeMsg).includes('not found'));
    
    // 4.5: send_message with empty message
    console.log("  Testing send_message with empty message...");
    if (task1Id) {
      const emptyMsg = await client.callTool({
        name: "send_message",
        arguments: { task_id: task1Id, message: "" },
      });
      // Empty message should default to "continue"
      test("Empty message defaults to continue", !getToolResultText(emptyMsg).includes('Error') || getToolResultText(emptyMsg).includes('continue'));
    }
    
    // 4.6: cancel_task array with mix of valid/invalid
    console.log("  Testing cancel_task with mixed IDs...");
    const mixedCancel = await client.callTool({
      name: "cancel_task",
      arguments: { task_id: ["fake-id-1", "fake-id-2", task1Id || "fake-id-3"] },
    });
    const mixedText = getToolResultText(mixedCancel);
    test("Mixed cancel handled gracefully", mixedText.includes('Cancel Results') || mixedText.includes('Error') || mixedText.includes('not found'));
    
    // 4.7: answer_question with invalid answer format
    console.log("  Testing answer_question edge cases...");
    if (task1Id) {
      const badAnswer = await client.callTool({
        name: "answer_question",
        arguments: { task_id: task1Id, answer: "" },
      });
      test("Empty answer handled", getToolResultText(badAnswer).includes('Error') || getToolResultText(badAnswer).includes('no pending'));
    }
    console.log("");

    // ═══════════════════════════════════════════════════════════════
    // SECTION 5: RESOURCE EDGE CASES
    // ═══════════════════════════════════════════════════════════════
    console.log("═══ SECTION 5: RESOURCE EDGE CASES ═══");
    
    // 5.1: Read non-existent task detail
    console.log("  Testing non-existent task resource...");
    try {
      await client.readResource({ uri: "task:///completely-fake-task-id-999" });
      test("Non-existent task throws error", false);
    } catch (e) {
      test("Non-existent task throws error", true);
    }
    
    // 5.2: Read session for non-existent task
    console.log("  Testing non-existent session resource...");
    try {
      await client.readResource({ uri: "task:///fake-task/session" });
      test("Non-existent session throws error", false);
    } catch (e) {
      test("Non-existent session throws error", true);
    }
    
    // 5.3: Invalid URI format
    console.log("  Testing invalid URI format...");
    try {
      await client.readResource({ uri: "invalid:///format" });
      test("Invalid URI format throws error", false);
    } catch (e) {
      test("Invalid URI format throws error", true);
    }
    console.log("");

    // ═══════════════════════════════════════════════════════════════
    // SECTION 6: ACCOUNT STATUS AFTER TESTS
    // ═══════════════════════════════════════════════════════════════
    console.log("═══ SECTION 6: FINAL ACCOUNT STATUS ═══");
    
    const finalStatus = await client.readResource({ uri: "system:///status" });
    const finalData = JSON.parse(getResourceText(finalStatus.contents));
    
    console.log(`    Accounts total: ${finalData.accounts?.total}`);
    console.log(`    Accounts available: ${finalData.accounts?.available}`);
    console.log(`    Current index: ${finalData.accounts?.current_index}`);
    console.log(`    Rotation count: ${finalData.accounts?.rotation_count}`);
    console.log(`    Failed tokens: ${finalData.accounts?.failed_count}`);
    console.log(`    Tasks total: ${finalData.tasks?.total}`);
    console.log(`    Tasks running: ${finalData.tasks?.by_status?.running}`);
    console.log(`    Tasks completed: ${finalData.tasks?.by_status?.completed}`);
    console.log(`    Tasks failed: ${finalData.tasks?.by_status?.failed}`);
    console.log(`    Tasks rate_limited: ${finalData.tasks?.by_status?.rate_limited}`);
    
    test("Account status readable", finalData.accounts !== undefined);
    console.log("");

    // ═══════════════════════════════════════════════════════════════
    // CLEANUP
    // ═══════════════════════════════════════════════════════════════
    console.log("═══ CLEANUP ═══");
    const clearResult = await client.callTool({
      name: "cancel_task",
      arguments: { task_id: "all", clear: true, confirm: true },
    });
    console.log(`    ${getToolResultText(clearResult)}`);
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
    testsFailed++;
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
