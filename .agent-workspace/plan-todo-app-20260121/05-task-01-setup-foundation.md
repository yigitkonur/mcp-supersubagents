# Task 01: Setup Foundation & Type Definitions

## Task ID
TASK-001

## Priority
HIGH (Blocking task - required for all other tasks)

## Complexity
SMALL (1-2 hours)

## Description
Create the foundational type definitions and interfaces required for the todo system. This establishes the data contracts that all other components will use.

## Prerequisites
- None (first task in sequence)

## Files to Modify

### 1. src/types.ts (Modify)
**Changes**: Add ~70 lines at the end of file

**Code Sections to Add**:

```typescript
// Todo-related enums
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

// Todo entity interface
export interface Todo {
  id: string;
  title: string;
  description?: string;
  completed: boolean;
  priority: Priority;
  dueDate?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  deletedAt?: string;
}

// Input interfaces for operations
export interface CreateTodoInput {
  title: string;
  description?: string;
  priority?: Priority;
  dueDate?: string;
  tags?: string[];
}

export interface UpdateTodoInput {
  title?: string;
  description?: string;
  priority?: Priority;
  dueDate?: string;
  tags?: string[];
  completed?: boolean;
}

export interface TodoFilterOptions {
  status?: TodoStatus;
  priority?: Priority;
  tags?: string[];
  search?: string;
  dueBefore?: string;
  dueAfter?: string;
}

export interface TodoListOptions extends TodoFilterOptions {
  limit?: number;
  offset?: number;
  sortBy?: 'createdAt' | 'updatedAt' | 'dueDate' | 'priority';
  sortOrder?: 'asc' | 'desc';
}
```

## Acceptance Criteria

### Functional Criteria
- [ ] All Todo-related types defined
- [ ] Enums created for TodoStatus and Priority
- [ ] Input interfaces created for create/update operations
- [ ] Filter and list options interfaces created
- [ ] All fields properly typed with optional modifiers

### Code Quality Criteria
- [ ] Follows existing types.ts format
- [ ] Properly exported for use in other files
- [ ] TypeScript strict mode compliant
- [ ] Consistent naming conventions with existing code
- [ ] Clear JSDoc comments for complex types

### Testing Criteria
- [ ] File compiles without TypeScript errors
- [ ] Types can be imported in test file
- [ ] No breaking changes to existing types

## Implementation Steps

1. Open src/types.ts
2. Add TodoStatus enum (3 values)
3. Add Priority enum (3 values)
4. Add Todo interface with all fields
5. Add CreateTodoInput interface
6. Add UpdateTodoInput interface
7. Add TodoFilterOptions interface
8. Add TodoListOptions interface
9. Run `npm run build` to verify compilation
10. Commit changes

## Validation Commands

```bash
# Compile TypeScript
npm run build

# Check for type errors
npx tsc --noEmit

# Verify types are exported
node -e "const types = require('./build/types.js'); console.log(Object.keys(types));"
```

## Dependencies
- **Depends On**: None
- **Blocks**: TASK-002, TASK-003, TASK-004

## Rollback Plan
If issues occur, simply remove the added lines from types.ts. No other files are affected yet.

## Notes
- Keep consistent with existing TaskStatus enum pattern
- Priority enum values should be lowercase for consistency
- Use optional chaining (?.) for optional fields
- ISO 8601 format for all date strings
