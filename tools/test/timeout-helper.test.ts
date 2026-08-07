import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const helperPath = resolve(repositoryRoot, "scripts", "run-with-timeout.mjs");

interface Invocation {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
}

interface ProcessExit {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

interface RunningInvocation {
  child: ReturnType<typeof spawn>;
  complete: Promise<Invocation>;
  exited: Promise<ProcessExit>;
  stderr: () => string;
  stdout: () => string;
}

function invoke(script: string, timeoutMs: number, environment: NodeJS.ProcessEnv = {}): Promise<Invocation> {
  return startInvocation(script, timeoutMs, environment).complete;
}

function startInvocation(
  script: string,
  timeoutMs: number,
  environment: NodeJS.ProcessEnv = {},
  graceMs = 50,
  readStdout = true,
): RunningInvocation {
  const child = spawn(
    process.execPath,
    [helperPath, "--timeout-ms", String(timeoutMs), "--grace-ms", String(graceMs), "--", process.execPath, "-e", script],
    { cwd: repositoryRoot, env: { ...process.env, ...environment } },
  );
  let stdout = "";
  let stderr = "";
  if (readStdout) child.stdout.on("data", (chunk: Buffer) => { stdout += chunk; });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk; });
  const exited = new Promise<ProcessExit>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => resolveExit({ exitCode, signal }));
  });
  const complete = new Promise<Invocation>((resolveInvocation, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolveInvocation({ exitCode, signal, stderr, stdout }));
  });
  return { child, complete, exited, stderr: () => stderr, stdout: () => stdout };
}

function settlesWithin<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolvePromise(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function waitFor(condition: () => boolean, timeoutMs: number, label: string): Promise<void> {
  return new Promise((resolveInvocation, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (condition()) {
        resolveInvocation();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`timed out waiting for ${label}`));
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

test("timeout helper returns output from a successful command", async () => {
  const result = await invoke("process.stdout.write('complete')", 1_000);

  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "complete");
  assert.equal(result.stderr, "");
});

test("timeout helper preserves a command nonzero exit", async () => {
  const result = await invoke("process.stderr.write('failure-tail'); process.exit(7)", 1_000);

  assert.equal(result.exitCode, 7);
  assert.match(result.stderr, /command failed with exit code 7/);
  assert.match(result.stderr, /failure-tail/);
});

test("timeout helper terminates a hung command without leaking environment", async () => {
  const secret = "must-not-appear-in-diagnostics";
  const result = await invoke("process.stderr.write('last-state'); setInterval(() => {}, 1_000)", 300, {
    TIMEOUT_HELPER_TEST_SECRET: secret,
  });

  assert.equal(result.exitCode, 124);
  assert.match(result.stderr, /timed out after 300ms/);
  assert.match(result.stderr, /last-state/);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret));
});

test("timeout helper forwards external SIGTERM to the detached child process group", async (t) => {
  const running = startInvocation(
    [
      "const { spawn } = require('node:child_process');",
      "const descendant = spawn(process.execPath, ['-e', \"setInterval(() => {}, 1_000)\"], { stdio: 'ignore' });",
      "process.stdout.write(`child=${process.pid} descendant=${descendant.pid}\\n`);",
      "setInterval(() => {}, 1_000);",
    ].join(" "),
    5_000,
  );
  let childPid: number | undefined;

  t.after(() => {
    if (childPid !== undefined && isAlive(childPid)) process.kill(-childPid, "SIGKILL");
  });

  await waitFor(() => /child=\d+ descendant=\d+/.test(running.stdout()), 1_000, "child and descendant pids");
  const match = /child=(\d+) descendant=(\d+)/.exec(running.stdout());
  assert.ok(match);
  childPid = Number(match[1]);
  const descendantPid = Number(match[2]);

  process.kill(running.child.pid!, "SIGTERM");
  const result = await running.complete;

  assert.equal(result.exitCode, 143);
  assert.equal(result.signal, null);
  await waitFor(() => !isAlive(descendantPid), 1_000, "descendant termination");
});

test("timeout helper escalates an external SIGTERM when the child process group ignores SIGTERM", async (t) => {
  const running = startInvocation(
    [
      "const { spawn } = require('node:child_process');",
      "const descendant = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000)\"], { stdio: 'ignore' });",
      "process.on('SIGTERM', () => {});",
      "process.stdout.write(`child=${process.pid} descendant=${descendant.pid}\\n`);",
      "setInterval(() => {}, 1_000);",
    ].join(" "),
    5_000,
  );
  let childPid: number | undefined;

  t.after(() => {
    if (childPid !== undefined && isAlive(childPid)) process.kill(-childPid, "SIGKILL");
  });

  await waitFor(() => /child=\d+ descendant=\d+/.test(running.stdout()), 1_000, "SIGTERM-ignoring child pids");
  const match = /child=(\d+) descendant=(\d+)/.exec(running.stdout());
  assert.ok(match);
  childPid = Number(match[1]);
  const descendantPid = Number(match[2]);

  process.kill(running.child.pid!, "SIGTERM");
  const result = await running.complete;

  assert.equal(result.exitCode, 143);
  assert.equal(result.signal, null);
  assert.match(result.stderr, /did not exit within 50ms; sending SIGKILL/);
  await waitFor(() => !isAlive(descendantPid), 1_000, "SIGTERM-ignoring descendant termination");
});

test("timeout helper pauses child stdout while its consumer is unread, then drains all output", async () => {
  const expectedBytes = 32 * 1024 * 1024;
  const child = spawn(
    process.execPath,
    [
      helperPath,
      "--timeout-ms", "5000",
      "--grace-ms", "50",
      "--",
      process.execPath,
      "-e",
      [
        "const chunk = Buffer.alloc(64 * 1024, 'x');",
        `let remaining = ${expectedBytes / (64 * 1024)};`,
        "process.stderr.write('producer-started\\n');",
        "function write() { while (remaining > 0) { remaining -= 1; if (!process.stdout.write(chunk)) { process.stdout.once('drain', write); return; } } process.stderr.write('producer-complete\\n'); }",
        "write();",
      ].join(" "),
    ],
    { cwd: repositoryRoot },
  );
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk; });
  const completed = new Promise<Invocation>((resolveInvocation, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolveInvocation({ exitCode, signal, stderr, stdout: "" }));
  });

  await waitFor(() => stderr.includes("producer-started"), 1_000, "producer start");
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  assert.doesNotMatch(stderr, /producer-complete/);

  let outputBytes = 0;
  child.stdout.on("data", (chunk: Buffer) => { outputBytes += chunk.length; });
  const result = await completed;

  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.equal(outputBytes, expectedBytes);
  assert.match(stderr, /producer-complete/);
});

test("timeout helper exits after timeout when its stdout consumer remains unread", async (t) => {
  const running = startInvocation(
    [
      "const chunk = Buffer.alloc(64 * 1024, 'x');",
      "process.stderr.write(`child=${process.pid}\\n`);",
      "process.on('SIGTERM', () => {});",
      "function write() { if (!process.stdout.write(chunk)) process.stdout.once('drain', write); else setImmediate(write); }",
      "write();",
    ].join(" "),
    100,
    {},
    50,
    false,
  );
  let childPid: number | undefined;

  t.after(() => {
    if (running.child.exitCode === null) running.child.kill("SIGKILL");
    if (childPid !== undefined && isAlive(childPid)) process.kill(-childPid, "SIGKILL");
  });

  await waitFor(() => /child=\d+/.test(running.stderr()), 1_000, "blocked-output child pid");
  childPid = Number(/child=(\d+)/.exec(running.stderr())![1]);
  const result = await settlesWithin(running.exited, 1_000, "blocked-output timeout exit").catch((error: unknown) => {
    throw new Error(`${error instanceof Error ? error.message : String(error)}; stderr: ${running.stderr()}`);
  });

  assert.equal(result.exitCode, 124);
  assert.equal(result.signal, null);
  assert.match(running.stderr(), /sending SIGKILL/);
});

test("timeout helper exits after external SIGTERM when its stdout consumer remains unread", async (t) => {
  const running = startInvocation(
    [
      "const chunk = Buffer.alloc(64 * 1024, 'x');",
      "process.stderr.write(`child=${process.pid}\\n`);",
      "process.on('SIGTERM', () => {});",
      "function write() { if (!process.stdout.write(chunk)) process.stdout.once('drain', write); else setImmediate(write); }",
      "write();",
    ].join(" "),
    5_000,
    {},
    50,
    false,
  );
  let childPid: number | undefined;

  t.after(() => {
    if (running.child.exitCode === null) running.child.kill("SIGKILL");
    if (childPid !== undefined && isAlive(childPid)) process.kill(-childPid, "SIGKILL");
  });

  await waitFor(() => /child=\d+/.test(running.stderr()), 1_000, "external blocked-output child pid");
  childPid = Number(/child=(\d+)/.exec(running.stderr())![1]);
  process.kill(running.child.pid!, "SIGTERM");
  const result = await settlesWithin(running.exited, 1_000, "blocked-output SIGTERM exit").catch((error: unknown) => {
    throw new Error(`${error instanceof Error ? error.message : String(error)}; stderr: ${running.stderr()}`);
  });

  assert.equal(result.exitCode, 143);
  assert.equal(result.signal, null);
  assert.match(running.stderr(), /sending SIGKILL/);
});

test("external SIGTERM cancels the timeout before delayed child exit", async () => {
  const running = startInvocation(
    [
      "process.stderr.write('ready\\n');",
      "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 450));",
      "setInterval(() => {}, 1_000);",
    ].join(" "),
    300,
    {},
    750,
  );

  await waitFor(() => running.stderr().includes("ready"), 1_000, "delayed child readiness");
  process.kill(running.child.pid!, "SIGTERM");
  const result = await settlesWithin(running.complete, 1_000, "delayed external SIGTERM exit");

  assert.equal(result.exitCode, 143);
  assert.equal(result.signal, null);
  assert.doesNotMatch(result.stderr, /timed out after/);
});

test("test-unit runs bounded tool and E2E gates before static checks", async () => {
  const justfile = await readFile(resolve(repositoryRoot, "justfile"), "utf8");
  const recipe = /test-unit:\n((?:    @.*\n)+)/.exec(justfile);
  const recipeBody = recipe?.[1];

  assert.ok(recipeBody);
  const lines = recipeBody.trim().split("\n");
  assert.match(lines[0]!, /run-with-timeout\.mjs --timeout-ms 60000 -- npm --prefix tools run typecheck/);
  assert.match(lines[1]!, /run-with-timeout\.mjs --timeout-ms 600000 -- npm --prefix tools test/);
  assert.match(lines[2]!, /run-with-timeout\.mjs --timeout-ms 60000 -- npm --prefix e2e run typecheck/);
  assert.match(lines[3]!, /run-with-timeout\.mjs --timeout-ms 600000 -- npm --prefix e2e run test:unit/);
  assert.match(lines[4]!, /run-with-timeout\.mjs --timeout-ms 60000 -- bash scripts\/static-checks\.sh/);
});
