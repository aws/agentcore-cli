import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import z from "zod";
import {
  ResourceChoiceField,
  RevealChoiceField,
  Step,
  Summary,
  TextField,
  Wizard,
  type Choice,
} from "../../../../components/wizard";
import {
  REAL_KB_ID_PATTERN,
  type AgentCoreGateway,
  type ConnectorId,
} from "../../../../projectSchemas/gateway";
import { ProjectKey } from "../../../../router";
import type { ScreenProps } from "../../../types";
import type { Project } from "../../types";
import { ProjectGate, projectQueryKey } from "../../ProjectGate";
import { toAddGatewayConnectorInput, type GatewayConnectorShortcutInput } from "./index";
import { RegionKey } from "../../../keys";

const BREADCRUMB = ["agentcore", "add", "gateway-connector"];
const DESCRIPTION = "add a connector-backed Target to a project Gateway";
const ADD_MENU = "/agentcore/add";

const KNOWLEDGE_BASES: ConnectorId = "bedrock-knowledge-bases";

// The curated connectors --connector accepts, each with the tool it configures.
const CONNECTOR_CHOICES: Choice<ConnectorId>[] = [
  {
    value: "web-search",
    label: "web-search",
    description: "search the web · adds the WebSearch tool",
  },
  {
    value: KNOWLEDGE_BASES,
    label: "bedrock-knowledge-bases",
    description: "retrieve from a Bedrock Knowledge Base · adds the Retrieve tool",
  },
];

// knowledgeBaseSchema accepts what the project spec accepts for a connector's
// knowledgeBaseId: a real ten-character ID, or the name of a knowledgeBases[]
// entry declared in this project. Like the spec, it refuses a value that is
// both, since the reference would be ambiguous; checking here means the wizard
// says so on the step rather than when the spec is written.
export function knowledgeBaseSchema(projectKnowledgeBases: readonly string[]): z.ZodType {
  const names =
    projectKnowledgeBases.length > 0 ? ` or one of ${projectKnowledgeBases.join(", ")}` : "";
  return z.string().superRefine((value, ctx) => {
    const looksLikeId = REAL_KB_ID_PATTERN.test(value);
    const isProjectName = projectKnowledgeBases.includes(value);
    if (looksLikeId && isProjectName) {
      ctx.addIssue({
        code: "custom",
        message: `'${value}' is both a Knowledge Base ID and the name of a Knowledge Base in this project; rename the project Knowledge Base so the reference is unambiguous`,
      });
    } else if (!looksLikeId && !isProjectName) {
      ctx.addIssue({
        code: "custom",
        message: `must be a ten-character Knowledge Base ID (A–Z, 0–9)${names}`,
      });
    }
  });
}

function gatewayChoices(gateways: readonly AgentCoreGateway[]): Choice<string>[] {
  return gateways.map((gateway) => ({
    value: gateway.name,
    label: gateway.name,
    description: `${gateway.targets.length} ${gateway.targets.length === 1 ? "Target" : "Targets"}`,
  }));
}

type GatewayConnectorFormValues = {
  gateway: string;
  connector: ConnectorId;
  knowledgeBase: string;
  name: string;
  // The name is prefilled with the connector's name and follows it until the
  // user edits it; after that it is theirs.
  nameEdited: boolean;
};

// toGatewayConnectorInput is the answers as the flag path would state them; the
// shared builder then writes exactly what `--connector` writes.
export function toGatewayConnectorInput(
  values: GatewayConnectorFormValues,
): GatewayConnectorShortcutInput {
  return {
    gateway: values.gateway,
    name: values.name,
    connector: values.connector,
    knowledgeBase: values.connector === KNOWLEDGE_BASES ? values.knowledgeBase : undefined,
  };
}

function summaryOf(values: GatewayConnectorFormValues): Record<string, string> {
  const isKnowledgeBase = values.connector === KNOWLEDGE_BASES;
  return {
    gateway: values.gateway,
    target: values.name,
    connector: values.connector,
    ...(isKnowledgeBase ? { "knowledge base": values.knowledgeBase } : {}),
    // The tool the connector configures, so what the flags would have written
    // is on screen before it is.
    tool: isKnowledgeBase ? "Retrieve" : "WebSearch · maxResults 10",
  };
}

export function AddGatewayConnectorScreen({ ctx, core }: ScreenProps) {
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
        <AddGatewayConnectorWizard project={project} core={core} region={ctx.value(RegionKey)} />
      )}
    </ProjectGate>
  );
}

function AddGatewayConnectorWizard({
  project,
  core,
  region,
}: {
  project: Project;
  core: ScreenProps["core"];
  /** The command\'s resolved region, for the China gate of a project without targets. */
  region: string | undefined;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const gateways = project.spec.agentCoreGateways ?? [];
  const kbSchema = useMemo(
    () => knowledgeBaseSchema((project.spec.knowledgeBases ?? []).map((kb) => kb.name)),
    [project.spec.knowledgeBases],
  );

  const [values, setValues] = useState<GatewayConnectorFormValues>({
    gateway: gateways[0]?.name ?? "",
    connector: "web-search",
    knowledgeBase: "",
    name: "web-search",
    nameEdited: false,
  });
  const set = (update: Partial<GatewayConnectorFormValues>) =>
    setValues((current) => ({ ...current, ...update }));

  return (
    <Wizard
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      onCancel={() => navigate(ADD_MENU)}
      onSubmit={async function* () {
        const updated = yield* core.projectManager.addResource(
          project,
          toAddGatewayConnectorInput(toGatewayConnectorInput(values)),
          { region },
        );
        queryClient.setQueryData(projectQueryKey(), updated);
        return updated;
      }}
      runningLabel={`adding connector ${values.name}…`}
      successLabel={`added Connector Target '${values.name}' to Gateway '${values.gateway}' in '${project.name}'`}
      successNextSteps={["agentcore deploy"]}
      onDone={() => navigate(ADD_MENU)}
      doneLabel="go back"
    >
      <Step stepKey="gateway" prompt="which Gateway should this connector hang off?">
        <ResourceChoiceField
          choices={gatewayChoices(gateways)}
          value={values.gateway}
          onChange={(gateway) => set({ gateway })}
          emptyMessage="no Gateways in this project"
          emptyHint="add one with  agentcore add gateway"
        />
      </Step>

      <Step stepKey="connector" prompt="which connector?">
        <RevealChoiceField
          choices={CONNECTOR_CHOICES}
          value={values.connector}
          onChange={(connector) =>
            set(values.nameEdited ? { connector } : { connector, name: connector })
          }
          input={{
            // Only the Knowledge Base connector needs to know which one, so the
            // question opens under that row.
            opensFor: (connector) => connector === KNOWLEDGE_BASES,
            label: "Knowledge Base",
            name: "knowledge base",
            help: "a ten-character Knowledge Base ID, or the name of a Knowledge Base in this project",
            placeholder: "ABCDEFGHIJ",
            value: values.knowledgeBase,
            onChange: (knowledgeBase) => set({ knowledgeBase }),
            required: true,
            schema: kbSchema,
          }}
        />
      </Step>

      <Step stepKey="name" prompt="what should this Target be called?">
        <TextField
          label="Target name"
          help="prefilled with the connector's name · unique across every Gateway in this project"
          placeholder="search"
          value={values.name}
          onChange={(name) => set({ name, nameEdited: true })}
          required
        />
      </Step>

      <Step stepKey="review" prompt="this connector will be added to agentcore.json">
        <Summary items={summaryOf(values)} />
      </Step>
    </Wizard>
  );
}
