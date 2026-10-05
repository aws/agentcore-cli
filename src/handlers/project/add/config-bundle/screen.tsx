import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import {
  MultiTextField,
  Step,
  Summary,
  TextAreaField,
  TextField,
  Wizard,
} from "../../../../components/wizard";
import type { AwsDeploymentTarget } from "../../../../projectSchemas/aws-targets";
import {
  ConfigBundleBranchNameSchema,
  ConfigBundleCommitMessageSchema,
  ConfigBundleNameSchema,
} from "../../../../projectSchemas/config-bundle";
import { ProjectKey } from "../../../../router";
import type { ScreenProps } from "../../../types";
import type { Project } from "../../types";
import { LoadingFrame, ProjectGate, projectQueryKey, useProjectTargets } from "../../ProjectGate";
import { requireDeployedNameFits } from "../shared";
import {
  ComponentsSchema,
  DEFAULT_BRANCH_NAME,
  toAddConfigBundleInput,
  type ConfigBundleInput,
} from "./index";
import { RegionKey } from "../../../keys";

const BREADCRUMB = ["agentcore", "add", "config-bundle"];
const DESCRIPTION = "add a configuration bundle to the current project";
const ADD_MENU = "/agentcore/add";

// A complete, valid components map. It stays on screen while the user types,
// so the shape can be copied rather than remembered.
export const COMPONENTS_EXAMPLE = '{"pricing": {"configuration": {"currency": "USD"}}}';

type ConfigBundleFormValues = {
  name: string;
  // The components map as typed; the step refuses to advance until it parses
  // and satisfies ComponentsSchema.
  components: string;
  branchName: string;
  commitMessage: string;
};

// blankToUndefined judges blankness the way an optional field does — whitespace
// alone is nothing entered — and otherwise submits the value untouched, so what
// reaches the project spec is what the field validated.
function blankToUndefined(value: string): string | undefined {
  return value.trim() === "" ? undefined : value;
}

// toConfigBundleInput is the answers as the flag path would state them. A blank
// optional answer becomes undefined so the shared builder applies the same
// default the flags get. The wizard does not ask for a description or a KMS
// key; --description and --kms-key-arn still set them.
export function toConfigBundleInput(values: ConfigBundleFormValues): ConfigBundleInput {
  return {
    name: values.name,
    components: JSON.parse(values.components),
    branchName: blankToUndefined(values.branchName),
    commitMessage: blankToUndefined(values.commitMessage),
  };
}

function summaryOf(values: ConfigBundleFormValues): Record<string, string> {
  // The components blob can be long, so the review names the components rather
  // than reprinting the JSON the user just typed.
  let componentNames = "(unreadable)";
  try {
    componentNames = Object.keys(JSON.parse(values.components) as object).join(", ");
  } catch {
    // The components step refuses to advance on malformed JSON, so this is only
    // reachable if the value changed afterwards.
  }
  return {
    bundle: values.name,
    components: componentNames,
    branch: blankToUndefined(values.branchName) ?? DEFAULT_BRANCH_NAME,
    // The row is always shown, so the review says what a skipped step means: the
    // service has no default commit message, an omitted one just leaves the
    // version without one.
    "commit message": blankToUndefined(values.commitMessage) ?? "(none)",
  };
}

export function AddConfigBundleScreen({ ctx, core }: ScreenProps) {
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
        <AddConfigBundleLoader project={project} core={core} region={ctx.value(RegionKey)} />
      )}
    </ProjectGate>
  );
}

function AddConfigBundleLoader({
  project,
  core,
  region,
}: {
  project: Project;
  core: ScreenProps["core"];
  region: string | undefined;
}) {
  const navigate = useNavigate();
  const targets = useProjectTargets(core, project);

  if (targets.data !== undefined) {
    return (
      <AddConfigBundleWizard project={project} targets={targets.data} core={core} region={region} />
    );
  }

  return (
    <LoadingFrame
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      query={targets}
      loadingLabel="loading deployment targets…"
      onBack={() => navigate(ADD_MENU)}
    />
  );
}

function AddConfigBundleWizard({
  project,
  targets,
  core,
  region,
}: {
  project: Project;
  targets: readonly AwsDeploymentTarget[];
  core: ScreenProps["core"];
  /** The command\'s resolved region, for the China gate of a project without targets. */
  region: string | undefined;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [values, setValues] = useState<ConfigBundleFormValues>({
    name: "",
    components: "",
    branchName: DEFAULT_BRANCH_NAME,
    commitMessage: "",
  });
  const set = (update: Partial<ConfigBundleFormValues>) =>
    setValues((current) => ({ ...current, ...update }));

  // The deployed name is <project>_<target>_<name> and must fit the service
  // cap, so the live check reports the real budget rather than the schema's.
  const nameSchema = useMemo(
    () =>
      ConfigBundleNameSchema.superRefine((name, ctx) => {
        try {
          requireDeployedNameFits("Configuration bundle", project.name, name, "_", 100, targets);
        } catch (error) {
          ctx.addIssue({
            code: "custom",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    [project.name, targets],
  );

  return (
    <Wizard
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      onCancel={() => navigate(ADD_MENU)}
      onSubmit={async function* () {
        const updated = yield* core.projectManager.addResource(
          project,
          toAddConfigBundleInput(project, targets, toConfigBundleInput(values)),
          { region },
        );
        queryClient.setQueryData(projectQueryKey(), updated);
        return updated;
      }}
      runningLabel={`adding configuration bundle ${values.name}…`}
      successLabel={`added configuration bundle '${values.name}' to '${project.name}'`}
      successNextSteps={["agentcore deploy"]}
      onDone={() => navigate(ADD_MENU)}
      doneLabel="go back"
    >
      <Step stepKey="name" prompt="what should this configuration bundle be called?">
        <TextField
          label="Bundle name"
          help="letters, digits and underscores, starting with a letter; the deployed <project>_<target>_<name> must fit 100 characters"
          placeholder="runtime_config"
          value={values.name}
          onChange={(name) => set({ name })}
          required
          schema={nameSchema}
          live
        />
      </Step>

      {/* A textarea rather than a single line: a components map is usually
          pasted from a file, pretty-printed, and it is the one answer here long
          enough to need more than a line to read back. */}
      <Step stepKey="components" prompt="which components does the bundle configure?">
        <TextAreaField
          label="Component configuration map"
          help="each component name maps to an object with a configuration · enter for a new line, ctrl+d to continue"
          placeholder={COMPONENTS_EXAMPLE}
          example={COMPONENTS_EXAMPLE}
          value={values.components}
          onChange={(components) => set({ components })}
          required
          json
          schema={ComponentsSchema}
        />
      </Step>

      {/* The branch and the message describing what lands on it are one answer
          about the initial version, so they share a step. */}
      <Step stepKey="version" prompt="how should the initial configuration be recorded?">
        <MultiTextField
          inputs={[
            {
              key: "branch",
              label: "Branch name",
              help: `prefilled with the flag's default, ${DEFAULT_BRANCH_NAME} · letters, digits, _ / and -`,
              placeholder: DEFAULT_BRANCH_NAME,
              value: values.branchName,
              onChange: (branchName) => set({ branchName }),
              schema: ConfigBundleBranchNameSchema,
            },
            {
              key: "commit",
              label: "Commit message",
              help: "optional · up to 500 characters",
              placeholder: "initial configuration",
              value: values.commitMessage,
              onChange: (commitMessage) => set({ commitMessage }),
              schema: ConfigBundleCommitMessageSchema,
            },
          ]}
        />
      </Step>

      <Step stepKey="review" prompt="this configuration bundle will be added to agentcore.json">
        <Summary items={summaryOf(values)} />
      </Step>
    </Wizard>
  );
}
