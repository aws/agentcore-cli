import { InMemorySink } from '../sinks/in-memory-sink';
import { CompositeSink, type MetricSink } from '../sinks/metric-sink';
import { describe, expect, it, vi } from 'vitest';

describe('CompositeSink', () => {
  it('fans out records to all sinks', () => {
    const a = new InMemorySink();
    const b = new InMemorySink();
    const composite = new CompositeSink([a, b]);

    composite.record(100, { command: 'deploy' });

    expect(a.metrics).toHaveLength(1);
    expect(b.metrics).toHaveLength(1);
    expect(a.metrics[0]!.attrs.command).toBe('deploy');
  });

  it('isolates errors — one sink throwing does not affect others', () => {
    const bad: MetricSink = {
      record: vi.fn(() => {
        throw new Error('sink failed');
      }),
      flush: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    const good = new InMemorySink();
    const composite = new CompositeSink([bad, good]);

    composite.record(100, { command: 'deploy' });

    expect(good.metrics).toHaveLength(1);
  });

  it('flushes all sinks in parallel', async () => {
    const a = new InMemorySink();
    const b = new InMemorySink();
    const flushA = vi.spyOn(a, 'flush');
    const flushB = vi.spyOn(b, 'flush');
    const composite = new CompositeSink([a, b]);

    await composite.flush(5000);

    expect(flushA).toHaveBeenCalledWith(5000);
    expect(flushB).toHaveBeenCalledWith(5000);
  });

  it('flush settles even if one sink rejects', async () => {
    const bad: MetricSink = {
      record: vi.fn(),
      flush: vi.fn().mockRejectedValue(new Error('flush failed')),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    const good = new InMemorySink();
    const flushGood = vi.spyOn(good, 'flush');
    const composite = new CompositeSink([bad, good]);

    await expect(composite.flush()).resolves.toBeUndefined();
    expect(flushGood).toHaveBeenCalled();
  });
});
