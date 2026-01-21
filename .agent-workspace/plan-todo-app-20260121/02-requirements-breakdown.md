# Requirements Breakdown

## Functional Requirements

### FR-1: Todo Creation
- **Requirement**: Users can create new todos with title, description, priority, and due date
- **Inputs**: title (required), description (optional), priority (optional), dueDate (optional), tags (optional)
- **Output**: Created todo with unique ID and timestamp
- **Validation**: Title must be non-empty, max 200 chars

### FR-2: Todo Reading
- **Requirement**: Users can retrieve individual todos or list all todos
- **Operations**:
  - Get single todo by ID
  - List all todos
  - Filter todos by status (active, completed, all)
  - Filter by priority
  - Filter by tags
  - Search by title/description
- **Output**: Todo object(s) with all properties

### FR-3: Todo Updates
- **Requirement**: Users can update any property of existing todos
- **Updateable Fields**: title, description, priority, dueDate, tags, completed status
- **Output**: Updated todo object
- **Validation**: Todo must exist, same rules as creation

### FR-4: Todo Deletion
- **Requirement**: Users can delete todos
- **Options**: 
  - Soft delete (mark as deleted)
  - Hard delete (remove from storage)
- **Output**: Confirmation of deletion

### FR-5: Todo Status Toggle
- **Requirement**: Quick operation to mark todo as complete/incomplete
- **Output**: Updated todo with new completion status and timestamp

### FR-6: Data Persistence
- **Requirement**: Todos persist between server restarts
- **Options**:
  - JSON file storage
  - SQLite database
  - In-memory with periodic snapshots
- **Implementation**: Follow existing pattern (similar to task cleanup)

## Non-Functional Requirements

### NFR-1: Performance
- Operations complete in <100ms for typical dataset (<1000 todos)
- List operations support pagination
- Efficient filtering without full scan

### NFR-2: Data Integrity
- All operations are atomic
- No data loss on server crash
- Consistent state management

### NFR-3: Maintainability
- Follow existing codebase patterns
- TypeScript strict mode
- Clear separation of concerns
- Comprehensive error handling

### NFR-4: Scalability
- Support up to 10,000 todos per user
- Efficient cleanup of old completed todos
- Memory-efficient storage

## Data Model Requirements

### Todo Entity
```typescript
interface Todo {
  id: string;              // Unique identifier (nanoid)
  title: string;           // Todo title (required)
  description?: string;    // Detailed description
  completed: boolean;      // Completion status
  priority: Priority;      // low | medium | high
  dueDate?: string;        // ISO timestamp
  tags: string[];          // Array of tags
  createdAt: string;       // ISO timestamp
  updatedAt: string;       // ISO timestamp
  completedAt?: string;    // ISO timestamp when completed
}

enum Priority {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
}
```

## API Requirements

### MCP Tools to Implement
1. `create_todo` - Create new todo
2. `get_todo` - Get single todo by ID
3. `list_todos` - List todos with filters
4. `update_todo` - Update existing todo
5. `delete_todo` - Delete todo
6. `toggle_todo` - Quick complete/incomplete toggle
7. `search_todos` - Search by text

Each tool needs:
- Input schema validation (Zod)
- Error handling
- Success/error response format
- Documentation
