// The shared `--help` group vocabulary for the eval commands. These commands
// have enough flags that a single flat option list is hard to skim, and they
// overlap heavily — batch evaluation, batch insights, and online evaluation all
// name a session source, narrow it, and apply evaluators. Naming the headings
// once means the same concept reads the same everywhere, and a typo cannot
// silently split one heading into two.
export const HELP_GROUP = {
  runtimeInvocation: "Runtime invocation:",
  dataset: "Dataset:",
  target: "Target:",
  configuration: "Configuration:",
  // The exclusive spelling is for commands where a source must be chosen at
  // creation; `sessionSource` is for update, where leaving it alone keeps the
  // existing source.
  sessionSourceExclusive: "Session source (choose exactly one):",
  sessionSource: "Session source:",
  sourceFilters: "Source filters:",
  evaluation: "Evaluation:",
  analysis: "Analysis:",
  execution: "Execution:",
} as const;
