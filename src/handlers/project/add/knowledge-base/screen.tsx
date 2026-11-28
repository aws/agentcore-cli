import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import z from "zod";
import { MultiTextField, Step, Summary, TextField, Wizard } from "../../../../components/wizard";
import {
  KnowledgeBaseNameSchema,
  S3DataSourceSchema,
} from "../../../../projectSchemas/knowledge-base";
import { ProjectKey } from "../../../../router";
import type { ScreenProps } from "../../../types";
import type { Project } from "../../types";
import { ProjectGate, projectQueryKey } from "../../ProjectGate";
import { RegionKey } from "../../../keys";
import { toAddKnowledgeBaseInput } from "./index";

const BREADCRUMB = ["agentcore", "add", "knowledge-base"];
const DESCRIPTION = "add a Knowledge Base to the current project";
const ADD_MENU = "/agentcore/add";

type KnowledgeBaseFormValues = {
  name: string;
  dataSource: string;
  description: string;
};

function summaryOf(values: KnowledgeBaseFormValues): Record<string, string> {
  return {
    name: values.name,
    dataSource: values.dataSource,
    description: values.description.trim() || "(none)",
  };
}

export function AddKnowledgeBaseScreen({ ctx, core }: ScreenProps) {
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
        <AddKnowledgeBaseWizard project={project} core={core} region={ctx.value(RegionKey)} />
      )}
    </ProjectGate>
  );
}

function AddKnowledgeBaseWizard({
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
  const [values, setValues] = useState<KnowledgeBaseFormValues>({
    name: "",
    dataSource: "",
    description: "",
  });
  const set = (update: Partial<KnowledgeBaseFormValues>) =>
    setValues((current) => ({ ...current, ...update }));

  return (
    <Wizard
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      onCancel={() => navigate(ADD_MENU)}
      onSubmit={async function* () {
        const updated = yield* core.projectManager.addResource(
          project,
          toAddKnowledgeBaseInput({
            name: values.name,
            dataSources: [values.dataSource],
            description: values.description.trim() || undefined,
          }),
          { region },
        );
        queryClient.setQueryData(projectQueryKey(), updated);
        return updated;
      }}
      runningLabel={`adding Knowledge Base ${values.name}…`}
      successLabel={`added Knowledge Base '${values.name}' to '${project.name}'`}
      successNextSteps={["agentcore deploy"]}
      onDone={() => navigate(ADD_MENU)}
      doneLabel="go back"
    >
      <Step stepKey="name" prompt="what should this Knowledge Base be called?">
        <TextField
          label="Knowledge Base name"
          help="letters, digits, dashes and underscores, starting with a letter (max 48)"
          placeholder="product-docs"
          value={values.name}
          onChange={(name) => set({ name })}
          required
          schema={KnowledgeBaseNameSchema}
          live
        />
      </Step>

      <Step stepKey="source" prompt="where does its data live?">
        <TextField
          label="S3 data source"
          help="an s3:// URI, for example s3://my-bucket/docs"
          placeholder="s3://my-bucket/docs"
          value={values.dataSource}
          onChange={(dataSource) => set({ dataSource })}
          required
          schema={S3DataSourceSchema.shape.uri}
          live
        />
      </Step>

      <Step stepKey="details" prompt="anything else worth recording?">
        <MultiTextField
          inputs={[
            {
              key: "description",
              label: "Description",
              help: "optional — up to 2048 characters",
              placeholder: "Product documentation",
              value: values.description,
              onChange: (description) => set({ description }),
              schema: z.string().max(2048).optional(),
            },
          ]}
        />
      </Step>

      <Step stepKey="review" prompt="this Knowledge Base will be added to agentcore.json">
        <Summary items={summaryOf(values)} />
      </Step>
    </Wizard>
  );
}
