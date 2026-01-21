# Task 05: Implement Get & List Todo Tools

## Task ID
TASK-005

## Priority
MEDIUM

## Complexity
MEDIUM (2 hours)

## Description
Create two MCP tools: one for retrieving a single todo by ID, and another for listing todos with advanced filtering and pagination.

## Prerequisites
- TASK-003 completed (TodoManager exists)

## Files to Create

### 1. src/tools/todo/get-todo.ts (New File)
**Estimated Lines**: 50-60

```typescript
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { todoManager } from '../../services/todo-manager.js';

const GetTodoSchema = z.object({
  id: z.string().min(1),
});

export const getTodoTool = {
  name: 'get_todo',
  description: 'Get a single todo by its ID',
  inputSchema: zodToJsonSchema(GetTodoSchema),
};

export async function handleGetTodo(args: unknown) {
  try {
    const { id } = GetTodoSchema.parse(args);
    
    const todo = todoManager.getTodo(id);
    
    if (!todo) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: 'Todo not found',
          }, null, 2),
        }],
      };
    }
    
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          todo,
        }, null, 2),
      }],
    };
  } catch (error: any) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: false,
          error: error.message || 'Failed to get todo',
        }, null, 2),
      }],
    };
  }
}
```

### 2. src/tools/todo/list-todos.ts (New File)
**Estimated Lines**: 100-120

```typescript
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { todoManager } from '../../services/todo-manager.js';
import { Priority, TodoStatus } from '../../types.js';

const ListTodosSchema = z.object({
  status: z.nativeEnum(TodoStatus).optional(),
  priority: z.nativeEnum(Priority).optional(),
  tags: z.array(z.string()).optional(),
  search: z.string().optional(),
  dueBefore: z.string().datetime().optional(),
  dueAfter: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  offset: z.number().int().min(0).optional(),
  sortBy: z.enum(['createdAt', 'updatedAt', 'dueDate', 'priority']).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
});

export const listTodosTool = {
  name: 'list_todos',
  description: 'List todos with optional filtering, sorting, and pagination',
  inputSchema: zodToJsonSchema(ListTodosSchema),
};

export async function handleListTodos(args: unknown) {
  try {
    const options = ListTodosSchema.parse(args);
    
    const result = todoManager.listTodos(options);
    
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          todos: result.todos,
          total: result.total,
          count: result.todos.length,
          options,
        }, null, 2),
      }],
    };
  } catch (error: any) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: false,
          error: error.message || 'Failed to list todos',
        }, null, 2),
      }],
    };
  }
}
```

## Acceptance Criteria

### Functional Criteria - get_todo
- [ ] Returns todo by ID if exists
- [ ] Returns error if todo not found
- [ ] Returns error if ID is empty
- [ ] Doesn't return deleted todos

### Functional Criteria - list_todos
- [ ] Lists all todos when no filters
- [ ] Filters by status (active/completed)
- [ ] Filters by priority
- [ ] Filters by tags (any match)
- [ ] Searches title and description
- [ ] Filters by due date range
- [ ] Supports pagination (limit/offset)
- [ ] Sorts by any field (asc/desc)
- [ ] Returns total count and filtered count
- [ ] Doesn't return deleted todos

### Code Quality Criteria
- [ ] Zod schema validation
- [ ] Proper error handling
- [ ] MCP-compliant responses
- [ ] TypeScript strict mode
- [ ] Follows existing patterns

### Testing Criteria
- [ ] get_todo finds existing todo
- [ ] get_todo returns error for invalid ID
- [ ] list_todos returns all when no filter
- [ ] Each filter works independently
- [ ] Multiple filters work together
- [ ] Pagination works correctly
- [ ] Sorting works for all fields

## Implementation Steps

### For get-todo.ts:
1. Create file in src/tools/todo/
2. Define GetTodoSchema
3. Export getTodoTool definition
4. Implement handleGetTodo
5. Handle not found case

### For list-todos.ts:
1. Create file in src/tools/todo/
2. Define ListTodosSchema with all options
3. Export listTodosTool definition
4. Implement handleListTodos
5. Pass options to todoManager
6. Format response with metadata

## Validation Commands

```bash
# Compile
npm run build

# Test get_todo
npx @modelcontextprotocol/inspector --cli node build/index.js \
  --method tools/call --tool-name get_todo \
  --tool-arg 'id=abc123'

# Test list_todos - all
npx @modelcontextprotocol/inspector --cli node build/index.js \
  --method tools/call --tool-name list_todos

# Test list_todos - filtered
npx @modelcontextprotocol/inspector --cli node build/index.js \
  --method tools/call --tool-name list_todos \
  --tool-arg 'status=active' \
  --tool-arg 'priority=high' \
  --tool-arg 'limit=10'

# Test list_todos - search
npx @modelcontextprotocol/inspector --cli node build/index.js \
  --method tools/call --tool-name list_todos \
  --tool-arg 'search=groceries'
```

## Dependencies
- **Depends On**: TASK-003 (TodoManager)
- **Blocks**: TASK-010 (server integration)

## Rollback Plan
1. Delete src/tools/todo/get-todo.ts
2. Delete src/tools/todo/list-todos.ts
3. Rebuild project

## Notes
- list_todos is the most complex tool
- Limit max 1000 todos per page
- Return both total and filtered count
- Search is case-insensitive
- Tag filter uses "any" match logic
- Date filters use ISO 8601 strings
- Default sort: createdAt desc (newest first)
