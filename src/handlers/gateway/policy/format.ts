import type { GeneratedPolicy } from "./types";

export function formatStatements(policies: GeneratedPolicy[]): string {
  const statements = policies.flatMap((policy) =>
    policy.statement ? [policy.statement.trimEnd()] : [],
  );
  return `${statements.join("\n\n")}\n`;
}

export function formatFindings(policies: GeneratedPolicy[]): string {
  const rows = policies.flatMap((policy, index) =>
    policy.findings.map(
      (finding) => `  policy ${index + 1}  [${finding.type}]  ${finding.description}`,
    ),
  );
  return rows.length === 0 ? "" : `Findings:\n${rows.join("\n")}\n`;
}
