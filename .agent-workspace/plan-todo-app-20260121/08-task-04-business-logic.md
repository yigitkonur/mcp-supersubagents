# Task 04: Implement Create Todo Tool

## Task ID
TASK-004

## Priority
MEDIUM

## Complexity
SMALL (1 hour)

## Description
Create the MCP tool handler for creating new todos. This tool validates input, calls the TodoManager, and returns a properly formatted response.

## Prerequisites
- TASK-003 completed (TodoManager exists)

## Files to Create

### 1. src/tools/todo/create-todo.ts (New File)
**Estimated Lines**: 60-70

**Implementation**:

```typescript
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { todoManager } from '../../services/todo-manager.js';
import { Priority } from '../../types.js';

const CreateTodoSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  priority: z.nativeEnum(Priority).optional(),
  dueDate: z.string().datetime().optional(),
  tags: z.array(z.string()).optional(),
});

export const createTodoTool = {
  name: 'create_todo',
  description: 'Create a new todo item with title, description, priority, due date, and tags',
  inputSchema: zodToJsonSchema(CreateTodoSchema),
};

export async function handleCreateTodo(args: unknown) {
  try {
    const input = CreateTodoSchema.parse(args);
    
    const todo = todoManager.createTodo(input);
    
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          todo,
          message: 'Todo created successfully',
        }, null, 2),
      }],
    };
  } catch (error: any) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: false,
          error: error.message || 'Failed to create todo',
        }, null, 2),
      }],
    };
  }
}
```

## Acceptance Criteria

### Functional Criteria
- [ ] Accepts title (required)
- [ ] Accepts optional description, priority, dueDate, tags
- [ ] Validates title length (1-200 chars)
- [ ] Validates description length (max 2000 chars)
- [ ] Validates priority enum values
- [ ] Validates dueDate is ISO 8601 format
- [ ] Returns created todo with ID
- [ ] Returns error for invalid input

### Code Quality Criteria
- [ ] Follows existing tool patterns
- [ ] Zod schema validation
- [ ] Proper error handling
- [ ] MCP-compliant response format
- [ ] TypeScript strict mode

### Testing Criteria
- [ ] Creates todo with only title
- [ ] Creates todo with all fields
- [ ] Rejects empty title
- [ ] Rejects title >200 chars
- [ ] Rejects invalid priority
- [ ] Rejects invalid date format

## Implementation Steps

1. Create src/tools/todo/ directory
2. Create create-todo.ts file
3. Import dependencies (zod, zodToJsonSchema, todoManager)
4. Define CreateTodoSchema with validation rules
5. Export createTodoTool definition
6. Implement handleCreateTodo with try-catch
7. Parse input with schema
8. Call todoManager.createTodo()
9. Format success response
10. Format error response
11. Build and test

## Validation Commands

```bash
# Compile
npm run build

# Test via MCP inspector
npx @modelcontextprotocol/inspector --cli node build/index.js \
  --method tools/call --tool-name create_todo \
  --tool-arg 'title=Buy groceries'

npx @modelcontextprotocol/inspector --cli node build/index.js \
  --method tools/call --tool-name create_todo \
  --tool-arg 'title=Complete project' \
  --tool-arg 'priority=high' \
  --tool-arg 'tags=["work","urgent"]'
```

## Dependencies
- **Depends On**: TASK-003 (TodoManager)
- **Blocks**: TASK-010 (server integration)

## Rollback Plan
1. Delete src/tools/todo/create-todo.ts
2. Rebuild project

## Notes
- Follow spawn-task.ts pattern exactly
- Use zodToJsonSchema for MCP compliance
- Pretty print JSON responses (null, 2)
- Validate dates are ISO 8601 format
- Max title 200 chars is reasonable limit
- Max description 2000 chars allows detailed todos
