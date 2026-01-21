#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, } from '@modelcontextprotocol/sdk/types.js';
import { spawnTaskTool, handleSpawnTask } from './tools/spawn-task.js';
import { getTaskStatusTool, handleGetTaskStatus } from './tools/get-status.js';
import { listTasksTool, handleListTasks } from './tools/list-tasks.js';
import { resumeTaskTool, handleResumeTask } from './tools/resume-task.js';
import { taskManager } from './services/task-manager.js';
import { checkCopilotInstalled } from './services/process-spawner.js';
const server = new Server({
    name: 'copilot-mcp-server',
    version: '1.0.0',
}, {
    capabilities: {
        tools: {},
    },
});
const tools = [
    spawnTaskTool,
    getTaskStatusTool,
    listTasksTool,
    resumeTaskTool,
];
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: tools.map(tool => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
        })),
    };
});
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    switch (name) {
        case 'spawn_copilot_task':
            return handleSpawnTask(args);
        case 'get_task_status':
            return handleGetTaskStatus(args);
        case 'list_tasks':
            return handleListTasks(args);
        case 'resume_copilot_task':
            return handleResumeTask(args);
        default:
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            success: false,
                            error: `Unknown tool: ${name}`,
                        }),
                    },
                ],
            };
    }
});
async function main() {
    if (!checkCopilotInstalled()) {
        console.error('Warning: Copilot CLI not found at /opt/homebrew/bin/copilot');
    }
    const transport = new StdioServerTransport();
    await server.connect(transport);
    process.on('SIGINT', () => {
        taskManager.shutdown();
        process.exit(0);
    });
    process.on('SIGTERM', () => {
        taskManager.shutdown();
        process.exit(0);
    });
}
main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
});
//# sourceMappingURL=index.js.map