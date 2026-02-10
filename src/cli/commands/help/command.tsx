import type { Command } from '@commander-js/extra-typings';

const MODES_HELP = `
INTERACTIVE MODE (TUI)
  Run any command without flags to launch the interactive terminal UI.
  
  Features:
    • Guided prompts walk you through options
    • Real-time streaming for invoke and dev
    • Visual feedback and progress indicators
  
  Examples:
    agentcore                    # Launch main menu
    agentcore create             # Guided project creation
    agentcore add                # Add resources interactively
    agentcore invoke             # Chat with deployed agent

NON-INTERACTIVE MODE (CLI)
  Pass any flag marked [non-interactive] to run in CLI mode.
  
  Features:
    • Scriptable for CI/CD pipelines
    • JSON output with --json flag
    • No prompts - fails fast on missing required options
  
  Examples:
    agentcore create --name MyProject --defaults --json
    agentcore deploy --target prod --yes
    agentcore invoke "Hello" --stream
    agentcore remove agent --name OldAgent --force

FLAGS THAT TRIGGER CLI MODE
  Most flags trigger non-interactive mode, including:
    --name, --json, --yes, --force, --target, --stream, etc.
  
  Some flags work in both modes:
    --session-id (invoke), --port (dev), --agent (dev)
`;

export const registerHelp = (program: Command) => {
  const helpCmd = program
    .command('help')
    .description('Display help topics')
    .action(() => {
      console.log('Available help topics: modes');
      console.log('Run `agentcore help <topic>` for details.');
    });

  helpCmd
    .command('modes')
    .description('Explain interactive vs non-interactive modes')
    .action(() => {
      console.log(MODES_HELP);
    });
};
