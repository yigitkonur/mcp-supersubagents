# Task 07: Implement Toggle Todo Tool

## Task ID
TASK-007

## Priority
LOW

## Complexity
SMALL (30 minutes)

## Description
Create a convenience MCP tool for quickly toggling a todo's completion status. This is a simplified version of update_todo focused solely on the completed field.

## Prerequisites
- TASK-003 completed (TodoManager exists)

## Files to Create

### 1. src/tools/todo/toggle-todo.ts (New File)
**Estimated Lines**: 50-60

```typescript
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { todoManager } from '../../services/todo-manager.js';

const ToggleTodoSchema = z.object({
  id: z.string().min(1),
});

export const toggleTodoTool = {
  name: 'toggle_todo',
  description: 'Toggle a todo\'s completion status (completed <-> active)',
  inputSchema: zodToJsonSchema(ToggleTodoSchema),
};

export async function handleToggleTodo(args: unknown) {
  try {
    const { id } = ToggleTodoSchema.parse(args);
    
    const todo = todoManager.toggleTodo(id);
    
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
          message: `Todo marked as ${todo.completed ? 'completed' : 'active'}`,
          newStatus: todo.completed ? 'completed' : 'active',
        }, null, 2),
      }],
    };
  } catch (error: any) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: false,
          error: error.message || 'Failed to toggle todo',
        }, null, 2),
      }],
    };
  }
}
```

## Acceptance Criteria

### Functional Criteria
- [ ] Accepts only ID as input
- [ ] Toggles completed: true → false
- [ ] Toggles completed: false → true
- [ ] Updates completedAt timestamp
- [ ] Returns updated todo
- [ ] Returns new status in message
- [ ] Returns error if todo not found

### Code Quality Criteria
- [ ] Zod schema validation
- [ ] Proper error handling
- [ ] MCP-compliant responses
- [ ] TypeScript strict mode
- [ ] Follows existing patterns
- [ ] Simple and focused

### Testing Criteria
- [ ] Toggle active todo to completed
- [ ] Toggle completed todo to active
- [ ] Toggle sets completedAt when completing
- [ ] Toggle clears completedAt when uncompleting
- [ ] Toggle non-existent todo returns error

## Implementation Steps

1. Create src/tools/todo/toggle-todo.ts
2. Import dependencies
3. Define ToggleTodoSchema (only ID)
4. Export toggleTodoTool definition
5. Implement handleToggleTodo
6. Parse ID from args
7. Call todoManager.toggleTodo()
8. Include status message in response
9. Handle not found case
10. Build and test

## Validation Commands

```bash
# Compile
npm run build

# Test toggle - mark as complete
npx @modelcontextprotocol/inspector --cli node build/index.js \
  --method tools/call --tool-name toggle_todo \
  --tool-arg 'id=abc123'

# Test toggle - mark as active (run again)
npx @modelcontextprotocol/inspector --cli node build/index.js \
  --method tools/call --tool-name toggle_todo \
  --tool-arg 'id=abc123'

# Test toggle - invalid ID
npx @modelcontextprotocol/inspector --cli node build/index.js \
  --method tools/call --tool-name toggle_todo \
  --tool-arg 'id=invalid'
```

## Dependencies
- **Depends On**: TASK-003 (TodoManager)
- **Blocks**: TASK-010 (server integration)

## Rollback Plan
1. Delete src/tools/todo/toggle-todo.ts
2. Rebuild project

## Notes
- This is a convenience tool for common operation
- Simpler than update_todo for single use case
- Better UX for users who just want to complete/uncomplete
- No need to specify completed=true/false
- Message makes it clear what happened
- Could be implemented as wrapper around update_todo
- Following REST API patterns (PATCH with toggle action)
