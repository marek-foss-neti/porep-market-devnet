import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface Invocation {
  exitCode: number | null;
  stderr: string;
  stdout: string;
}

function run(command: string, arguments_: string[], cwd: string): Promise<Invocation> {
  return new Promise((resolveInvocation, reject) => {
    const child = spawn(command, arguments_, { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk; });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (exitCode) => resolveInvocation({ exitCode, stderr, stdout }));
  });
}

test("static safety rejects a reachable npm auth assignment without echoing its value", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "porep-static-safety-"));
  const fixtureToken = "fixture-token-not-a-real-secret";
  try {
    await cp(join(repositoryRoot, ".gitignore"), join(fixtureRoot, ".gitignore"));
    await cp(join(repositoryRoot, "scripts"), join(fixtureRoot, "scripts"), { recursive: true });
    await writeFile(join(fixtureRoot, "justfile"), "bootstrap:\n    @true\nbuild:\n    @true\nup:\n    @true\nstatus:\n    @true\ndeploy:\n    @true\naddresses:\n    @true\ntest-unit:\n    @true\ntest-scenario:\n    @true\ntest-e2e:\n    @true\ntest-all:\n    @true\nlogs:\n    @true\ndown:\n    @true\nreset:\n    @true\n");
    await writeFile(join(fixtureRoot, ".npmrc"), `//registry.example.test/:_auth${"Token"}=${fixtureToken}\n`);
    await run("git", ["init", "--quiet"], fixtureRoot);
    await run("git", ["add", "--force", ".npmrc"], fixtureRoot);

    const result = await run("bash", ["scripts/static-checks.sh"], fixtureRoot);

    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /unsafe implementation text found/);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(fixtureToken));
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("static safety rejects private key assignments but permits Go field writes", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "porep-static-safety-"));
  const fixtureKey = "fixture-private-key-not-a-real-secret";
  try {
    await cp(join(repositoryRoot, ".gitignore"), join(fixtureRoot, ".gitignore"));
    await cp(join(repositoryRoot, "scripts"), join(fixtureRoot, "scripts"), { recursive: true });
    await writeFile(join(fixtureRoot, "justfile"), "bootstrap:\n    @true\nbuild:\n    @true\nup:\n    @true\nstatus:\n    @true\ndeploy:\n    @true\naddresses:\n    @true\ntest-unit:\n    @true\ntest-scenario:\n    @true\ntest-e2e:\n    @true\ntest-all:\n    @true\nlogs:\n    @true\ndown:\n    @true\nreset:\n    @true\n");
    await writeFile(join(fixtureRoot, "field.go"), "package fixture\n\nfunc copyKey() { target.PrivateKey = source.PrivateKey }\n");
    await writeFile(join(fixtureRoot, "env.sh"), `DEVNET_PRIVATE_KEY=${fixtureKey}\n`);
    await run("git", ["init", "--quiet"], fixtureRoot);

    const result = await run("bash", ["scripts/static-checks.sh"], fixtureRoot);

    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /unsafe implementation text found/);
    assert.match(result.stdout, /^env\.sh$/m);
    assert.doesNotMatch(result.stdout, /^field\.go$/m);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(fixtureKey));
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("static safety scans docs architecture but excludes generated review artifacts", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "porep-static-safety-"));
  const localPath = `/${"Users"}/fixture`;
  try {
    await cp(join(repositoryRoot, ".gitignore"), join(fixtureRoot, ".gitignore"));
    await cp(join(repositoryRoot, "scripts"), join(fixtureRoot, "scripts"), { recursive: true });
    await writeFile(join(fixtureRoot, "justfile"), "bootstrap:\n    @true\nbuild:\n    @true\nup:\n    @true\nstatus:\n    @true\ndeploy:\n    @true\naddresses:\n    @true\ntest-unit:\n    @true\ntest-scenario:\n    @true\ntest-e2e:\n    @true\ntest-all:\n    @true\nlogs:\n    @true\ndown:\n    @true\nreset:\n    @true\n");
    await mkdir(join(fixtureRoot, "docs", "architecture"), { recursive: true });
    await mkdir(join(fixtureRoot, "docs", "review"), { recursive: true });
    await writeFile(join(fixtureRoot, "docs", "architecture", "unsafe.md"), `${localPath}\n`);
    await writeFile(join(fixtureRoot, "docs", "review", "generated.md"), `${localPath}\n`);
    await run("git", ["init", "--quiet"], fixtureRoot);

    const result = await run("bash", ["scripts/static-checks.sh"], fixtureRoot);

    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /unsafe implementation text found/);
    assert.match(result.stdout, /docs\/architecture\/unsafe\.md/);
    assert.doesNotMatch(result.stdout, /docs\/review\/generated\.md/);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("static safety rejects a reachable netrc password without echoing its value", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "porep-static-safety-"));
  const fixturePassword = "fixture-password-not-a-real-secret";
  try {
    await cp(join(repositoryRoot, ".gitignore"), join(fixtureRoot, ".gitignore"));
    await cp(join(repositoryRoot, "scripts"), join(fixtureRoot, "scripts"), { recursive: true });
    await writeFile(join(fixtureRoot, "justfile"), "bootstrap:\n    @true\nbuild:\n    @true\nup:\n    @true\nstatus:\n    @true\ndeploy:\n    @true\naddresses:\n    @true\ntest-unit:\n    @true\ntest-scenario:\n    @true\ntest-e2e:\n    @true\ntest-all:\n    @true\nlogs:\n    @true\ndown:\n    @true\nreset:\n    @true\n");
    await writeFile(join(fixtureRoot, ".netrc"), `machine example login user password ${fixturePassword}\n`);
    await run("git", ["init", "--quiet"], fixtureRoot);
    await run("git", ["add", "--force", ".netrc"], fixtureRoot);

    const result = await run("bash", ["scripts/static-checks.sh"], fixtureRoot);

    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /unsafe implementation text found/);
    assert.match(result.stdout, /^\.netrc$/m);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(fixturePassword));
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
