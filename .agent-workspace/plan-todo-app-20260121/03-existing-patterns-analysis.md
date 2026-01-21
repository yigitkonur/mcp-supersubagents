# Existing Patterns Analysis

## Code Architecture Patterns

### Pattern 1: Manager Classes
**Location**: `src/services/task-manager.ts`

**Pattern Description**:
- Singleton manager class handling state
- Private Map for storage: `Map<string, TaskState>`
- Methods for CRUD operations
- Automatic cleanup with intervals
- TTL-based data retention

**Application to Todo App**:
```typescript
class TodoManager {
  private todos: Map<string, Todo> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;
  
  // Similar CRUD methods
  createTodo(data: CreateTodoInput): Todo
  getTodo(id: string): Todo | null
  updateTodo(id: string, updates: Partial<Todo>): Todo | null
  deleteTodo(id: string): boolean
}
```

### Pattern 2: Tool Definition Structure
**Location**: `src/tools/spawn-task.ts`, `src/tools/get-status.ts`

**Pattern Description**:
- Export tool definition object
- Export handler function separately
- Zod schema for input validation
- Consistent error handling
- Return format: `{ content: [{ type: 'text', text: JSON }] }`

**Application to Todo App**:
```typescript
export const createTodoTool = {
  name: 'create_todo',
  description: 'Create a new todo item',
  inputSchema: zodToJsonSchema(CreateTodoSchema)
};

export async function handleCreateTodo(args: unknown) {
  const input = CreateTodoSchema.parse(args);
  const todo = todoManager.createTodo(input);
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ success: true, todo })
    }]
  };
}
```

### Pattern 3: Type Safety with TypeScript
**Location**: `src/types.ts`

**Pattern Description**:
- Dedicated types file
- Enums for constants
- Interfaces for data structures
- Clear separation of concerns

**Application to Todo App**:
```typescript
// src/types.ts additions
export enum TodoStatus {
  ACTIVE = 'active',
  COMPLETED = 'completed',
  DELETED = 'deleted',
}

export enum Priority {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
}

export interface Todo {
  id: string;
  title: string;
  // ... rest of properties
}
```

### Pattern 4: ID Generation
**Location**: `src/services/task-manager.ts` (line 55)

**Pattern Description**:
- Using nanoid for unique IDs
- 12 character length
- URL-safe characters

**Application to Todo App**:
```typescript
import { nanoid } from 'nanoid';

createTodo(input: CreateTodoInput): Todo {
  const id = nanoid(12);
  // ... create todo
}
```

### Pattern 5: Server Registration
**Location**: `src/index.ts`

**Pattern Description**:
- Central server setup
- Tool registration in array
- Switch-case for request routing
- Graceful shutdown handling

**Application to Todo App**:
```typescript
// Add to tools array
const tools = [
  spawnTaskTool, 
  getTaskStatusTool, 
  listTasksTool, 
  resumeTaskTool,
  createTodoTool,      // NEW
  getTodoTool,         // NEW
  listTodosTest,       // NEW
  updateTodoTool,      // NEW
  deleteTodoTool,      // NEW
  toggleTodoTool,      // NEW
];

// Add cases in CallToolRequestSchema handler
case 'create_todo': return handleCreateTodo(args);
case 'get_todo': return handleGetTodo(args);
// ... etc
```

## File Organization Patterns

### Current Structure
```
src/
├── index.ts              # Server entry point
├── types.ts              # Type definitions
├── models.ts             # Model configurations
├── services/             # Business logic
│   ├── task-manager.ts
│   └── process-spawner.ts
├── tools/                # MCP tool handlers
│   ├── spawn-task.ts
│   ├── get-status.ts
│   ├── list-tasks.ts
│   └── resume-task.ts
├── templates/            # Agent templates
└── utils/                # Utilities
    └── sanitize.ts
```

### Proposed Structure for Todo App
```
src/
├── services/
│   ├── task-manager.ts       # Existing
│   └── todo-manager.ts       # NEW: Todo state management
├── tools/
│   ├── todo/                 # NEW: Group todo tools
│   │   ├── create-todo.ts
│   │   ├── get-todo.ts
│   │   ├── list-todos.ts
│   │   ├── update-todo.ts
│   │   ├── delete-todo.ts
│   │   └── toggle-todo.ts
└── types.ts                  # Add Todo types here
```

## Key Learnings

### 1. State Management
- Use Map for O(1) lookups
- Implement cleanup intervals
- Consider TTL for data lifecycle

### 2. Error Handling
- Parse inputs with Zod schemas
- Try-catch in handlers
- Return consistent error format

### 3. Persistence Strategy
- Current system: in-memory only
- Need to add: periodic snapshots to file
- Pattern: Similar to cleanup interval

### 4. Response Format
- Always return MCP-compliant format
- Wrap JSON in text content block
- Include success/error flags

### 5. Testing Integration
- Follow existing test patterns
- Test files in root: `*-test.js`
- Direct MCP server invocation
