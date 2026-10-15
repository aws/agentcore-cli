import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { ProjectKey } from "../../../../router";
import { RegionKey } from "../../../keys";
import { AgentNameSchema } from "../../../../projectSchemas/runtime";
import type { ProtocolMode } from "../../../../projectSchemas/constants";
import type { ScreenProps } from "../../../types";
import type { Project } from "../../types";
import { ProjectGate, projectQueryKey } from "../../ProjectGate";
import {
  ChoiceField,
  Step,
  Summary,
  TextField,
  Wizard,
  type Choice,
} from "../../../../components/wizard";
import { docsRuntimeEntrypoint } from "../../../../core/project/templates/runtimeDocs";
import {
  RUNTIME_LANGUAGES,
  runtimeDocsAddedMessage,
  toAddRuntimeInput,
  type RuntimeInput,
  type RuntimeLanguageFlag,
} from "./index";

const BREADCRUMB = ["agentcore", "add", "runtime"];
const DESCRIPTION = "add a Runtime to the current project";
const ADD_MENU = "/agentcore/add";

const LANGUAGE_CHOICES: Choice<RuntimeLanguageFlag>[] = [
  { value: "python", label: "python", description: "main.py, dependencies in pyproject.toml (uv)" },
  {
    value: "typescript",
    label: "typescript",
    description: "main.ts, dependencies in package.json (npm)",
  },
];

const PROTOCOL_CHOICES: Choice<ProtocolMode>[] = [
  {
    value: "HTTP",
    label: "HTTP",
    description: "an agent: POST /invocations and GET /ping on 8080",
  },
  { value: "MCP", label: "MCP", description: "an MCP server: POST /mcp on 8000" },
  { value: "A2A", label: "A2A", description: "an agent-to-agent server: JSON-RPC on 9000" },
  { value: "AGUI", label: "AGUI", description: "an AG-UI agent: event stream on 8080" },
];

interface RuntimeFormValues {
  name: string;
  language: RuntimeLanguageFlag;
  protocol: ProtocolMode;
}

// toRuntimeInput builds the runtime the way the flag handler does for
// `--name <n> --language <l> --protocol <p>`.
export function toRuntimeInput(values: RuntimeFormValues): RuntimeInput {
  return {
    name: values.name,
    envVars: [],
    language: RUNTIME_LANGUAGES[values.language],
    protocol: values.protocol,
  };
}

function summaryOf(values: RuntimeFormValues): Record<string, string> {
  const language = RUNTIME_LANGUAGES[values.language];
  return {
    runtime: values.name,
    language,
    protocol: values.protocol,
    folder: `app/${values.name}/ (README.md, AGENTS.md)`,
    entrypoint: docsRuntimeEntrypoint(language),
  };
}

export function AddRuntimeScreen({ ctx, core }: ScreenProps) {
  const navigate = useNavigate();
  return (
    <ProjectGate
      core={core}
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      seed={ctx.value(ProjectKey)}
      onBack={() => navigate(ADD_MENU)}
    >
      {(project) => (
        <AddRuntimeWizard project={project} core={core} region={ctx.value(RegionKey)} />
      )}
    </ProjectGate>
  );
}

function AddRuntimeWizard({
  project,
  core,
  region,
}: {
  project: Project;
  core: ScreenProps["core"];
  region: string | undefined;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [values, setValues] = useState<RuntimeFormValues>({
    name: "",
    language: "python",
    protocol: "HTTP",
  });
  const set = (update: Partial<RuntimeFormValues>) =>
    setValues((current) => ({ ...current, ...update }));

  return (
    <Wizard
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      onCancel={() => navigate(ADD_MENU)}
      onSubmit={async function* () {
        const updated = yield* core.projectManager.addResource(
          project,
          toAddRuntimeInput(toRuntimeInput(values)),
          { region },
        );
        queryClient.setQueryData(projectQueryKey(), updated);
        return updated;
      }}
      runningLabel={`adding runtime ${values.name}…`}
      successLabel={runtimeDocsAddedMessage(
        values.name,
        RUNTIME_LANGUAGES[values.language],
        values.protocol,
      )}
      onDone={() => navigate(ADD_MENU)}
      doneLabel="go back"
    >
      <Step stepKey="name" prompt="what should this runtime be called?">
        <TextField
          label="Name"
          help="also the directory under app/ · letters, digits and underscores, starting with a letter (max 48)"
          placeholder="my_agent"
          value={values.name}
          onChange={(name) => set({ name })}
          required
          schema={AgentNameSchema}
          live
        />
      </Step>

      <Step stepKey="language" prompt="which language will you write it in?">
        <ChoiceField<RuntimeLanguageFlag>
          help="app/<name>/ gets a README.md and AGENTS.md describing what your code needs"
          choices={LANGUAGE_CHOICES}
          value={values.language}
          onChange={(language) => set({ language })}
        />
      </Step>

      <Step stepKey="protocol" prompt="which protocol will it serve?">
        <ChoiceField<ProtocolMode>
          help="the runtime contract your server implements"
          choices={PROTOCOL_CHOICES}
          value={values.protocol}
          onChange={(protocol) => set({ protocol })}
        />
      </Step>

      <Step stepKey="review" prompt="this runtime will be added to agentcore.json">
        <Summary items={summaryOf(values)} />
      </Step>
    </Wizard>
  );
}
