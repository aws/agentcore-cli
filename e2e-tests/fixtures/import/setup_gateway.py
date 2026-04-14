#!/usr/bin/env python3
"""Setup: Gateway with MCP server target + tags.

Tests: gateway import, target mapping, authorizerType, enableSemanticSearch,
       exceptionLevel, tags, deployed state nesting under mcp.gateways.

Creates:
  1. A gateway with NONE authorizer + semantic search enabled
  2. An MCP Server target pointing to a public test endpoint
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import time
from common import (
    REGION, get_control_client, ensure_role, save_resource,
    tag_resource, wait_for_gateway, wait_for_gateway_target,
)


def main():
    role_arn = ensure_role()
    client = get_control_client()
    ts = int(time.time())
    gateway_name = f"bugbashGw{ts}"

    # ------------------------------------------------------------------
    # 1. Create gateway
    # ------------------------------------------------------------------
    print(f"Creating gateway: {gateway_name}")
    resp = client.create_gateway(
        name=gateway_name,
        description="Bugbash gateway for import testing",
        roleArn=role_arn,
        protocolType="MCP",
        protocolConfiguration={
            "mcp": {
                "supportedVersions": ["2025-03-26"],
                "searchType": "SEMANTIC",
            },
        },
        authorizerType="NONE",
        exceptionLevel="DEBUG",
    )

    gateway_id = resp["gatewayId"]
    gateway_arn = resp["gatewayArn"]
    print(f"Gateway ID: {gateway_id}")
    print(f"Gateway ARN: {gateway_arn}")

    tag_resource(client, gateway_arn, {
        "env": "bugbash",
        "team": "agentcore-cli",
    })

    save_resource("gateway", gateway_arn, gateway_id)

    if not wait_for_gateway(client, gateway_id):
        print("Gateway creation failed. Aborting target creation.")
        sys.exit(1)

    # ------------------------------------------------------------------
    # 2. Create MCP Server target
    # ------------------------------------------------------------------
    target_name = "mcpTarget"
    print(f"\nCreating MCP Server target: {target_name}")
    target_resp = client.create_gateway_target(
        gatewayIdentifier=gateway_id,
        name=target_name,
        targetConfiguration={
            "mcp": {
                "mcpServer": {
                    "endpoint": "https://mcp.exa.ai/mcp",
                },
            },
        },
    )

    target_id = target_resp["targetId"]
    print(f"Target ID: {target_id}")

    save_resource("gateway-target-mcp", gateway_arn, target_id)
    wait_for_gateway_target(client, gateway_id, target_id)


if __name__ == "__main__":
    main()
