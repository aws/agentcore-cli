import { NodeHttpHandler } from '@smithy/node-http-handler';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';

/**
 * Proxy support for AWS SDK clients.
 *
 * The AWS SDK for JavaScript v3 does not read HTTP(S)_PROXY on its own: its NodeHttpHandler creates
 * private http/https agents, so neither the environment variables nor NODE_USE_ENV_PROXY affect it.
 *
 * Node.js >= 22.21 / >= 24.5 can build agents that honor HTTPS_PROXY, HTTP_PROXY and NO_PROXY
 * (upper or lower case) through the `proxyEnv` agent option. We hand such agents to every SDK client,
 * so no third-party proxy library is needed.
 *
 * Global `fetch` calls are covered separately by Node itself when NODE_USE_ENV_PROXY=1 is set.
 */

const PROXY_ENV_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'] as const;

type Env = Record<string, string | undefined>;

/** Returns the first configured proxy URL, or undefined when no proxy variable is set. */
export function getProxyUrlFromEnv(env: Env = process.env): string | undefined {
  for (const name of PROXY_ENV_VARS) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/** Whether this Node.js version supports the `proxyEnv` agent option (added in v24.5.0, backported to v22.21.0). */
export function supportsNativeProxyEnv(nodeVersion: string = process.versions.node): boolean {
  const [major = 0, minor = 0] = nodeVersion.split('.').map(part => Number.parseInt(part, 10));
  if (major >= 25) return true;
  if (major === 24) return minor >= 5;
  if (major === 22) return minor >= 21;
  return false;
}

let warnedUnsupported = false;

/** @internal Test hook. */
export function resetProxyWarningForTests(): void {
  warnedUnsupported = false;
}

/**
 * Build a `requestHandler` config for AWS SDK v3 clients that routes traffic through the proxy defined in
 * HTTPS_PROXY / HTTP_PROXY, honoring NO_PROXY.
 *
 * Returns undefined when no proxy is configured (or the Node.js version cannot support it), in which case the
 * SDK keeps its default handler. A fresh handler is created per call, mirroring the SDK default of one handler
 * per client, so destroying one client never affects another.
 *
 * An HTTP/1.1 handler instance is returned (rather than plain options) so that clients whose default is the
 * HTTP/2 handler, such as BedrockRuntimeClient, also go through the proxy; Node's proxy support is HTTP/1.1 only.
 *
 * @example
 * new STSClient({ region, credentials, requestHandler: getProxyRequestHandler() });
 */
export function getProxyRequestHandler(env: Env = process.env): NodeHttpHandler | undefined {
  const httpsAgent = getProxyHttpsAgent(env);
  if (!httpsAgent) return undefined;

  return new NodeHttpHandler({
    httpAgent: new HttpAgent({ keepAlive: true, proxyEnv: env }),
    httpsAgent,
  });
}

/**
 * Build an https.Agent that honors HTTPS_PROXY / HTTP_PROXY / NO_PROXY, for APIs that take a single agent
 * (such as the CDK Toolkit's `sdkConfig.httpOptions.agent`). Returns undefined when no proxy is configured.
 */
export function getProxyHttpsAgent(env: Env = process.env): HttpsAgent | undefined {
  const proxyUrl = getProxyUrlFromEnv(env);
  if (!proxyUrl) return undefined;

  if (!supportsNativeProxyEnv()) {
    if (!warnedUnsupported) {
      warnedUnsupported = true;
      console.warn(
        `Warning: a proxy is configured (${redactProxyUrl(proxyUrl)}) but Node.js ${process.versions.node} ` +
          'cannot route AWS SDK traffic through it. Upgrade to Node.js >= 22.21 or >= 24.5 to use a proxy.'
      );
    }
    return undefined;
  }

  return new HttpsAgent({ keepAlive: true, proxyEnv: env });
}

/** Strip credentials from a proxy URL before printing it. */
export function redactProxyUrl(proxyUrl: string): string {
  try {
    const url = new URL(proxyUrl);
    if (url.username || url.password) {
      url.username = '***';
      url.password = '';
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    return '<invalid proxy URL>';
  }
}
