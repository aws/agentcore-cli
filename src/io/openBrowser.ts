import { spawn } from "node:child_process";

export type BrowserOpener = (url: string) => Promise<void>;

/**
 * Open a URL in the user's default browser, best-effort: failures resolve
 * quietly because the URL is always printed as well, so a machine without a
 * browser association must not fail `project dev`.
 */
export const openBrowser: BrowserOpener = (url) => {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];

  return new Promise((resolve) => {
    const child = spawn(command!, args, { stdio: "ignore", detached: true });
    child.on("error", () => resolve());
    child.on("spawn", () => {
      child.unref();
      resolve();
    });
  });
};
