import io
import json
import unittest
from contextlib import redirect_stdout
from unittest.mock import MagicMock, patch

import harness_review


class HarnessReviewTest(unittest.TestCase):
    @patch.object(harness_review.boto3, "client")
    def test_invoke_harness_does_not_forward_github_token(self, client):
        client.return_value.invoke_harness.return_value = {"stream": []}

        stream = harness_review.invoke_harness_streaming(
            "arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/test-1234567890",
            "session-id-with-at-least-thirty-three-characters",
            "system prompt",
            [{"role": "user", "content": [{"text": "review"}]}],
            "model-id",
            "us-east-1",
        )

        self.assertEqual(stream, [])
        request = client.return_value.invoke_harness.call_args.kwargs
        self.assertNotIn("tools", request)

    def test_extract_review_uses_final_complete_block(self):
        text = (
            "analysis <github-review>old</github-review> more analysis "
            "<github-review>\n## AgentCore Harness Review\n\nLooks good.\n</github-review>"
        )

        self.assertEqual(
            harness_review.extract_review(text),
            "## AgentCore Harness Review\n\nLooks good.",
        )

    def test_extract_review_rejects_missing_block(self):
        with self.assertRaisesRegex(
            harness_review.HarnessReviewError,
            "complete review block",
        ):
            harness_review.extract_review("Review complete without a result")

    def test_print_stream_returns_only_text_after_final_tool(self):
        events = [
            {"contentBlockDelta": {"delta": {"text": "<github-review>old</github-review>"}}},
            {
                "contentBlockStart": {
                    "start": {"toolUse": {"name": "shell"}},
                }
            },
            {"contentBlockDelta": {"delta": {"toolUse": {"input": '{"command":"true"}'}}}},
            {"contentBlockStop": {}},
            {"contentBlockDelta": {"delta": {"text": "<github-review>final</github-review>"}}},
            {"messageStop": {"stopReason": "end_turn"}},
        ]

        with redirect_stdout(io.StringIO()):
            result = harness_review.print_stream(events)

        self.assertEqual(result, "<github-review>final</github-review>")

    @patch.object(harness_review, "urlopen")
    def test_post_review_uses_github_api_and_comment_event(self, urlopen):
        response = MagicMock()
        response.__enter__.return_value = io.BytesIO(b'{"id": 123}')
        urlopen.return_value = response
        github = harness_review.GitHubClient(
            "https://github.com/aws/agentcore-cli/pull/2001",
            "token",
        )

        result = github.post_review("Looks good.")

        self.assertEqual(result, {"id": 123})
        request = urlopen.call_args.args[0]
        self.assertEqual(
            request.full_url,
            "https://api.github.com/repos/aws/agentcore-cli/pulls/2001/reviews",
        )
        self.assertEqual(
            json.loads(request.data),
            {"body": "Looks good.", "event": "COMMENT"},
        )
        self.assertEqual(request.get_header("Authorization"), "Bearer token")


if __name__ == "__main__":
    unittest.main()
