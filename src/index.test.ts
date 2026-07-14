import { expect, test } from "bun:test";

test("source entrypoint supervises static failure output without calling process.exit", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
        const originalWrite = process.stderr.write;
        let captured = "";
        const pendingWrites = [];
        let acceptWrite;
        const accepted = new Promise((resolve) => {
          acceptWrite = resolve;
        });
        process.stderr.write = function (chunk, encoding, callback) {
          captured += typeof chunk === "string" ? chunk : chunk.toString("utf8");
          const done = typeof encoding === "function" ? encoding : callback;
          if (done) {
            pendingWrites.push(done);
          }
          acceptWrite();
          return false;
        };
        const completeWrites = () => {
          for (const done of pendingWrites) {
            done();
          }
          if (pendingWrites.length > 0) {
            process.stderr.emit("drain");
          }
        };

        let exitCalls = 0;
        process.exit = (code) => {
          exitCalls += 1;
          process.exitCode = code;
        };
        const hostile =
          "SOURCE_ENTRY_SENTINEL" +
          String.fromCharCode(0, 1, 27, 0x9b, 0x202e, 0xd800) +
          "\\\\\\\\";
        process.argv = [process.execPath, "./src/index.ts", hostile];

        let completed = false;
        const importing = import("./src/index.ts").then(() => {
          completed = true;
        });
        await accepted;
        await new Promise((resolve) => {
          setImmediate(resolve);
        });
        const completedBeforeRelease = completed;
        completeWrites();
        await importing;
        process.stderr.write = originalWrite;

        console.log(
          JSON.stringify({
            captured,
            completedBeforeRelease,
            exitCalls,
            exitCode: process.exitCode,
          }),
        );
      `,
    ],
    {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  expect(exitCode).toBe(1);
  expect(JSON.parse(stdout)).toEqual({
    captured: "Too many arguments were provided. Run with --help for usage.\n",
    completedBeforeRelease: false,
    exitCalls: 0,
    exitCode: 1,
  });
  expect(stderr).toBe("");
  expect(`${stdout}${stderr}`).not.toContain("SOURCE_ENTRY_SENTINEL");
});
