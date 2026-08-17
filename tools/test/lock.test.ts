import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadVersionLock, managedSources } from "../src/lock.js";
import { run } from "../src/process.js";

const workspaceRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function withLock(contents: string, runTest: (path: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "porep-lock-"));
  const path = join(directory, "versions.lock.yaml");
  await writeFile(path, contents);
  try {
    await runTest(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("loads the ten checked-in managed sources", async () => {
  const lock = await loadVersionLock(join(workspaceRoot, "versions.lock.yaml"));
  const sources = managedSources(lock);

  assert.equal(sources.length, 10);
  assert.deepEqual(sources.find((source) => source.name === "curio")?.submodules, {
    "extern/filecoin-ffi": "fbe802089480458d730cbce8a3ca83dcd84a4cd1",
    "extern/supraseal/deps/sppark": "73c8a4586b15fc7227f8736d3f31ff6b35d261a4",
  });
  assert.equal(
    sources.find((source) => source.name === "rust_fil_proofs")?.repository,
    "https://github.com/marek-foss-neti/rust-fil-proofs.git",
  );
  assert.equal(
    sources.find((source) => source.name === "rust_fil_proofs")?.commit,
    "7996df427bb3d497677b3b5f8db58c65d6e6ab4b",
  );
});

test("CLI source uses only Node-20-compatible main and path checks", async () => {
  const cliSource = await readFile(join(workspaceRoot, "tools", "src", "cli.ts"), "utf8");

  assert.doesNotMatch(cliSource, /import\.meta\.(?:dirname|main)/);
  assert.match(cliSource, /fileURLToPath\(import\.meta\.url\)/);
  assert.match(cliSource, /pathToFileURL\(resolve\(process\.argv\[1\]\)\)/);
});

test("CLI executes its main module and prints every locked source", async () => {
  const toolsRoot = join(workspaceRoot, "tools");
  const result = await run(
    join(toolsRoot, "node_modules", ".bin", "tsx"),
    ["src/cli.ts", "lock", "verify"],
    { cwd: toolsRoot, timeoutMs: 10_000 },
  );
  const rows = result.stdout.trim().split("\n");

  assert.equal(rows.length, 10);
  assert.ok(rows.every((row) => row.split("\t").length === 3));
  assert.ok(rows.every((row) => row.split("\t")[1] === "locked"));
});

test("rejects an unknown lock schema", async () => {
  await withLock("schema_version: 2\nsources: {}\n", async (path) => {
    await assert.rejects(loadVersionLock(path), /unsupported schema_version 2/);
  });
});

test("rejects an empty source repository", async () => {
  await withLock("schema_version: 1\nsources:\n  curio:\n    repository: ''\n    commit: abc\n", async (path) => {
    await assert.rejects(loadVersionLock(path), /curio.*repository/i);
  });
});

test("rejects a non-pinned commit", async () => {
  await withLock("schema_version: 1\nsources:\n  curio:\n    repository: https://example.test/x.git\n    commit: main\n", async (path) => {
    await assert.rejects(loadVersionLock(path), /curio.*40 lowercase hexadecimal/i);
  });
});

test("rejects HTTPS repository credentials", async () => {
  const commit = "a".repeat(40);
  await withLock(`schema_version: 1\nsources:\n  curio:\n    repository: https://user:password@example.test/x.git\n    commit: ${commit}\n`, async (path) => {
    await assert.rejects(loadVersionLock(path), /curio.*credentials|userinfo/i);
  });
});

test("rejects HTTPS repository query text without echoing it", async () => {
  const commit = "b".repeat(40);
  await withLock(`schema_version: 1\nsources:\n  curio:\n    repository: https://example.test/x.git?token=secret\n    commit: ${commit}\n`, async (path) => {
    await assert.rejects(loadVersionLock(path), (error: Error) => {
      assert.match(error.message, /curio.*query|search/i);
      assert.doesNotMatch(error.message, /token=secret/);
      return true;
    });
  });
});

test("rejects HTTPS repository fragments without echoing them", async () => {
  const commit = "c".repeat(40);
  await withLock(`schema_version: 1\nsources:\n  curio:\n    repository: https://example.test/x.git#secret\n    commit: ${commit}\n`, async (path) => {
    await assert.rejects(loadVersionLock(path), (error: Error) => {
      assert.match(error.message, /curio.*fragment|hash/i);
      assert.doesNotMatch(error.message, /#secret/);
      return true;
    });
  });
});

test("rejects duplicate source checkout paths", async () => {
  const commit = "a".repeat(40);
  await withLock(`schema_version: 1\nsources:\n  one:\n    repository: https://example.test/x.git\n    commit: ${commit}\n  two:\n    repository: https://example.test/x.git\n    commit: ${commit}\n`, async (path) => {
    await assert.rejects(loadVersionLock(path), /duplicate.*repository.*commit/i);
  });
});

test("can explicitly allow local repositories for fixture locks", async () => {
  const commit = "b".repeat(40);
  await withLock(`schema_version: 1\nsources:\n  fixture:\n    repository: /tmp/fixture.git\n    commit: ${commit}\n`, async (path) => {
    const lock = await loadVersionLock(path, { allowLocalRepositories: true });
    assert.equal(managedSources(lock)[0]?.repository, "/tmp/fixture.git");
  });
});

test("rejects a source expressed as a YAML set", async () => {
  await withLock("schema_version: 1\nsources:\n  curio: !!set\n    repository: null\n    commit: null\n", async (path) => {
    await assert.rejects(loadVersionLock(path), /source curio must be a plain mapping/);
  });
});

test("rejects a source expressed as a YAML ordered map", async () => {
  const commit = "c".repeat(40);
  await withLock(`schema_version: 1\nsources:\n  curio: !!omap\n    - repository: https://example.test/x.git\n    - commit: ${commit}\n`, async (path) => {
    await assert.rejects(loadVersionLock(path), /source curio must be a plain mapping/);
  });
});

test("rejects non-plain submodule mappings", async () => {
  const commit = "d".repeat(40);
  await withLock(`schema_version: 1\nsources:\n  curio:\n    repository: https://example.test/x.git\n    commit: ${commit}\n    submodules: !!set\n      child: null\n`, async (path) => {
    await assert.rejects(loadVersionLock(path), /source curio submodules must be a plain mapping/);
  });
});

test("rejects reserved source keys", async () => {
  const commit = "e".repeat(40);
  await withLock(`schema_version: 1\nsources:\n  __proto__:\n    repository: https://example.test/x.git\n    commit: ${commit}\n`, async (path) => {
    await assert.rejects(loadVersionLock(path), /reserved source key __proto__/);
  });
});
