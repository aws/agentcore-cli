import { useState } from "react";
import { useNavigate } from "react-router";
import type z from "zod";
import { ProjectKey } from "../../../../router";
import {
  ConfigBundleBranchNameSchema,
  ConfigBundleCommitMessageSchema,
  ConfigBundleDescriptionSchema,
  ConfigBundleNameSchema,
  type ConfigBundleSchema,
} from "../../../../projectSchemas/config-bundle";
import type { ScreenProps } from "../../../types";
import type { AddResourceInput, Project } from "../../types";
import { ProjectGate } from "../../ProjectGate";
import { Wizard, Step, TextField, Summary } from "../../../../components/wizard";
import { ComponentsSchema } from "./index";

const BREADCRUMB = ["agentcore", "project", "add", "config-bundle"];
const DESCRIPTION = "adds a configuration bundle to the current project";

// The default the --branch-name flag applies.
const DEFAULT_BRANCH_NAME = "mainline";

// A complete, valid components map. It stays on screen while the user types,
// so the shape can be copied rather than remembered.
export const COMPONENTS_EXAMPLE = '{"pricing": {"configuration": {"currency": "USD"}}}';

interface ConfigBundleFormValues {
  name: string;
  components: string;
  description: string;
  branchName: string;
  commitMessage: string;
}

export function buildAddConfigBundleInput(values: ConfigBundleFormValues): AddResourceInput {
  const resourceConfig: z.input<typeof ConfigBundleSchema> = {
    name: values.name.trim(),
    description: values.description.trim() === "" ? undefined : values.description.trim(),
    components: ComponentsSchema.parse(JSON.parse(values.components)),
    branchName: values.branchName.trim() === "" ? DEFAULT_BRANCH_NAME : values.branchName.trim(),
    commitMessage: values.commitMessage.trim() === "" ? undefined : values.commitMessage.trim(),
  };
  return { resourceType: "config-bundle", resourceConfig };
}

function summaryOf(values: ConfigBundleFormValues): Record<string, string> {
  // The components blob can be long, so the review reports its component names
  // rather than reprinting the JSON the user just typed.
  let componentNames = "(unreadable)";
  try {
    componentNames = Object.keys(JSON.parse(values.components) as object).join(", ");
  } catch {
    // The components step refuses to advance on malformed JSON, so this is only
    // reachable if the value changed afterwards.
  }
  return {
    bundle: values.name.trim(),
    components: componentNames,
    branch: values.branchName.trim() === "" ? DEFAULT_BRANCH_NAME : values.branchName.trim(),
    ...(values.description.trim() === "" ? {} : { description: values.description.trim() }),
    ...(values.commitMessage.trim() === "" ? {} : { commit: values.commitMessage.trim() }),
  };
}

export function AddConfigBundleScreen({ ctx, core }: ScreenProps) {
  return (
    <ProjectGate
      core={core}
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      seed={ctx.value(ProjectKey)}
    >
      {(project) => <AddConfigBundleWizard project={project} core={core} />}
    </ProjectGate>
  );
}

function AddConfigBundleWizard({ project, core }: { project: Project; core: ScreenProps["core"] }) {
  const navigate = useNavigate();
  const [values, setValues] = useState<ConfigBundleFormValues>({
    name: "",
    components: "",
    description: "",
    branchName: DEFAULT_BRANCH_NAME,
    commitMessage: "",
  });
  const set = (update: Partial<ConfigBundleFormValues>) =>
    setValues((current) => ({ ...current, ...update }));

  return (
    <Wizard
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      onCancel={() => navigate("/agentcore/project/add")}
      onSubmit={() => core.projectManager.addResource(project, buildAddConfigBundleInput(values))}
      runningLabel={`adding configuration bundle ${values.name.trim()}…`}
      successLabel={`added configuration bundle '${values.name.trim()}' to '${project.name}'`}
      successHint="enter exits"
    >
      <Step name="name" question="what should this configuration bundle be called?">
        <TextField
          label="bundle name"
          placeholder="runtime-config"
          value={values.name}
          onChange={(name) => set({ name })}
          required
          schema={ConfigBundleNameSchema}
        />
      </Step>

      {/* Single-line rather than a textarea: JSON is valid on one line, so
          multi-line editing buys nothing, and this field can be corrected in
          place — the textarea is append-only. It also keeps enter meaning
          "continue" here, as it does on every other step. Pasting
          pretty-printed JSON still works: the input drops the newlines but
          keeps the spaces around them, so the value stays valid. */}
      <Step name="components" question="which components does the bundle configure?">
        <TextField
          label="component configuration map"
          help="each component name maps to an object with a configuration"
          example={COMPONENTS_EXAMPLE}
          value={values.components}
          onChange={(components) => set({ components })}
          required
          json
          schema={ComponentsSchema}
        />
      </Step>

      <Step name="description" question="what is this bundle for? (optional)">
        <TextField
          label="description"
          placeholder="feature flags for the checkout agent"
          value={values.description}
          onChange={(description) => set({ description })}
          schema={ConfigBundleDescriptionSchema}
        />
      </Step>

      <Step name="branch" title="branch" question="which branch holds the initial configuration?">
        <TextField
          label="branch name"
          placeholder={DEFAULT_BRANCH_NAME}
          value={values.branchName}
          onChange={(branchName) => set({ branchName })}
          schema={ConfigBundleBranchNameSchema}
        />
      </Step>

      <Step name="commit" title="commit" question="describe the initial configuration (optional)">
        <TextField
          label="commit message"
          placeholder="initial configuration"
          value={values.commitMessage}
          onChange={(commitMessage) => set({ commitMessage })}
          schema={ConfigBundleCommitMessageSchema}
        />
      </Step>

      <Step name="review" question="this configuration bundle will be added to agentcore.json">
        <Summary items={summaryOf(values)} />
      </Step>
    </Wizard>
  );
}
