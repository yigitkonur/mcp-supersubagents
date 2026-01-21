# Files to Modify List

## New Files to Create

### Core Service Files (1 file)
1. **src/services/todo-manager.ts**
   - Purpose: Central todo state management
   - Lines: ~250-300
   - Pattern: Mirror task-manager.ts structure
   - Dependencies: nanoid, types.ts

### Tool Handler Files (6 files)
2. **src/tools/todo/create-todo.ts**
   - Purpose: Handle todo creation
   - Lines: ~50-60
   - Pattern: Mirror spawn-task.ts

3. **src/tools/todo/get-todo.ts**
   - Purpose: Handle single todo retrieval
   - Lines: ~40-50
   - Pattern: Mirror get-status.ts

4. **src/tools/todo/list-todos.ts**
   - Purpose: Handle todo listing with filters
   - Lines: ~80-100
   - Pattern: Mirror list-tasks.ts with enhanced filtering

5. **src/tools/todo/update-todo.ts**
   - Purpose: Handle todo updates
   - Lines: ~60-70
   - Pattern: Similar to create-todo.ts

6. **src/tools/todo/delete-todo.ts**
   - Purpose: Handle todo deletion
   - Lines: ~40-50
   - Pattern: Simple handler with validation

7. **src/tools/todo/toggle-todo.ts**
   - Purpose: Quick complete/incomplete toggle
   - Lines: ~40-50
   - Pattern: Simplified update operation

### Storage Files (1 file)
8. **src/services/todo-storage.ts**
   - Purpose: File-based persistence layer
   - Lines: ~100-150
   - Pattern: JSON file read/write with atomic operations

### Test Files (1 file)
9. **todo-test.js**
   - Purpose: Integration tests for todo tools
   - Lines: ~150-200
   - Pattern: Mirror advanced-test.js

## Files to Modify

### 1. src/types.ts
**Changes Required**:
- Add Todo interface
- Add Priority enum
- Add TodoStatus enum
- Add CreateTodoInput, UpdateTodoInput interfaces
- Add TodoFilterOptions interface

**Estimated Lines Added**: 60-80

**Location**: Append to end of file

### 2. src/index.ts
**Changes Required**:
- Import 6 new todo tools
- Import 6 new todo handlers
- Add tools to tools array (6 additions)
- Add cases to CallToolRequestSchema handler (6 cases)

**Estimated Lines Added**: 20-25

**Locations**: 
- Lines 7-10: Add imports
- Line 19: Add to tools array
- Lines 26-31: Add switch cases

### 3. package.json
**Changes Required**:
- Add test script for todos: `"test:todo": "node todo-test.js"`

**Estimated Lines Added**: 1

**Location**: Line 14 (in scripts section)

### 4. README.md
**Changes Required**:
- Update tools count from (4) to (10)
- Add todo tools to tools table
- Add usage examples for todo tools
- Add API documentation section for each todo tool

**Estimated Lines Added**: 80-100

**Locations**:
- Line 5: Update count
- Lines 6-12: Expand tools table
- Lines 46-65: Add usage examples
- Lines 69-103: Add API docs

### 5. tsconfig.json
**Changes Required**: None
- Already configured correctly

## File Dependency Graph

```
todo-manager.ts
    ↓
    ├── types.ts (interface definitions)
    ├── todo-storage.ts (persistence)
    └── nanoid (ID generation)

create-todo.ts, get-todo.ts, list-todos.ts, 
update-todo.ts, delete-todo.ts, toggle-todo.ts
    ↓
    ├── todo-manager.ts (state management)
    ├── types.ts (type definitions)
    └── zod (validation)

index.ts
    ↓
    └── All tool files (registration)

todo-test.js
    ↓
    └── index.ts (via MCP protocol)
```

## Modification Order

### Phase 1: Foundation (Files 1-2)
1. Update `src/types.ts` - Add type definitions
2. Create `src/services/todo-storage.ts` - Add persistence

### Phase 2: Core Service (File 3)
3. Create `src/services/todo-manager.ts` - Main state management

### Phase 3: Tools (Files 4-9)
4. Create `src/tools/todo/create-todo.ts`
5. Create `src/tools/todo/get-todo.ts`
6. Create `src/tools/todo/list-todos.ts`
7. Create `src/tools/todo/update-todo.ts`
8. Create `src/tools/todo/delete-todo.ts`
9. Create `src/tools/todo/toggle-todo.ts`

### Phase 4: Integration (File 10)
10. Update `src/index.ts` - Register all tools

### Phase 5: Testing (File 11)
11. Create `todo-test.js` - Integration tests

### Phase 6: Documentation (Files 12-13)
12. Update `package.json` - Add test scripts
13. Update `README.md` - Document new features

## Total File Changes Summary

- **New Files**: 9
- **Modified Files**: 4
- **Total Files Touched**: 13
- **Estimated Total Lines Added**: 1,200-1,500
- **Estimated Implementation Time**: 8-12 hours
