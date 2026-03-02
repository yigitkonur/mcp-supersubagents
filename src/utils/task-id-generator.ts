import { uniqueNamesGenerator, adjectives, animals } from 'unique-names-generator';

/**
 * Generates human-readable task IDs like "brave-tiger-42" or "cosmic-falcon-17"
 * Much easier to remember and communicate than UUIDs or random strings
 */
export function generateTaskId(): string {
  const randomNumber = Math.floor(Math.random() * 10000);
  
  const name = uniqueNamesGenerator({
    dictionaries: [adjectives, animals],
    separator: '-',
    length: 2,
    style: 'lowerCase',
  });
  
  return `${name}-${randomNumber}`;
}

/**
 * Generates a task ID guaranteed unique within the given set.
 * Retries up to 10 times; falls back to timestamp suffix on exhaustion.
 */
export function generateUniqueTaskId(existingIds: Set<string>): string {
  for (let i = 0; i < 10; i++) {
    const id = generateTaskId();
    if (!existingIds.has(id)) return id;
  }
  // Fallback: append timestamp fragment to avoid collision
  return `${generateTaskId()}-${Date.now() % 100000}`;
}

/**
 * Normalizes task ID for case-insensitive lookups
 */
export function normalizeTaskId(taskId: string): string {
  return taskId.toLowerCase().trim();
}
