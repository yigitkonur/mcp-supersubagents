/**
 * Codex App-Server JSON-RPC Client
 *
 * Implements the Codex app-server JSON-RPC 2.0 protocol over stdio transport.
 * This enables bidirectional communication, including user input requests
 * (`item/tool/requestUserInput`) that the simpler `codex exec` mode cannot support.
 *
 * Protocol reference:
 *   https://github.com/openai/codex/tree/main/codex-rs/app-server
 *
 * Wire format: newline-delimited JSON (JSONL) without the "jsonrpc":"2.0" header.
 * Transport: `codex app-server --listen stdio://`
 *
 * Lifecycle:
 *   1. spawn process → initialize handshake (experimentalApi: true)
 *   2. thread/start (or thread/resume) → get threadId
 *   3. turn/start with prompt → stream notifications + handle server requests
 *   4. turn/completed or turn/failed → done
 *
 * Resilience:
 *   - 60s request timeout on all JSON-RPC calls
 *   - Exponential backoff (1s→2s→4s) on -32001 (server overloaded)
 *   - CodexRpcError preserves error codes and codexErrorInfo
 *   - Process registered with processRegistry for kill escalation
 *   - turn/interrupt for graceful cancellation
 *   - thread/resume for session continuation (sendMessage)
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

// ============================================================================
// Constants
// ============================================================================

const REQUEST_TIMEOUT_MS = 60_000;
const BACKPRESSURE_MAX_RETRIES = 3;
const BACKPRESSURE_BASE_DELAY_MS = 1_000;
const BACKPRESSURE_ERROR_CODE = -32001;

// ============================================================================
// JSON-RPC Types (upstream protocol — no "jsonrpc" header on wire)
// ============================================================================

type RequestId = string | number;

// ============================================================================
// Error Classification
// ============================================================================

export type CodexErrorInfo =
  | string
  | {
      kind?: string;
      message?: string;
      httpConnectionFailed?: { httpStatusCode?: number | null };
      responseStreamConnectionFailed?: { httpStatusCode?: number | null };
      responseStreamDisconnected?: { httpStatusCode?: number | null };
      responseTooManyFailedAttempts?: { httpStatusCode?: number | null };
    };

function getCodexErrorKind(codexErrorInfo?: CodexErrorInfo): string | undefined {
  if (!codexErrorInfo) return undefined;
  if (typeof codexErrorInfo === 'string') return codexErrorInfo;
  if (typeof codexErrorInfo.kind === 'string') return codexErrorInfo.kind;

  for (const key of [
    'httpConnectionFailed',
    'responseStreamConnectionFailed',
    'responseStreamDisconnected',
    'responseTooManyFailedAttempts',
  ] as const) {
    if (key in codexErrorInfo) return key;
  }

  return undefined;
}

function extractCodexErrorInfo(data: unknown): CodexErrorInfo | undefined {
  if (typeof data === 'string') return data;
  if (!data || typeof data !== 'object') return undefined;

  const record = data as Record<string, unknown>;
  const nested = record.codexErrorInfo;
  if (typeof nested === 'string') return nested;
  if (nested && typeof nested === 'object') return nested as CodexErrorInfo;

  if (
    typeof record.kind === 'string' ||
    typeof record.message === 'string' ||
    'httpConnectionFailed' in record ||
    'responseStreamConnectionFailed' in record ||
    'responseStreamDisconnected' in record ||
    'responseTooManyFailedAttempts' in record
  ) {
    return record as CodexErrorInfo;
  }

  return undefined;
}

export class CodexRpcError extends Error {
  readonly code: number;
  readonly codexErrorInfo?: CodexErrorInfo;

  constructor(message: string, code: number, codexErrorInfo?: CodexErrorInfo) {
    super(message);
    this.name = 'CodexRpcError';
    this.code = code;
    this.codexErrorInfo = codexErrorInfo;
  }

  get isBackpressure(): boolean {
    return this.code === BACKPRESSURE_ERROR_CODE;
  }

  get isContextWindowExceeded(): boolean {
    const kind = getCodexErrorKind(this.codexErrorInfo);
    return kind === 'ContextWindowExceeded' || kind === 'contextWindowExceeded';
  }

  get isUsageLimitExceeded(): boolean {
    const kind = getCodexErrorKind(this.codexErrorInfo);
    return kind === 'UsageLimitExceeded' || kind === 'usageLimitExceeded';
  }

  get isHttpConnectionFailed(): boolean {
    const kind = getCodexErrorKind(this.codexErrorInfo);
    return kind === 'HttpConnectionFailed' || kind === 'httpConnectionFailed';
  }
}

// ============================================================================
// App-Server Protocol Types
// ============================================================================

export interface UserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: Array<{ label: string; description: string }> | null;
}

export interface UserInputRequestParams {
  threadId: string;
  turnId: string;
  itemId: string;
  questions: UserInputQuestion[];
}

export interface UserInputAnswer {
  answer: string;
}

// ============================================================================
// Messages yielded to the consumer (adapter)
// ============================================================================

export type AppServerMessage =
  | { kind: 'notification'; method: string; params: Record<string, unknown> }
  | { kind: 'request'; method: string; id: RequestId; params: Record<string, unknown> };

// ============================================================================
// Async Queue — bridges readline events into async iteration
// ============================================================================

class AsyncQueue<T> {
  private buffer: T[] = [];
  private waiters: Array<(value: T | null) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(item);
    } else {
      this.buffer.push(item);
    }
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters) {
      waiter(null);
    }
    this.waiters.length = 0;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      if (this.buffer.length > 0) {
        yield this.buffer.shift()!;
        continue;
      }
      if (this.closed) return;
      const value = await new Promise<T | null>((resolve) => {
        this.waiters.push(resolve);
      });
      if (value === null) return;
      yield value;
    }
  }
}

// ============================================================================
// Binary Resolution
// ============================================================================

/**
 * Find the codex CLI binary. Priority:
 *   1. Explicit override (CODEX_PATH env var)
 *   2. Vendored binary in @openai/codex-{platform}-{arch} package
 *   3. 'codex' from PATH
 */
export function findCodexBinary(override?: string): string {
  if (override) return override;

  try {
    const require = createRequire(import.meta.url);
    const platform = process.platform;
    const arch = process.arch;
    const packageName = `@openai/codex-${platform}-${arch}`;
    const packageDir = join(require.resolve(`${packageName}/package.json`), '..');
    const binaryName = platform === 'win32' ? 'codex.exe' : 'codex';
    const binaryPath = join(packageDir, 'bin', binaryName);
    if (existsSync(binaryPath)) return binaryPath;
  } catch {
    // Platform package not installed — fall through to PATH
  }

  return 'codex';
}

// ============================================================================
// Client Options
// ============================================================================

export interface CodexAppServerOptions {
  codexPath?: string;
  apiKey?: string;
}

// ============================================================================
// Thread Options (shared between start and resume)
// ============================================================================

export interface ThreadOptions {
  model: string;
  cwd: string;
  sandboxMode: string;
  approvalPolicy: string;
  reasoningEffort?: string;
}

// ============================================================================
// CodexAppServerClient
// ============================================================================

export class CodexAppServerClient {
  private process: ChildProcess | null = null;
  private readline: ReadlineInterface | null = null;
  private nextRequestId = 1;
  private pendingRequests = new Map<
    RequestId,
    { resolve: (result: unknown) => void; reject: (error: Error) => void; timeoutId: NodeJS.Timeout }
  >();
  private messageQueue = new AsyncQueue<AppServerMessage>();
  private threadId: string | null = null;
  private turnId: string | null = null;
  private destroyed = false;
  private codexPath: string;
  private apiKey?: string;
  private registeredTaskId?: string;

  constructor(options: CodexAppServerOptions) {
    this.codexPath = findCodexBinary(options.codexPath);
    this.apiKey = options.apiKey;
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Get the PID of the spawned app-server process.
   */
  get pid(): number | undefined {
    return this.process?.pid;
  }

  /**
   * Get the current thread ID (set after startThread/resumeThread).
   */
  get currentThreadId(): string | null {
    return this.threadId;
  }

  /**
   * Get the current turn ID (set after runTurn() starts).
   */
  get currentTurnId(): string | null {
    return this.turnId;
  }

  /**
   * Spawn the app-server process and perform the initialize handshake.
   * Must be called before startThread()/resumeThread().
   *
   * Optionally registers the process with processRegistry for kill escalation.
   */
  async start(signal?: AbortSignal, taskId?: string): Promise<void> {
    if (signal?.aborted) throw new Error('Already aborted');

    const env = { ...process.env };
    if (this.apiKey) {
      env.OPENAI_API_KEY = this.apiKey;
    }

    console.error(`[codex-app-server] Spawning: ${this.codexPath} app-server --listen stdio://`);

    this.process = spawn(
      this.codexPath,
      ['app-server', '--listen', 'stdio://'],
      { stdio: ['pipe', 'pipe', 'pipe'], env },
    );

    // stderr → console.error (same pattern as other providers)
    this.process.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trimEnd();
      if (text) console.error(`[codex-app-server] ${text}`);
    });

    this.process.on('exit', (code, sig) => {
      console.error(`[codex-app-server] Process exited (code=${code}, signal=${sig})`);
      this.rejectAllPending(new Error(`Process exited (code=${code})`));
      this.messageQueue.close();
    });

    this.process.on('error', (err) => {
      console.error(`[codex-app-server] Process error:`, err);
      this.rejectAllPending(err instanceof Error ? err : new Error(String(err)));
      this.messageQueue.close();
    });

    // JSONL reader
    this.readline = createInterface({
      input: this.process.stdout!,
      crlfDelay: Infinity,
    });

    this.readline.on('line', (line) => this.handleLine(line));
    this.readline.on('close', () => this.messageQueue.close());

    // Abort signal → destroy
    if (signal) {
      signal.addEventListener('abort', () => this.destroy(), { once: true });
    }

    console.error(`[codex-app-server] Process spawned: pid=${this.process.pid}`);

    // Register with processRegistry for kill escalation
    if (taskId && this.process.pid) {
      this.registeredTaskId = taskId;
      try {
        const { processRegistry } = await import('../services/process-registry.js');
        processRegistry.register({
          taskId,
          pid: this.process.pid,
          registeredAt: Date.now(),
          label: 'codex-app-server',
        });
      } catch {
        // process-registry not available — non-fatal
      }
    }

    // Initialize handshake
    await this.sendRequest('initialize', {
      clientInfo: {
        name: 'mcp-supersubagents',
        title: 'MCP Super Sub-Agents',
        version: '1.0.0',
      },
      capabilities: {
        experimentalApi: true,
      },
    });

    this.sendNotification('initialized');
    console.error(`[codex-app-server] Initialize handshake complete`);
  }

  /**
   * Start a NEW conversation thread. Returns the server-assigned threadId.
   */
  async startThread(options: ThreadOptions): Promise<string> {
    const params = this.buildThreadParams(options);

    console.error(`[codex-app-server] Sending thread/start (model=${options.model})`);
    const result = (await this.sendRequest('thread/start', params)) as Record<string, unknown>;
    // Protocol returns { thread: { id: "..." }, ... } — extract nested ID
    const threadId = (
      result?.threadId ??
      result?.thread_id ??
      (result?.thread as Record<string, unknown> | undefined)?.id
    ) as string | undefined;
    if (!threadId) {
      console.error('[codex-app-server] thread/start response:', JSON.stringify(result));
      throw new Error(`thread/start did not return a threadId: ${JSON.stringify(result)}`);
    }
    this.threadId = threadId;
    console.error(`[codex-app-server] Thread started: ${threadId}`);
    return this.threadId;
  }

  /**
   * Resume an EXISTING conversation thread. Returns the threadId.
   * Used by sendMessage() to continue a completed session.
   */
  async resumeThread(existingThreadId: string, options: ThreadOptions): Promise<string> {
    const params = this.buildThreadParams(options);
    params.threadId = existingThreadId;

    console.error(`[codex-app-server] Sending thread/resume (existingId=${existingThreadId})`);
    const result = (await this.sendRequest('thread/resume', params)) as Record<string, unknown>;
    // Protocol returns { thread: { id: "..." }, ... } — extract nested ID
    const threadId = (
      result?.threadId ??
      result?.thread_id ??
      (result?.thread as Record<string, unknown> | undefined)?.id
    ) as string | undefined;
    if (!threadId) {
      console.error('[codex-app-server] thread/resume response:', JSON.stringify(result));
      throw new Error(`thread/resume did not return a threadId: ${JSON.stringify(result)}`);
    }
    this.threadId = threadId;
    console.error(`[codex-app-server] Thread resumed: ${threadId}`);
    return this.threadId;
  }

  /**
   * Start a turn and yield all server messages (notifications + server requests)
   * until `turn/completed` or `turn/failed` is received.
   *
   * The consumer is responsible for responding to server requests
   * (e.g., `item/tool/requestUserInput`) via respondToRequest().
   */
  async *runTurn(prompt: string, options?: { reasoningEffort?: string }): AsyncGenerator<AppServerMessage> {
    if (!this.threadId) throw new Error('No active thread — call startThread() or resumeThread() first');

    console.error(`[codex-app-server] Sending turn/start (thread=${this.threadId}, promptLen=${prompt.length})`);
    const result = (await this.sendRequest('turn/start', {
      threadId: this.threadId,
      input: [{ type: 'text', text: prompt }],
      ...(options?.reasoningEffort ? { effort: options.reasoningEffort } : {}),
    })) as Record<string, unknown>;

    const startedTurnId = (
      result?.turnId ??
      result?.turn_id ??
      (result?.turn as Record<string, unknown> | undefined)?.id
    ) as string | undefined;
    if (startedTurnId) {
      this.turnId = startedTurnId;
    }

    for await (const msg of this.messageQueue) {
      yield msg;

      if (msg.kind === 'notification' &&
          (msg.method === 'turn/completed' || msg.method === 'turn/failed')) {
        break;
      }
    }
  }

  /**
   * Send a JSON-RPC response to a server request (e.g., user input answer).
   */
  respondToRequest(id: RequestId, result: unknown): void {
    this.write({ id, result });
  }

  /**
   * Send a JSON-RPC notification to the server.
   * Public for adapter use (e.g., `serverRequest/resolved`).
   */
  sendNotification(method: string, params?: unknown): void {
    const msg: Record<string, unknown> = { method };
    if (params !== undefined) msg.params = params;
    this.write(msg);
  }

  /**
   * Gracefully interrupt the current turn.
   * Sends `turn/interrupt` and waits for acknowledgment.
   * Returns true if interrupt was acknowledged, false if it timed out.
   */
  async interruptTurn(): Promise<boolean> {
    if (!this.threadId || this.destroyed) {
      console.error(`[codex-app-server] interruptTurn skipped: thread=${this.threadId}, destroyed=${this.destroyed}`);
      return false;
    }
    if (!this.turnId) {
      console.error(`[codex-app-server] interruptTurn skipped: no active turnId for thread=${this.threadId}`);
      return false;
    }

    console.error(`[codex-app-server] Sending turn/interrupt (thread=${this.threadId}, turn=${this.turnId})`);
    try {
      await Promise.race([
        this.sendRequest('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }),
        new Promise<never>((_, reject) => {
          const t = setTimeout(() => reject(new Error('interrupt timeout')), 5_000);
          t.unref();
        }),
      ]);
      console.error(`[codex-app-server] turn/interrupt acknowledged`);
      return true;
    } catch (err) {
      console.error(`[codex-app-server] turn/interrupt failed:`, err);
      return false;
    }
  }

  /**
   * Destroy the client: kill process, close streams, reject pending requests.
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    console.error(`[codex-app-server] Destroying client (pid=${this.process?.pid}, pending=${this.pendingRequests.size})`);

    this.messageQueue.close();
    this.readline?.close();

    this.rejectAllPending(new Error('Client destroyed'));

    // Unregister from processRegistry
    if (this.registeredTaskId) {
      import('../services/process-registry.js')
        .then(({ processRegistry }) => processRegistry.unregister(this.registeredTaskId!))
        .catch(() => {});
    }

    if (this.process && !this.process.killed) {
      this.process.kill('SIGTERM');
      const forceKill = setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill('SIGKILL');
        }
      }, 3000);
      forceKill.unref();
    }
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  /**
   * Build thread params shared between startThread and resumeThread.
   */
  private buildThreadParams(options: ThreadOptions): Record<string, unknown> {
    // The app-server protocol expects kebab-case sandbox values directly:
    // 'read-only', 'workspace-write', 'danger-full-access'
    return {
      model: options.model,
      cwd: options.cwd,
      sandbox: options.sandboxMode,
      approvalPolicy: options.approvalPolicy,
    };
  }

  /**
   * Handle a single JSONL line from the app-server stdout.
   * Routes responses to pending request Promises; pushes notifications
   * and server requests to the consumer queue.
   */
  private handleLine(line: string): void {
    if (!line.trim()) return;

    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(line);
    } catch {
      console.error('[codex-app-server] Failed to parse JSONL:', line.slice(0, 200));
      return;
    }

    const hasMethod = typeof raw.method === 'string';
    const hasId = raw.id !== undefined;
    const hasResult = raw.result !== undefined;
    const hasError = typeof raw.error === 'object' && raw.error !== null;

    // Response or Error to OUR request
    if (!hasMethod && hasId && (hasResult || hasError)) {
      const pending = this.pendingRequests.get(raw.id as RequestId);
      if (pending) {
        clearTimeout(pending.timeoutId);
        this.pendingRequests.delete(raw.id as RequestId);
        if (hasError) {
          const err = raw.error as { code?: number; message?: string; data?: unknown };
          const code = typeof err.code === 'number' ? err.code : -1;
          const codexErrorInfo = extractCodexErrorInfo(err.data);
          pending.reject(new CodexRpcError(
            err.message || 'Unknown JSON-RPC error',
            code,
            codexErrorInfo,
          ));
        } else {
          pending.resolve(raw.result);
        }
      }
      return;
    }

    // Server Request — needs our response
    if (hasMethod && hasId) {
      this.messageQueue.push({
        kind: 'request',
        method: raw.method as string,
        id: raw.id as RequestId,
        params: (raw.params || {}) as Record<string, unknown>,
      });
      return;
    }

    // Server Notification
    if (hasMethod && !hasId) {
      const params = (raw.params || {}) as Record<string, unknown>;
      this.trackTurnLifecycle(raw.method as string, params);
      this.messageQueue.push({
        kind: 'notification',
        method: raw.method as string,
        params,
      });
      return;
    }

    console.error(
      '[codex-app-server] Unrecognized message:',
      JSON.stringify(raw).slice(0, 200),
    );
  }

  /**
   * Send a JSON-RPC request with timeout and backpressure retry.
   */
  private async sendRequest(method: string, params: unknown): Promise<unknown> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= BACKPRESSURE_MAX_RETRIES; attempt++) {
      try {
        return await this.sendRequestOnce(method, params);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Retry on backpressure (-32001)
        if (err instanceof CodexRpcError && err.isBackpressure && attempt < BACKPRESSURE_MAX_RETRIES) {
          const delay = BACKPRESSURE_BASE_DELAY_MS * Math.pow(2, attempt);
          const jitter = Math.random() * delay * 0.2;
          console.error(`[codex-app-server] Backpressure on ${method}, retry ${attempt + 1}/${BACKPRESSURE_MAX_RETRIES} after ${Math.round(delay + jitter)}ms`);
          await new Promise<void>(resolve => {
            const t = setTimeout(resolve, delay + jitter);
            t.unref();
          });
          continue;
        }

        throw err;
      }
    }

    throw lastError!;
  }

  /**
   * Send a single JSON-RPC request with timeout.
   */
  private sendRequestOnce(method: string, params: unknown): Promise<unknown> {
    if (this.destroyed) {
      return Promise.reject(new Error('Client destroyed'));
    }

    const id = this.nextRequestId++;

    return new Promise<unknown>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        const pending = this.pendingRequests.get(id);
        if (pending) {
          this.pendingRequests.delete(id);
          reject(new CodexRpcError(
            `Request timeout after ${REQUEST_TIMEOUT_MS}ms: ${method}`,
            -32000,
          ));
        }
      }, REQUEST_TIMEOUT_MS);
      timeoutId.unref();

      this.pendingRequests.set(id, { resolve, reject, timeoutId });
      this.write({ method, id, params });
    });
  }

  private write(message: unknown): void {
    if (this.destroyed || !this.process?.stdin?.writable) return;
    try {
      this.process.stdin.write(JSON.stringify(message) + '\n');
    } catch (err) {
      console.error('[codex-app-server] stdin write failed:', err);
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private trackTurnLifecycle(method: string, params: Record<string, unknown>): void {
    const turn = params.turn as Record<string, unknown> | undefined;
    const turnId = typeof turn?.id === 'string' ? turn.id : undefined;

    if (method === 'turn/started' && turnId) {
      this.turnId = turnId;
      return;
    }

    if (method === 'turn/completed' || method === 'turn/failed') {
      this.turnId = null;
    }
  }
}
