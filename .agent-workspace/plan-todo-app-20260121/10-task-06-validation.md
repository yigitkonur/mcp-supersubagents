# Task 06: Implement Update & Delete Todo Tools

## Task ID
TASK-006

## Priority
MEDIUM

## Complexity
SMALL-MEDIUM (1.5 hours)

## Description
Create MCP tools for updating and deleting todos. Update tool allows partial updates of any field. Delete tool supports both soft and hard deletion.

## Prerequisites
- TASK-003 completed (TodoManager exists)

## Files to Create

### 1. src/tools/todo/update-todo.ts (New File)
**Estimated Lines**: 70-80

```typescript
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { todoManager } from '../../services/todo-manager.js';
import { Priority } from '../../types.js';

const UpdateTodoSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  priority: z.nativeEnum(Priority).optional(),
  dueDate: z.string().datetime().optional(),
  tags: z.array(z.string()).optional(),
  completed: z.boolean().optional(),
});

export const updateTodoTool = {
  name: 'update_todo',
  description: 'Update an existing todo. All fields except ID are optional.',
  inputSchema: zodToJsonSchema(UpdateTodoSchema),
};

export async function handleUpdateTodo(args: unknown) {
  try {
    const { id, ...updates } = UpdateTodoSchema.parse(args);
    
    const todo = todoManager.updateTodo(id, updates);
    
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
          message: 'Todo updated successfully',
        }, null, 2),
      }],
    };
  } catch (error: any) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: false,
          error: error.message || 'Failed to update todo',
        }, null, 2),
      }],
    };
  }
}
```

### 2. src/tools/todo/delete-todo.ts (New File)
**Estimated Lines**: 60-70

```typescript
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { todoManager } from '../../services/todo-manager.js';

const DeleteTodoSchema = z.object({
  id: z.string().min(1),
  hard: z.boolean().optional(),
});

export const deleteTodoTool = {
  name: 'delete_todo',
  description: 'Delete a todo. Use hard=true for permanent deletion, false (default) for soft delete.',
  inputSchema: zodToJsonSchema(DeleteTodoSchema),
};

export async function handleDeleteTodo(args: unknown) {
  try {
    const { id, hard = false } = DeleteTodoSchema.parse(args);
    
    const success = todoManager.deleteTodo(id, hard);
    
    if (!success) {
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
          message: `Todo ${hard ? 'permanently deleted' : 'soft deleted'}`,
          deletionType: hard ? 'hard' : 'soft',
        }, null, 2),
      }],
    };
  } catch (error: any) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: false,
          error: error.message || 'Failed to delete todo',
        }, null, 2),
      }],
    };
  }
}
```

## Acceptance Criteria

### Functional Criteria - update_todo
- [ ] Requires ID (required)
- [ ] All other fields optional
- [ ] Partial updates work (only update provided fields)
- [ ] Validates field constraints (same as create)
- [ ] Returns updated todo
- [ ] Returns error if todo not found
- [ ] Updates completedAt when completed changes

### Functional Criteria - delete_todo
- [ ] Soft delete by default (hard=false)
- [ ] Hard delete when hard=true
- [ ] Soft delete sets deletedAt timestamp
- [ ] Hard delete removes from storage
- [ ] Returns success with deletion type
- [ ] Returns error if todo not found

### Code Quality Criteria
- [ ] Zod schema validation
- [ ] Proper error handling
- [ ] MCP-compliant responses
- [ ] TypeScript strict mode
- [ ] Follows existing patterns

### Testing Criteria
- [ ] Update single field works
- [ ] Update multiple fields works
- [ ] Update with no fields returns error
- [ ] Update non-existent todo returns error
- [ ] Soft delete doesn't return in get/list
- [ ] Hard delete removes permanently
- [ ] Delete non-existent todo returns error

## Implementation Steps

### For update-todo.ts:
1. Create file in src/tools/todo/
2. Define UpdateTodoSchema (all fields optional)
3. Export updateTodoTool definition
4. Implement handleUpdateTodo
5. Destructure ID from updates
6. Call todoManager.updateTodo()
7. Handle not found case

### For delete-todo.ts:
1. Create file in src/tools/todo/
2. Define DeleteTodoSchema
3. Export deleteTodoTool definition
4. Implement handleDeleteTodo
5. Call todoManager.deleteTodo()
6. Return deletion type in response

## Validation Commands

```bash
# Compile
npm run build

# Test update_todo - single field
npx @modelcontextprotocol/inspector --cli node build/index.js \
  --method tools/call --tool-name update_todo \
  --tool-arg 'id=abc123' \
  --tool-arg 'title=Updated title'

# Test update_todo - multiple fields
npx @modelcontextprotocol/inspector --cli node build/index.js \
  --method tools/call --tool-name update_todo \
  --tool-arg 'id=abc123' \
  --tool-arg 'completed=true' \
  --tool-arg 'priority=high'

# Test delete_todo - soft
npx @modelcontextprotocol/inspector --cli node build/index.js \
  --method tools/call --tool-name delete_todo \
  --tool-arg 'id=abc123'

# Test delete_todo - hard
npx @modelcontextprotocol/inspector --cli node build/index.js \
  --method tools/call --tool-name delete_todo \
  --tool-arg 'id=abc123' \
  --tool-arg 'hard=true'
```

## Dependencies
- **Depends On**: TASK-003 (TodoManager)
- **Blocks**: TASK-010 (server integration)

## Rollback Plan
1. Delete src/tools/todo/update-todo.ts
2. Delete src/tools/todo/delete-todo.ts
3. Rebuild project

## Notes
- Update allows partial modifications
- Destructure ID separately from updates object
- Soft delete is default (safer)
- Hard delete is permanent (use with caution)
- Return deletion type for clarity
- Same validation rules as create for updated fields
