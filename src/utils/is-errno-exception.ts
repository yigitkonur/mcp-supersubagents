/**
 * Type guard for NodeJS.ErrnoException.
 * Replaces `catch (err: any)` patterns that access `.code` unsafely.
 */
export function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err && (typeof err.code === 'string' || typeof err.code === 'undefined');
}
