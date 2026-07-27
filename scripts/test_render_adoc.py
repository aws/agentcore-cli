import unittest

from scripts.render_adoc import normalize_param_description, normalize_style


class NormalizeParamDescriptionTest(unittest.TestCase):
    def test_optional_descriptions_support_singular_plural_and_mass_nouns(self):
        cases = {
            "Optional session name.": "The optional session name.",
            "Optional tags.": "The optional tags.",
            "Optional additional task metadata.": "The optional additional task metadata.",
        }

        for description, expected in cases.items():
            with self.subTest(description=description):
                self.assertEqual(normalize_param_description(description), expected)

    def test_service_names_are_fully_qualified(self):
        self.assertEqual(
            normalize_style("Client for AgentCore runtime."),
            "Client for Amazon Bedrock AgentCore runtime.",
        )
        self.assertEqual(
            normalize_style("Client for the AgentCore Code Interpreter sandbox service."),
            "Client for the Amazon Bedrock AgentCore Code Interpreter sandbox service.",
        )
        self.assertEqual(
            normalize_style("Retrieves an API key from AgentCore Identity."),
            "Retrieves an API key from Amazon Bedrock AgentCore Identity.",
        )
        self.assertEqual(
            normalize_style("Provides credentials, allowing applications to connect."),
            "Provides credentials so applications can connect.",
        )


if __name__ == "__main__":
    unittest.main()
