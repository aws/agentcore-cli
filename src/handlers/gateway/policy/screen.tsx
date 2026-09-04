import { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { ScrollView, type ScrollViewRef } from "ink-scroll-view";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router";
import { ErrorPanel } from "../../../components/ErrorPanel";
import { GatewayPicker } from "../../../components/GatewayPicker";
import { KeyValueTable } from "../../../components/KeyValueTable";
import { Layout } from "../../../components/Layout";
import { MultilineInput } from "../../../components/MultilineInput";
import { Divider } from "../../../components/ui/divider";
import { Spinner } from "../../../components/ui/spinner";
import { TaskList, type Task } from "../../../components/ui/task-list";
import { darkTheme, glyphs } from "../../../components/ui/_core.js";
import { UserCancellationError } from "../../../errors";
import type { ScreenProps } from "../../types";
import { coreOptsFromCtx } from "../../utils";
import type { PolicyGenerationResult } from "./types";

const theme = darkTheme;
const PICKER_PATH = "/agentcore/gateway/policy/generate";
const PROMPT_PLACEHOLDER = "Describe what the policy should allow or deny";

type Phase =
  | { kind: "form" }
  | { kind: "running" }
  | { kind: "result"; result: PolicyGenerationResult }
  | { kind: "error"; message: string };

export function GatewayPolicyGenerateScreen(props: ScreenProps) {
  const { gatewayId } = useParams();
  const navigate = useNavigate();

  if (!gatewayId) {
    return (
      <GatewayPicker
        {...props}
        breadcrumb={["agentcore", "gateway", "policy", "generate"]}
        description="choose a Gateway to generate a policy for"
        onSelect={(id) => navigate(`${PICKER_PATH}/${encodeURIComponent(id)}`)}
        onEscape={() => navigate("/agentcore/gateway")}
      />
    );
  }
  return <GeneratePolicyForm {...props} gatewayId={gatewayId} />;
}

function finishTasks(tasks: Task[], state: Task["state"]): Task[] {
  return tasks.map((task, index) => (index === tasks.length - 1 ? { ...task, state } : task));
}

function GeneratePolicyForm({ ctx, core, gatewayId }: ScreenProps & { gatewayId: string }) {
  const navigate = useNavigate();
  const opts = coreOptsFromCtx(ctx);
  const gateway = useQuery({
    queryKey: ["gateway", opts.region, gatewayId],
    queryFn: () => core.gateway.getGateway(gatewayId, opts),
  });
  const engineArn = gateway.data?.policyEngineConfiguration?.arn;

  const [phase, setPhase] = useState<Phase>({ kind: "form" });
  const [prompt, setPrompt] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const scrollRef = useRef<ScrollViewRef>(null);
  const runRef = useRef<{
    controller: AbortController;
    generation: AsyncGenerator<unknown, PolicyGenerationResult>;
  }>(null);

  const cancel = () => {
    const run = runRef.current;
    if (!run) return;
    runRef.current = null;
    run.controller.abort(new UserCancellationError());
    void run.generation.return(undefined as never);
  };
  useEffect(() => cancel, []);

  const submit = async () => {
    const controller = new AbortController();
    const generation = core.policy.generatePolicy(
      { gatewayId, prompt, name: `cli_generation_${Date.now()}` },
      opts,
      controller.signal,
    );
    runRef.current = { controller, generation };
    setTasks([]);
    setPhase({ kind: "running" });
    try {
      let next = await generation.next();
      while (!next.done) {
        if (controller.signal.aborted) return;
        if (next.value.type === "step") {
          const title = next.value.message;
          setTasks((current) => [
            ...finishTasks(current, "done"),
            { title, state: "running", tail: [] },
          ]);
        }
        next = await generation.next();
      }
      if (controller.signal.aborted) return;
      setTasks((current) => finishTasks(current, "done"));
      setPhase({ kind: "result", result: next.value });
    } catch (error) {
      if (controller.signal.aborted) return;
      setTasks((current) => finishTasks(current, "failed"));
      setPhase({ kind: "error", message: (error as Error).message });
    } finally {
      if (runRef.current?.controller === controller) runRef.current = null;
    }
  };

  useInput(
    (input, key) => {
      if (key.escape) {
        cancel();
        navigate(PICKER_PATH);
        return;
      }
      if (phase.kind !== "result") return;
      if (input === "e") setPhase({ kind: "form" });
      if (key.upArrow || input === "k") scrollRef.current?.scrollBy(-1);
      if (key.downArrow || input === "j") scrollRef.current?.scrollBy(1);
    },
    { isActive: phase.kind !== "error" },
  );

  const keyHints =
    phase.kind === "form" && engineArn
      ? [
          { key: "enter", label: "generate" },
          { key: `${glyphs.shift}${glyphs.enter}`, label: "newline" },
          { key: "esc", label: "back" },
          { key: "ctrl+c", label: "quit" },
        ]
      : phase.kind === "result"
        ? [
            { key: "↑↓/jk", label: "scroll" },
            { key: "e", label: "edit prompt" },
            { key: "esc", label: "back" },
            { key: "ctrl+c", label: "quit" },
          ]
        : [
            { key: "esc", label: phase.kind === "running" ? "cancel" : "back" },
            { key: "ctrl+c", label: "quit" },
          ];

  return (
    <Layout
      breadcrumb={["agentcore", "gateway", "policy", "generate", gatewayId]}
      keyHints={keyHints}
    >
      {gateway.isPending ? (
        <Spinner label="loading Gateway…" />
      ) : gateway.isError ? (
        <Text color={theme.colors.error}>Error: {(gateway.error as Error).message}</Text>
      ) : (
        <Box flexDirection="column" flexGrow={1}>
          <KeyValueTable
            items={{
              name: gateway.data!.name ?? "",
              id: gatewayId,
              engine: engineArn ?? "none",
            }}
          />
          <Divider />
          {!engineArn ? (
            <Text color={theme.colors.warning}>
              This Gateway has no Policy Engine attached. Attach one and deploy, then come back.
            </Text>
          ) : phase.kind === "form" ? (
            <MultilineInput
              value={prompt}
              onChange={setPrompt}
              onSubmit={() => void submit()}
              placeholder={PROMPT_PLACEHOLDER}
              submitDisabled={prompt.trim().length === 0}
            />
          ) : phase.kind === "running" ? (
            <TaskList tasks={tasks} />
          ) : phase.kind === "error" ? (
            <Box flexDirection="column">
              <TaskList tasks={tasks} />
              <ErrorPanel message={phase.message} onBack={() => setPhase({ kind: "form" })} />
            </Box>
          ) : (
            <ScrollView ref={scrollRef}>
              <TaskList tasks={tasks} />
              <Divider />
              <Text>
                {phase.result.policies
                  .flatMap((policy) => (policy.statement ? [policy.statement.trimEnd()] : []))
                  .join("\n\n")}
              </Text>
              {phase.result.policies.flatMap((policy, index) =>
                policy.findings.map((finding, findingIndex) => (
                  <Text key={`finding-${index}-${findingIndex}`} color={theme.colors.muted}>
                    [{finding.type}] {finding.description}
                  </Text>
                )),
              )}
            </ScrollView>
          )}
        </Box>
      )}
    </Layout>
  );
}
