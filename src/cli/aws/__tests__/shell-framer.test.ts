import { MAX_FRAME_SIZE, ShellChannel, ShellFramer, ValueError, parseStatusFrame } from '../shell-framer.js';
import { describe, expect, it } from 'vitest';

const framer = new ShellFramer();

describe('ShellFramer.decode', () => {
  it('decodes a STDOUT frame', () => {
    const payload = Buffer.from('hello');
    const raw = Buffer.concat([Buffer.from([ShellChannel.STDOUT]), payload]);
    const frame = framer.decode(raw);
    expect(frame.channel).toBe(ShellChannel.STDOUT);
    expect(frame.payload).toEqual(payload);
    expect(frame.text).toBe('hello');
  });

  it('decodes a STDIN frame', () => {
    const raw = Buffer.concat([Buffer.from([ShellChannel.STDIN]), Buffer.from('ls\n')]);
    const frame = framer.decode(raw);
    expect(frame.channel).toBe(ShellChannel.STDIN);
    expect(frame.text).toBe('ls\n');
  });

  it('decodes a STATUS frame and exposes json()', () => {
    const status = { kind: 'Status', status: 'Success', metadata: { shellId: 'abc' } };
    const raw = Buffer.concat([Buffer.from([ShellChannel.STATUS]), Buffer.from(JSON.stringify(status))]);
    const frame = framer.decode(raw);
    expect(frame.channel).toBe(ShellChannel.STATUS);
    expect(frame.json()).toEqual(status);
  });

  it('decodes a RESIZE frame', () => {
    const payload = JSON.stringify({ width: 120, height: 40 });
    const raw = Buffer.concat([Buffer.from([ShellChannel.RESIZE]), Buffer.from(payload)]);
    const frame = framer.decode(raw);
    expect(frame.channel).toBe(ShellChannel.RESIZE);
    expect(frame.json()).toEqual({ width: 120, height: 40 });
  });

  it('decodes a HEARTBEAT frame (empty payload)', () => {
    const raw = Buffer.from([ShellChannel.HEARTBEAT]);
    const frame = framer.decode(raw);
    expect(frame.channel).toBe(ShellChannel.HEARTBEAT);
    expect(frame.payload.length).toBe(0);
  });

  it('decodes a CLOSE frame (empty payload)', () => {
    const raw = Buffer.from([ShellChannel.CLOSE]);
    const frame = framer.decode(raw);
    expect(frame.channel).toBe(ShellChannel.CLOSE);
    expect(frame.payload.length).toBe(0);
  });

  it('passes through unknown channel bytes with payload preserved', () => {
    const unknown = 0x42;
    const payload = Buffer.from('future-data');
    const raw = Buffer.concat([Buffer.from([unknown]), payload]);
    const frame = framer.decode(raw);
    expect(frame.channel).toBe(unknown);
    expect(frame.payload).toEqual(payload);
  });

  it('throws on empty buffer', () => {
    expect(() => framer.decode(Buffer.alloc(0))).toThrow('Empty frame');
  });
});

describe('ShellFramer.encodeStdin', () => {
  it('prepends STDIN channel byte', () => {
    const buf = framer.encodeStdin('hello');
    expect(buf[0]).toBe(ShellChannel.STDIN);
    expect(buf.subarray(1).toString()).toBe('hello');
  });

  it('round-trips through decode', () => {
    const encoded = framer.encodeStdin('test input');
    const frame = framer.decode(encoded);
    expect(frame.channel).toBe(ShellChannel.STDIN);
    expect(frame.text).toBe('test input');
  });

  it('throws ValueError when payload exceeds MAX_FRAME_SIZE', () => {
    const huge = 'x'.repeat(MAX_FRAME_SIZE + 1);
    expect(() => framer.encodeStdin(huge)).toThrow(ValueError);
  });

  it('accepts payload exactly at MAX_FRAME_SIZE', () => {
    const exact = 'x'.repeat(MAX_FRAME_SIZE);
    expect(() => framer.encodeStdin(exact)).not.toThrow();
  });
});

describe('ShellFramer.encodeStdinRaw', () => {
  it('prepends STDIN channel byte and preserves raw bytes', () => {
    const input = Buffer.from([0x1b, 0x5b, 0x41]); // ESC [ A (arrow up)
    const buf = framer.encodeStdinRaw(input);
    expect(buf[0]).toBe(ShellChannel.STDIN);
    expect(buf.subarray(1)).toEqual(input);
  });

  it('round-trips through decode', () => {
    const input = Buffer.from([0x03]); // Ctrl+C
    const encoded = framer.encodeStdinRaw(input);
    const frame = framer.decode(encoded);
    expect(frame.channel).toBe(ShellChannel.STDIN);
    expect(frame.payload).toEqual(input);
  });

  it('throws ValueError when payload exceeds MAX_FRAME_SIZE', () => {
    const huge = Buffer.alloc(MAX_FRAME_SIZE + 1);
    expect(() => framer.encodeStdinRaw(huge)).toThrow(ValueError);
  });

  it('accepts payload exactly at MAX_FRAME_SIZE', () => {
    const exact = Buffer.alloc(MAX_FRAME_SIZE);
    expect(() => framer.encodeStdinRaw(exact)).not.toThrow();
  });
});

describe('ShellFramer.encodeResize', () => {
  it('encodes correct JSON with width/height', () => {
    const buf = framer.encodeResize(220, 50);
    expect(buf[0]).toBe(ShellChannel.RESIZE);
    expect(JSON.parse(buf.subarray(1).toString())).toEqual({ width: 220, height: 50 });
  });
});

describe('ShellFramer.encodeHeartbeat', () => {
  it('returns single-byte HEARTBEAT frame', () => {
    const buf = framer.encodeHeartbeat();
    expect(buf).toEqual(Buffer.from([ShellChannel.HEARTBEAT]));
  });
});

describe('ShellFramer.encodeClose', () => {
  it('returns single-byte CLOSE frame', () => {
    const buf = framer.encodeClose();
    expect(buf).toEqual(Buffer.from([ShellChannel.CLOSE]));
  });
});

describe('parseStatusFrame', () => {
  it('identifies a confirmation frame with shellId', () => {
    const payload = JSON.stringify({
      kind: 'Status',
      apiVersion: 'v1',
      metadata: { shellId: 'my-shell', reconnected: false },
      status: 'Success',
    });
    const raw = Buffer.concat([Buffer.from([ShellChannel.STATUS]), Buffer.from(payload)]);
    const frame = framer.decode(raw);
    const result = parseStatusFrame(frame);
    expect(result.type).toBe('confirmation');
    if (result.type === 'confirmation') {
      expect(result.shellId).toBe('my-shell');
      expect(result.reconnected).toBe(false);
    }
  });

  it('sets reconnected=true when metadata says so', () => {
    const payload = JSON.stringify({
      kind: 'Status',
      metadata: { shellId: 'old-shell', reconnected: true },
      status: 'Success',
    });
    const raw = Buffer.concat([Buffer.from([ShellChannel.STATUS]), Buffer.from(payload)]);
    const result = parseStatusFrame(framer.decode(raw));
    expect(result.type).toBe('confirmation');
    if (result.type === 'confirmation') {
      expect(result.reconnected).toBe(true);
    }
  });

  it('identifies a termination frame with empty metadata', () => {
    const payload = JSON.stringify({
      kind: 'Status',
      apiVersion: 'v1',
      metadata: {},
      status: 'Success',
    });
    const raw = Buffer.concat([Buffer.from([ShellChannel.STATUS]), Buffer.from(payload)]);
    const result = parseStatusFrame(framer.decode(raw));
    expect(result.type).toBe('termination');
    if (result.type === 'termination') {
      expect(result.exitCode).toBeNull();
    }
  });

  it('extracts exit code from causes array', () => {
    const payload = JSON.stringify({
      kind: 'Status',
      metadata: {},
      status: 'Failure',
      reason: 'NonZeroExitCode',
      details: {
        causes: [
          { reason: 'ExitCode', message: '137' },
          { reason: 'Signal', message: '9' },
        ],
      },
    });
    const raw = Buffer.concat([Buffer.from([ShellChannel.STATUS]), Buffer.from(payload)]);
    const result = parseStatusFrame(framer.decode(raw));
    expect(result.type).toBe('termination');
    if (result.type === 'termination') {
      expect(result.exitCode).toBe(137);
      expect(result.signal).toBe('9');
    }
  });

  it('handles missing details gracefully', () => {
    const payload = JSON.stringify({ kind: 'Status', metadata: {}, status: 'Failure' });
    const raw = Buffer.concat([Buffer.from([ShellChannel.STATUS]), Buffer.from(payload)]);
    const result = parseStatusFrame(framer.decode(raw));
    expect(result.type).toBe('termination');
    if (result.type === 'termination') {
      expect(result.exitCode).toBeNull();
      expect(result.signal).toBeNull();
    }
  });

  it('returns unknown for invalid JSON', () => {
    const raw = Buffer.concat([Buffer.from([ShellChannel.STATUS]), Buffer.from('not-json')]);
    const result = parseStatusFrame(framer.decode(raw));
    expect(result.type).toBe('unknown');
  });

  // Gap 4 — bytesDropped in parseStatusFrame
  it('surfaces bytesDropped from confirmation frame metadata', () => {
    const payload = JSON.stringify({
      kind: 'Status',
      apiVersion: 'v1',
      metadata: { shellId: 'my-shell', reconnected: true, bytesDropped: 1024 },
      status: 'Success',
    });
    const raw = Buffer.concat([Buffer.from([ShellChannel.STATUS]), Buffer.from(payload)]);
    const result = parseStatusFrame(framer.decode(raw));
    expect(result.type).toBe('confirmation');
    if (result.type === 'confirmation') {
      expect(result.bytesDropped).toBe(1024);
    }
  });

  it('leaves bytesDropped undefined when not present in confirmation frame', () => {
    const payload = JSON.stringify({
      kind: 'Status',
      apiVersion: 'v1',
      metadata: { shellId: 'my-shell', reconnected: false },
      status: 'Success',
    });
    const raw = Buffer.concat([Buffer.from([ShellChannel.STATUS]), Buffer.from(payload)]);
    const result = parseStatusFrame(framer.decode(raw));
    expect(result.type).toBe('confirmation');
    if (result.type === 'confirmation') {
      expect(result.bytesDropped).toBeUndefined();
    }
  });
});
