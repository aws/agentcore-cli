import type { DeployMessage } from '../../../cdk/toolkit-lib/index.js';
import { DeployStatus } from '../DeployStatus.js';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';

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

      expect(lastFrame()).toContain('Deploying to AWS');
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
      expect(lastFrame()).toContain('Deploying to AWS');
      expect(lastFrame()).not.toContain('Some general info');
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
