import { spawn } from "node:child_process";

export type CappedOutput = { truncated: boolean; value: string };

export type BoundedCommandResult = {
  code: number | null;
  outputLimitExceeded: boolean;
  signal: NodeJS.Signals | null;
  stderr: string;
  stderrTruncated: boolean;
  stdout: string;
  stdoutTruncated: boolean;
  timedOut: boolean;
};

export type BoundedCommandOptions = {
  args: string[];
  cwd: string;
  executable: string;
  input?: string;
  maxOutputBytes: number;
  timeoutMs: number;
};

export function shellCommandArgs(command: string): { args: string[]; executable: string } {
  if (process.platform === "win32") {
    return {
      executable: "powershell.exe",
      args: ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
    };
  }

  return {
    executable: "/bin/sh",
    args: ["-lc", command],
  };
}

export function sanitizedRunnerEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const denied = new Set([
    "CF_API_TOKEN",
    "CLOUDFLARE_API_TOKEN",
    "GITHUB_CLIENT_SECRET",
    "OAUTH_CLIENT_SECRET",
    "OPENAI_API_KEY",
  ]);

  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase();
    if (
      denied.has(upper) ||
      upper.includes("API_KEY") ||
      upper.includes("PASSWORD") ||
      upper.includes("SECRET") ||
      upper.includes("TOKEN")
    ) {
      delete env[key];
    }
  }

  return env;
}

function appendCapped(current: CappedOutput, chunk: Buffer, maxBytes: number): CappedOutput {
  if (current.truncated) {
    return current;
  }

  const next = current.value + chunk.toString("utf8");
  const buffer = Buffer.from(next);
  if (buffer.byteLength <= maxBytes) {
    return { truncated: false, value: next };
  }

  return {
    truncated: true,
    value: buffer.subarray(0, maxBytes).toString("utf8"),
  };
}

export function killProcessTree(child: ReturnType<typeof spawn>): void {
  if (!child.pid) {
    child.kill();
    return;
  }

  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.on("error", () => child.kill());
    return;
  }

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill();
  }
}

export async function runBoundedCommand(options: BoundedCommandOptions): Promise<BoundedCommandResult> {
  const { args, cwd, executable, input, maxOutputBytes, timeoutMs } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      detached: process.platform !== "win32",
      env: sanitizedRunnerEnv(),
      windowsHide: true,
    });

    let stdout: CappedOutput = { truncated: false, value: "" };
    let stderr: CappedOutput = { truncated: false, value: "" };
    let outputLimitExceeded = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      const next = appendCapped(stdout, chunk, maxOutputBytes);
      if (!stdout.truncated && next.truncated) {
        outputLimitExceeded = true;
        killProcessTree(child);
      }
      stdout = next;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const next = appendCapped(stderr, chunk, maxOutputBytes);
      if (!stderr.truncated && next.truncated) {
        outputLimitExceeded = true;
        killProcessTree(child);
      }
      stderr = next;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        outputLimitExceeded,
        signal,
        stderr: stderr.value,
        stderrTruncated: stderr.truncated,
        stdout: stdout.value,
        stdoutTruncated: stdout.truncated,
        timedOut,
      });
    });
    if (input !== undefined) {
      child.stdin.end(input);
    }
  });
}
