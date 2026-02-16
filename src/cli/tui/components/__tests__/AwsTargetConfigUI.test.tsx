import { getAwsConfigHelpText } from '../AwsTargetConfigUI.js';
import { describe, expect, it } from 'vitest';

describe('getAwsConfigHelpText', () => {
  it('returns exact help text for choice phase', () => {
    expect(getAwsConfigHelpText('choice')).toBe('↑↓ navigate · Enter select · Esc exit');
  });

  it('returns same help text for token-expired as choice', () => {
    expect(getAwsConfigHelpText('token-expired')).toBe(getAwsConfigHelpText('choice'));
  });

  it('returns exact help text for select-target phase', () => {
    expect(getAwsConfigHelpText('select-target')).toBe('↑↓ navigate · Space toggle · Enter deploy · Esc exit');
  });

  it('returns exact help text for manual-account phase', () => {
    expect(getAwsConfigHelpText('manual-account')).toBe('12-digit account ID · Esc back');
  });

  it('returns exact help text for manual-region phase', () => {
    expect(getAwsConfigHelpText('manual-region')).toBe('Type to filter · ↑↓ navigate · Enter select · Esc back');
  });

  it('returns undefined for loading phases', () => {
    expect(getAwsConfigHelpText('checking')).toBeUndefined();
    expect(getAwsConfigHelpText('detecting')).toBeUndefined();
    expect(getAwsConfigHelpText('saving')).toBeUndefined();
  });

  it('returns undefined for terminal phases', () => {
    expect(getAwsConfigHelpText('configured')).toBeUndefined();
    expect(getAwsConfigHelpText('error')).toBeUndefined();
  });
});
