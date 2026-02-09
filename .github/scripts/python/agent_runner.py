#!/usr/bin/env python3
"""
Strands Action
Agent runner for GitHub Actions.
"""

import base64
import json
import os
import sys

from strands import Agent
from strands.session import S3SessionManager
from strands.telemetry import StrandsTelemetry
from strands_tools.utils.models.model import create_model

# Environment defaults
os.environ.setdefault("BYPASS_TOOL_CONSENT", "true")
os.environ.setdefault("STRANDS_TOOL_CONSOLE_MODE", "enabled")
os.environ.setdefault("EDITOR_DISABLE_BACKUP", "true")


def setup_otel() -> None:
    """Setup OpenTelemetry if configured."""
    # Langfuse configuration
    langfuse_host = os.environ.get("LANGFUSE_BASE_URL")
    if langfuse_host:
        public_key = os.environ.get("LANGFUSE_PUBLIC_KEY", "")
        secret_key = os.environ.get("LANGFUSE_SECRET_KEY", "")

        if public_key and secret_key:
            auth_token = base64.b64encode(f"{public_key}:{secret_key}".encode()).decode()
            otel_endpoint = f"{langfuse_host}/api/public/otel"

            os.environ["OTEL_EXPORTER_OTLP_ENDPOINT"] = otel_endpoint
            os.environ["OTEL_EXPORTER_OTLP_HEADERS"] = f"Authorization=Basic {auth_token}"
            print(f"✓ Langfuse OTEL: {langfuse_host}")

    # Generic OTEL configuration
    if os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT"):
        try:
            strands_telemetry = StrandsTelemetry()
            strands_telemetry.setup_otlp_exporter()
            print(f"✓ OTEL exporter: {os.environ.get('OTEL_EXPORTER_OTLP_ENDPOINT')}")
        except Exception as e:
            print(f"⚠ OTEL setup failed: {e}")


def load_github_tools() -> list:
    """Load GitHub tools from github_tools.py"""
    try:
        import github_tools
        github_tool_functions = [
            github_tools.create_issue,
            github_tools.update_issue,
            github_tools.add_issue_comment,
            github_tools.create_pull_request,
            github_tools.update_pull_request,
            github_tools.reply_to_review_comment,
            github_tools.get_issue,
            github_tools.list_issues,
            github_tools.get_issue_comments,
            github_tools.get_pull_request,
            github_tools.list_pull_requests,
            github_tools.get_pr_review_and_comments,
        ]
        print(f"✓ Loaded {len(github_tool_functions)} GitHub tools")
        return github_tool_functions
    except ImportError as e:
        print(f"✗ Failed to import github_tools: {e}")
        return []


def load_additional_tools() -> list:
    """Load additional tools: handoff_to_user, notebook, str_replace_based_edit_tool"""
    tools = []
    
    # Load handoff_to_user
    try:
        import handoff_to_user
        tools.append(handoff_to_user.handoff_to_user)
        print("✓ Loaded handoff_to_user tool")
    except ImportError as e:
        print(f"✗ Failed to import handoff_to_user: {e}")
    
    # Load notebook
    try:
        import notebook
        tools.append(notebook.notebook)
        print("✓ Loaded notebook tool")
    except ImportError as e:
        print(f"✗ Failed to import notebook: {e}")
    
    # Load str_replace_based_edit_tool
    try:
        import str_replace_based_edit_tool
        tools.append(str_replace_based_edit_tool.str_replace_based_edit_tool)
        print("✓ Loaded str_replace_based_edit_tool")
    except ImportError as e:
        print(f"✗ Failed to import str_replace_based_edit_tool: {e}")
    
    if tools:
        print(f"✓ Loaded {len(tools)} additional tools")
    
    return tools


def load_tools(config: str) -> list:
    """
    Load tools from config string.
    Format: package1:tool1,tool2;package2:tool3,tool4
    Examples:
      - strands_tools:shell,editor;strands_action:use_github
      - strands_action:use_github;strands_tools:shell,use_aws
    """
    tools = []

    # Split by semicolon to get package groups
    groups = config.split(";")

    for group in groups:
        group = group.strip()
        if not group:
            continue

        # Split by colon to get package:tools
        parts = group.split(":", 1)
        if len(parts) != 2:
            print(f"✗ Invalid format: {group}")
            continue

        package = parts[0].strip()
        tools_str = parts[1].strip()

        # Parse tools (comma-separated)
        tool_names = [t.strip() for t in tools_str.split(",") if t.strip()]

        for tool_name in tool_names:
            try:
                module = __import__(package, fromlist=[tool_name])
                tool = getattr(module, tool_name)
                tools.append(tool)
                print(f"✓ {package}:{tool_name}")
            except (ImportError, AttributeError) as e:
                print(f"✗ {package}:{tool_name} - {e}")

    print(f"Loaded {len(tools)} tools")
    return tools


def load_mcp_servers() -> list:
    """Load MCP servers from MCP_SERVERS env var with tool filtering."""
    mcp_json = os.getenv("MCP_SERVERS")
    if not mcp_json:
        return []

    try:
        from mcp import StdioServerParameters, stdio_client
        from mcp.client.sse import sse_client
        from mcp.client.streamable_http import streamablehttp_client
        from strands.tools.mcp import MCPClient

        config = json.loads(mcp_json).get("mcpServers", {})
        clients = []

        for name, cfg in config.items():
            try:
                # Check if server is disabled
                if cfg.get("disabled", False):
                    print(f"⏭  MCP server '{name}' (disabled)")
                    continue

                # Get disabled tools list (for logging only - MCPClient handles filtering differently)
                disabled_tools = cfg.get("disabledTools", [])

                if "command" in cfg:
                    command = cfg["command"]
                    args = cfg.get("args", [])
                    env = cfg.get("env")

                    def transport(_cmd: str = command, _args: list = args, _env: dict | None = env):  # type: ignore[no-untyped-def]
                        return stdio_client(StdioServerParameters(command=_cmd, args=_args, env=_env))

                    client = MCPClient(
                        transport_callable=transport,
                        prefix=cfg.get("prefix", name),
                    )
                elif "url" in cfg:
                    url = cfg["url"]
                    headers = cfg.get("headers")

                    def transport_http(_url: str = url, _headers: dict | None = headers):  # type: ignore[no-untyped-def]
                        return sse_client(_url) if "/sse" in _url else streamablehttp_client(url=_url, headers=_headers)

                    client = MCPClient(
                        transport_callable=transport_http,
                        prefix=cfg.get("prefix", name),
                    )
                else:
                    continue

                clients.append(client)

                if disabled_tools:
                    print(f"✓ MCP server '{name}' (disabled: {', '.join(disabled_tools)})")
                else:
                    print(f"✓ MCP server '{name}'")
            except Exception as e:
                print(f"✗ MCP server '{name}': {e}")

        return clients
    except Exception as e:
        print(f"MCP loading failed: {e}")
        return []


def build_system_prompt() -> str:
    """Build system prompt from environment variables and context."""
    # Base system prompt
    base_prompt = os.getenv("SYSTEM_PROMPT", "")
    if not base_prompt:
        base_prompt = "You are an autonomous GitHub agent powered by Strands Agents SDK. (strands-agents/sdk-python)"

    # Add GitHub context if available
    github_context = os.getenv("GITHUB_CONTEXT", "")
    if github_context:
        base_prompt = f"{base_prompt}\n\nGitHub Context:\n```{github_context}\n```"

    return base_prompt


def run_agent(prompt: str) -> None:
    """Run the agent with the provided prompt."""
    has_mcp_servers = False
    try:
        # Setup OpenTelemetry
        setup_otel()

        # Tool loading with defaults (minimal core tools)
        default_tools = (
            "strands_tools:shell,retrieve,use_agent;strands_action:use_github,system_prompt,store_in_kb,create_subagent"
        )
        tools_config = os.getenv("STRANDS_TOOLS", default_tools)

        print(f"Loading tools: {tools_config}")
        tools = load_tools(tools_config)

        # Add GitHub tools
        github_tools = load_github_tools()
        tools.extend(github_tools)

        # Add additional tools
        additional_tools = load_additional_tools()
        tools.extend(additional_tools)

        # MCP servers
        if os.getenv("STRANDS_LOAD_MCP_SERVERS", "true").lower() == "true":
            mcp_servers = load_mcp_servers()
            if mcp_servers:
                has_mcp_servers = True
                tools.extend(mcp_servers)

        # Model and session
        model = create_model(provider=os.getenv("STRANDS_PROVIDER", "bedrock"))
        session_id = (
            os.getenv("SESSION_ID")
            or f"gh-{os.getenv('GITHUB_REPOSITORY', 'unknown').replace('/', '-')}-{os.getenv('GITHUB_RUN_ID', 'local')}"
        )

        session_manager = None
        s3_bucket = os.getenv("S3_SESSION_BUCKET")
        if s3_bucket:
            session_manager = S3SessionManager(
                session_id=session_id,
                bucket=s3_bucket,
                prefix=os.getenv("S3_SESSION_PREFIX", ""),
            )
            print(f"S3 session: {session_id}")

        # Create agent
        agent = Agent(
            model=model,
            system_prompt=build_system_prompt(),
            tools=tools,
            session_manager=session_manager,
            load_tools_from_directory=os.getenv("STRANDS_TOOLS_DIRECTORY", "false").lower() == "true",
            trace_attributes={
                "session.id": session_id,
                "user.id": os.getenv("GITHUB_ACTOR", "unknown"),
                "repository": os.getenv("GITHUB_REPOSITORY", "unknown"),
                "workflow": os.getenv("GITHUB_WORKFLOW", "unknown"),
                "run_id": os.getenv("GITHUB_RUN_ID", "unknown"),
                "tags": ["Strands-Agents", "GitHub-Action"],
            },
        )

        print(f"Agent created with {len(tools)} tools")

        # Knowledge base retrieval (before)
        kb_id = os.getenv("STRANDS_KNOWLEDGE_BASE_ID")
        if kb_id and "retrieve" in agent.tool_names:
            try:
                # Critical: `record_direct_tool_call=True` is mandatory. Do not remove.
                agent.tool.retrieve(text=prompt, knowledgeBaseId=kb_id, record_direct_tool_call=True)
                print(f"KB retrieval: {kb_id}")
            except Exception as e:
                print(f"KB retrieval failed: {e}")

        result = agent(prompt)

        # Write to GitHub Actions summary
        summary_file = os.getenv("GITHUB_STEP_SUMMARY")
        if summary_file:
            try:
                with open(summary_file, "a") as f:
                    f.write("## Agent\n\n")
                    f.write(f"**Prompt:**\n```\n{prompt}\n```\n\n")
                    f.write(f"**Result:**\n```\n{str(result)}\n```\n\n")
                    f.write(f"**Session:** `{session_id}`\n")
                    if kb_id:
                        f.write(f"**Knowledge Base:** `{kb_id}`\n")
            except Exception as e:
                print(f"Failed to write summary: {e}")

        # Knowledge base storage (after)
        if kb_id and "store_in_kb" in agent.tool_names:
            try:
                agent.tool.store_in_kb(
                    content=f"Input: {prompt}\nResult: {str(result)}",
                    title=f"GitHub Agent: {prompt[:1000]}",
                    knowledge_base_id=kb_id,
                    record_direct_tool_call=False,
                )
                print(f"\nKB storage: {kb_id}")
            except Exception as e:
                print(f"\nKB storage failed: {e}")

        print("\n✅ Agent completed successfully")

        # Use os._exit() when MCP servers present (background threads need force-kill)
        # Unless PYTEST_CURRENT_TEST is set (testing mode), use sys.exit() for proper cleanup
        if has_mcp_servers and not os.getenv("PYTEST_CURRENT_TEST"):
            os._exit(0)
        else:
            sys.exit(0)

    except Exception as e:
        print(f"Agent failed: {e}", file=sys.stderr)

        # Use os._exit() when MCP servers present (background threads need force-kill)
        # Unless PYTEST_CURRENT_TEST is set (testing mode), use sys.exit() for proper cleanup
        if "has_mcp_servers" in locals() and has_mcp_servers and not os.getenv("PYTEST_CURRENT_TEST"):
            os._exit(1)
        else:
            sys.exit(1)


def main() -> None:
    """Main entry point."""
    import argparse

    parser = argparse.ArgumentParser(
        prog="strands-action",
        description="Autonomous GitHub agent powered by Strands Agents SDK",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Via environment variable (recommended in GitHub Actions)
  STRANDS_PROMPT="analyze this repository" strands-action

  # Via command-line argument (CLI usage)
  strands-action "analyze this repository"
  strands-action "create a PR to fix issue #123"
  strands-action "run tests and report results"

Environment Variables:
  STRANDS_PROMPT           Task prompt (takes precedence over CLI args)
  STRANDS_PROVIDER         Model provider (default: bedrock)
  STRANDS_MODEL_ID         Model identifier
  STRANDS_TOOLS            Tools config (format: pkg:tool1,tool2;pkg2:tool3)
  SYSTEM_PROMPT            Base system prompt
  STRANDS_KNOWLEDGE_BASE_ID  AWS Bedrock Knowledge Base ID for RAG
  S3_SESSION_BUCKET        S3 bucket for session persistence
  MCP_SERVERS              JSON config for MCP servers
  LANGFUSE_BASE_URL        Langfuse endpoint for telemetry
  GITHUB_CONTEXT           GitHub event/workflow context

For more info: https://github.com/strands-agents/sdk-python
        """,
    )

    parser.add_argument(
        "prompt",
        nargs="*",  # Changed from "+" to "*" to make it optional
        help="Task prompt for the agent to execute (alternative to STRANDS_PROMPT env var)",
    )

    try:
        args = parser.parse_args()

        # Priority: STRANDS_PROMPT env var > command-line args
        prompt = os.getenv("STRANDS_PROMPT")

        if not prompt:
            # Fallback to command-line arguments
            if args.prompt:
                prompt = " ".join(args.prompt)
            else:
                parser.error("Prompt required via STRANDS_PROMPT env var or command-line argument")

        if not prompt.strip():
            parser.error("Prompt cannot be empty")

        run_agent(prompt)

    except SystemExit:
        raise
    except Exception as e:
        print(f"Fatal: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()