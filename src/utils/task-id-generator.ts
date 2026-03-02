import { uniqueNamesGenerator, adjectives, animals } from 'unique-names-generator';
import { randomInt } from 'node:crypto';

/**
 * Generates human-readable task IDs like "brave-tiger-42" or "cosmic-falcon-17"
 * Much easier to remember and communicate than UUIDs or random strings
 */
export function generateTaskId(): string {
  const randomNumber = randomInt(10000);
  
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
 * Retries up to 100 times; falls back to timestamp-based ID on exhaustion.
 */
export function generateUniqueTaskId(existingIds: Set<string>): string {
  let id: string;
  let attempts = 0;
  do {
    id = generateTaskId();
    attempts++;
    if (attempts > 100) {
      id = `task-${Date.now()}-${randomInt(1000)}`;
      break;
    }
  } while (existingIds.has(normalizeTaskId(id)));
  return id;
}

/**
 * Normalizes task ID for case-insensitive lookups
 */
export function normalizeTaskId(taskId: string): string {
  return taskId.toLowerCase().trim();
}
