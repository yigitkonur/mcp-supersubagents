#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { spawnTaskTool, handleSpawnTask } from './tools/spawn-task.js';
import { getTaskStatusTool, handleGetTaskStatus } from './tools/get-status.js';
import { listTasksTool, handleListTasks } from './tools/list-tasks.js';
import { resumeTaskTool, handleResumeTask } from './tools/resume-task.js';
import { clearTasksTool, handleClearTasks } from './tools/clear-tasks.js';
import { retryTaskTool, handleRetryTask } from './tools/retry-task.js';
import { cancelTaskTool, handleCancelTask } from './tools/cancel-task.js';
import { forceStartTool, handleForceStart } from './tools/force-start.js';
import { taskManager } from './services/task-manager.js';
import { clientContext } from './services/client-context.js';
import { checkCopilotInstalled } from './services/process-spawner.js';

const server = new Server(
  { name: 'copilot-agent', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// Register retry callback for rate-limited tasks
taskManager.onRetry(async (task) => {
  const { spawnCopilotProcess } = await import('./services/process-spawner.js');
  
  console.error(`[index] Retrying task ${task.id}: "${task.prompt.slice(0, 50)}..."`);
  
  try {
    // Spawn a new process with the same parameters, carrying forward retry info
    const newTaskId = await spawnCopilotProcess({
      prompt: task.prompt,
      cwd: task.cwd,
      model: task.model,
      autonomous: task.autonomous ?? true,
      retryInfo: task.retryInfo,
    });
    return newTaskId;
  } catch (err) {
    console.error(`[index] Failed to retry task ${task.id}:`, err);
    return undefined;
  }
});

// Register execute callback for waiting tasks (dependencies satisfied)
taskManager.onExecute(async (task) => {
  const { executeWaitingTask } = await import('./services/process-spawner.js');
  
  console.error(`[index] Executing waiting task ${task.id}: "${task.prompt.slice(0, 50)}..."`);
  await executeWaitingTask(task);
});

server.oninitialized = async () => {
  try {
    const result = await server.listRoots();
    if (result?.roots?.length) {
      clientContext.setRoots(result.roots);
    }
  } catch {
    // Client may not support roots - use server cwd as fallback
  }
  
  // Load persisted tasks for this workspace (also triggers auto-retry for rate-limited tasks)
  const cwd = clientContext.getDefaultCwd();
  taskManager.setCwd(cwd);
};

const tools = [spawnTaskTool, getTaskStatusTool, listTasksTool, resumeTaskTool, clearTasksTool, retryTaskTool, cancelTaskTool, forceStartTool];

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  switch (name) {
    case 'spawn_task': return handleSpawnTask(args);
    case 'get_status': return handleGetTaskStatus(args);
    case 'list_tasks': return handleListTasks(args);
    case 'resume_task': return handleResumeTask(args);
    case 'clear_tasks': return handleClearTasks(request.params.arguments);
    case 'retry_task': return handleRetryTask(request.params.arguments);
    case 'cancel_task': return handleCancelTask(request.params.arguments);
    case 'force_start': return handleForceStart(request.params.arguments);
    default: return { content: [{ type: 'text', text: JSON.stringify({ error: `Unknown: ${name}` }) }] };
  }
});

async function main() {
  if (!checkCopilotInstalled()) console.error('Warning: Copilot CLI not found');
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.on('SIGINT', () => { taskManager.shutdown(); process.exit(0); });
  process.on('SIGTERM', () => { taskManager.shutdown(); process.exit(0); });
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
