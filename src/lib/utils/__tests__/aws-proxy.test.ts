import {
  getProxyHttpsAgent,
  getProxyRequestHandler,
  getProxyUrlFromEnv,
  redactProxyUrl,
  resetProxyWarningForTests,
  supportsNativeProxyEnv,
} from '../aws-proxy.js';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { HttpRequest } from '@smithy/protocol-http';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nativeSupport = supportsNativeProxyEnv();

describe('getProxyUrlFromEnv', () => {
  it('returns undefined when no proxy variable is set', () => {
    expect(getProxyUrlFromEnv({})).toBeUndefined();
  });

  it('prefers HTTPS_PROXY over HTTP_PROXY', () => {
    expect(getProxyUrlFromEnv({ HTTP_PROXY: 'http://a:1', HTTPS_PROXY: 'http://b:2' })).toBe('http://b:2');
  });

  it('accepts lowercase variables', () => {
    expect(getProxyUrlFromEnv({ http_proxy: 'http://c:3' })).toBe('http://c:3');
  });

  it('ignores empty values', () => {
    expect(getProxyUrlFromEnv({ HTTPS_PROXY: '  ', HTTP_PROXY: 'http://d:4' })).toBe('http://d:4');
  });

  it('ignores NO_PROXY on its own', () => {
    expect(getProxyUrlFromEnv({ NO_PROXY: 'localhost' })).toBeUndefined();
  });
});

describe('supportsNativeProxyEnv', () => {
  it.each([
    ['20.19.0', false],
    ['22.20.0', false],
    ['22.21.0', true],
    ['23.11.0', false],
    ['24.4.1', false],
    ['24.5.0', true],
    ['25.0.0', true],
  ])('Node %s -> %s', (version, expected) => {
    expect(supportsNativeProxyEnv(version)).toBe(expected);
  });
});

describe('redactProxyUrl', () => {
  it('hides credentials', () => {
    expect(redactProxyUrl('http://user:secret@proxy.corp:3128')).toBe('http://***@proxy.corp:3128');
  });

  it('keeps URLs without credentials', () => {
    expect(redactProxyUrl('http://proxy.corp:3128')).toBe('http://proxy.corp:3128');
  });

  it('does not echo invalid input', () => {
    expect(redactProxyUrl('not a url')).toBe('<invalid proxy URL>');
  });
});

describe('getProxyRequestHandler', () => {
  beforeEach(() => resetProxyWarningForTests());
  afterEach(() => vi.restoreAllMocks());

  it('returns undefined without a proxy so the SDK keeps its default handler', () => {
    expect(getProxyRequestHandler({})).toBeUndefined();
    expect(getProxyHttpsAgent({})).toBeUndefined();
  });

  it.runIf(nativeSupport)('returns a fresh NodeHttpHandler per call when a proxy is set', () => {
    const env = { HTTPS_PROXY: 'http://127.0.0.1:3128' };
    const a = getProxyRequestHandler(env);
    const b = getProxyRequestHandler(env);
    expect(a).toBeInstanceOf(NodeHttpHandler);
    expect(a).not.toBe(b);
  });

  it.skipIf(nativeSupport)('warns once and returns undefined on Node versions without proxyEnv', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const env = { HTTPS_PROXY: 'http://user:pw@127.0.0.1:3128' };
    expect(getProxyRequestHandler(env)).toBeUndefined();
    expect(getProxyRequestHandler(env)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).not.toContain('pw');
  });
});

describe.runIf(nativeSupport)('getProxyRequestHandler (network)', () => {
  let proxy: Server;
  let target: Server;
  let proxyPort: number;
  let targetPort: number;
  const proxied: string[] = [];

  const listen = (server: Server) =>
    new Promise<number>(resolve =>
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
    );

  const get = async (handler: NodeHttpHandler, hostname: string, port: number) => {
    const { response } = await handler.handle(
      new HttpRequest({
        protocol: 'http:',
        hostname,
        port,
        path: '/',
        method: 'GET',
        headers: { host: `${hostname}:${port}` },
        query: {},
      })
    );
    return response.statusCode;
  };

  beforeEach(async () => {
    proxied.length = 0;
    // Minimal forward proxy: records the absolute-form URL it receives and answers itself.
    proxy = createServer((req, res) => {
      proxied.push(req.url ?? '');
      res.writeHead(200).end('via-proxy');
    });
    // HTTPS goes through a CONNECT tunnel; refuse it so the test needs no TLS certificate.
    proxy.on('connect', (req, socket) => {
      proxied.push(`CONNECT ${req.url}`);
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    });
    target = createServer((_req, res) => res.writeHead(204).end());
    proxyPort = await listen(proxy);
    targetPort = await listen(target);
  });

  afterEach(async () => {
    await new Promise(resolve => proxy.close(resolve));
    await new Promise(resolve => target.close(resolve));
  });

  it('routes SDK requests through the proxy', async () => {
    const handler = getProxyRequestHandler({ HTTP_PROXY: `http://127.0.0.1:${proxyPort}` })!;
    expect(await get(handler, 'service.example.invalid', 443)).toBe(200);
    expect(proxied).toEqual(['http://service.example.invalid:443/']);
    handler.destroy();
  });

  it('tunnels HTTPS requests with CONNECT', async () => {
    const handler = getProxyRequestHandler({ HTTPS_PROXY: `http://127.0.0.1:${proxyPort}` })!;
    await expect(
      handler.handle(
        new HttpRequest({
          protocol: 'https:',
          hostname: 'sts.us-east-1.amazonaws.com',
          port: 443,
          path: '/',
          method: 'GET',
          headers: { host: 'sts.us-east-1.amazonaws.com' },
          query: {},
        })
      )
    ).rejects.toThrow();
    expect(proxied).toEqual(['CONNECT sts.us-east-1.amazonaws.com:443']);
    handler.destroy();
  });

  it('bypasses the proxy for hosts in NO_PROXY', async () => {
    const handler = getProxyRequestHandler({
      HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
      NO_PROXY: '127.0.0.1',
    })!;
    expect(await get(handler, '127.0.0.1', targetPort)).toBe(204);
    expect(proxied).toEqual([]);
    handler.destroy();
  });
});
