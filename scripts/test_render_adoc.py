import unittest

from scripts.render_adoc import normalize_param_description


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


if __name__ == "__main__":
    unittest.main()
