import { SKILLS_DIRECTORY, SKILL_MANIFEST_FILENAME } from "../skillsDir";

/**
 * The README scaffolded into a harness's skills/ directory. Inlined like the
 * harness template's default prompt rather than shipped as an asset: the
 * harness template has no asset source, and this is a single short file.
 */
export const HARNESS_SKILLS_README = `# Skills

Drop skills for this harness in here, **one subdirectory per skill**. Each skill
directory holds a \`${SKILL_MANIFEST_FILENAME}\` (the skill's name, description, and
instructions) plus whatever files the skill needs:

\`\`\`
${SKILLS_DIRECTORY}/
├── README.md          # this file; ignored by deploy (not a directory)
├── pdf-tools/
│   ├── ${SKILL_MANIFEST_FILENAME}
│   └── scripts/...
└── release-notes/
    └── ${SKILL_MANIFEST_FILENAME}
\`\`\`

Copy a skill directory in to add it; delete the directory to remove it. Files at
the top level of \`${SKILLS_DIRECTORY}/\` are ignored, as are dotfiles, \`.git\`,
\`__pycache__\`, and \`.DS_Store\` anywhere inside a skill.

Rules checked before a deploy touches AWS:

- every skill directory contains a \`${SKILL_MANIFEST_FILENAME}\` at its top level;
- directory names match \`^[a-z0-9][a-z0-9._-]{0,63}$\` (they become part of an
  S3 key and a URI);
- no single file exceeds 5 GB.

## How they deploy

With \`AGENTCORE_CLI_EXPERIMENTAL_IMPERATIVE_DEPLOY=1\`, \`agentcore project deploy\`
uploads every skill here to an S3 bucket the CLI creates for your account and
region (\`agentcore-skills-<account>-<region>\`, public access blocked) under
\`<project>/<harness>/${SKILLS_DIRECTORY}/<skill>/\`, and lists each one on the harness as
an \`s3\` skill source after whatever \`harness.json\` already declares.
\`harness.json\` is never rewritten. Redeploying uploads only changed files,
removes objects for skills you deleted, and updates the harness when anything
changed. The bucket is shared by every project in the account and is never
deleted by the CLI.

The CDK deployment path (the default, without the variable) currently ignores
this directory; list skills in \`harness.json\` there.
`;
