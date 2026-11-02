import { lstat, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { devNull } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { ManagedSource } from "./lock.js";
import { run } from "./process.js";

export const SOURCE_INSPECTION_GIT_TIMEOUT_MS = 60_000;
export const SOURCE_FETCH_GIT_TIMEOUT_MS = 600_000;
const SAFE_SOURCE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const BLOCKED_GIT_ENVIRONMENT = new Set(["SSH_ASKPASS", "SSH_ASKPASS_REQUIRE"]);
const SAFE_LOCAL_GIT_CONFIG_KEYS = new Set([
  "core.bare",
  "core.filemode",
  "core.ignorecase",
  "core.logallrefupdates",
  "core.precomposeunicode",
  "core.repositoryformatversion",
  "core.worktree",
  "remote.origin.fetch",
  "remote.origin.url",
]);
const SAFE_SCOPED_LOCAL_GIT_CONFIG_KEYS = [
  /^branch\..+\.(?:merge|remote)$/,
  /^submodule\..+\.(?:active|url)$/,
];

export interface SourceState {
  name: string;
  path: string;
  expectedCommit: string;
  actualCommit: string;
  detached: boolean;
  dirty: boolean;
  submodules: Record<string, string>;
}

export interface ReconcileOptions {
  /** Test fixtures may opt in to local Git submodule transport. Production callers must not. */
  allowFileTransport?: boolean;
}

interface SourceContext {
  source: ManagedSource;
  cacheRoot: string;
  destination: string;
}

interface ExpectedModuleConfig {
  submodulePath: string;
  worktree: string;
}

export async function reconcileSource(
  source: ManagedSource,
  cacheRoot: string,
  options: ReconcileOptions = {},
): Promise<SourceState> {
  const context = sourceContext(source, cacheRoot);
  normalizeRepository(source.repository);
  if ((await managedPathState(context)).destinationExists) {
    return verifySource(source, cacheRoot);
  }

  await ensureManagedDirectories(context);
  try {
    await git(context, context.cacheRoot, ["init", context.destination]);
    await git(context, context.destination, ["remote", "add", "origin", source.repository]);
    await git(context, context.destination, ["fetch", "--depth", "1", "origin", source.commit]);
    await git(context, context.destination, ["checkout", "--detach", "FETCH_HEAD"]);
    const submoduleArgs = options.allowFileTransport
      ? ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive"]
      : ["submodule", "update", "--init", "--recursive"];
    await git(context, context.destination, submoduleArgs);
  } catch (error) {
    throw sourceError(source, context.destination, `could not create the exact checkout (${errorMessage(error)})`);
  }
  return verifySource(source, cacheRoot);
}

export async function verifySource(source: ManagedSource, cacheRoot: string): Promise<SourceState> {
  const context = sourceContext(source, cacheRoot);
  const expectedOrigin = normalizeRepository(source.repository);
  if (!(await managedPathState(context)).destinationExists) {
    throw sourceError(source, context.destination, "checkout is missing");
  }

  try {
    await validateLocalGitConfiguration(context);
    const origin = await gitOutput(context, ["remote", "get-url", "origin"]);
    if (normalizeRepository(origin) !== expectedOrigin) {
      throw sourceError(source, context.destination, "origin URL does not match the locked repository");
    }

    const actualCommit = await gitOutput(context, ["rev-parse", "HEAD"]);
    const detached = (await gitOutput(context, ["branch", "--show-current"])) === "";
    const dirtyOutput = await gitOutput(context, ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"]);
    const dirty = dirtyOutput !== "";

    if (actualCommit !== source.commit) {
      throw sourceError(source, context.destination, `unexpected commit ${actualCommit}, expected ${source.commit}`);
    }
    if (!detached) {
      throw sourceError(source, context.destination, "HEAD is attached to a branch");
    }
    if (dirty) {
      throw sourceError(source, context.destination, `checkout is dirty (${JSON.stringify(dirtyOutput)})`);
    }

    return {
      name: source.name,
      path: context.destination,
      expectedCommit: source.commit,
      actualCommit,
      detached,
      dirty,
      submodules: await verifySubmodules(context),
    };
  } catch (error) {
    if (isSourceError(error)) throw error;
    throw sourceError(source, context.destination, `could not inspect checkout (${errorMessage(error)})`);
  }
}

async function validateLocalGitConfiguration(context: SourceContext): Promise<void> {
  const gitDirectory = join(context.destination, ".git");
  await requireDirectory(context, gitDirectory, "Git metadata directory");
  const realGitDirectory = await realpath(gitDirectory);
  await validateLocalGitConfigFile(context, join(realGitDirectory, "config"));

  const expectedConfigs = await expectedModuleConfigs(context, realGitDirectory);
  const discoveredConfigs = new Set<string>();
  for (const configPath of await collectModuleConfigPaths(context, join(realGitDirectory, "modules"))) {
    const realConfigPath = await realpath(configPath);
    if (discoveredConfigs.has(realConfigPath)) {
      throw sourceError(context.source, context.destination, "nested Git metadata contains a duplicate config mapping");
    }
    discoveredConfigs.add(realConfigPath);
    const expected = expectedConfigs.get(realConfigPath);
    if (expected === undefined) {
      throw sourceError(context.source, context.destination, "nested Git metadata contains an unexpected config mapping");
    }
    await validateLocalGitConfigFile(context, realConfigPath, expected);
    expectedConfigs.delete(realConfigPath);
  }
  if (expectedConfigs.size > 0) {
    throw sourceError(context.source, context.destination, "nested Git metadata is missing a declared submodule config mapping");
  }
}

async function expectedModuleConfigs(
  context: SourceContext,
  realGitDirectory: string,
): Promise<Map<string, ExpectedModuleConfig>> {
  const mappings = new Map<string, ExpectedModuleConfig>();
  const submodulePaths = Object.keys(context.source.submodules);
  if (submodulePaths.length === 0) return mappings;

  const modulesDirectory = join(realGitDirectory, "modules");
  await requireDirectory(context, modulesDirectory, "nested Git modules directory");
  const realModulesDirectory = await realpath(modulesDirectory);
  const realDestination = await realpath(context.destination);

  for (const submodulePath of submodulePaths) {
    const worktreePath = resolve(context.destination, submodulePath);
    const relativeWorktreePath = relative(context.destination, worktreePath);
    if (
      relativeWorktreePath === ""
      || relativeWorktreePath === ".."
      || relativeWorktreePath.startsWith(`..${sep}`)
    ) {
      throw sourceError(context.source, context.destination, "declared submodule worktree escapes the managed checkout");
    }
    await requireDirectory(context, worktreePath, "declared submodule worktree");
    const realWorktree = await realpath(worktreePath);
    const relativeRealWorktree = relative(realDestination, realWorktree);
    if (relativeRealWorktree === ".." || relativeRealWorktree.startsWith(`..${sep}`)) {
      throw sourceError(context.source, context.destination, "declared submodule worktree escapes the managed checkout");
    }

    const gitdirFile = join(worktreePath, ".git");
    const gitdirTarget = await readGitdirFile(context, gitdirFile);
    const realGitdirTarget = await realpath(resolve(dirname(gitdirFile), gitdirTarget));
    const relativeGitdir = relative(realModulesDirectory, realGitdirTarget);
    if (relativeGitdir === "" || relativeGitdir === ".." || relativeGitdir.startsWith(`..${sep}`)) {
      throw sourceError(context.source, context.destination, "declared submodule gitdir escapes nested Git metadata");
    }
    await requireDirectory(context, realGitdirTarget, "declared submodule gitdir");

    const configPath = join(realGitdirTarget, "config");
    await requireRegularFile(context, configPath, "declared submodule config");
    const realConfigPath = await realpath(configPath);
    if (mappings.has(realConfigPath)) {
      throw sourceError(context.source, context.destination, "declared submodules contain a duplicate config mapping");
    }
    mappings.set(realConfigPath, { submodulePath, worktree: realWorktree });
  }
  return mappings;
}

async function readGitdirFile(context: SourceContext, path: string): Promise<string> {
  const info = await requireRegularFile(context, path, "declared submodule .git file");
  if (info.size > 4_096) {
    throw sourceError(context.source, context.destination, "declared submodule .git file is too large");
  }
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch {
    throw sourceError(context.source, context.destination, "declared submodule .git file is unreadable");
  }
  const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(contents);
  if (match?.[1] === undefined) {
    throw sourceError(context.source, context.destination, "declared submodule .git file has an invalid format");
  }
  return match[1];
}

async function collectModuleConfigPaths(context: SourceContext, directory: string): Promise<string[]> {
  let info;
  try {
    info = await lstat(directory);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw sourceError(context.source, context.destination, "nested Git metadata is not a real directory");
  }

  const entries = await readdir(directory, { withFileTypes: true });
  const configEntry = entries.find((entry) => entry.name === "config");
  if (configEntry !== undefined) {
    if (configEntry.isSymbolicLink() || !configEntry.isFile()) {
      throw sourceError(context.source, context.destination, "local Git config is not a regular file");
    }
    return [
      join(directory, configEntry.name),
      ...await collectModuleConfigPaths(context, join(directory, "modules")),
    ];
  }

  const configPaths: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw sourceError(context.source, context.destination, "nested Git metadata contains a symlink");
    }
    if (entry.isDirectory()) {
      configPaths.push(...await collectModuleConfigPaths(context, join(directory, entry.name)));
    }
  }
  return configPaths;
}

async function validateLocalGitConfigFile(
  context: SourceContext,
  configPath: string,
  expectedModule?: ExpectedModuleConfig,
): Promise<void> {
  await requireRegularFile(context, configPath, "local Git config");

  let output: string;
  try {
    output = (await run("git", [
      "config",
      "--file",
      configPath,
      "--no-includes",
      "--null",
      "--list",
    ], {
      cwd: context.destination,
      env: sanitizedGitEnvironment(),
      timeoutMs: SOURCE_INSPECTION_GIT_TIMEOUT_MS,
    })).stdout;
  } catch {
    throw sourceError(context.source, context.destination, "local Git config could not be parsed safely");
  }

  let worktreeEntries = 0;
  for (const record of output.split("\0")) {
    if (record === "") continue;
    const separatorIndex = record.indexOf("\n");
    if (separatorIndex <= 0) {
      throw sourceError(context.source, context.destination, "local Git config contains an unreadable entry");
    }
    const key = record.slice(0, separatorIndex).toLowerCase();
    const value = record.slice(separatorIndex + 1);
    if (!isSafeLocalGitConfigKey(key)) {
      const reportedKey = /^[a-z0-9-]+\.[a-z0-9-]+$/.test(key) ? key : "an unsupported key";
      throw sourceError(context.source, context.destination, `local Git config contains unsafe key ${reportedKey}`);
    }
    if (key === "core.worktree") {
      worktreeEntries += 1;
      if (expectedModule === undefined) {
        throw sourceError(context.source, context.destination, "local Git root config contains unsafe key core.worktree");
      }
      await validateExactLocalWorktree(context, configPath, value, expectedModule);
    }
  }
  if (expectedModule !== undefined && worktreeEntries !== 1) {
    throw sourceError(
      context.source,
      context.destination,
      `local Git config must contain one exact core.worktree for declared submodule ${expectedModule.submodulePath}`,
    );
  }
}

function isSafeLocalGitConfigKey(key: string): boolean {
  return SAFE_LOCAL_GIT_CONFIG_KEYS.has(key)
    || SAFE_SCOPED_LOCAL_GIT_CONFIG_KEYS.some((pattern) => pattern.test(key));
}

async function validateExactLocalWorktree(
  context: SourceContext,
  configPath: string,
  value: string,
  expectedModule: ExpectedModuleConfig,
): Promise<void> {
  let worktree: string;
  try {
    worktree = await realpath(resolve(dirname(configPath), value));
  } catch {
    throw sourceError(context.source, context.destination, "local Git config core.worktree is missing or unreadable");
  }
  if (worktree !== expectedModule.worktree) {
    throw sourceError(
      context.source,
      context.destination,
      `local Git config core.worktree does not match exact declared submodule ${expectedModule.submodulePath}`,
    );
  }
}

async function requireRegularFile(
  context: SourceContext,
  path: string,
  label: string,
): Promise<Awaited<ReturnType<typeof lstat>>> {
  let info;
  try {
    info = await lstat(path);
  } catch {
    throw sourceError(context.source, context.destination, `${label} is missing or unreadable`);
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw sourceError(context.source, context.destination, `${label} is not a regular file`);
  }
  return info;
}

async function requireDirectory(context: SourceContext, path: string, label: string): Promise<void> {
  let info;
  try {
    info = await lstat(path);
  } catch {
    throw sourceError(context.source, context.destination, `${label} is missing or unreadable`);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw sourceError(context.source, context.destination, `${label} is not a real directory`);
  }
}

async function verifySubmodules(context: SourceContext): Promise<Record<string, string>> {
  const output = await gitRawOutput(context, ["submodule", "status", "--recursive"]);
  const observed = new Map<string, string>();
  for (const line of output.split("\n")) {
    if (line === "") continue;
    const match = /^(.)([0-9a-f]{40})\s+(.+?)(?:\s|$)/.exec(line);
    if (!match || match[1] === undefined || match[2] === undefined || match[3] === undefined) {
      throw sourceError(context.source, context.destination, `unreadable recursive submodule state ${JSON.stringify(line)}`);
    }
    const state = match[1];
    const commit = match[2];
    const path = match[3];
    if (state !== " ") {
      throw sourceError(context.source, context.destination, `submodule ${path} is not initialized at its recorded commit (${JSON.stringify(line)})`);
    }
    observed.set(path, commit);
  }

  const verified: Record<string, string> = {};
  for (const [name, expectedCommit] of Object.entries(context.source.submodules)) {
    const path = findSubmodulePath(name, observed);
    if (path === undefined) {
      throw sourceError(context.source, context.destination, `declared submodule ${name} is missing`);
    }
    const actualCommit = observed.get(path);
    if (actualCommit !== expectedCommit) {
      throw sourceError(context.source, context.destination, `submodule ${name} is ${actualCommit}, expected ${expectedCommit}`);
    }
    verified[name] = actualCommit;
    observed.delete(path);
  }
  if (observed.size > 0) {
    throw sourceError(context.source, context.destination, `contains undeclared submodule ${[...observed.keys()][0]}`);
  }
  return verified;
}

function sourceContext(source: ManagedSource, cacheRoot: string): SourceContext {
  const root = resolve(cacheRoot);
  if (!SAFE_SOURCE_NAME.test(source.name)) {
    throw sourceError(source, root, "source name must be one safe path segment");
  }
  const destination = resolve(root, source.name, source.commit);
  const pathFromRoot = relative(root, destination);
  if (pathFromRoot === "" || pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`)) {
    throw sourceError(source, root, "managed checkout path escapes the cache root");
  }
  return { source, cacheRoot: root, destination };
}

async function managedPathState(context: SourceContext): Promise<{ destinationExists: boolean }> {
  await checkDirectory(context, dirname(context.cacheRoot), "cache parent", true);
  const rootExists = await checkDirectory(context, context.cacheRoot, "cache root", true);
  if (!rootExists) return { destinationExists: false };
  const sourceDirectory = resolve(context.cacheRoot, context.source.name);
  const sourceExists = await checkDirectory(context, sourceDirectory, "source-name directory", true);
  if (!sourceExists) return { destinationExists: false };
  return { destinationExists: await checkDirectory(context, context.destination, "final destination", true) };
}

async function ensureManagedDirectories(context: SourceContext): Promise<void> {
  await ensureDirectory(context, context.cacheRoot, "cache root");
  await ensureDirectory(context, resolve(context.cacheRoot, context.source.name), "source-name directory");
  if ((await managedPathState(context)).destinationExists) {
    throw sourceError(context.source, context.destination, "checkout appeared while creating its managed directory");
  }
}

async function ensureDirectory(context: SourceContext, path: string, label: string): Promise<void> {
  const missing: string[] = [];
  let current = path;
  while (!(await checkDirectory(context, current, label, true))) {
    missing.push(current);
    const parent = dirname(current);
    if (parent === current) {
      throw sourceError(context.source, context.destination, `cannot create ${label}`);
    }
    current = parent;
  }
  for (const directory of missing.reverse()) {
    await mkdir(directory);
    await checkDirectory(context, directory, label, false);
  }
}

async function checkDirectory(context: SourceContext, path: string, label: string, allowMissing: boolean): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      throw sourceError(context.source, context.destination, `${label} is a symlink`);
    }
    if (!info.isDirectory()) {
      throw sourceError(context.source, context.destination, `${label} is not a directory`);
    }
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT") && allowMissing) return false;
    throw error;
  }
}

async function git(context: SourceContext, cwd: string, args: string[]): Promise<void> {
  await assertSafeBeforeGit(context, cwd);
  // Avoid spurious GitHub HTTP/2 401s during recursive submodule clones.
  // Pass this explicitly because managed sources ignore global Git config.
  await run("git", ["-c", "http.version=HTTP/1.1", ...args], {
    cwd,
    env: sanitizedGitEnvironment(),
    timeoutMs: SOURCE_FETCH_GIT_TIMEOUT_MS,
  });
}

async function gitOutput(context: SourceContext, args: string[]): Promise<string> {
  await assertSafeBeforeGit(context, context.destination);
  return (await run("git", ["--no-optional-locks", ...args], {
    cwd: context.destination,
    env: sanitizedGitEnvironment(),
    timeoutMs: SOURCE_INSPECTION_GIT_TIMEOUT_MS,
  })).stdout.trim();
}

async function gitRawOutput(context: SourceContext, args: string[]): Promise<string> {
  await assertSafeBeforeGit(context, context.destination);
  return (await run("git", ["--no-optional-locks", ...args], {
    cwd: context.destination,
    env: sanitizedGitEnvironment(),
    timeoutMs: SOURCE_INSPECTION_GIT_TIMEOUT_MS,
  })).stdout.replace(/[\r\n]+$/, "");
}

function sanitizedGitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    const normalizedName = name.toUpperCase();
    if (normalizedName.startsWith("GIT_") || BLOCKED_GIT_ENVIRONMENT.has(normalizedName)) continue;
    environment[name] = value;
  }
  environment.GIT_CONFIG_GLOBAL = devNull;
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.GCM_INTERACTIVE = "Never";
  return environment;
}

async function assertSafeBeforeGit(context: SourceContext, cwd: string): Promise<void> {
  const state = await managedPathState(context);
  if (cwd === context.destination && !state.destinationExists) {
    throw sourceError(context.source, context.destination, "checkout disappeared before Git could inspect it");
  }
  if (cwd === context.cacheRoot && state.destinationExists) {
    throw sourceError(context.source, context.destination, "checkout appeared before Git could initialize it");
  }
}

function normalizeRepository(repository: string): string {
  if (repository.startsWith("https://")) {
    const url = new URL(repository);
    if (url.username !== "" || url.password !== "") {
      throw new Error("HTTPS repository URL must not include credentials");
    }
    const pathname = url.pathname.replace(/\/+$/, "").replace(/\.git$/, "") || "/";
    const port = url.port === "" || url.port === "443" ? "" : `:${url.port}`;
    return `https://${url.hostname.toLowerCase()}${port}${pathname}${url.search}`;
  }
  if (repository.startsWith("file://")) {
    return resolve(fileURLToPath(repository));
  }
  return resolve(repository);
}

function findSubmodulePath(name: string, observed: Map<string, string>): string | undefined {
  if (observed.has(name)) return name;
  const normalizedName = normalizeSubmoduleName(name);
  const matches = [...observed.keys()].filter((path) => {
    const normalizedPath = normalizeSubmoduleName(path);
    return normalizedPath === normalizedName || normalizedPath.endsWith(`_${normalizedName}`);
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function normalizeSubmoduleName(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
}

function sourceError(source: ManagedSource, path: string, detail: string): Error {
  return new Error(`source ${source.name} at ${path}: ${detail}. Inspect and move this managed checkout to a safe location, then rerun sources fetch.`);
}

function isSourceError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("source ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === code;
}
