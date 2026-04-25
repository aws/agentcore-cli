import { RuntimeEndpointPrimitive } from '../RuntimeEndpointPrimitive';
import { describe, expect, it } from 'vitest';

describe('RuntimeEndpointPrimitive', () => {
  const primitive = new RuntimeEndpointPrimitive();

  it('has kind "runtime-endpoint"', () => {
    expect(primitive.kind).toBe('runtime-endpoint');
  });

  it('has label "Runtime Endpoint"', () => {
    expect(primitive.label).toBe('Runtime Endpoint');
  });
});
