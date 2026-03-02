/**
 * Module augmentation for @github/copilot-sdk
 *
 * These types exist in the SDK's dist/types.d.ts but are not re-exported
 * from the barrel index.d.ts. This augmentation exposes them so our source
 * code can import them from '@github/copilot-sdk' directly.
 *
 * Verified against @github/copilot-sdk@0.1.29 dist/types.d.ts
 */

import type { ToolResultObject } from '@github/copilot-sdk';

declare module '@github/copilot-sdk' {
  export interface UserInputRequest {
    question: string;
    choices?: string[];
    allowFreeform?: boolean;
  }

  export interface UserInputResponse {
    answer: string;
    wasFreeform: boolean;
  }

  interface BaseHookInput {
    timestamp: number;
    cwd: string;
  }

  export interface SessionStartHookInput extends BaseHookInput {
    source: 'startup' | 'resume' | 'new';
    initialPrompt?: string;
  }
  export interface SessionStartHookOutput {
    additionalContext?: string;
    modifiedConfig?: Record<string, unknown>;
  }

  export interface SessionEndHookInput extends BaseHookInput {
    reason: 'complete' | 'error' | 'abort' | 'timeout' | 'user_exit';
    finalMessage?: string;
    error?: string;
  }
  export interface SessionEndHookOutput {
    suppressOutput?: boolean;
    cleanupActions?: string[];
    sessionSummary?: string;
  }

  export interface ErrorOccurredHookInput extends BaseHookInput {
    error: string;
    errorContext: 'model_call' | 'tool_execution' | 'system' | 'user_input';
    recoverable: boolean;
  }
  export interface ErrorOccurredHookOutput {
    suppressOutput?: boolean;
    errorHandling?: 'retry' | 'skip' | 'abort';
    retryCount?: number;
    userNotification?: string;
  }

  export interface PreToolUseHookInput extends BaseHookInput {
    toolName: string;
    toolArgs: unknown;
  }
  export interface PreToolUseHookOutput {
    permissionDecision?: 'allow' | 'deny' | 'ask';
    permissionDecisionReason?: string;
    modifiedArgs?: unknown;
    additionalContext?: string;
    suppressOutput?: boolean;
  }

  export interface PostToolUseHookInput extends BaseHookInput {
    toolName: string;
    toolArgs: unknown;
    toolResult: ToolResultObject;
  }
  export interface PostToolUseHookOutput {
    modifiedResult?: ToolResultObject;
    additionalContext?: string;
    suppressOutput?: boolean;
  }

  type PreToolUseHandler = (input: PreToolUseHookInput, invocation: { sessionId: string }) => Promise<PreToolUseHookOutput | void> | PreToolUseHookOutput | void;
  type PostToolUseHandler = (input: PostToolUseHookInput, invocation: { sessionId: string }) => Promise<PostToolUseHookOutput | void> | PostToolUseHookOutput | void;
  type SessionStartHandler = (input: SessionStartHookInput, invocation: { sessionId: string }) => Promise<SessionStartHookOutput | void> | SessionStartHookOutput | void;
  type SessionEndHandler = (input: SessionEndHookInput, invocation: { sessionId: string }) => Promise<SessionEndHookOutput | void> | SessionEndHookOutput | void;
  type ErrorOccurredHandler = (input: ErrorOccurredHookInput, invocation: { sessionId: string }) => Promise<ErrorOccurredHookOutput | void> | ErrorOccurredHookOutput | void;

  export interface SessionHooks {
    onPreToolUse?: PreToolUseHandler;
    onPostToolUse?: PostToolUseHandler;
    onUserPromptSubmitted?: (input: { timestamp: number; cwd: string; prompt: string }, invocation: { sessionId: string }) => Promise<{ modifiedPrompt?: string; additionalContext?: string; suppressOutput?: boolean } | void> | { modifiedPrompt?: string; additionalContext?: string; suppressOutput?: boolean } | void;
    onSessionStart?: SessionStartHandler;
    onSessionEnd?: SessionEndHandler;
    onErrorOccurred?: ErrorOccurredHandler;
  }
}
