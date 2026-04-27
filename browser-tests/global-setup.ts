import { ENV_FILE } from './constants';
import * as pty from 'node-pty';
import { type ExecSyncOptions, execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI_PATH = join(__dirname, '..', 'dist', 'cli', 'index.mjs');
const PTY_LOG = join(__dirname, 'test-results', 'agentcore-dev-pty.log');

function hasAwsCredentials(): boolean {
  try {
    execSync('aws sts get-caller-identity', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function hasCommand(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function waitForServerReady(port: number, timeoutMs = 90000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const listening = await new Promise<boolean>(resolve => {
      const socket = createConnection({ port, host: '127.0.0.1' }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('error', () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (listening) return true;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return false;
}

export default async function globalSetup() {
  const missing: string[] = [];
  if (!hasAwsCredentials()) missing.push('AWS credentials (run `aws sts get-caller-identity`)');
  if (!hasCommand('uv')) missing.push('`uv` on PATH');

  if (missing.length > 0) {
    if (process.env.CI) {
      throw new Error(`Browser tests require: ${missing.join(', ')}`);
    }
    console.log(`\nSkipping browser tests — missing: ${missing.join(', ')}\n`);
    process.exit(0);
  }

  const testDir = join(tmpdir(), `agentcore-browser-test-${randomUUID()}`);
  mkdirSync(testDir, { recursive: true });

  const projectName = `BrTest${String(Date.now()).slice(-8)}`;

  console.log(`\nCreating test project "${projectName}" in ${testDir}`);

  const cleanEnv = { ...process.env };
  delete cleanEnv.INIT_CWD;

  const execOpts: ExecSyncOptions = { cwd: testDir, stdio: 'pipe', env: cleanEnv };

  let createRaw: string;
  try {
    createRaw = execSync(
      `node ${CLI_PATH} create --name ${projectName} --language Python --framework Strands --model-provider Bedrock --memory none --json`,
      execOpts
    ).toString();
  } catch (err: unknown) {
    const e = err as { stderr?: Buffer; stdout?: Buffer; status?: number };
    const stderr = e.stderr?.toString() ?? '';
    const stdout = e.stdout?.toString() ?? '';
    throw new Error(`agentcore create failed (exit ${e.status}):\nstdout: ${stdout}\nstderr: ${stderr}`);
  }

  // eslint-disable-next-line no-control-regex
  const createResult = createRaw.replace(/\x1B\[\??\d*[a-zA-Z]/g, '').trim();
  const parsed = JSON.parse(createResult.split('\n').pop()!);
  const projectPath: string = resolve(testDir, parsed.projectPath);

  console.log(`Project created at ${projectPath}`);
  console.log(`Starting agentcore dev...`);

  const env = { ...process.env };
  delete env.INIT_CWD;
  if (env.AGENT_INSPECTOR_PATH) {
    env.AGENT_INSPECTOR_PATH = resolve(env.AGENT_INSPECTOR_PATH);
  }

  const ptyProcess = pty.spawn('node', [CLI_PATH, 'dev'], {
    cwd: projectPath,
    env,
    cols: 80,
    rows: 24,
  });

  mkdirSync(join(__dirname, 'test-results'), { recursive: true });
  // eslint-disable-next-line no-control-regex
  const stripAnsi = (s: string) => s.replace(/\x1B\[\??[\d;]*[a-zA-Z]/g, '');
  const ptyLog = createWriteStream(PTY_LOG);

  let serverOutput = '';
  const webUIPort = await new Promise<number>((resolvePort, reject) => {
    const timeout = setTimeout(() => {
      ptyProcess.kill();
      reject(new Error(`agentcore dev failed to start within timeout.\nOutput: ${serverOutput}`));
    }, 90000);

    ptyProcess.onData((data: string) => {
      serverOutput += data;
      ptyLog.write(stripAnsi(data));
      const match = serverOutput.match(/Chat UI: http:\/\/localhost:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolvePort(parseInt(match[1]!, 10));
      }
    });
  });

  const ready = await waitForServerReady(webUIPort);
  if (!ready) {
    ptyProcess.kill();
    throw new Error(`Web UI reported port ${webUIPort} but it is not responding.\nOutput: ${serverOutput}`);
  }

  console.log(`Dev server ready on port ${webUIPort}`);

  writeFileSync(
    ENV_FILE,
    `PROJECT_PATH=${projectPath}\nPORT=${webUIPort}\nTEST_DIR=${testDir}\nSERVER_PID=${ptyProcess.pid}\nPROJECT_NAME=${projectName}\n`
  );
}
