import { uniqueNamesGenerator, adjectives, colors, animals, names } from 'unique-names-generator';

/**
 * Generates human-readable task IDs like "brave-tiger-42" or "cosmic-falcon-17"
 * Much easier to remember and communicate than UUIDs or random strings
 */
export function generateTaskId(): string {
  const randomNumber = Math.floor(Math.random() * 100);
  
  const name = uniqueNamesGenerator({
    dictionaries: [adjectives, animals],
    separator: '-',
    length: 2,
    style: 'lowerCase',
  });
  
  return `${name}-${randomNumber}`;
}

/**
 * Normalizes task ID for case-insensitive lookups
 */
export function normalizeTaskId(taskId: string): string {
  return taskId.toLowerCase().trim();
}
