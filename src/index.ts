#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { spawnTaskTool, handleSpawnTask } from './tools/spawn-task.js';
import { getTaskStatusTool, handleGetTaskStatus } from './tools/get-status.js';
import { listTasksTool, handleListTasks } from './tools/list-tasks.js';
import { resumeTaskTool, handleResumeTask } from './tools/resume-task.js';
import { taskManager } from './services/task-manager.js';
import { clientContext } from './services/client-context.js';
import { checkCopilotInstalled } from './services/process-spawner.js';

const server = new Server(
  { name: 'copilot-agent', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// Fetch client roots after initialization
server.oninitialized = async () => {
  try {
    const result = await server.listRoots();
    if (result?.roots?.length) {
      clientContext.setRoots(result.roots);
    }
  } catch {
    // Client may not support roots - use server cwd as fallback
  }
};

const tools = [spawnTaskTool, getTaskStatusTool, listTasksTool, resumeTaskTool];

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
