import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { ProjectKey } from "../../../../router";
import {
  PolicyNameSchema,
  type AuthorizationPhase,
  type EnforcementMode,
  type ValidationMode,
} from "../../../../projectSchemas/policy";
import type { ScreenProps } from "../../../types";
import type { Project } from "../../types";
import { ProjectGate } from "../../ProjectGate";
import {
  Wizard,
  Step,
  TextField,
  TextAreaField,
  ChoiceField,
  Summary,
  Prerequisite,
  blankToUndefined,
} from "../../../../components/wizard";
import { inferAuthorizationPhase, toAddPolicyInput, type PolicyInput } from "./index";

const BREADCRUMB = ["agentcore", "project", "add", "policy"];
const DESCRIPTION = "adds a Cedar Policy to a project Policy Engine";
const ADD_MENU = "/agentcore/project/add";

// "infer" is the wizard's stand-in for leaving --authorization-phase unset:
// the builder reads the statement and decides.
type PhaseChoice = AuthorizationPhase | "infer";

const PHASE_CHOICES = [
  {
    value: "infer" as PhaseChoice,
    label: "infer from the statement (default)",
    description: "RETURN_OUTPUT when it mentions suppressOutput or context.output",
  },
  { value: "INITIATE" as PhaseChoice, label: "INITIATE", description: "evaluate before the call" },
  {
    value: "RETURN_OUTPUT" as PhaseChoice,
    label: "RETURN_OUTPUT",
    description: "evaluate against the call's output",
  },
];

const VALIDATION_CHOICES = [
  {
    value: "FAIL_ON_ANY_FINDINGS" as ValidationMode,
    label: "fail on any findings (default)",
    description: "refuse to deploy a statement the validator flags",
  },
  {
    value: "IGNORE_ALL_FINDINGS" as ValidationMode,
    label: "ignore all findings",
    description: "deploy regardless of validator findings",
  },
];

const ENFORCEMENT_CHOICES = [
  {
    value: "ACTIVE" as EnforcementMode,
    label: "active (default)",
    description: "deny requests this Policy forbids",
  },
  {
    value: "LOG_ONLY" as EnforcementMode,
    label: "log-only",
    description: "record decisions without blocking anything",
  },
];

interface PolicyFormValues {
  engineName: string;
  name: string;
  statement: string;
  phase: PhaseChoice;
  validationMode: ValidationMode;
  enforcementMode: EnforcementMode;
  description: string;
}

// toPolicyInput reads the form into the PolicyInput the handler's
// toAddPolicyInput builds a Policy from. "infer" becomes an absent phase, so
// the builder infers it exactly as it does when --authorization-phase is unset.
export function toPolicyInput(values: PolicyFormValues): PolicyInput {
  return {
    engineName: values.engineName,
    name: values.name.trim(),
    statement: values.statement.trim(),
    description: blankToUndefined(values.description),
    validationMode: values.validationMode,
    enforcementMode: values.enforcementMode,
    authorizationPhase: values.phase === "infer" ? undefined : values.phase,
  };
}

function summaryOf(values: PolicyFormValues): Record<string, string> {
  const inferred = inferAuthorizationPhase(values.statement);
  return {
    policy: values.name.trim(),
    engine: values.engineName,
    phase: values.phase === "infer" ? `${inferred} (inferred)` : values.phase,
    validation: values.validationMode,
    enforcement: values.enforcementMode,
    ...(values.description.trim() === "" ? {} : { description: values.description.trim() }),
  };
}

export function AddPolicyScreen({ ctx, core }: ScreenProps) {
  return (
    <ProjectGate
      core={core}
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      seed={ctx.value(ProjectKey)}
    >
      {(project) => <AddPolicyWizard project={project} core={core} />}
    </ProjectGate>
  );
}

function AddPolicyWizard({ project, core }: { project: Project; core: ScreenProps["core"] }) {
  const navigate = useNavigate();

  // A Policy lives inside a Policy Engine, so the first question is which one.
  const engineChoices = useMemo(
    () =>
      project.spec.policyEngines.map((engine) => ({
        value: engine.name,
        label: engine.name,
        description: engine.description ?? `${engine.policies?.length ?? 0} policies`,
      })),
    [project.spec.policyEngines],
  );

  const [values, setValues] = useState<PolicyFormValues>({
    engineName: engineChoices[0]?.value ?? "",
    name: "",
    statement: "",
    phase: "infer",
    validationMode: "FAIL_ON_ANY_FINDINGS",
    enforcementMode: "ACTIVE",
    description: "",
  });
  const set = (update: Partial<PolicyFormValues>) =>
    setValues((current) => ({ ...current, ...update }));

  if (engineChoices.length === 0) {
    return (
      <Prerequisite
        breadcrumb={BREADCRUMB}
        description={DESCRIPTION}
        message={`'${project.name}' has no Policy Engines yet; a Policy needs one to live in`}
        command="agentcore project add policy-engine"
        onBack={() => navigate(ADD_MENU)}
      />
    );
  }

  return (
    <Wizard
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      onCancel={() => navigate(ADD_MENU)}
      onSubmit={() =>
        core.projectManager.addResource(project, toAddPolicyInput(toPolicyInput(values)))
      }
      runningLabel={`adding Policy ${values.name.trim()}…`}
      successLabel={`added Policy '${values.name.trim()}' to Policy Engine '${values.engineName}' in '${project.name}'`}
      successHint="enter exits"
    >
      <Step name="engine" question="which Policy Engine should hold this Policy?">
        <ChoiceField
          choices={engineChoices}
          value={values.engineName}
          onChange={(engineName) => set({ engineName })}
        />
      </Step>

      <Step name="name" question="what should this Policy be called?">
        <TextField
          label="policy name"
          placeholder="DenyDeletes"
          value={values.name}
          onChange={(name) => set({ name })}
          required
          schema={PolicyNameSchema}
        />
      </Step>

      <Step name="statement" question="paste the Cedar statement">
        <TextAreaField
          label="Cedar statement"
          placeholder='forbid(principal, action == Action::"delete", resource);'
          value={values.statement}
          onChange={(statement) => set({ statement })}
          required
        />
      </Step>

      <Step name="phase" question="when should this Policy be evaluated?">
        <ChoiceField
          choices={PHASE_CHOICES}
          value={values.phase}
          onChange={(phase) => set({ phase })}
        />
      </Step>

      <Step name="validation" question="what should happen if the validator flags the statement?">
        <ChoiceField
          choices={VALIDATION_CHOICES}
          value={values.validationMode}
          onChange={(validationMode) => set({ validationMode })}
        />
      </Step>

      <Step name="enforcement" question="how should this Policy be enforced?">
        <ChoiceField
          choices={ENFORCEMENT_CHOICES}
          value={values.enforcementMode}
          onChange={(enforcementMode) => set({ enforcementMode })}
        />
      </Step>

      <Step name="description" question="what does this Policy do? (optional)">
        <TextField
          label="description"
          placeholder="blocks destructive tool calls"
          value={values.description}
          onChange={(description) => set({ description })}
        />
      </Step>

      <Step name="review" question="this Policy will be added to agentcore.json">
        <Summary items={summaryOf(values)} />
      </Step>
    </Wizard>
  );
}
