import { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { ScrollView, type ScrollViewRef } from "ink-scroll-view";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router";
import { ErrorPanel } from "../../../components/ErrorPanel";
import { EventLog } from "../../../components/EventLog";
import { GatewayPicker } from "../../../components/GatewayPicker";
import { KeyValueTable } from "../../../components/KeyValueTable";
import { Layout } from "../../../components/Layout";
import { MultilineInput } from "../../../components/MultilineInput";
import { Divider } from "../../../components/ui/divider";
import { Spinner } from "../../../components/ui/spinner";
import { darkTheme } from "../../../components/ui/_core.js";
import type { ScreenProps } from "../../types";
import { coreOptsFromCtx } from "../../utils";
import type { PolicyGenerationResult } from "./types";

const theme = darkTheme;
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
        onSelect={(id) => navigate(`/agentcore/gateway/policy/generate/${encodeURIComponent(id)}`)}
      />
    );
  }
  return <GeneratePolicyForm {...props} gatewayId={gatewayId} />;
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
  const [events, setEvents] = useState<string[]>([]);
  const scrollRef = useRef<ScrollViewRef>(null);
  const aliveRef = useRef(true);
  useEffect(
    () => () => {
      aliveRef.current = false;
    },
    [],
  );

  const submit = async () => {
    setEvents([]);
    setPhase({ kind: "running" });
    try {
      const generation = core.policy.generatePolicy(
        { gatewayId, prompt, name: `cli_generation_${Date.now()}` },
        opts,
      );
      let next = await generation.next();
      while (!next.done) {
        if (!aliveRef.current) return;
        if (next.value.type === "step") {
          const message = next.value.message;
          setEvents((current) => [...current, message]);
        }
        next = await generation.next();
      }
      if (aliveRef.current) setPhase({ kind: "result", result: next.value });
    } catch (error) {
      if (aliveRef.current) setPhase({ kind: "error", message: (error as Error).message });
    }
  };

  useInput(
    (input, key) => {
      if (key.escape) {
        navigate(-1);
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
          { key: "⇧↵", label: "newline" },
          { key: "esc", label: "back" },
          { key: "ctl+c", label: "quit" },
        ]
      : phase.kind === "result"
        ? [
            { key: "↑↓/kj", label: "scroll" },
            { key: "e", label: "edit prompt" },
            { key: "esc", label: "back" },
            { key: "ctl+c", label: "quit" },
          ]
        : [
            { key: "esc", label: "back" },
            { key: "ctl+c", label: "quit" },
          ];

  return (
    <Layout
      breadcrumb={["agentcore", "gateway", "policy", "generate", gatewayId]}
      keyHints={keyHints}
    >
      {gateway.isPending ? (
        <Spinner label="Loading Gateway…" />
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
            <Box flexDirection="column">
              <EventLog events={events} />
              <Spinner label="generating…" />
            </Box>
          ) : phase.kind === "error" ? (
            <ErrorPanel message={phase.message} onBack={() => setPhase({ kind: "form" })} />
          ) : (
            <ScrollView ref={scrollRef}>
              <EventLog events={events} />
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
