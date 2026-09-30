import { useQuery } from "@tanstack/react-query";
import { createContext, useContext, type ReactNode } from "react";
import semver from "semver";
import type { CliVersionManager } from "../cliVersionManager";
import { PACKAGE_VERSION } from "../constants";

type TuiUpdateState = {
  currentVersion: string;
  latestVersion?: string;
  isChecking: boolean;
  updateAvailable: boolean;
};

const TuiUpdateContext = createContext<TuiUpdateState>({
  currentVersion: PACKAGE_VERSION,
  latestVersion: PACKAGE_VERSION,
  isChecking: false,
  updateAvailable: false,
});

export function TuiUpdateProvider({
  versionManager,
  children,
}: {
  versionManager: CliVersionManager;
  children: ReactNode;
}) {
  const currentVersion = versionManager.getCurrentVersion();
  const latestVersionQuery = useQuery({
    queryKey: ["cli-update", currentVersion],
    queryFn: () => versionManager.getLatestVersion(),
    retry: false,
  });
  const latestVersion = latestVersionQuery.data;
  const updateAvailable = latestVersion !== undefined && semver.gt(latestVersion, currentVersion);

  return (
    <TuiUpdateContext.Provider
      value={{
        currentVersion,
        latestVersion,
        isChecking: latestVersionQuery.isPending,
        updateAvailable,
      }}
    >
      {children}
    </TuiUpdateContext.Provider>
  );
}

export function useTuiUpdate(): TuiUpdateState {
  return useContext(TuiUpdateContext);
}
