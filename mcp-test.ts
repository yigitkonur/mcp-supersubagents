/**
 * Persistent MCP Client Test Script
 * 
 * Tests the MCP server with a long-lived connection to verify:
 * - Tool listing
 * - Task spawning and completion
 * - Resource reading (task status, system status)
 * - Task cancellation
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const CWD = process.cwd();

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Helper to extract text from resource content
function getResourceText(contents: Array<{ text?: string; blob?: string }>): string {
  const content = contents[0];
  if ('text' in content && content.text) return content.text;
  if ('blob' in content && content.blob) return Buffer.from(content.blob, 'base64').toString();
  return '';
}

// Helper to extract text from tool result
function getToolResultText(result: unknown): string {
  const r = result as { content?: Array<{ type: string; text?: string }> };
  if (r.content && r.content[0] && r.content[0].text) {
    return r.content[0].text;
  }
  return JSON.stringify(result);
}

async function main() {
  console.log("=== MCP Persistent Client Test ===\n");

  // Create client
  const client = new Client(
    { name: "mcp-cli-test", version: "1.0.0" },
    { capabilities: {} }
  );

  // Create transport - spawns the server as a child process
  const transport = new StdioClientTransport({
    command: "node",
    args: ["./build/index.js"],
    env: {
      ...process.env,
      GH_PAT_TOKEN: process.env.GH_PAT_TOKEN || '',
    },
  });

  console.log("Connecting to MCP server...");
  await client.connect(transport);
  console.log("✅ Connected\n");

  try {
    // Test 1: List tools
    console.log("--- TEST 1: List Tools ---");
    const toolsResult = await client.listTools();
    console.log(`Found ${toolsResult.tools.length} tools:`);
    for (const tool of toolsResult.tools) {
      console.log(`  - ${tool.name}`);
    }
    console.log("");

    // Test 2: List resources
    console.log("--- TEST 2: List Resources ---");
    const resourcesResult = await client.listResources();
    console.log(`Found ${resourcesResult.resources.length} resources:`);
    for (const resource of resourcesResult.resources) {
      console.log(`  - ${resource.uri}: ${resource.name}`);
    }
    console.log("");

    // Test 3: Read system status
    console.log("--- TEST 3: Read System Status ---");
    const systemStatus = await client.readResource({ uri: "system:///status" });
    const statusData = JSON.parse(getResourceText(systemStatus.contents as Array<{ text?: string; blob?: string }>));
    console.log(`Accounts: ${statusData.accounts.total} (${statusData.accounts.available} available)`);
    console.log(`Tasks: ${statusData.tasks.total}`);
    console.log("");

    // Test 4: Spawn a task
    console.log("--- TEST 4: Spawn Task ---");
    const spawnResult = await client.callTool({
      name: "spawn_task",
      arguments: {
        prompt: "List the files in the current directory using ls -la. Then say 'DONE' and stop.",
        cwd: CWD,
        task_type: "super-coder",
      },
    });
    const spawnText = getToolResultText(spawnResult);
    console.log(`Spawn result: ${spawnText}`);
    
    // Extract task ID from response
    const taskIdMatch = spawnText.match(/\*\*([a-z]+-[a-z]+-\d+)\*\*/);
    const taskId = taskIdMatch ? taskIdMatch[1] : null;
    console.log(`Task ID: ${taskId}`);
    console.log("");

    if (taskId) {
      // Test 5: Poll task status until completion
      console.log("--- TEST 5: Poll Task Status ---");
      let attempts = 0;
      const maxAttempts = 60; // 60 seconds max
      
      while (attempts < maxAttempts) {
        await sleep(1000);
        attempts++;
        
        const taskResource = await client.readResource({ uri: `task:///${taskId}` });
        const taskData = JSON.parse(getResourceText(taskResource.contents as Array<{ text?: string; blob?: string }>));
        
        const status = taskData.status;
        const round = taskData.progress?.round || 0;
        const messages = taskData.progress?.total_messages || 0;
        
        console.log(`[${attempts}s] Status: ${status}, Round: ${round}, Messages: ${messages}`);
        
        if (status === "completed" || status === "failed" || status === "cancelled") {
          console.log(`\nTask finished with status: ${status}`);
          if (taskData.error) {
            console.log(`Error: ${taskData.error}`);
          }
          if (taskData.output_tail) {
            console.log(`\nOutput tail:\n${taskData.output_tail.slice(-500)}`);
          }
          break;
        }
      }
      console.log("");

      // Test 6: Read task:///all
      console.log("--- TEST 6: Read All Tasks ---");
      const allTasks = await client.readResource({ uri: "task:///all" });
      const allTasksData = JSON.parse(getResourceText(allTasks.contents as Array<{ text?: string; blob?: string }>));
      console.log(`Total tasks: ${allTasksData.count}`);
      for (const task of allTasksData.tasks) {
        console.log(`  - ${task.id}: ${task.status} (round ${task.round}, ${task.total_messages} msgs)`);
      }
      console.log("");

      // Test 7: Cancel/clear task
      console.log("--- TEST 7: Clear Task ---");
      const cancelResult = await client.callTool({
        name: "cancel_task",
        arguments: {
          task_id: taskId,
        },
      });
      const cancelText = getToolResultText(cancelResult);
      console.log(`Cancel result: ${cancelText}`);
      console.log("");
    }

    console.log("=== All Tests Complete ===");
    
  } catch (error) {
    console.error("Test error:", error);
  } finally {
    console.log("\nDisconnecting...");
    await client.close();
    console.log("✅ Disconnected");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
