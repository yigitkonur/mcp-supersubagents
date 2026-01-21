# Task 03: Implement Todo Manager Service

## Task ID
TASK-003

## Priority
HIGH (Core business logic)

## Complexity
LARGE (3-4 hours)

## Description
Create the central TodoManager service that handles all todo CRUD operations, filtering, searching, and state management. This is the core business logic layer.

## Prerequisites
- TASK-001 completed (type definitions)
- TASK-002 completed (storage layer)

## Files to Create

### 1. src/services/todo-manager.ts (New File)
**Estimated Lines**: 300-350

**Core Responsibilities**:
- Manage in-memory Map of todos
- CRUD operations with validation
- Filtering and search logic
- Periodic persistence to storage
- Cleanup of old deleted todos
- State synchronization

**Class Structure**:

```typescript
import { nanoid } from 'nanoid';
import { 
  Todo, 
  CreateTodoInput, 
  UpdateTodoInput,
  TodoFilterOptions,
  TodoListOptions,
  Priority,
  TodoStatus 
} from '../types.js';
import { todoStorage } from './todo-storage.js';

const MAX_TODOS = 10000;
const SAVE_INTERVAL_MS = 30 * 1000; // 30 seconds
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DELETED_TODO_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

class TodoManager {
  private todos: Map<string, Todo> = new Map();
  private saveInterval: NodeJS.Timeout | null = null;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private initialized: boolean = false;

  constructor() {
    this.initialize();
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    
    // Load existing todos from storage
    this.todos = await todoStorage.loadTodos();
    this.initialized = true;
    
    // Start periodic save
    this.startPeriodicSave();
    
    // Start cleanup
    this.startCleanup();
  }

  private startPeriodicSave(): void {
    this.saveInterval = setInterval(async () => {
      await this.save();
    }, SAVE_INTERVAL_MS);
  }

  private startCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, CLEANUP_INTERVAL_MS);
  }

  private cleanup(): void {
    const now = Date.now();
    const toDelete: string[] = [];

    for (const [id, todo] of this.todos) {
      if (todo.deletedAt) {
        const deletedTime = new Date(todo.deletedAt).getTime();
        if (now - deletedTime > DELETED_TODO_TTL_MS) {
          toDelete.push(id);
        }
      }
    }

    for (const id of toDelete) {
      this.todos.delete(id);
    }

    if (this.todos.size > MAX_TODOS) {
      // Remove oldest deleted todos
      const deleted = Array.from(this.todos.values())
        .filter(t => t.deletedAt)
        .sort((a, b) => 
          new Date(a.deletedAt!).getTime() - new Date(b.deletedAt!).getTime()
        );
      
      const toRemove = deleted.slice(0, this.todos.size - MAX_TODOS);
      for (const todo of toRemove) {
        this.todos.delete(todo.id);
      }
    }
  }

  async save(): Promise<boolean> {
    return await todoStorage.saveTodos(this.todos);
  }

  createTodo(input: CreateTodoInput): Todo {
    const id = nanoid(12);
    const now = new Date().toISOString();
    
    const todo: Todo = {
      id,
      title: input.title.trim(),
      description: input.description?.trim(),
      completed: false,
      priority: input.priority || Priority.MEDIUM,
      dueDate: input.dueDate,
      tags: input.tags || [],
      createdAt: now,
      updatedAt: now,
    };

    this.todos.set(id, todo);
    return todo;
  }

  getTodo(id: string): Todo | null {
    const todo = this.todos.get(id);
    if (!todo || todo.deletedAt) {
      return null;
    }
    return todo;
  }

  updateTodo(id: string, updates: UpdateTodoInput): Todo | null {
    const todo = this.todos.get(id);
    if (!todo || todo.deletedAt) {
      return null;
    }

    const now = new Date().toISOString();
    const updated: Todo = {
      ...todo,
      ...updates,
      updatedAt: now,
    };

    // Handle completion status change
    if (updates.completed !== undefined && updates.completed !== todo.completed) {
      if (updates.completed) {
        updated.completedAt = now;
      } else {
        updated.completedAt = undefined;
      }
    }

    this.todos.set(id, updated);
    return updated;
  }

  deleteTodo(id: string, hard: boolean = false): boolean {
    const todo = this.todos.get(id);
    if (!todo) {
      return false;
    }

    if (hard) {
      this.todos.delete(id);
    } else {
      // Soft delete
      todo.deletedAt = new Date().toISOString();
    }

    return true;
  }

  toggleTodo(id: string): Todo | null {
    return this.updateTodo(id, { 
      completed: !this.getTodo(id)?.completed 
    });
  }

  listTodos(options: TodoListOptions = {}): { todos: Todo[], total: number } {
    let filtered = Array.from(this.todos.values())
      .filter(t => !t.deletedAt);

    // Apply filters
    if (options.status === TodoStatus.COMPLETED) {
      filtered = filtered.filter(t => t.completed);
    } else if (options.status === TodoStatus.ACTIVE) {
      filtered = filtered.filter(t => !t.completed);
    }

    if (options.priority) {
      filtered = filtered.filter(t => t.priority === options.priority);
    }

    if (options.tags && options.tags.length > 0) {
      filtered = filtered.filter(t => 
        options.tags!.some(tag => t.tags.includes(tag))
      );
    }

    if (options.search) {
      const search = options.search.toLowerCase();
      filtered = filtered.filter(t =>
        t.title.toLowerCase().includes(search) ||
        t.description?.toLowerCase().includes(search)
      );
    }

    if (options.dueBefore) {
      filtered = filtered.filter(t => 
        t.dueDate && t.dueDate < options.dueBefore!
      );
    }

    if (options.dueAfter) {
      filtered = filtered.filter(t => 
        t.dueDate && t.dueDate > options.dueAfter!
      );
    }

    const total = filtered.length;

    // Sort
    const sortBy = options.sortBy || 'createdAt';
    const sortOrder = options.sortOrder || 'desc';
    
    filtered.sort((a, b) => {
      const aVal = a[sortBy];
      const bVal = b[sortBy];
      
      if (!aVal && !bVal) return 0;
      if (!aVal) return 1;
      if (!bVal) return -1;
      
      const comparison = aVal > bVal ? 1 : -1;
      return sortOrder === 'asc' ? comparison : -comparison;
    });

    // Pagination
    const offset = options.offset || 0;
    const limit = options.limit || total;
    filtered = filtered.slice(offset, offset + limit);

    return { todos: filtered, total };
  }

  shutdown(): void {
    if (this.saveInterval) {
      clearInterval(this.saveInterval);
      this.saveInterval = null;
    }

    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    // Final save
    this.save().catch(err => console.error('Failed final save:', err));
  }
}

export const todoManager = new TodoManager();
```

## Acceptance Criteria

### Functional Criteria
- [ ] Can create todos with all properties
- [ ] Can retrieve single todo by ID
- [ ] Can update any todo property
- [ ] Can delete todos (soft and hard)
- [ ] Can toggle completion status
- [ ] Can list todos with all filter options
- [ ] Filtering works correctly for all criteria
- [ ] Sorting works for all sort fields
- [ ] Pagination works correctly
- [ ] Search works on title and description

### Code Quality Criteria
- [ ] Follows task-manager.ts patterns
- [ ] Proper error handling
- [ ] TypeScript strict mode compliant
- [ ] Singleton pattern with async initialization
- [ ] Clean separation of concerns
- [ ] Efficient filtering algorithms

### Testing Criteria
- [ ] Periodic save triggers correctly
- [ ] Cleanup removes old deleted todos
- [ ] MAX_TODOS limit enforced
- [ ] Soft delete doesn't return in getTodo
- [ ] Hard delete removes completely
- [ ] All filters work independently and combined

## Implementation Steps

1. Create src/services/todo-manager.ts
2. Import dependencies (nanoid, types, storage)
3. Define constants (MAX, intervals, TTL)
4. Create TodoManager class skeleton
5. Implement constructor and initialize()
6. Implement periodic save logic
7. Implement cleanup logic
8. Implement createTodo()
9. Implement getTodo()
10. Implement updateTodo()
11. Implement deleteTodo()
12. Implement toggleTodo()
13. Implement listTodos() with all filters
14. Implement shutdown()
15. Export singleton instance
16. Test all operations manually

## Validation Commands

```bash
# Compile
npm run build

# Test basic operations
node -e "
const { todoManager } = require('./build/services/todo-manager.js');
setTimeout(async () => {
  const todo = todoManager.createTodo({ title: 'Test Todo' });
  console.log('Created:', todo.id);
  
  const retrieved = todoManager.getTodo(todo.id);
  console.log('Retrieved:', retrieved?.title);
  
  const updated = todoManager.updateTodo(todo.id, { completed: true });
  console.log('Updated completed:', updated?.completed);
  
  const { todos, total } = todoManager.listTodos();
  console.log('Listed:', total, 'todos');
  
  await todoManager.save();
  todoManager.shutdown();
}, 1000);
"
```

## Dependencies
- **Depends On**: TASK-001 (types), TASK-002 (storage)
- **Blocks**: TASK-004, TASK-005, TASK-006, TASK-007, TASK-008, TASK-009

## Rollback Plan
1. Delete src/services/todo-manager.ts
2. Clear .data/todos.json if created
3. Rebuild project

## Notes
- Initialize async to load from storage
- Periodic save every 30 seconds (configurable)
- Cleanup every 5 minutes
- Soft delete keeps data for 7 days
- Follow existing task-manager patterns closely
- Use Map for O(1) lookups
- Efficient filtering with early returns
