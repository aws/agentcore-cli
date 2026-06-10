import type { IIoHost, IoRequest, StackSelectionStrategy } from '@aws-cdk/toolkit-lib';

/**
 * Silent IO host that suppresses all CDK output.
 * Use this in TUI contexts where CDK output would interfere with rendering.
 */
export const silentIoHost: IIoHost = {
  notify(): Promise<void> {
    // No-op: suppress all output
    return Promise.resolve();
  },
  requestResponse<T>(msg: IoRequest<unknown, T>): Promise<T> {
    // Return the default response without prompting
    return Promise.resolve(msg.defaultResponse);
  },
};

/**
 * Resource progress extracted from CDK messages.
 */
export interface ResourceProgress {
  completed: number;
  total: number;
}

/**
 * Message from CDK toolkit filtered for deploy progress display.
 * Data is pre-extracted to avoid passing complex CDK objects with circular refs.
 */
export interface DeployMessage {
  code: string;
  message: string;
  level: string;
  timestamp: Date;
  /** Pre-extracted resource progress (only for I5502 messages) */
  progress?: ResourceProgress;
  /** Stack outputs (only for I5900 messages) */
  outputs?: Record<string, string>;
  /** Stack ARN (only for I5900 messages) */
  stackArn?: string;
}

/**
 * Switchable IO host that can toggle between silent and verbose modes.
 * Use this when you need silent output during synth but verbose during deploy.
 */
export interface SwitchableIoHost {
  ioHost: IIoHost;
  /** Set to true to enable message capture */
  setVerbose: (verbose: boolean) => void;
  /** Set callback to receive filtered deploy messages for TUI */
  setOnMessage: (callback: ((msg: DeployMessage) => void) | null) => void;
  /** Set callback to receive ALL raw CDK messages for logging */
  setOnRawMessage: (callback: ((code: string, level: string, message: string, data?: unknown) => void) | null) => void;
}

/**
 * CDK message codes relevant for deploy progress display.
 * See: https://docs.aws.amazon.com/cdk/api/toolkit-lib/message-registry/
 *
 * We intentionally exclude I5100 (StackDeployProgress) as it provides
 * stack-level counts (e.g., 1/1 for single stack), not resource-level progress.
 */
const DEPLOY_MESSAGE_CODES = new Set([
  'CDK_TOOLKIT_I5501', // Stack monitoring start
  'CDK_TOOLKIT_I5502', // Stack activity event (resource events with progress)
  'CDK_TOOLKIT_I5503', // Stack monitoring end
  'CDK_TOOLKIT_I5900', // Deployment results
  'CDK_TOOLKIT_I5901', // Deployment success
]);

/**
 * Extract resource progress from CDK message text.
 * I5502 messages have format: "StackName | X/Y | timestamp | STATUS | ..."
 */
function extractProgressFromMessage(message: string): ResourceProgress | undefined {
  // Match pattern like "| 0/6 |" or "| 1/6 |"
  const match = /\|\s*(\d+)\/(\d+)\s*\|/.exec(message);
  if (match?.[1] && match[2]) {
    return {
      completed: parseInt(match[1], 10),
      total: parseInt(match[2], 10),
    };
  }
  return undefined;
}

/**
 * Create a switchable IO host that starts in silent mode.
 * Call setVerbose(true) before deploy to enable message capture.
 * Messages are filtered to only include deployment-relevant events for TUI.
 * Raw messages can be logged separately via setOnRawMessage.
 */
export function createSwitchableIoHost(): SwitchableIoHost {
  let verbose = false;
  let onMessage: ((msg: DeployMessage) => void) | null = null;
  let onRawMessage: ((code: string, level: string, message: string, data?: unknown) => void) | null = null;

  const ioHost: IIoHost = {
    notify(msg): Promise<void> {
      if (!verbose) return Promise.resolve();

      const code = msg.code ?? 'UNKNOWN';
      const level = msg.level ?? 'info';
      const text = typeof msg.message === 'string' ? msg.message : '';

      // Log ALL messages for debugging (pass data for structured access)
      onRawMessage?.(code, level, text, msg.data);

      // Only pass filtered messages to TUI
      if (onMessage && msg.code && DEPLOY_MESSAGE_CODES.has(msg.code)) {
        // Extract progress from message text (format: "StackName | X/Y | timestamp | ...")
        const progress = extractProgressFromMessage(text);

        // Build the deploy message
        const deployMessage: DeployMessage = {
          code: msg.code,
          message: text,
          level,
          timestamp: msg.time ?? new Date(),
          progress,
        };

        // Extract outputs from I5900 (SuccessfulDeployStackResult)
        if (msg.code === 'CDK_TOOLKIT_I5900') {
          const data = msg.data as { outputs?: Record<string, string>; stackArn?: string } | undefined;
          if (data?.outputs) {
            deployMessage.outputs = data.outputs;
          }
          if (data?.stackArn) {
            deployMessage.stackArn = data.stackArn;
          }
        }

        onMessage(deployMessage);
      }
      return Promise.resolve();
    },
    requestResponse<T>(msg: IoRequest<unknown, T>): Promise<T> {
      // Don't display request messages, just return default response
      return Promise.resolve(msg.defaultResponse);
    },
  };

  return {
    ioHost,
    setVerbose: (v: boolean) => {
      verbose = v;
    },
    setOnMessage: (cb: ((msg: DeployMessage) => void) | null) => {
      onMessage = cb;
    },
    setOnRawMessage: (cb: ((code: string, level: string, message: string, data?: unknown) => void) | null) => {
      onRawMessage = cb;
    },
  };
}

export interface CdkToolkitWrapperOptions {
  /**
   * Root directory where the CDK project resides.
   * Defaults to `./agentcore-cdk` relative to process.cwd().
   */
  projectDir?: string;

  /**
   * Optional IO host for customizing message/request handling.
   */
  ioHost?: IIoHost;

  /**
   * Optional AWS profile to use.
   */
  profile?: string;

  /**
   * Default AWS region for CDK operations.
   * Without this, the toolkit falls back to AWS_REGION env var or us-east-1.
   */
  region?: string;
}

export interface StackSelectionOptions {
  /**
   * Stack selection strategy and patterns.
   */
  stacks?: {
    strategy: StackSelectionStrategy;
    patterns?: string[];
  };
}

export type DeployOptions = StackSelectionOptions;

export type DestroyOptions = StackSelectionOptions;

export type DiffOptions = StackSelectionOptions;

export type ListOptions = StackSelectionOptions;
