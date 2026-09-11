import { useState } from "react";
import { useNavigate } from "react-router";
import { ProjectKey } from "../../../../router";
import {
  ConfigBundleBranchNameSchema,
  ConfigBundleCommitMessageSchema,
  ConfigBundleNameSchema,
} from "../../../../projectSchemas/config-bundle";
import type { ScreenProps } from "../../../types";
import type { Project } from "../../types";
import { ProjectGate } from "../../ProjectGate";
import { Wizard, Step, TextField, TextAreaField, Summary } from "../../../../components/wizard";
import {
  ComponentsSchema,
  DEFAULT_BRANCH_NAME,
  toAddConfigBundleInput,
  type ConfigBundleInput,
} from "./index";

const BREADCRUMB = ["agentcore", "project", "add", "config-bundle"];
const DESCRIPTION = "add a configuration bundle to the current project";
const ADD_MENU = "/agentcore/project/add";

// A complete, valid components map. It stays on screen while the user types,
// so the shape can be copied rather than remembered.
export const COMPONENTS_EXAMPLE = '{"pricing": {"configuration": {"currency": "USD"}}}';

interface ConfigBundleFormValues {
  name: string;
  components: string;
  branchName: string;
  commitMessage: string;
}

// toConfigBundleInput reads the form into the ConfigBundleInput the handler's
// toAddConfigBundleInput builds a bundle from. Values are passed exactly as
// they were typed and validated; a blank optional answer becomes undefined so
// the shared builder applies the same default the flag path applies. The wizard
// does not ask for a description — --description still sets one.
export function toConfigBundleInput(values: ConfigBundleFormValues): ConfigBundleInput {
  return {
    name: values.name,
    components: JSON.parse(values.components),
    branchName: blankToUndefined(values.branchName),
    commitMessage: blankToUndefined(values.commitMessage),
  };
}

// blankToUndefined judges blankness the way an optional field does — whitespace
// alone is nothing entered — and otherwise submits the value untouched, so what
// reaches the project spec is what the field validated.
function blankToUndefined(value: string): string | undefined {
  return value.trim() === "" ? undefined : value;
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
    bundle: values.name,
    components: componentNames,
    branch: blankToUndefined(values.branchName) ?? DEFAULT_BRANCH_NAME,
    // The row is always shown, so the review says what a skipped step means. The
    // service has no default commit message — an omitted one just leaves the
    // version without one, which is how the version list renders it.
    "commit message": blankToUndefined(values.commitMessage) ?? "(none)",
  };
}

// AddConfigBundleScreen is the interactive flow behind a bare `agentcore
// project add config-bundle`: name → components → branch → commit → review,
// then the add itself.
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
      {(project) => <AddConfigBundleWizard project={project} core={core} />}
    </ProjectGate>
  );
}

function AddConfigBundleWizard({ project, core }: { project: Project; core: ScreenProps["core"] }) {
  const navigate = useNavigate();
  const [values, setValues] = useState<ConfigBundleFormValues>({
    name: "",
    components: "",
    branchName: DEFAULT_BRANCH_NAME,
    commitMessage: "",
  });
  const set = (update: Partial<ConfigBundleFormValues>) =>
    setValues((current) => ({ ...current, ...update }));

  return (
    <Wizard
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      onCancel={() => navigate(ADD_MENU)}
      onSubmit={() =>
        core.projectManager.addResource(
          project,
          toAddConfigBundleInput(toConfigBundleInput(values)),
        )
      }
      runningLabel={`adding configuration bundle ${values.name}…`}
      successLabel={`added configuration bundle '${values.name}' to '${project.name}'`}
      // Enter returns to the add menu rather than tearing the TUI down, so a
      // second resource is one keystroke away — what add runtime does too.
      onDone={() => navigate(ADD_MENU)}
      doneLabel="go back"
      // A failure reports itself and hands the form back: a rejected name should
      // not cost the user the components map they just pasted.
      onError="retry"
    >
      <Step name="name" question="what should this configuration bundle be called?">
        <TextField
          label="bundle name"
          placeholder="runtime_config"
          value={values.name}
          onChange={(name) => set({ name })}
          required
          schema={ConfigBundleNameSchema}
          live
        />
      </Step>

      {/* A textarea rather than a single line: a components map is usually
          pasted from a file, pretty-printed, and it is the one answer here long
          enough to need more than a line to read back. The cost is that enter
          inserts a newline, so ctrl+d continues. */}
      <Step name="components" question="which components does the bundle configure?">
        <TextAreaField
          label="component configuration map"
          help="each component name maps to an object with a configuration · ctrl+d continues"
          placeholder={COMPONENTS_EXAMPLE}
          example={COMPONENTS_EXAMPLE}
          value={values.components}
          onChange={(components) => set({ components })}
          required
          json
          schema={ComponentsSchema}
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
