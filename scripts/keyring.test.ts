import { expect, test } from "bun:test";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keyringBindingPath, nativeKeyringPlugin } from "./keyring";

test("compiled keyring loads without an adjacent node_modules directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentcore-keyring-binary-"));
  try {
    const entry = join(root, "entry.ts"),
      binary = join(root, process.platform === "win32" ? "probe.exe" : "probe");
    const modulePath = join(import.meta.dir, "..", "src", "io", "keyring.ts");
    await writeFile(
      entry,
      "import { loadKeyring } from " +
        JSON.stringify(modulePath) +
        ';\nif (typeof loadKeyring().Entry !== "function") throw new Error("Missing native Entry");\nconsole.log("embedded-keyring");\n',
    );
    const platform = process.platform === "win32" ? "windows" : process.platform;
    const target = "bun-" + platform + "-" + process.arch;
    await Bun.build({
      entrypoints: [entry],
      compile: { outfile: binary },
      plugins: [nativeKeyringPlugin(target)],
    });
    const binding = keyringBindingPath(target);
    const hidden = binding + ".probe-hidden";
    await rename(binding, hidden);
    try {
      const child = Bun.spawn([binary], { cwd: root, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, status] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
      expect(stdout.trim()).toBe("embedded-keyring");
    } finally {
      await rename(hidden, binding);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
