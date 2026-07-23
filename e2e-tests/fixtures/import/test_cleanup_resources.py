#!/usr/bin/env python3
import importlib.util
import os
import sys
import types
import unittest

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

fake_boto3 = types.ModuleType("boto3")
fake_common = types.ModuleType("common")
fake_common.REGION = "us-east-1"
fake_common.RESOURCES_FILE = "/tmp/unused-bugbash-resources.json"
fake_common.get_account_id = lambda: "123456789012"
fake_common.get_control_client = lambda: None
sys.modules["boto3"] = fake_boto3
sys.modules["common"] = fake_common

spec = importlib.util.spec_from_file_location(
    "cleanup_resources",
    os.path.join(SCRIPT_DIR, "cleanup_resources.py"),
)
cleanup_resources = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cleanup_resources)


class ResourceNotFoundError(Exception):
    response = {"Error": {"Code": "ResourceNotFoundException"}}


class FakeControlClient:
    def __init__(self):
        self.calls = []

    def delete_gateway_target(self, **kwargs):
        self.calls.append(("delete_gateway_target", kwargs))

    def get_gateway_target(self, **kwargs):
        self.calls.append(("get_gateway_target", kwargs))
        raise ResourceNotFoundError()

    def delete_gateway(self, **kwargs):
        self.calls.append(("delete_gateway", kwargs))

    def delete_agent_runtime(self, **kwargs):
        self.calls.append(("delete_agent_runtime", kwargs))


class CleanupResourcesTest(unittest.TestCase):
    def test_deletes_target_before_parent_gateway(self):
        client = FakeControlClient()
        resources = {
            "gateway": {"arn": "gateway-arn", "id": "gateway-id"},
            "gateway-target-mcp": {"arn": "gateway-arn", "id": "target-id"},
            "runtime-basic": {"arn": "runtime-arn", "id": "runtime-id"},
        }

        failed = cleanup_resources.delete_tracked_resources(client, resources)

        self.assertEqual(failed, [])
        self.assertEqual(
            [name for name, _kwargs in client.calls],
            [
                "delete_gateway_target",
                "get_gateway_target",
                "delete_agent_runtime",
                "delete_gateway",
            ],
        )

    def test_retains_unknown_and_incomplete_records(self):
        client = FakeControlClient()
        resources = {
            "unknown-resource": {"arn": "unknown-arn", "id": "unknown-id"},
            "runtime-without-id": {"arn": "runtime-arn"},
        }

        failed = cleanup_resources.delete_tracked_resources(client, resources)

        self.assertEqual(failed, ["unknown-resource", "runtime-without-id"])
        self.assertEqual(client.calls, [])

    def test_retains_target_without_matching_gateway(self):
        client = FakeControlClient()
        resources = {
            "gateway-target-mcp": {"arn": "missing-gateway-arn", "id": "target-id"},
        }

        failed = cleanup_resources.delete_tracked_resources(client, resources)

        self.assertEqual(failed, ["gateway-target-mcp"])
        self.assertEqual(client.calls, [])


if __name__ == "__main__":
    unittest.main()
