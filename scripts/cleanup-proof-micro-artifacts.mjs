#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  lstat,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

function die(message) {
  console.error(`cleanup-proof-micro-artifacts: ${message}`);
  process.exit(1);
}

function isInside(parent, child) {
  const path = relative(parent, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

async function requireRegularFile(path, label) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    die(`${label} is missing: ${path} (${error.message})`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    die(`${label} must be a regular, non-symbolic file: ${path}`);
  }
  return metadata;
}

async function requireRealDirectory(path, label, parent) {
  const metadata = await lstat(path).catch(() => null);
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) {
    die(`${label} must be a real directory: ${path}`);
  }
  const resolvedPath = await realpath(path);
  if (parent && !isInside(parent, resolvedPath)) {
    die(`${label} escapes the run directory: ${resolvedPath}`);
  }
  return resolvedPath;
}

async function readJson(path, label) {
  await requireRegularFile(path, label);
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    die(`${label} is not valid JSON: ${path} (${error.message})`);
  }
}

function fileRecord(runDirectory, path, metadata) {
  return {
    path: relative(runDirectory, path),
    logical_bytes: metadata.size,
    allocated_bytes: Number.isFinite(metadata.blocks) ? metadata.blocks * 512 : null,
  };
}

async function retainedFileRecord(runDirectory, path, label) {
  const metadata = await requireRegularFile(path, label);
  return {
    ...fileRecord(runDirectory, path, metadata),
    sha256: createHash("sha256").update(await readFile(path)).digest("hex"),
  };
}

async function collectDirectoryFiles(runDirectory, root, label) {
  const resolvedRoot = await requireRealDirectory(root, label, runDirectory);
  const files = [];
  const directories = [resolvedRoot];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        die(`refusing symbolic link in ${label}: ${path}`);
      }
      if (entry.isDirectory()) {
        const resolvedPath = await realpath(path);
        if (!isInside(runDirectory, resolvedPath)) {
          die(`${label} entry escapes the run directory: ${resolvedPath}`);
        }
        directories.push(resolvedPath);
        await visit(resolvedPath);
      } else if (entry.isFile()) {
        files.push({ path, metadata: await lstat(path) });
      } else {
        die(`refusing unexpected entry in ${label}: ${path}`);
      }
    }
  };
  await visit(resolvedRoot);
  return { files, directories };
}

async function writeManifest(path, manifest) {
  const temporaryPath = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  await rename(temporaryPath, path);
}

const runDirectoryArgument = process.argv[2];
const backend = process.argv[3];
if (!runDirectoryArgument || !backend || process.argv.length !== 4) {
  die("usage: cleanup-proof-micro-artifacts.mjs RUN_DIRECTORY BACKEND");
}
if (backend !== "zigzag" && backend !== "stacked") {
  die(`unsupported proof backend: ${backend}`);
}

const requestedRunDirectory = resolve(runDirectoryArgument);
const runDirectoryMetadata = await lstat(requestedRunDirectory).catch(() => null);
if (!runDirectoryMetadata?.isDirectory() || runDirectoryMetadata.isSymbolicLink()) {
  die(`run directory must be a real directory: ${requestedRunDirectory}`);
}
const runDirectory = await realpath(requestedRunDirectory);
const realRunDirectory = runDirectory;

const summary = await readJson(join(runDirectory, "summary.json"), "benchmark summary");
const report = await readJson(join(runDirectory, "report.json"), "combined report");
await readJson(join(runDirectory, "telemetry-summary.json"), "telemetry summary");
await readJson(join(runDirectory, "provenance.json"), "provenance");
const expectedSummaryBackend = backend === "zigzag" ? "zig-zag" : "stacked";
if (
  summary.backend !== expectedSummaryBackend
  || summary.verify_seal !== true
  || summary.raw_unseal_bytes_match !== true
  || report.mode !== "full"
) {
  die(`refusing to prune before a successful full ${backend} benchmark is validated`);
}

const workDirectory = join(runDirectory, "work");
await requireRealDirectory(workDirectory, "work directory", realRunDirectory);

const removalCandidates = [];
const removedDirectories = [];
const retainedFiles = [];
let retained;
let cleanupKind;

const addRegularFileIfPresent = async (path, label) => {
  const metadata = await lstat(path).catch(() => null);
  if (!metadata) return;
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    die(`refusing unexpected ${label} path: ${path}`);
  }
  removalCandidates.push({ path, metadata });
};

if (backend === "zigzag") {
  cleanupKind = "post-success-zigzag-work-prune";
  const cacheDirectory = join(workDirectory, "zigzag-cache");
  await requireRealDirectory(cacheDirectory, "ZigZag cache directory", realRunDirectory);
  const auxPath = join(cacheDirectory, "zigzag-aux.json");
  const aux = await readJson(auxPath, "ZigZag auxiliary commitment record");
  for (const field of ["comm_d", "comm_r", "comm_r_star", "replica_id", "layers"]) {
    if (aux[field] === undefined || aux[field] === null) {
      die(`ZigZag auxiliary commitment record is missing ${field}: ${auxPath}`);
    }
  }
  const auxRecord = await retainedFileRecord(
    runDirectory,
    auxPath,
    "ZigZag auxiliary commitment record",
  );
  retainedFiles.push({
    ...auxRecord,
    fields: ["comm_d", "comm_r", "comm_r_star", "replica_id", "layers"],
  });
  retained = retainedFiles[0];

  await addRegularFileIfPresent(join(workDirectory, "zigzag-sealed.dat"), "sealed-sector");
  for (const entry of await readdir(cacheDirectory, { withFileTypes: true })) {
    if (!entry.name.endsWith(".dat")) continue;
    const path = join(cacheDirectory, entry.name);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      die(`refusing unexpected ZigZag cache entry: ${path}`);
    }
    removalCandidates.push({ path, metadata: await lstat(path) });
  }
} else {
  cleanupKind = "post-success-stacked-work-prune";
  const cacheDirectory = join(workDirectory, "seal-cache");
  await requireRealDirectory(cacheDirectory, "Stacked seal cache directory", realRunDirectory);
  for (const name of ["p_aux", "t_aux"]) {
    retainedFiles.push(await retainedFileRecord(
      runDirectory,
      join(cacheDirectory, name),
      `Stacked ${name} auxiliary record`,
    ));
  }
  retained = {
    path: relative(runDirectory, cacheDirectory),
    files: retainedFiles,
  };

  await addRegularFileIfPresent(join(workDirectory, "staged.dat"), "Stacked staged-sector");
  await addRegularFileIfPresent(join(workDirectory, "sealed.dat"), "Stacked sealed-sector");
  for (const entry of await readdir(cacheDirectory, { withFileTypes: true })) {
    if (!entry.name.endsWith(".dat")) continue;
    const path = join(cacheDirectory, entry.name);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      die(`refusing unexpected Stacked seal cache entry: ${path}`);
    }
    removalCandidates.push({ path, metadata: await lstat(path) });
  }

  const parameterCacheDirectory = join(runDirectory, "stacked-proof-parameter-cache");
  const parameterCacheMetadata = await lstat(parameterCacheDirectory).catch(() => null);
  if (parameterCacheMetadata) {
    const collected = await collectDirectoryFiles(
      realRunDirectory,
      parameterCacheDirectory,
      "isolated Stacked proof parameter cache",
    );
    removalCandidates.push(...collected.files);
    removedDirectories.push(...collected.directories);
  }
}
removalCandidates.sort((left, right) => left.path.localeCompare(right.path));

const removedFiles = removalCandidates.map(({ path, metadata }) =>
  fileRecord(runDirectory, path, metadata));
const totalLogicalBytes = removedFiles.reduce((total, file) => total + file.logical_bytes, 0);
const allocatedValues = removedFiles.map((file) => file.allocated_bytes);
const totalAllocatedBytes = allocatedValues.every(Number.isFinite)
  ? allocatedValues.reduce((total, bytes) => total + bytes, 0)
  : null;
const manifestPath = join(runDirectory, "cleanup.json");
const baseManifest = {
  schema_version: 1,
  cleanup_kind: cleanupKind,
  backend,
  run_directory: basename(runDirectory),
  retained,
  retained_files: retainedFiles,
  removed_files: removedFiles,
  removed_directories: removedDirectories
    .map((path) => relative(runDirectory, path))
    .sort(),
  removed_logical_bytes: totalLogicalBytes,
  removed_allocated_bytes: totalAllocatedBytes,
};

await writeManifest(manifestPath, {
  ...baseManifest,
  status: "in_progress",
  started_at_utc: new Date().toISOString(),
});
for (const { path } of removalCandidates) await unlink(path);
for (const path of removedDirectories.sort((left, right) => right.length - left.length)) {
  await rmdir(path);
}

const prewarmWorkDirectory = join(runDirectory, "prewarm-work");
let removedEmptyPrewarmWorkDirectory = false;
try {
  await rmdir(prewarmWorkDirectory);
  removedEmptyPrewarmWorkDirectory = true;
} catch (error) {
  if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
}

const completedManifest = {
  ...baseManifest,
  status: "completed",
  completed_at_utc: new Date().toISOString(),
  removed_empty_prewarm_work_directory: removedEmptyPrewarmWorkDirectory,
};
await writeManifest(manifestPath, completedManifest);
process.stdout.write(`${JSON.stringify(completedManifest)}\n`);
