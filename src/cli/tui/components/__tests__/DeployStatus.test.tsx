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
  return { message, code, level: 'info', time: new Date(), timestamp: new Date(), progress } as DeployMessage;
}

describe('DeployStatus', () => {
  it('renders deploying state with gradient text', () => {
    const { lastFrame } = render(<DeployStatus messages={[]} isComplete={false} hasError={false} />);

    expect(lastFrame()).toContain('Deploying to AWS');
  });

  it('renders success state when complete', () => {
    const { lastFrame } = render(<DeployStatus messages={[]} isComplete={true} hasError={false} />);

    expect(lastFrame()).toContain('Deploy to AWS Complete');
  });

  it('renders failure state when complete with error', () => {
    const { lastFrame } = render(<DeployStatus messages={[]} isComplete={true} hasError={true} />);

    expect(lastFrame()).toContain('Deploy to AWS Failed');
  });

  it('renders resource events during deployment', () => {
    const messages = [
      makeMsg('MyStack | CREATE_IN_PROGRESS | AWS::Lambda::Function | MyFunc'),
      makeMsg('MyStack | CREATE_COMPLETE | AWS::Lambda::Function | MyFunc'),
    ];

    const { lastFrame } = render(<DeployStatus messages={messages} isComplete={false} hasError={false} />);

    expect(lastFrame()).toContain('Lambda::Function');
    expect(lastFrame()).toContain('CREATE_COMPLETE');
  });

  it('renders progress bar when progress data exists', () => {
    const messages = [makeMsg('deploying', 'CDK_TOOLKIT_I5502', { completed: 3, total: 10 })];

    const { lastFrame } = render(<DeployStatus messages={messages} isComplete={false} hasError={false} />);

    expect(lastFrame()).toContain('3/10');
  });

  it('skips CLEANUP messages', () => {
    const messages = [
      makeMsg('MyStack | CREATE_COMPLETE | AWS::Lambda::Function | MyFunc'),
      makeMsg('MyStack | CLEANUP_IN_PROGRESS | AWS::Lambda::Function | OldFunc'),
    ];

    const { lastFrame } = render(<DeployStatus messages={messages} isComplete={false} hasError={false} />);

    expect(lastFrame()).toContain('Lambda::Function');
    expect(lastFrame()).toContain('CREATE_COMPLETE');
  });

  it('ignores non-resource-event messages', () => {
    const messages = [makeMsg('Some general info', 'CDK_TOOLKIT_I1234')];

    const { lastFrame } = render(<DeployStatus messages={messages} isComplete={false} hasError={false} />);

    // Should still show the deploying text but no resource lines
    expect(lastFrame()).toContain('Deploying to AWS');
  });
});
