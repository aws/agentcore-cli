import type { DeployMessage } from '../../../cdk/toolkit-lib/index.js';
import { DeployStatus } from '../DeployStatus.js';
import { render } from 'ink-testing-library';
import React from 'react';
import stripAnsi from 'strip-ansi';
import { describe, expect, it, vi } from 'vitest';

// Force ink/chalk to emit ANSI color codes so the status color-coding tests are
// deterministic regardless of TTY/CI. vi.hoisted is lifted above the ink import
// by vitest, so FORCE_COLOR is set before ink evaluates its color support.
vi.hoisted(() => {
  process.env.FORCE_COLOR = '1';
});

// ink/chalk ANSI foreground color codes.
const ANSI = { green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m' } as const;

function makeMsg(
  message: string,
  code = 'CDK_TOOLKIT_I5502',
  progress?: { completed: number; total: number }
): DeployMessage {
  return {
    message,
    code,
    level: 'info',
    time: new Date(),
    timestamp: new Date(),
    progress,
  } as DeployMessage;
}

function makeResourceMsg(resourceType: string, status: string): DeployMessage {
  return makeMsg(`MyStack | ${status} | AWS::${resourceType} | LogicalId`);
}

describe('DeployStatus', () => {
  describe('header state', () => {
    it('shows "Deploying to AWS" when not complete', () => {
      const { lastFrame } = render(<DeployStatus messages={[]} isComplete={false} hasError={false} />);

      expect(stripAnsi(lastFrame()!)).toContain('Deploying to AWS');
    });

    it('shows success message when complete without error', () => {
      const { lastFrame } = render(<DeployStatus messages={[]} isComplete={true} hasError={false} />);
      const frame = lastFrame()!;

      expect(frame).toContain('✓');
      expect(frame).toContain('Deploy to AWS Complete');
    });

    it('shows failure message when complete with error', () => {
      const { lastFrame } = render(<DeployStatus messages={[]} isComplete={true} hasError={true} />);
      const frame = lastFrame()!;

      expect(frame).toContain('✗');
      expect(frame).toContain('Deploy to AWS Failed');
    });
  });

  describe('resource event parsing', () => {
    it('displays parsed resource type and status from CDK event messages', () => {
      const messages = [
        makeResourceMsg('Lambda::Function', 'CREATE_IN_PROGRESS'),
        makeResourceMsg('Lambda::Function', 'CREATE_COMPLETE'),
      ];

      const { lastFrame } = render(<DeployStatus messages={messages} isComplete={false} hasError={false} />);
      const frame = lastFrame()!;

      expect(frame).toContain('Lambda::Function');
      expect(frame).toContain('CREATE_COMPLETE');
    });

    it('strips AWS:: prefix from resource types', () => {
      const messages = [makeResourceMsg('S3::Bucket', 'CREATE_COMPLETE')];

      const { lastFrame } = render(<DeployStatus messages={messages} isComplete={false} hasError={false} />);

      expect(lastFrame()).toContain('S3::Bucket');
      expect(lastFrame()).not.toContain('AWS::S3::Bucket');
    });

    it('skips CLEANUP messages', () => {
      const messages = [
        makeResourceMsg('Lambda::Function', 'CREATE_COMPLETE'),
        makeMsg('MyStack | CLEANUP_IN_PROGRESS | AWS::Lambda::Function | OldFunc'),
      ];

      const { lastFrame } = render(<DeployStatus messages={messages} isComplete={false} hasError={false} />);
      const frame = lastFrame()!;

      expect(frame).toContain('CREATE_COMPLETE');
      expect(frame).not.toContain('CLEANUP');
    });

    it('ignores non-resource-event messages (non-I5502 codes)', () => {
      const messages = [makeMsg('Some general info', 'CDK_TOOLKIT_I1234')];

      const { lastFrame } = render(<DeployStatus messages={messages} isComplete={false} hasError={false} />);

      // Should show deploying text but no resource lines
      expect(stripAnsi(lastFrame()!)).toContain('Deploying to AWS');
      expect(lastFrame()).not.toContain('Some general info');
    });

    it('renders ROLLBACK statuses instead of dropping the events', () => {
      const messages = [
        makeResourceMsg('CloudFormation::Stack', 'ROLLBACK_IN_PROGRESS'),
        makeResourceMsg('BedrockAgentCore::Gateway', 'UPDATE_ROLLBACK_IN_PROGRESS'),
        makeResourceMsg('CloudFormation::Stack', 'ROLLBACK_FAILED'),
      ];

      const { lastFrame } = render(<DeployStatus messages={messages} isComplete={false} hasError={false} />);
      const frame = lastFrame()!;

      expect(frame).toContain('ROLLBACK_IN_PROGRESS');
      expect(frame).toContain('UPDATE_ROLLBACK_IN_PROGRESS');
      expect(frame).toContain('ROLLBACK_FAILED');
    });

    it('shows only last 8 resource events', () => {
      const messages = Array.from({ length: 12 }, (_, i) =>
        makeResourceMsg(`Service::Resource${i}`, 'CREATE_COMPLETE')
      );

      const { lastFrame } = render(<DeployStatus messages={messages} isComplete={false} hasError={false} />);
      const frame = lastFrame()!;

      // First 4 should be trimmed (12 - 8 = 4)
      expect(frame).not.toContain('Resource0');
      expect(frame).not.toContain('Resource3');
      // Last 8 should be visible
      expect(frame).toContain('Resource4');
      expect(frame).toContain('Resource11');
    });
  });

  describe('status color coding', () => {
    // Returns the ANSI color code wrapping the line that contains the status, e.g.
    // for "...\x1b[33mService::Resource ROLLBACK_COMPLETE\x1b[39m" -> "\x1b[33m".
    // A single resource line is rendered as one colored Text node, so the opening
    // code is the last ANSI escape before the status word on that line.
    function colorOf(frame: string, status: string): string | undefined {
      const line = frame.split('\n').find(l => l.includes(status));
      if (!line) return undefined;
      const before = line.slice(0, line.indexOf(status));
      // eslint-disable-next-line no-control-regex
      const codes = before.match(/\x1b\[\d+m/g);
      return codes?.[codes.length - 1];
    }

    it('renders CREATE_COMPLETE green (sanity check)', () => {
      const messages = [makeResourceMsg('Lambda::Function', 'CREATE_COMPLETE')];
      const { lastFrame } = render(<DeployStatus messages={messages} isComplete={false} hasError={false} />);

      expect(colorOf(lastFrame()!, 'CREATE_COMPLETE')).toBe(ANSI.green);
    });

    it('does NOT render ROLLBACK_COMPLETE green — it is a failed deploy, not a success (#1610)', () => {
      const messages = [makeResourceMsg('CloudFormation::Stack', 'ROLLBACK_COMPLETE')];
      const { lastFrame } = render(<DeployStatus messages={messages} isComplete={false} hasError={false} />);

      const color = colorOf(lastFrame()!, 'ROLLBACK_COMPLETE');
      expect(color).not.toBe(ANSI.green);
      expect(color).toBe(ANSI.yellow);
    });

    it('does NOT render UPDATE_ROLLBACK_COMPLETE green', () => {
      const messages = [makeResourceMsg('BedrockAgentCore::Gateway', 'UPDATE_ROLLBACK_COMPLETE')];
      const { lastFrame } = render(<DeployStatus messages={messages} isComplete={false} hasError={false} />);

      const color = colorOf(lastFrame()!, 'UPDATE_ROLLBACK_COMPLETE');
      expect(color).not.toBe(ANSI.green);
      expect(color).toBe(ANSI.yellow);
    });

    it('renders rollback in-progress states yellow (recovering from failure)', () => {
      const messages = [makeResourceMsg('CloudFormation::Stack', 'ROLLBACK_IN_PROGRESS')];
      const { lastFrame } = render(<DeployStatus messages={messages} isComplete={false} hasError={false} />);

      expect(colorOf(lastFrame()!, 'ROLLBACK_IN_PROGRESS')).toBe(ANSI.yellow);
    });

    it('renders ROLLBACK_FAILED red (worst case)', () => {
      const messages = [makeResourceMsg('CloudFormation::Stack', 'ROLLBACK_FAILED')];
      const { lastFrame } = render(<DeployStatus messages={messages} isComplete={false} hasError={false} />);

      expect(colorOf(lastFrame()!, 'ROLLBACK_FAILED')).toBe(ANSI.red);
    });
  });

  describe('progress bar', () => {
    it('renders progress bar with completed/total count', () => {
      const messages = [makeMsg('deploying', 'CDK_TOOLKIT_I5502', { completed: 3, total: 10 })];

      const { lastFrame } = render(<DeployStatus messages={messages} isComplete={false} hasError={false} />);
      const frame = lastFrame()!;

      expect(frame).toContain('3/10');
      expect(frame).toContain('█');
      expect(frame).toContain('░');
    });

    it('shows full progress bar on completion', () => {
      const messages = [makeMsg('done', 'CDK_TOOLKIT_I5502', { completed: 10, total: 10 })];

      const { lastFrame } = render(<DeployStatus messages={messages} isComplete={true} hasError={false} />);
      const frame = lastFrame()!;

      // On completion, bar shows total/total
      expect(frame).toContain('10/10');
    });

    it('does not show progress bar when no progress data', () => {
      const messages = [makeResourceMsg('Lambda::Function', 'CREATE_COMPLETE')];

      const { lastFrame } = render(<DeployStatus messages={messages} isComplete={false} hasError={false} />);

      expect(lastFrame()).not.toContain('█');
      expect(lastFrame()).not.toContain('░');
    });

    it('uses most recent progress data', () => {
      const messages = [
        makeMsg('step1', 'CDK_TOOLKIT_I5502', { completed: 2, total: 10 }),
        makeMsg('step2', 'CDK_TOOLKIT_I5502', { completed: 7, total: 10 }),
      ];

      const { lastFrame } = render(<DeployStatus messages={messages} isComplete={false} hasError={false} />);

      // Should show the latest progress
      expect(lastFrame()).toContain('7/10');
    });

    it('clamps when CDK reports completed greater than total without throwing', () => {
      // CDK toolkit can briefly report completed > total during graph expansion.
      // Before the clamp, this asked String.repeat for a negative count and crashed
      // the deploy TUI with "Invalid count value: -10".
      const messages = [makeMsg('overflow', 'CDK_TOOLKIT_I5502', { completed: 50, total: 30 })];

      expect(() => render(<DeployStatus messages={messages} isComplete={false} hasError={false} />)).not.toThrow();
    });

    it('clamps when CDK reports a negative completed count', () => {
      const messages = [makeMsg('underflow', 'CDK_TOOLKIT_I5502', { completed: -5, total: 10 })];

      expect(() => render(<DeployStatus messages={messages} isComplete={false} hasError={false} />)).not.toThrow();
    });
  });

  describe('warning state (post-deploy errors)', () => {
    it('shows warning banner when hasPostDeployError is true', () => {
      const { lastFrame } = render(
        <DeployStatus messages={[]} isComplete={true} hasError={false} hasPostDeployError={true} />
      );
      const frame = lastFrame()!;

      expect(frame).toContain('⚠');
      expect(frame).toContain('Deploy to AWS Complete (with warnings)');
    });

    it('shows post-deploy warnings in the banner', () => {
      const warnings = ['Config bundle "my-bundle": timeout', 'AB test "test-1": not found'];
      const { lastFrame } = render(
        <DeployStatus
          messages={[]}
          isComplete={true}
          hasError={false}
          hasPostDeployError={true}
          postDeployWarnings={warnings}
        />
      );
      const frame = lastFrame()!;

      expect(frame).toContain('Config bundle "my-bundle": timeout');
      expect(frame).toContain('AB test "test-1": not found');
    });

    it('warning state takes precedence over complete state', () => {
      const { lastFrame } = render(
        <DeployStatus messages={[]} isComplete={true} hasError={false} hasPostDeployError={true} />
      );
      const frame = lastFrame()!;

      expect(frame).not.toContain('✓ Deploy to AWS Complete');
      expect(frame).toContain('⚠ Deploy to AWS Complete (with warnings)');
    });

    it('error state takes precedence over warning state', () => {
      const { lastFrame } = render(
        <DeployStatus messages={[]} isComplete={true} hasError={true} hasPostDeployError={true} />
      );
      const frame = lastFrame()!;

      expect(frame).toContain('✗ Deploy to AWS Failed');
      expect(frame).not.toContain('with warnings');
    });
  });

  describe('error state details', () => {
    it('shows last 3 resource events on failure', () => {
      const messages = [
        makeResourceMsg('Lambda::Function', 'CREATE_COMPLETE'),
        makeResourceMsg('IAM::Role', 'CREATE_COMPLETE'),
        makeResourceMsg('S3::Bucket', 'CREATE_COMPLETE'),
        makeResourceMsg('DynamoDB::Table', 'CREATE_FAILED'),
      ];

      const { lastFrame } = render(<DeployStatus messages={messages} isComplete={true} hasError={true} />);
      const frame = lastFrame()!;

      // Last 3 of 4 resource events should show
      expect(frame).toContain('IAM::Role');
      expect(frame).toContain('S3::Bucket');
      expect(frame).toContain('DynamoDB::Table');
    });
  });
});
