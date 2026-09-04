import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";
import { JsonDetail } from "../../../../components/JsonDetail";
import { ResourceDetailScreen } from "../../../../components/ResourceDetailScreen";
import type { ScreenProps } from "../../../types";
import { useCoreOpts, useRegionNavigate } from "../../../utils";

function useApiKeyProviderDetail({ ctx, core }: ScreenProps, name: string | undefined) {
  const opts = useCoreOpts(ctx);
  return useQuery({
    queryKey: ["api-key-credential-provider", opts.region, name],
    queryFn: () => core.identity.getApiKeyCredentialProvider(name!, opts),
    enabled: name !== undefined,
  });
}

export function ApiKeyCredentialProviderGetScreen(props: ScreenProps) {
  const navigate = useRegionNavigate();
  const { name } = useParams();
  const detail = useApiKeyProviderDetail(props, name);

  return (
    <ResourceDetailScreen
      breadcrumb={["agentcore", "identity", "api-key-credential-provider", "get", name ?? ""]}
      isPending={detail.isPending}
      error={detail.isError ? (detail.error as Error) : null}
      items={{
        name: detail.data?.name ?? "",
        secretSource: detail.data?.apiKeySecretSource ?? "-",
        secretArn: detail.data?.apiKeySecretArn?.secretArn ?? "-",
        createdAt: detail.data?.createdTime?.toISOString() ?? "-",
        updatedAt: detail.data?.lastUpdatedTime?.toISOString() ?? "-",
        arn: detail.data?.credentialProviderArn ?? "",
      }}
      actions={
        name && detail.data
          ? [
              {
                name: "detail",
                description: "show the full JSON definition",
                onSelect: () =>
                  navigate(
                    `/agentcore/identity/api-key-credential-provider/get/${encodeURIComponent(name)}/json`,
                  ),
              },
            ]
          : []
      }
      loadingLabel="loading API key credential provider…"
      onRetry={() => void detail.refetch()}
      selectLabel="open"
    />
  );
}

export function ApiKeyCredentialProviderGetJsonScreen(props: ScreenProps) {
  const { name } = useParams();
  const detail = useApiKeyProviderDetail(props, name);

  return (
    <JsonDetail
      breadcrumb={[
        "agentcore",
        "identity",
        "api-key-credential-provider",
        "get",
        name ?? "",
        "json",
      ]}
      isPending={detail.isPending}
      error={detail.isError ? (detail.error as Error) : null}
      data={detail.data}
      loadingLabel="loading API key credential provider…"
      onRetry={() => void detail.refetch()}
    />
  );
}
