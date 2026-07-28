import { copyAndRenderDir } from '../render.js';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Regression tests for the multi-gateway tool-name collision.
 *
 * Two AgentCore Gateways each expose the built-in semantic search tool
 * `x_amz_bedrock_agentcore_search` (and may share target names). Each HTTP
 * framework template wires one MCP client/toolset/server per gateway into a
 * single agent, so identical tool names collide. Each SDK is de-collided with
 * its own namespacing primitive:
 *   - Strands:      MCPClient(prefix=...)
 *   - Google ADK:   MCPToolset(tool_name_prefix=...)
 *   - LangChain:    MultiServerMCPClient(servers, tool_name_prefix=True)  (prefixes by server key)
 *   - OpenAIAgents: Agent(mcp_config={"include_server_in_tool_names": True})
 *
 * Gateway names are constrained to /^[a-zA-Z][a-zA-Z0-9-]*$/, so `snakeCase`
 * always yields a valid, unique tool-name prefix.
 */

const ASSETS_HTTP = join(__dirname, '../../../assets/python/http');

const TWO_IAM_GATEWAYS = {
  hasGateway: true,
  gatewayAuthTypes: ['AWS_IAM'],
  gatewayProviders: [
    { name: 'orders-gw', envVarName: 'ORDERS_GW_GATEWAY_URL', authType: 'AWS_IAM' },
    { name: 'inventory', envVarName: 'INVENTORY_GATEWAY_URL', authType: 'AWS_IAM' },
  ],
};

const JWT_AND_NONE_GATEWAYS = {
  hasGateway: true,
  gatewayAuthTypes: ['CUSTOM_JWT', 'NONE'],
  gatewayProviders: [
    {
      name: 'orders-gw',
      envVarName: 'ORDERS_GW_GATEWAY_URL',
      authType: 'CUSTOM_JWT',
      credentialProviderName: 'orders-oauth',
    },
    { name: 'public', envVarName: 'PUBLIC_GATEWAY_URL', authType: 'NONE' },
  ],
};

describe('Multi-gateway tool-name collision fix', () => {
  let srcDir: string;
  let destDir: string;

  beforeEach(() => {
    srcDir = mkdtempSync(join(tmpdir(), 'mg-src-'));
    destDir = join(mkdtempSync(join(tmpdir(), 'mg-dest-')), 'output');
  });

  afterEach(() => {
    rmSync(srcDir, { recursive: true, force: true });
    rmSync(join(destDir, '..'), { recursive: true, force: true });
  });

  /** Renders a single template asset file through the project's Handlebars pipeline. */
  async function renderAsset(relPath: string, data: object): Promise<string> {
    const dir = join(srcDir, 'tpl');
    mkdirSync(dir, { recursive: true });
    const fileName = relPath.split('/').pop()!;
    cpSync(join(ASSETS_HTTP, relPath), join(dir, fileName));
    await copyAndRenderDir(dir, destDir, data);
    return readFileSync(join(destDir, fileName), 'utf-8');
  }

  describe('Strands', () => {
    it('gives each gateway MCPClient a distinct snakeCase prefix', async () => {
      const out = await renderAsset('strands/base/mcp_client/client.py', TWO_IAM_GATEWAYS);
      expect(out).toContain('prefix="orders_gw"');
      expect(out).toContain('prefix="inventory"');
    });

    it('prefixes across CUSTOM_JWT and NONE auth types', async () => {
      const out = await renderAsset('strands/base/mcp_client/client.py', JWT_AND_NONE_GATEWAYS);
      expect(out).toContain('prefix="orders_gw"');
      expect(out).toContain('prefix="public"');
    });

    it('pins the gateway-capable strands-agents floor unconditionally', async () => {
      const withGw = await renderAsset('strands/base/pyproject.toml', {
        ...TWO_IAM_GATEWAYS,
        name: 'a',
        modelProvider: 'Bedrock',
      });
      const noGw = await renderAsset('strands/base/pyproject.toml', {
        hasGateway: false,
        name: 'a',
        modelProvider: 'Bedrock',
      });
      expect(withGw).toContain('strands-agents >= 1.15.0');
      expect(noGw).toContain('strands-agents >= 1.15.0');
      expect(noGw).not.toContain('1.13.0');
    });
  });

  describe('Google ADK', () => {
    it('gives each gateway MCPToolset a distinct tool_name_prefix', async () => {
      const out = await renderAsset('googleadk/base/mcp_client/client.py', TWO_IAM_GATEWAYS);
      expect(out).toContain('tool_name_prefix="orders_gw"');
      expect(out).toContain('tool_name_prefix="inventory"');
    });

    it('prefixes across CUSTOM_JWT and NONE auth types', async () => {
      const out = await renderAsset('googleadk/base/mcp_client/client.py', JWT_AND_NONE_GATEWAYS);
      expect(out).toContain('tool_name_prefix="orders_gw"');
      expect(out).toContain('tool_name_prefix="public"');
    });

    it('pins google-adk to a tool_name_prefix-capable floor under the 2.x ceiling', async () => {
      const out = await renderAsset('googleadk/base/pyproject.toml', { ...TWO_IAM_GATEWAYS, name: 'a' });
      expect(out).toContain('google-adk >= 1.35.0, < 2.0.0');
    });
  });

  describe('LangChain / LangGraph', () => {
    it('namespaces by snakeCase server key and enables tool_name_prefix', async () => {
      const out = await renderAsset('langchain_langgraph/base/mcp_client/client.py', TWO_IAM_GATEWAYS);
      expect(out).toContain('servers["orders_gw"]');
      expect(out).toContain('servers["inventory"]');
      expect(out).toContain('MultiServerMCPClient(servers, tool_name_prefix=True)');
    });

    it('pins the gateway-capable langchain-mcp-adapters floor unconditionally', async () => {
      const withGw = await renderAsset('langchain_langgraph/base/pyproject.toml', {
        ...TWO_IAM_GATEWAYS,
        modelProvider: 'Bedrock',
      });
      const noGw = await renderAsset('langchain_langgraph/base/pyproject.toml', {
        hasGateway: false,
        modelProvider: 'Bedrock',
      });
      expect(withGw).toContain('langchain-mcp-adapters >= 0.3.1');
      expect(noGw).toContain('langchain-mcp-adapters >= 0.3.1');
      expect(noGw).not.toContain('0.1.11');
    });
  });

  describe('OpenAI Agents', () => {
    it('enables include_server_in_tool_names and connects servers via AsyncExitStack', async () => {
      const out = await renderAsset('openaiagents/base/main.py', TWO_IAM_GATEWAYS);
      expect(out).toContain('"include_server_in_tool_names": True');
      expect(out).toContain('AsyncExitStack()');
      expect(out).toContain('await stack.enter_async_context(server)');
    });

    it('does not import AsyncExitStack when there is no gateway', async () => {
      const out = await renderAsset('openaiagents/base/main.py', { hasGateway: false });
      expect(out).not.toContain('AsyncExitStack');
    });

    it('pins the gateway-capable openai-agents floor unconditionally', async () => {
      const withGw = await renderAsset('openaiagents/base/pyproject.toml', { ...TWO_IAM_GATEWAYS, name: 'a' });
      const noGw = await renderAsset('openaiagents/base/pyproject.toml', { hasGateway: false, name: 'a' });
      expect(withGw).toContain('openai-agents >= 0.16.0');
      expect(noGw).toContain('openai-agents >= 0.16.0');
      expect(noGw).not.toContain('0.4.2');
    });
  });

  /**
   * The auth-type {{#if}}/{{else}}/{{/if}} block sits inside an `if url:` immediately
   * followed by `else:`. When the control tags were indented, Handlebars left stray
   * whitespace that over-indented the Python `else:` (`            else:`), producing
   * a SyntaxError — but only on the NONE-auth branch. Control tags now sit at column 0
   * so Handlebars removes them as standalone lines, keeping `else:` at 4-space indent.
   */
  describe('NONE-auth renders valid Python indentation', () => {
    const NONE_GATEWAYS = {
      hasGateway: true,
      gatewayAuthTypes: ['NONE'],
      gatewayProviders: [
        { name: 'public-a', envVarName: 'PUBLIC_A_GATEWAY_URL', authType: 'NONE' },
        { name: 'public-b', envVarName: 'PUBLIC_B_GATEWAY_URL', authType: 'NONE' },
      ],
    };

    it.each([
      ['Google ADK', 'googleadk/base/mcp_client/client.py'],
      ['LangChain', 'langchain_langgraph/base/mcp_client/client.py'],
      ['OpenAIAgents', 'openaiagents/base/mcp_client/client.py'],
    ])('%s keeps the else: at 4-space indent (not over-indented)', async (_fw, asset) => {
      const out = await renderAsset(asset, NONE_GATEWAYS);
      expect(out).toContain('\n    else:\n');
      expect(out).not.toContain('            else:');
    });

    // Strands uses a different `if not url: return None` structure with no trailing
    // Python `else:`, so it never had the over-indent bug and was intentionally not
    // touched. Assert it still renders the prefixed clients cleanly for NONE auth so a
    // future Strands template edit can't silently reintroduce the collision/indent bug.
    it('Strands renders prefixed NONE-auth clients without an over-indented else', async () => {
      const out = await renderAsset('strands/base/mcp_client/client.py', NONE_GATEWAYS);
      expect(out).toContain('prefix="public_a"');
      expect(out).toContain('prefix="public_b"');
      expect(out).not.toContain('            else:');
    });
  });
});
