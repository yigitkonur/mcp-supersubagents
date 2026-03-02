import { fileURLToPath } from 'node:url';

/**
 * Stores client context including workspace roots from MCP initialization.
 * The first root is used as default CWD for spawned processes.
 */
class ClientContext {
  private _roots: string[] = [];
  private _defaultCwd: string = process.cwd();

  /**
   * Set roots from client's roots/list response
   */
  setRoots(roots: Array<{ uri: string; name?: string }>): void {
    this._roots = roots.map(r => {
      // Convert file:// URI to filesystem path using proper URL parsing
      if (r.uri.startsWith('file://')) {
        return fileURLToPath(r.uri);
      }
      return r.uri;
    });
    
    if (this._roots.length > 0) {
      this._defaultCwd = this._roots[0];
    }
  }

  /**
   * Get the default CWD for spawning processes.
   * Returns first client root if available, otherwise server's cwd.
   */
  getDefaultCwd(): string {
    return this._defaultCwd;
  }

  /**
   * Get all client roots
   */
  getRoots(): string[] {
    return [...this._roots];
  }

  /**
   * Check if roots were provided by client
   */
  hasRoots(): boolean {
    return this._roots.length > 0;
  }
}

export const clientContext = new ClientContext();
