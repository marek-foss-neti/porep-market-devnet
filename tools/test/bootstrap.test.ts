import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const bootstrap = join(root, "scripts/bootstrap.sh");
const resultUrl = "https://browser.geekbench.com/v6/cpu/12345678";
const success = `printf '%s\\n' 'Upload succeeded.' '  ${resultUrl}' '${resultUrl}/claim?key=fixture'`;

function fixture(body: string, options: { os?: string; arch?: string; cached?: boolean; enabled?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bootstrap-geekbench-"));
  const platform = options.os === "Darwin" ? "Mac" : "Linux";
  const cache = join(dir, ".cache/geekbench", `6.7.1-${platform}`);
  const executable = join(cache, platform === "Mac"
    ? "Geekbench 6.app/Contents/Resources/geekbench6"
    : "Geekbench-6.7.1-Linux/geekbench6");
  mkdirSync(join(dir, "scripts"), { recursive: true });
  copyFileSync(join(root, "scripts/run-with-timeout.mjs"), join(dir, "scripts/run-with-timeout.mjs"));
  if (options.cached !== false) {
    mkdirSync(dirname(executable), { recursive: true });
    writeFileSync(executable, `#!/usr/bin/env bash\nset -eu\n[[ "$#" == 1 && "$1" == --cpu ]]\n${body}\n`, { mode: 0o755 });
    writeFileSync(join(cache, ".ready"), "");
  }
  try {
    const child = spawnSync("bash", ["-c", `
      source "$1"
      repository_root="$2"
      uname() { if [[ "$1" == -s ]]; then printf '%s\\n' "$FIXTURE_OS"; else printf '%s\\n' "$FIXTURE_ARCH"; fi; }
      start_command_progress() { printf -v "$1" '%s' ''; }
      # No test can download or run a real Geekbench. A fresh install receives an invalid archive.
      curl() { local output; for output in "$@"; do :; done; printf 'invalid archive' > "$output"; }
      run_bootstrap_geekbench
    `, "test", bootstrap, dir], {
      encoding: "utf8", timeout: 10000,
      env: { ...process.env, FIXTURE_OS: options.os ?? "Linux", FIXTURE_ARCH: options.arch ?? "x86_64", BOOTSTRAP_GEEKBENCH: options.enabled ?? "1" },
    });
    const logDir = join(dir, ".runtime/devnet/logs");
    const files = readdirSync(dir).includes(".runtime") ? readdirSync(logDir) : [];
    const saved = Object.fromEntries(files.map(name => [name, readFileSync(join(logDir, name), "utf8")]));
    return { ...child, saved };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("bootstrap runs cached Geekbench CPU and prints and saves the public result URL", () => {
  for (const os of ["Linux", "Darwin"]) {
    const child = fixture(success, { os, arch: os === "Darwin" ? "arm64" : "x86_64" });
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, new RegExp(`Geekbench 6 CPU result: ${resultUrl}`));
    assert.doesNotMatch(child.stdout + child.stderr, /claim\?key=/);
    assert.ok(Object.entries(child.saved).some(([name, value]) => name.endsWith(".url") && value === `${resultUrl}\n`));
    assert.ok(Object.entries(child.saved).some(([name, value]) => name.endsWith(".log") && value.includes("Upload succeeded.")));
  }
});

test("bootstrap explicitly skips Geekbench without downloading or running it", () => {
  const child = fixture("exit 99", { enabled: "0", cached: false });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stderr, /Geekbench 6 skipped/);
  assert.deepEqual(child.saved, {});
});

test("unsupported hosts get a skip warning instead of an incompatible binary", () => {
  const child = fixture("exit 99", { arch: "aarch64", cached: false });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stderr, /CPU benchmark skipped/);
});

test("failed CPU run or missing public upload link cannot report success", () => {
  const failed = fixture("echo 'test failure' >&2; exit 7");
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /Geekbench 6 failed with exit code 7/);
  const missing = fixture(`printf '%s\\n' '${resultUrl}/claim?key=fixture'`);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /without a public result link/);
  for (const child of [failed, missing]) {
    assert.doesNotMatch(child.stdout, /Geekbench 6 CPU result:/);
    assert.ok(Object.keys(child.saved).every(name => !name.endsWith(".url")));
  }
});

test("a mismatched download checksum stops bootstrap before running Geekbench", () => {
  const child = fixture("exit 99", { cached: false });
  assert.notEqual(child.status, 0);
  assert.match(child.stderr + child.stdout, /FAILED|did NOT match/);
  assert.deepEqual(child.saved, {});
});

test("Geekbench is the last bootstrap operation after managed sources verification", () => {
  const child = spawnSync("bash", ["-c", `
    source "$1"
    can_install_system_deps() { return 1; }
    ensure_node_and_npm() { :; }
    ensure_just() { :; }
    require_command() { :; }
    run_with_timeout_logged() { printf '%s\\n' "$1"; }
    capture_with_timeout_logged() { printf '%s\\n' "$2"; printf -v "$1" '%s' ''; }
    run_bootstrap_geekbench() { printf 'Geekbench CPU\\n'; }
    main
  `, "test", bootstrap], { encoding: "utf8", timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(child.stdout.trim().split("\n"), [
    "npm ci tools", "npm ci e2e", "lock verify", "managed sources fetch", "managed sources verify", "Geekbench CPU",
  ]);
  assert.match(child.stderr, /bootstrap complete/);
});
