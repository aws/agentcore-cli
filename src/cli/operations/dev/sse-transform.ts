import { parseSSELine } from './invoke';
import { type IncomingMessage, type ServerResponse } from 'node:http';

/**
 * Pipe an SSE stream from an agent response to a client response,
 * transforming each SSE event through parseSSELine so formats like
 * ConverseStream are normalized to plain text before reaching the browser.
 *
 * Non-text content (errors) is forwarded as `data: {"error": "..."}\n\n`.
 * Parsed text is forwarded as `data: "text"\n\n`.
 */
export function pipeSSETransformed(input: IncomingMessage, output: ServerResponse): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = '';

    input.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const { content, error } = parseSSELine(line);
        if (error) {
          output.write(`data: ${JSON.stringify({ error })}\n\n`);
        } else if (content) {
          output.write(`data: ${JSON.stringify(content)}\n\n`);
        }
      }
    });

    input.on('end', () => {
      if (buffer) {
        const { content, error } = parseSSELine(buffer);
        if (error) {
          output.write(`data: ${JSON.stringify({ error })}\n\n`);
        } else if (content) {
          output.write(`data: ${JSON.stringify(content)}\n\n`);
        }
      }
      output.end();
      resolve();
    });

    input.on('error', reject);
  });
}
