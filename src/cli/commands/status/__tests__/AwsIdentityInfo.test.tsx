import { AwsIdentityInfo } from '../AwsIdentityInfo.js';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';

describe('AwsIdentityInfo', () => {
  it('renders nothing without an identity', () => {
    const { lastFrame } = render(<AwsIdentityInfo />);
    expect(lastFrame()).toBe('');
  });

  it('shows the account and profile', () => {
    const { lastFrame } = render(
      <AwsIdentityInfo
        identity={{ success: true, account: '111111111111', profile: 'dev', fromEnvironment: false }}
        targetName="default"
        targetAccount="111111111111"
      />
    );
    expect(lastFrame()).toContain('AWS account: 111111111111 (profile: dev)');
    expect(lastFrame()).not.toContain('Warning');
  });

  it('omits the profile when none is set', () => {
    const { lastFrame } = render(
      <AwsIdentityInfo identity={{ success: true, account: '111111111111', fromEnvironment: false }} />
    );
    expect(lastFrame()).toContain('AWS account: 111111111111');
    expect(lastFrame()).not.toContain('profile');
  });

  it('says when credentials come from environment variables', () => {
    const { lastFrame } = render(
      <AwsIdentityInfo identity={{ success: true, account: '111111111111', fromEnvironment: true }} />
    );
    expect(lastFrame()).toContain('AWS account: 111111111111 (credentials from environment variables)');
  });

  it('warns when the credentials belong to a different account than the target', () => {
    const { lastFrame } = render(
      <AwsIdentityInfo
        identity={{ success: true, account: '111111111111', fromEnvironment: false }}
        targetName="prod"
        targetAccount="222222222222"
      />
    );
    const frame = lastFrame()!.replace(/\s+/g, ' ');
    expect(frame).toContain(
      "Warning: your AWS credentials are for account 111111111111, but target 'prod' is configured for account 222222222222."
    );
  });

  it('explains why the account is unavailable', () => {
    const { lastFrame } = render(
      <AwsIdentityInfo
        identity={{ success: false, profile: 'expired', fromEnvironment: false, error: 'AWS credentials expired.' }}
        targetAccount="222222222222"
      />
    );
    expect(lastFrame()).toContain('AWS account: unavailable (profile: expired) - AWS credentials expired.');
    expect(lastFrame()).not.toContain('Warning');
  });
});
