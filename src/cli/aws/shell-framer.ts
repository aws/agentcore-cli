export const MAX_FRAME_SIZE = 65536;

export enum ShellChannel {
  STDIN = 0x00,
  STDOUT = 0x01,
  STDERR = 0x02,
  STATUS = 0x03,
  RESIZE = 0x04,
  HEARTBEAT = 0x05,
  CLOSE = 0xff,
}

export interface ShellFrame {
  channel: ShellChannel;
  payload: Buffer;
  /** UTF-8 text of the payload (empty string for binary-only channels) */
  readonly text: string;
  /** Parse payload as JSON (throws on invalid JSON) */
  json(): unknown;
}

function makeFrame(channel: ShellChannel, payload: Buffer): ShellFrame {
  return {
    channel,
    payload,
    get text() {
      return payload.toString('utf8');
    },
    json() {
      return JSON.parse(payload.toString('utf8')) as unknown;
    },
  };
}

/** Stateless encoder/decoder for the channel-prefix binary framing protocol.
 *  Wire format: 1-byte channel ID followed by payload bytes (identical to k8s v5.channel.k8s.io).
 */
export class ShellFramer {
  decode(raw: Buffer): ShellFrame {
    if (raw.length === 0) {
      throw new Error('Empty frame');
    }
    const channel = raw[0] as ShellChannel;
    const payload = raw.subarray(1);
    return makeFrame(channel, payload);
  }

  encodeStdin(text: string): Buffer {
    const payload = Buffer.from(text, 'utf8');
    if (payload.length > MAX_FRAME_SIZE) {
      throw new ValueError(
        `stdin payload ${payload.length} bytes exceeds MAX_FRAME_SIZE ${MAX_FRAME_SIZE}; chunk large pastes`
      );
    }
    return Buffer.concat([Buffer.from([ShellChannel.STDIN]), payload]);
  }

  /** Encode raw bytes as a STDIN frame without any string conversion.
   *  Use this for interactive PTY input where the chunk may contain arbitrary
   *  byte sequences (ESC codes, arrow keys, non-UTF-8 encodings).
   */
  encodeStdinRaw(chunk: Buffer): Buffer {
    if (chunk.length > MAX_FRAME_SIZE) {
      throw new ValueError(
        `stdin payload ${chunk.length} bytes exceeds MAX_FRAME_SIZE ${MAX_FRAME_SIZE}; chunk large pastes`
      );
    }
    return Buffer.concat([Buffer.from([ShellChannel.STDIN]), chunk]);
  }

  encodeResize(cols: number, rows: number): Buffer {
    const payload = Buffer.from(JSON.stringify({ width: cols, height: rows }), 'utf8');
    return Buffer.concat([Buffer.from([ShellChannel.RESIZE]), payload]);
  }

  encodeHeartbeat(): Buffer {
    return Buffer.from([ShellChannel.HEARTBEAT]);
  }

  encodeClose(): Buffer {
    return Buffer.from([ShellChannel.CLOSE]);
  }
}

export class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValueError';
  }
}

// ---------------------------------------------------------------------------
// STATUS frame parsing
// ---------------------------------------------------------------------------

interface MetaV1Status {
  kind?: string;
  apiVersion?: string;
  metadata?: {
    shellId?: string;
    reconnected?: boolean;
    bytesDropped?: number;
  };
  status?: string;
  reason?: string;
  details?: {
    causes?: { reason?: string; message?: string }[];
  };
}

export type StatusFrameResult =
  | { type: 'confirmation'; shellId: string; reconnected: boolean; bytesDropped?: number }
  | { type: 'termination'; exitCode: number | null; signal: string | null }
  | { type: 'unknown' };

/** Parse a STATUS channel frame into a typed result.
 *  Confirmation frames have metadata.shellId; termination frames have empty metadata.
 */
export function parseStatusFrame(frame: ShellFrame): StatusFrameResult {
  let status: MetaV1Status;
  try {
    status = frame.json() as MetaV1Status;
  } catch {
    return { type: 'unknown' };
  }

  const shellId = status.metadata?.shellId;
  if (shellId) {
    const result: StatusFrameResult & { type: 'confirmation' } = {
      type: 'confirmation',
      shellId,
      reconnected: status.metadata?.reconnected ?? false,
    };
    if (status.metadata?.bytesDropped !== undefined) {
      result.bytesDropped = status.metadata.bytesDropped;
    }
    return result;
  }

  // Termination frame — empty metadata
  const causes = status.details?.causes ?? [];
  const exitCodeStr = causes.find(c => c.reason === 'ExitCode')?.message ?? null;
  const signal = causes.find(c => c.reason === 'Signal')?.message ?? null;
  const exitCode = exitCodeStr !== null ? parseInt(exitCodeStr, 10) : null;

  return { type: 'termination', exitCode: isNaN(exitCode!) ? null : exitCode, signal };
}
