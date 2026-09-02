import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import z from "zod";
import { ProjectKey } from "../../../../router";
import { REAL_KB_ID_PATTERN, type ConnectorId } from "../../../../projectSchemas/gateway";
import type { ScreenProps } from "../../../types";
import type { Project } from "../../types";
import { ProjectGate } from "../../ProjectGate";
import {
  Wizard,
  Step,
  TextField,
  ChoiceField,
  Summary,
  Prerequisite,
} from "../../../../components/wizard";
import { toAddGatewayConnectorInput, type GatewayConnectorInput } from "./index";

const BREADCRUMB = ["agentcore", "project", "add", "gateway-connector"];
const DESCRIPTION = "adds a connector-backed Target to a project Gateway";
const ADD_MENU = "/agentcore/project/add";

const CONNECTOR_CHOICES = [
  {
    value: "web-search" as ConnectorId,
    label: "web-search",
    description: "search the web · no configuration needed",
  },
  {
    value: "bedrock-knowledge-bases" as ConnectorId,
    label: "bedrock-knowledge-bases",
    description: "retrieve from a Knowledge Base · asks which one",
  },
];

// OTHER_KB is the picker entry that opens the free-text step, for a Knowledge
// Base that lives outside this project.
const OTHER_KB = "\u0000other";

// A Knowledge Base is named either by a project Knowledge Base or by the
// service's ten-character ID; the flag accepts both and so does this step.
const KnowledgeBaseRefSchema = z
  .string()
  .refine((value) => REAL_KB_ID_PATTERN.test(value) || /^[A-Za-z][A-Za-z0-9_-]*$/.test(value), {
    message: "enter a project Knowledge Base name or a ten-character Knowledge Base ID",
  });

interface GatewayConnectorFormValues {
  gatewayName: string;
  connectorId: ConnectorId;
  // knowledgeBasePick is the picker's answer; OTHER_KB defers to knowledgeBaseId.
  knowledgeBasePick: string;
  knowledgeBaseId: string;
  name: string;
}

// toGatewayConnectorInput reads the form into the shortcut form of
// GatewayConnectorInput. The Knowledge Base is passed only for the connector
// that takes one, so a value typed before switching connectors is dropped.
export function toGatewayConnectorInput(values: GatewayConnectorFormValues): GatewayConnectorInput {
  const usesKnowledgeBase = values.connectorId === "bedrock-knowledge-bases";
  const knowledgeBase =
    values.knowledgeBasePick === OTHER_KB
      ? values.knowledgeBaseId.trim()
      : values.knowledgeBasePick;
  return {
    gatewayName: values.gatewayName,
    target: {
      kind: "shortcut",
      name: values.name.trim(),
      connectorId: values.connectorId,
      knowledgeBase: usesKnowledgeBase ? knowledgeBase : undefined,
    },
  };
}

function summaryOf(values: GatewayConnectorFormValues): Record<string, string> {
  const input = toGatewayConnectorInput(values);
  const target = input.target as Extract<GatewayConnectorInput["target"], { kind: "shortcut" }>;
  return {
    target: target.name,
    gateway: input.gatewayName,
    connector: target.connectorId,
    ...(target.knowledgeBase === undefined ? {} : { "knowledge base": target.knowledgeBase }),
  };
}

export function AddGatewayConnectorScreen({ ctx, core }: ScreenProps) {
  return (
    <ProjectGate
      core={core}
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      seed={ctx.value(ProjectKey)}
    >
      {(project) => <AddGatewayConnectorWizard project={project} core={core} />}
    </ProjectGate>
  );
}

function AddGatewayConnectorWizard({
  project,
  core,
}: {
  project: Project;
  core: ScreenProps["core"];
}) {
  const navigate = useNavigate();

  const gatewayChoices = useMemo(
    () =>
      (project.spec.agentCoreGateways ?? []).map((gateway) => ({
        value: gateway.name,
        label: gateway.name,
        description: gateway.description ?? `${gateway.targets.length} targets`,
      })),
    [project.spec.agentCoreGateways],
  );

  // Project Knowledge Bases are offered first; OTHER_KB opens a text step for
  // an external one, so a project with none goes straight to the text step.
  const knowledgeBaseChoices = useMemo(
    () => [
      ...(project.spec.knowledgeBases ?? []).map((kb) => ({
        value: kb.name,
        label: kb.name,
        description: kb.description ?? "project Knowledge Base",
      })),
      {
        value: OTHER_KB,
        label: "another Knowledge Base",
        description: "enter its ten-character ID",
      },
    ],
    [project.spec.knowledgeBases],
  );
  const hasProjectKnowledgeBases = knowledgeBaseChoices.length > 1;

  const [values, setValues] = useState<GatewayConnectorFormValues>({
    gatewayName: gatewayChoices[0]?.value ?? "",
    connectorId: "web-search",
    knowledgeBasePick: hasProjectKnowledgeBases ? knowledgeBaseChoices[0]!.value : OTHER_KB,
    knowledgeBaseId: "",
    name: "",
  });
  const set = (update: Partial<GatewayConnectorFormValues>) =>
    setValues((current) => ({ ...current, ...update }));

  if (gatewayChoices.length === 0) {
    return (
      <Prerequisite
        breadcrumb={BREADCRUMB}
        description={DESCRIPTION}
        message={`'${project.name}' has no Gateways yet; a connector Target needs one to attach to`}
        command="agentcore project add gateway"
        onBack={() => navigate(ADD_MENU)}
      />
    );
  }

  const usesKnowledgeBase = values.connectorId === "bedrock-knowledge-bases";
  const asksForId = usesKnowledgeBase && values.knowledgeBasePick === OTHER_KB;

  return (
    <Wizard
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      onCancel={() => navigate(ADD_MENU)}
      onSubmit={() =>
        core.projectManager.addResource(
          project,
          toAddGatewayConnectorInput(toGatewayConnectorInput(values)),
        )
      }
      runningLabel={`adding Connector Target ${values.name.trim()}…`}
      successLabel={`added Connector Target '${values.name.trim()}' to Gateway '${values.gatewayName}' in '${project.name}'`}
      successHint="enter exits"
    >
      <Step name="gateway" question="which Gateway should expose this connector?">
        <ChoiceField
          choices={gatewayChoices}
          value={values.gatewayName}
          onChange={(gatewayName) => set({ gatewayName })}
        />
      </Step>

      <Step name="connector" question="which connector?">
        <ChoiceField
          choices={CONNECTOR_CHOICES}
          value={values.connectorId}
          onChange={(connectorId) => set({ connectorId })}
        />
      </Step>

      {usesKnowledgeBase && hasProjectKnowledgeBases && (
        <Step name="knowledge-base" title="knowledge base" question="which Knowledge Base?">
          <ChoiceField
            choices={knowledgeBaseChoices}
            value={values.knowledgeBasePick}
            onChange={(knowledgeBasePick) => set({ knowledgeBasePick })}
          />
        </Step>
      )}

      {asksForId && (
        <Step
          name="knowledge-base-id"
          title="knowledge base"
          question="which Knowledge Base should it retrieve from?"
        >
          <TextField
            label="knowledge base"
            help="a project Knowledge Base name, or the service's ten-character ID"
            placeholder="ABCDEFGHIJ"
            value={values.knowledgeBaseId}
            onChange={(knowledgeBaseId) => set({ knowledgeBaseId })}
            required
            schema={KnowledgeBaseRefSchema}
          />
        </Step>
      )}

      <Step name="name" question="what should this Target be called?">
        <TextField
          label="target name"
          placeholder={values.connectorId === "web-search" ? "web" : "knowledge"}
          value={values.name}
          onChange={(name) => set({ name })}
          required
        />
      </Step>

      <Step name="review" question="this Target will be added to agentcore.json">
        <Summary items={summaryOf(values)} />
      </Step>
    </Wizard>
  );
}
