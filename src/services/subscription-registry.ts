const URI_PREFIX = 'task:///';

class SubscriptionRegistry {
  private subscriptions = new Set<string>();

  subscribe(uri: string): void {
    this.subscriptions.add(uri);
  }

  unsubscribe(uri: string): void {
    this.subscriptions.delete(uri);
  }

  isSubscribed(uri: string): boolean {
    return this.subscriptions.has(uri);
  }

  clear(): void {
    this.subscriptions.clear();
  }
}

export function taskIdToUri(taskId: string): string {
  return `${URI_PREFIX}${taskId}`;
}

export function uriToTaskId(uri: string): string | null {
  if (!uri.startsWith(URI_PREFIX)) return null;
  const taskId = uri.slice(URI_PREFIX.length);
  return taskId || null;
}

export const subscriptionRegistry = new SubscriptionRegistry();
