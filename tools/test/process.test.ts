import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { OUTPUT_CAPTURE_LIMIT_BYTES, run } from "../src/process.js";

const options = { cwd: process.cwd(), timeoutMs: 1_000 };
const toolsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const delay = (durationMs: number): Promise<void> => new Promise((resolveDelay) => {
  setTimeout(resolveDelay, durationMs);
});

async function waitForFile(path: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      await delay(10);
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error, "ESRCH")) return false;
    throw error;
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

test("returns captured output from a successful process", async () => {
  const result = await run(process.execPath, ["-e", "process.stdout.write('hello')"], options);

  assert.equal(result.stdout, "hello");
  assert.equal(result.stderr, "");
  assert.equal(result.exitCode, 0);
  assert.ok(result.durationMs >= 0);
});

test("captures stderr from a nonzero process", async () => {
  await assert.rejects(
    run(process.execPath, ["-e", "process.stderr.write('bad'); process.exit(7)"], options),
    /exit code 7.*bad/s,
  );
});

test("terminates a process that exceeds its timeout", async () => {
  await assert.rejects(
    run(process.execPath, ["-e", "setTimeout(() => {}, 10_000)"], { cwd: process.cwd(), timeoutMs: 100 }),
    /timed out after 100ms/,
  );
});

test("timeout terminates a SIGTERM-ignoring descendant before it can continue work", {
  skip: process.platform === "win32",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "porep-process-tree-"));
  const markerPath = join(directory, "descendant-worked");
  const pidPath = join(directory, "descendant.pid");
  const descendantScript = [
    "const { writeFileSync } = require('node:fs');",
    "process.on('SIGTERM', () => {});",
    `setTimeout(() => writeFileSync(${JSON.stringify(markerPath)}, 'worked'), 2_500);`,
    "setInterval(() => {}, 1_000);",
  ].join("");
  const parentScript = [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    `const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { stdio: 'ignore' });`,
    `writeFileSync(${JSON.stringify(pidPath)}, String(descendant.pid));`,
    "setInterval(() => {}, 1_000);",
  ].join("");
  let descendantPid: number | undefined;
  const originalKill = process.kill;
  let injectedEperm = false;

  try {
    process.kill = ((pid: number, signal?: NodeJS.Signals | number): true => {
      if (pid < 0 && signal === 0) {
        injectedEperm = true;
        throw Object.assign(new Error("injected process-group liveness denial"), { code: "EPERM" });
      }
      return signal === undefined ? originalKill(pid) : originalKill(pid, signal);
    }) as typeof process.kill;
    await assert.rejects(run(process.execPath, ["-e", parentScript], {
      cwd: directory,
      timeoutMs: 300,
    }), /timed out after 300ms.*could not confirm process group termination.*EPERM/s);
    process.kill = originalKill;
    descendantPid = Number(await readFile(pidPath, "utf8"));
    await delay(500);
    assert.equal(injectedEperm, true);
    await assert.rejects(access(markerPath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
    assert.equal(isProcessAlive(descendantPid), false);
  } finally {
    process.kill = originalKill;
    if (descendantPid !== undefined && isProcessAlive(descendantPid)) {
      process.kill(descendantPid, "SIGKILL");
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("forwards external SIGTERM to the detached process group", {
  skip: process.platform === "win32",
  timeout: 5_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "porep-process-signal-"));
  const readyPath = join(directory, "ready");
  const forwardedPath = join(directory, "forwarded");
  const pidPath = join(directory, "child.pid");
  const runnerPath = join(directory, "runner.ts");
  const processModuleUrl = pathToFileURL(join(toolsRoot, "src", "process.ts")).href;
  const childScript = [
    "const { writeFileSync } = require('node:fs');",
    `writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
    "process.on('SIGTERM', () => {",
    `writeFileSync(${JSON.stringify(forwardedPath)}, 'forwarded');`,
    "process.exit(0);",
    "});",
    `writeFileSync(${JSON.stringify(readyPath)}, 'ready');`,
    "setInterval(() => {}, 1_000);",
  ].join("");
  await writeFile(
    runnerPath,
    `import { run } from ${JSON.stringify(processModuleUrl)};\n`
      + `run(process.execPath, ["-e", ${JSON.stringify(childScript)}], `
      + `{ cwd: ${JSON.stringify(directory)}, timeoutMs: 10_000 })`
      + ".catch((error) => { console.error(error); process.exitCode = 1; });\n",
  );
  const runner = spawn(resolve(toolsRoot, "node_modules", ".bin", "tsx"), [runnerPath], {
    cwd: toolsRoot,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let runnerStderr = "";
  runner.stderr.on("data", (chunk: Buffer) => {
    runnerStderr += chunk;
  });
  const outcomePromise = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolveOutcome, reject) => {
    runner.once("error", reject);
    runner.once("close", (exitCode, signal) => resolveOutcome({ exitCode, signal }));
  });
  let childPid: number | undefined;

  try {
    await Promise.race([
      waitForFile(readyPath),
      outcomePromise.then((outcome) => {
        throw new Error(`runner exited before child readiness: ${JSON.stringify({ ...outcome, runnerStderr })}`);
      }),
    ]);
    childPid = Number(await readFile(pidPath, "utf8"));
    runner.kill("SIGTERM");
    const outcome = await outcomePromise;
    assert.ok(outcome.signal === "SIGTERM" || outcome.exitCode === 143);
    await access(forwardedPath);
    assert.equal(isProcessAlive(childPid), false);
  } finally {
    if (runner.pid !== undefined && isProcessAlive(runner.pid)) runner.kill("SIGKILL");
    if (childPid !== undefined && isProcessAlive(childPid)) process.kill(childPid, "SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
});

test("does not retain process signal listeners after sequential runs", async () => {
  const before = {
    SIGINT: process.listenerCount("SIGINT"),
    SIGTERM: process.listenerCount("SIGTERM"),
  };

  await run(process.execPath, ["-e", ""], options);
  await run(process.execPath, ["-e", ""], options);

  assert.equal(process.listenerCount("SIGINT"), before.SIGINT);
  assert.equal(process.listenerCount("SIGTERM"), before.SIGTERM);
});

test("uses an explicit environment override", async () => {
  const result = await run(
    process.execPath,
    ["-e", "process.stdout.write(process.env.RUN_ENV_OVERRIDE ?? 'missing')"],
    { ...options, env: { ...process.env, RUN_ENV_OVERRIDE: "isolated" } },
  );

  assert.equal(result.stdout, "isolated");
});

test("retains only a marked diagnostic tail for oversized output", async () => {
  const result = await run(
    process.execPath,
    ["-e", `process.stdout.write('x'.repeat(${OUTPUT_CAPTURE_LIMIT_BYTES * 2}) + 'TAIL')`],
    options,
  );

  assert.ok(Buffer.byteLength(result.stdout) <= OUTPUT_CAPTURE_LIMIT_BYTES);
  assert.match(result.stdout, /^\n\[output truncated\]\n/);
  assert.match(result.stdout, /TAIL$/);
});

test("bounds stderr retained in a nonzero-process error", async () => {
  await assert.rejects(
    run(
      process.execPath,
      ["-e", `process.stderr.write('y'.repeat(${OUTPUT_CAPTURE_LIMIT_BYTES * 2}) + 'ERRTAIL'); process.exitCode = 9`],
      options,
    ),
    (error: Error) => {
      assert.ok(Buffer.byteLength(error.message) < OUTPUT_CAPTURE_LIMIT_BYTES + 1_000);
      assert.match(error.message, /\[output truncated\]/);
      assert.match(error.message, /ERRTAIL/);
      return true;
    },
  );
});
