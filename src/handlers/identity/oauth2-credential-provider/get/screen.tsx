import { useQuery } from "@tanstack/react-query";
import { Box, Text, useInput } from "ink";
import { useNavigate, useParams } from "react-router";
import { JsonDetail } from "../../../../components/JsonDetail";
import { KeyValueTable } from "../../../../components/KeyValueTable.js";
import { Layout } from "../../../../components/Layout";
import { darkTheme } from "../../../../components/ui/_core.js";
import { Divider } from "../../../../components/ui/divider/Divider.js";
import { Spinner } from "../../../../components/ui/spinner";
import type { ScreenProps } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

function useOauth2ProviderDetail({ ctx, core }: ScreenProps, name: string | undefined) {
  const opts = coreOptsFromCtx(ctx);
  return useQuery({
    queryKey: ["oauth2-credential-provider", opts.region, name],
    queryFn: () => core.identity.getOauth2CredentialProvider(name!, opts),
    enabled: name !== undefined,
  });
}

export function Oauth2CredentialProviderGetScreen(props: ScreenProps) {
  const navigate = useNavigate();
  const { name } = useParams();
  const detail = useOauth2ProviderDetail(props, name);

  useInput((input, key) => {
    if (key.escape) {
      navigate(-1);
      return;
    }
    if (input === "r" && detail.isError) {
      void detail.refetch();
      return;
    }
    if (detail.isError || !detail.data) return;
    if (key.return && name) {
      navigate(
        `/agentcore/identity/oauth2-credential-provider/get/${encodeURIComponent(name)}/json`,
      );
    }
  });

  return (
    <Layout
      breadcrumb={["agentcore", "identity", "oauth2-credential-provider", "get", name ?? ""]}
      keyHints={[
        ...(!detail.isPending && !detail.isError ? [{ key: "enter", label: "open detail" }] : []),
        ...(detail.isError ? [{ key: "r", label: "retry" }] : []),
        { key: "esc", label: "back" },
        { key: "ctl+c", label: "quit" },
      ]}
    >
      {detail.isPending ? (
        <Spinner label="Loading OAuth2 credential provider…" />
      ) : detail.isError ? (
        <Text color="red">Error: {(detail.error as Error).message}</Text>
      ) : (
        <Box flexDirection="column">
          <Box flexDirection="column" paddingLeft={1}>
            <KeyValueTable
              items={{
                name: detail.data.name ?? "",
                vendor: detail.data.credentialProviderVendor ?? "-",
                secretSource: detail.data.clientSecretSource ?? "-",
                clientSecretArn: detail.data.clientSecretArn?.secretArn ?? "-",
                ...(detail.data.callbackUrl ? { callbackUrl: detail.data.callbackUrl } : {}),
                createdAt: detail.data.createdTime?.toISOString() ?? "-",
                updatedAt: detail.data.lastUpdatedTime?.toISOString() ?? "-",
                arn: detail.data.credentialProviderArn ?? "",
              }}
            />
          </Box>

          <Divider />

          <Box paddingLeft={1}>
            <Text color={darkTheme.colors.focus}>❯ </Text>
            <Text bold color={darkTheme.colors.focus}>
              {"detail".padEnd(9)}
            </Text>
            <Text color={darkTheme.colors.muted}>show the full JSON definition</Text>
          </Box>
        </Box>
      )}
    </Layout>
  );
}

export function Oauth2CredentialProviderGetJsonScreen(props: ScreenProps) {
  const { name } = useParams();
  const detail = useOauth2ProviderDetail(props, name);

  return (
    <JsonDetail
      breadcrumb={[
        "agentcore",
        "identity",
        "oauth2-credential-provider",
        "get",
        name ?? "",
        "json",
      ]}
      isPending={detail.isPending}
      error={detail.isError ? (detail.error as Error) : null}
      data={detail.data}
      loadingLabel="Loading OAuth2 credential provider…"
      onRetry={() => void detail.refetch()}
    />
  );
}
