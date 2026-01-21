# Task 02: Create Storage Layer

## Task ID
TASK-002

## Priority
HIGH (Blocking task - required for persistence)

## Complexity
MEDIUM (2-3 hours)

## Description
Implement a file-based persistence layer for todo data. This service handles reading and writing todos to a JSON file, providing atomic operations and data durability.

## Prerequisites
- TASK-001 completed (type definitions exist)

## Files to Create

### 1. src/services/todo-storage.ts (New File)
**Estimated Lines**: 120-150

**Core Functions**:
- `loadTodos()`: Load todos from file
- `saveTodos()`: Save todos to file atomically
- `ensureStorageFile()`: Initialize storage file if not exists
- Error handling for file operations
- Atomic write with temp file + rename pattern

**Implementation Pattern**:

```typescript
import { promises as fs } from 'fs';
import path from 'path';
import { Todo } from '../types.js';

const STORAGE_DIR = path.join(process.cwd(), '.data');
const STORAGE_FILE = path.join(STORAGE_DIR, 'todos.json');
const TEMP_FILE = path.join(STORAGE_DIR, 'todos.tmp.json');

export class TodoStorage {
  private static instance: TodoStorage;
  
  private constructor() {}
  
  static getInstance(): TodoStorage {
    if (!TodoStorage.instance) {
      TodoStorage.instance = new TodoStorage();
    }
    return TodoStorage.instance;
  }

  async ensureStorageDir(): Promise<void> {
    try {
      await fs.mkdir(STORAGE_DIR, { recursive: true });
    } catch (error) {
      console.error('Failed to create storage dir:', error);
    }
  }

  async loadTodos(): Promise<Map<string, Todo>> {
    await this.ensureStorageDir();
    
    try {
      const data = await fs.readFile(STORAGE_FILE, 'utf-8');
      const todos = JSON.parse(data);
      return new Map(Object.entries(todos));
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return new Map();
      }
      console.error('Failed to load todos:', error);
      return new Map();
    }
  }

  async saveTodos(todos: Map<string, Todo>): Promise<boolean> {
    await this.ensureStorageDir();
    
    try {
      const data = JSON.stringify(
        Object.fromEntries(todos),
        null,
        2
      );
      
      // Atomic write: write to temp, then rename
      await fs.writeFile(TEMP_FILE, data, 'utf-8');
      await fs.rename(TEMP_FILE, STORAGE_FILE);
      
      return true;
    } catch (error) {
      console.error('Failed to save todos:', error);
      return false;
    }
  }

  async clear(): Promise<boolean> {
    try {
      await fs.unlink(STORAGE_FILE);
      return true;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return true; // Already clear
      }
      console.error('Failed to clear todos:', error);
      return false;
    }
  }
}

export const todoStorage = TodoStorage.getInstance();
```

## Acceptance Criteria

### Functional Criteria
- [ ] Can load todos from file into Map
- [ ] Can save Map of todos to file
- [ ] Handles missing file gracefully (returns empty Map)
- [ ] Atomic write prevents corruption
- [ ] Creates storage directory if missing
- [ ] Singleton pattern implemented

### Code Quality Criteria
- [ ] Error handling for all file operations
- [ ] TypeScript strict mode compliant
- [ ] Follows async/await pattern
- [ ] Proper import/export statements
- [ ] Matches existing service patterns

### Testing Criteria
- [ ] Can write and read todos successfully
- [ ] Handles corrupt JSON gracefully
- [ ] Handles permission errors
- [ ] Atomic write prevents partial writes
- [ ] Concurrent writes don't corrupt data

## Implementation Steps

1. Create src/services/todo-storage.ts
2. Import required Node.js modules (fs, path)
3. Import Todo type from types.ts
4. Define storage paths constants
5. Implement TodoStorage class with singleton
6. Implement ensureStorageDir()
7. Implement loadTodos() with error handling
8. Implement saveTodos() with atomic write
9. Implement clear() helper
10. Export singleton instance
11. Run `npm run build` to verify
12. Create manual test to verify read/write

## Validation Commands

```bash
# Compile
npm run build

# Manual test
node -e "
const { todoStorage } = require('./build/services/todo-storage.js');
(async () => {
  const todos = new Map();
  todos.set('test1', { id: 'test1', title: 'Test', completed: false });
  await todoStorage.saveTodos(todos);
  const loaded = await todoStorage.loadTodos();
  console.log('Success:', loaded.size === 1);
})();
"

# Check storage file created
ls -la .data/todos.json
```

## Dependencies
- **Depends On**: TASK-001 (types)
- **Blocks**: TASK-003 (todo-manager needs storage)

## Rollback Plan
1. Delete src/services/todo-storage.ts
2. Delete .data directory if created
3. Rebuild project

## Notes
- Use .data directory for storage (already in .gitignore pattern)
- Atomic write prevents corruption during concurrent writes
- JSON format for human readability
- Consider adding backup mechanism in future
- Map<string, Todo> format matches existing task-manager pattern
