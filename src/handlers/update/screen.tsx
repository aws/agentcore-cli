import { Box, Text, useApp, useInput } from "ink";
import { useNavigate } from "react-router";
import { CliVersionManagerKey } from "../keys";
import { ConfirmAction, type ActionResult } from "../../components/ConfirmAction";
import { Layout } from "../../components/Layout";
import { Spinner } from "../../components/ui/spinner";
import { darkTheme } from "../../components/ui/_core";
import { useTuiUpdate } from "../../components/TuiUpdateContext";
import type { ProgressEvent } from "../../tui/progress";
import type { ScreenProps } from "../types";

const breadcrumb = ["agentcore", "update"];

export function CliUpdateScreen({ ctx }: ScreenProps) {
  const navigate = useNavigate();
  const { exit } = useApp();
  const updateState = useTuiUpdate();

  if (updateState.isChecking) {
    return (
      <Layout
        breadcrumb={breadcrumb}
        description="update the AgentCore CLI"
        keyHints={[
          { key: "esc", label: "back" },
          { key: "ctrl+c", label: "quit" },
        ]}
      >
        <Spinner label="checking for updates…" />
      </Layout>
    );
  }

  if (updateState.latestVersion === undefined) {
    return (
      <UpdateMessage
        message={`Unable to check for updates. Current version: ${updateState.currentVersion}`}
      />
    );
  }

  if (!updateState.updateAvailable) {
    return <UpdateMessage message={`AgentCore ${updateState.currentVersion} is up to date.`} />;
  }

  return (
    <ConfirmAction
      breadcrumb={breadcrumb}
      description="update the AgentCore CLI"
      rows={{
        current: updateState.currentVersion,
        latest: updateState.latestVersion,
      }}
      trigger={{
        kind: "confirm",
        message: `Update AgentCore from ${updateState.currentVersion} to ${updateState.latestVersion}?`,
      }}
      isPending={false}
      error={null}
      action={async function* (): AsyncGenerator<ProgressEvent, ActionResult> {
        const updateResult = yield* ctx.require(CliVersionManagerKey).update();
        if (updateResult.status !== "updated") {
          return {
            title:
              updateResult.status === "up-to-date"
                ? "AgentCore is up to date"
                : "Local AgentCore is newer",
            rows: {
              current: updateResult.currentVersion,
              latest: updateResult.latestVersion,
            },
          };
        }
        return {
          title: "AgentCore updated",
          rows: {
            previous: updateResult.currentVersion,
            installed: updateResult.latestVersion,
            "next step": "Restart AgentCore to use the new version.",
          },
        };
      }}
      successTitle="AgentCore updated"
      runningLabel="updating AgentCore…"
      onDone={exit}
      onCancel={() => navigate("/agentcore")}
      doneLabel="exit"
    />
  );
}

function UpdateMessage({ message }: { message: string }) {
  const navigate = useNavigate();
  useInput((_input, key) => {
    if (key.escape || key.return) navigate("/agentcore");
  });

  return (
    <Layout
      breadcrumb={breadcrumb}
      description="update the AgentCore CLI"
      keyHints={[
        { key: "esc", label: "back" },
        { key: "ctrl+c", label: "quit" },
      ]}
    >
      <Box paddingX={1}>
        <Text color={darkTheme.colors.muted}>{message}</Text>
      </Box>
    </Layout>
  );
}
