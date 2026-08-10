import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parse, stringify } from "yaml";

import { loadVersionLock } from "../src/lock.js";
import { loadRuntimeLock } from "../src/runtime-lock.js";
import { run } from "../src/process.js";

const workspaceRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const checkedInLockPath = join(workspaceRoot, "versions.lock.yaml");
const digestPattern = /^sha256:[0-9a-f]{64}$/;

async function withMutatedLock(
  mutate: (lock: Record<string, unknown>) => void,
  runTest: (path: string) => Promise<void>,
): Promise<void> {
  const lock = parse(await readFile(checkedInLockPath, "utf8")) as Record<string, unknown>;
  mutate(lock);
  await withLock(stringify(lock), runTest);
}

async function withLock(contents: string, runTest: (path: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "porep-runtime-lock-"));
  const path = join(directory, "versions.lock.yaml");
  await writeFile(path, contents);
  try {
    await runTest(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function mapping(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

test("runtime lock loads the exact devnet network schedule and actor CIDs", async () => {
  const lock = await loadRuntimeLock(checkedInLockPath);

  assert.equal(lock.selectedAt, "2026-07-28T15:06:39+02:00");
  assert.deepEqual(lock.network, {
    chainId: 31_415_926,
    genesis: {
      networkVersion: 27,
      actorsVersion: 17,
    },
    firehorse: {
      epoch: 20,
      networkVersion: 28,
      actorsVersion: 18,
    },
    actorsV18: {
      manifestCid: "bafy2bzaced35gjxagazf2fne5dakbok5abmivsh7cq7huwfuptebgwjmcpcf6",
      storageMinerActorCid: "bafk2bzacedhvcxgdz2w75izwa5s5dwvsrxsnzkjcbpbresziyrrjrsvjzwvxe",
    },
  });
});

test("runtime lock loads every immutable image index and required platform child", async () => {
  const lock = await loadRuntimeLock(checkedInLockPath);

  assert.deepEqual(
    Object.fromEntries(Object.entries(lock.images).map(([name, image]) => [
      name,
      [
        image.resolvedReference,
        image.platformDigests["linux/amd64"],
        image.platformDigests["linux/arm64"],
      ],
    ])),
    {
      lotus_devnet: [
        "ghcr.io/filecoin-shipyard/lotus-containers:lotus-v1.36.0-devnet@sha256:aeb1de6103a07ee316d45d09141a8063fc67fa99d14289c38fe0f2aeee84f4a9",
        "sha256:731dbcecbc3ba69943076e0eb986da030de1509d92100fb7880bc2f23a869ead",
        "sha256:cce2db8da59446ebc2bcd00743798a9b1833258c55499a5bfbffbec66e7e7afe",
      ],
      yugabyte: [
        "docker.io/yugabytedb/yugabyte:2024.1.0.0-b129@sha256:5074792658b19c1379d79fdfe418d33a6587c2637422f56d0d224d8bbbe277a8",
        "sha256:a1f1302c9d1384f77fd06fd71845a9b10f9450282c440cc903edddf0dc11a458",
        "sha256:21893ba85b5d73105418af430e684452026bcaf0e6af245cc036f68797630ef6",
      ],
      go_builder: [
        "docker.io/library/golang:1.26-trixie@sha256:4ee9ffa999b4583ce281939cdff828763083610292f252279a0cee77473bd9a7",
        "sha256:dbb10bd1b3400ba0858e2f7c354fd4556b782c187feeff52789d4ee156a84db8",
        "sha256:d86488d9077169d6dd4fa32e954e8b68a41e94e32c0ec3d3fefdcc017ac9a759",
      ],
      rust_toolchain: [
        "docker.io/library/rust:1.86.0-slim-bookworm@sha256:57d415bbd61ce11e2d5f73de068103c7bd9f3188dc132c97cef4a8f62989e944",
        "sha256:a044f7ab9a762f95be2ee7eb2c49e4d4a4ec60011210de9f7da01d552cae3a55",
        "sha256:7f059ca8afb64fd4cc2d397ed1dedfe7e5c390c7a923b7cf71cfb281141f1bc3",
      ],
      ubuntu_runtime: [
        "docker.io/library/ubuntu:24.04@sha256:4fbb8e6a8395de5a7550b33509421a2bafbc0aab6c06ba2cef9ebffbc7092d90",
        "sha256:52df9b1ee71626e0088f7d400d5c6b5f7bb916f8f0c82b474289a4ece6cf3faf",
        "sha256:7f622ca8766bccb22f04242ecb6f19f770b2f08827dc4b8c707de5e78a6da7ab",
      ],
      node_runtime: [
        "docker.io/library/node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8",
        "sha256:4bd6219054c8bebcd26a66bfd8ca0bd6e1024b4b97474c59bb7ee3bbcbef4fe8",
        "sha256:b3e8b37cd3102ef30c77d039f15baffe72c18fa23058c6e18b75a2e2faaad2e3",
      ],
      foundry: [
        "ghcr.io/foundry-rs/foundry:v1.7.1@sha256:8347b728d5d393dac1c018691b36f506d23b9dcd78341d40ea0fcb11c3a19cdd",
        "sha256:bdc584033cefab8be282c7f57c263cda42f04700cd1ec88d64bebe2f645aba72",
        "sha256:0c20baa42962751668e464c7853470e3c06e440acfa3b5da5e4766f2742b0cba",
      ],
    },
  );
  for (const image of Object.values(lock.images)) {
    assert.match(image.indexDigest, digestPattern);
    assert.match(image.platformDigests["linux/amd64"], digestPattern);
    assert.match(image.platformDigests["linux/arm64"], digestPattern);
    assert.equal(image.resolvedReference, `${image.reference}@${image.indexDigest}`);
  }
});

test("runtime lock loads exact build tool versions and revisions", async () => {
  const lock = await loadRuntimeLock(checkedInLockPath);

  assert.equal(lock.buildTools.node.version, "24.14.0");
  assert.equal(lock.buildTools.npm.version, "11.9.0");
  assert.deepEqual(
    Object.fromEntries(Object.entries(lock.buildTools.sources).map(([name, tool]) => [name, tool.commit])),
    {
      foundry: "4072e48705af9d93e3c0f6e29e93b5e9a40caed8",
      go_car: "a95c3df95441327b750cc8bfcc74062d6ed3c702",
      piece_server: "1049cc8bd6d727cf7f9f961be2958963abb0a3e9",
      storetheindex: "9c6c25cd958e9d2f0a892bffbd4144eccca372d5",
      go_ethereum: "36a7dc72e96b3f42846be925cfeb2fad18489917",
      blst: "8c7db7fe8d2ce6e76dc398ebd4d475c0ec564355",
    },
  );
});

test("runtime lock exposes BLST v0.3.14 as an exact managed build input", async () => {
  const versionLock = await loadVersionLock(checkedInLockPath);
  const runtimeLock = await loadRuntimeLock(checkedInLockPath);

  assert.deepEqual(versionLock.sources.blst, {
    name: "blst",
    repository: "https://github.com/supranational/blst.git",
    commit: "8c7db7fe8d2ce6e76dc398ebd4d475c0ec564355",
    submodules: {},
  });
  assert.deepEqual(runtimeLock.buildTools.sources.blst, {
    name: "blst",
    repository: "https://github.com/supranational/blst.git",
    tag: "v0.3.14",
    commit: "8c7db7fe8d2ce6e76dc398ebd4d475c0ec564355",
    managedSource: "blst",
    compatibility: "filecoin-ffi Cargo.lock crate blst 0.3.14",
  });
});

test("runtime lock validates BLST shape and cross-references without a second version pin", async () => {
  await withMutatedLock((lock) => {
    mapping(mapping(lock.sources).blst).commit = "main";
  }, async (path) => {
    await assert.rejects(loadRuntimeLock(path), /source blst commit.*40 lowercase/i);
  });

  await withMutatedLock((lock) => {
    mapping(mapping(lock.sources).blst).tag = "v0.3.17";
    mapping(mapping(lock.build_tools).blst).tag = "v0.3.17";
  }, async (path) => {
    await assert.doesNotReject(loadRuntimeLock(path));
  });

  await withMutatedLock((lock) => {
    delete mapping(mapping(lock.build_tools).blst).managed_source;
  }, async (path) => {
    await assert.rejects(loadRuntimeLock(path), /build_tools blst.*managed_source/i);
  });
});

test("runtime lock loads the exact project, seven services, and port bindings", async () => {
  const lock = await loadRuntimeLock(checkedInLockPath);

  assert.equal(lock.runtime.composeProject, "porep-market-curio-devnet");
  assert.deepEqual(lock.runtime.services, [
    "lotus",
    "contracts-bootstrap",
    "lotus-miner",
    "curio",
    "yugabyte",
    "piece-server",
    "indexer",
  ]);
  assert.deepEqual(
    Object.fromEntries(Object.entries(lock.runtime.ports).map(([name, port]) => [
      name,
      [port.service, port.host, port.container],
    ])),
    {
      lotus_rpc: ["lotus", 2234, 1234],
      lotus_miner_api: ["lotus-miner", 22345, 2345],
      curio_api: ["curio", 22300, 12300],
      curio_market: ["curio", 22310, 12310],
      curio_ui: ["curio", 24701, 4701],
      piece_server: ["piece-server", 22320, 12320],
      yugabyte_ysql: ["yugabyte", 25433, 5433],
      yugabyte_ycql: ["yugabyte", 29042, 9042],
      yugabyte_ui: ["yugabyte", 25434, 15433],
      indexer_3000: ["indexer", 23000, 3000],
      indexer_3001: ["indexer", 23001, 3001],
      indexer_3002: ["indexer", 23002, 3002],
      indexer_3003: ["indexer", 23003, 3003],
    },
  );
});

test("runtime lock rejects invalid and floating image digests", async () => {
  await withMutatedLock((lock) => {
    mapping(mapping(lock.images).lotus_devnet).index_digest = "sha256:ABC";
  }, async (path) => {
    await assert.rejects(loadRuntimeLock(path), /lotus_devnet index_digest.*sha256.*64 lowercase/i);
  });

  await withMutatedLock((lock) => {
    delete mapping(mapping(lock.images).go_builder).index_digest;
  }, async (path) => {
    await assert.rejects(loadRuntimeLock(path), /go_builder.*(?:missing field index_digest|index_digest.*sha256)/i);
  });
});

test("runtime lock rejects invalid Docker and OCI image references", async () => {
  const invalidReferences = [
    "https://example.test/repo:",
    "example.test/repo:",
    "https://example.test/repo:tag",
    "example.test//repo:tag",
    "example.test/-repo:tag",
    "example.test/repo..child:tag",
    `example.test/repo:tag@sha256:${"a".repeat(64)}`,
    "example.test/repo:tag?query=fixture",
    "example.test/repo:tag#fragment",
    "example.test\\repo:tag",
    "example.test/repo:latest",
  ];

  for (const reference of invalidReferences) {
    await withMutatedLock((lock) => {
      mapping(mapping(lock.images).go_builder).reference = reference;
    }, async (path) => {
      await assert.rejects(
        loadRuntimeLock(path),
        /go_builder reference.*credential-free tagged Docker\/OCI reference/i,
      );
    });
  }
});

test("runtime lock rejects missing image platform children", async () => {
  await withMutatedLock((lock) => {
    delete mapping(mapping(mapping(lock.images).node_runtime).platforms).linux_arm64;
  }, async (path) => {
    await assert.rejects(loadRuntimeLock(path), /node_runtime platforms.*linux_arm64/i);
  });
});

test("runtime lock rejects duplicate and invalid host ports", async () => {
  await withMutatedLock((lock) => {
    mapping(mapping(mapping(lock.runtime).ports).curio_api).host =
      mapping(mapping(mapping(lock.runtime).ports).lotus_rpc).host;
  }, async (path) => {
    await assert.rejects(loadRuntimeLock(path), /duplicate host port 2234/i);
  });

  await withMutatedLock((lock) => {
    mapping(mapping(mapping(lock.runtime).ports).curio_api).host = 65_536;
  }, async (path) => {
    await assert.rejects(loadRuntimeLock(path), /curio_api host.*1.*65535/i);
  });
});

test("runtime lock rejects an inconsistent network schedule", async () => {
  await withMutatedLock((lock) => {
    mapping(lock.network).required_network_version = 27;
  }, async (path) => {
    await assert.rejects(loadRuntimeLock(path), /required network version.*genesis/i);
  });

  await withMutatedLock((lock) => {
    mapping(lock.network).firehorse_upgrade_epoch = 0;
  }, async (path) => {
    await assert.rejects(loadRuntimeLock(path), /FireHorse epoch.*positive/i);
  });
});

test("runtime lock rejects invalid actor CIDs", async () => {
  await withMutatedLock((lock) => {
    mapping(mapping(lock.network).actors_v18).manifest_cid = "not-a-cid";
  }, async (path) => {
    await assert.rejects(loadRuntimeLock(path), /actors_v18 manifest_cid.*CID/i);
  });
});

test("runtime lock rejects unsafe YAML shapes, reserved keys, and unknown fields", async () => {
  const checkedIn = await readFile(checkedInLockPath, "utf8");
  await withLock(checkedIn.replace(/^images:$/m, "images: !!set"), async (path) => {
    await assert.rejects(loadRuntimeLock(path), /invalid or unsafe YAML|images must be a plain mapping/i);
  });

  await withLock(checkedIn.replace(/^  ports:$/m, "  ports:\n    __proto__: invalid"), async (path) => {
    await assert.rejects(loadRuntimeLock(path), /reserved runtime port key __proto__/i);
  });

  await withMutatedLock((lock) => {
    lock.unexpected = true;
  }, async (path) => {
    await assert.rejects(loadRuntimeLock(path), /version lock.*unknown field unexpected/i);
  });
});

test("runtime lock rejects unresolved YAML tag warnings", async () => {
  const checkedIn = await readFile(checkedInLockPath, "utf8");
  const warned = checkedIn.replace(
    "repository: https://github.com/CodeWarriorr/curio.git",
    "repository: !runtime-warning https://github.com/CodeWarriorr/curio.git",
  );
  assert.notEqual(warned, checkedIn);

  await withLock(warned, async (path) => {
    await assert.rejects(loadRuntimeLock(path), /contains invalid or unsafe YAML/);
  });
});

test("runtime lock child process never discloses warning source credentials", async () => {
  const checkedIn = await readFile(checkedInLockPath, "utf8");
  const secret = "S3cr3t7d425e63";
  const warned = checkedIn.replace(
    "repository: https://github.com/CodeWarriorr/curio.git",
    `repository: !runtime-warning https://fixture-user:${secret}@example.test/repo.git`,
  );
  assert.notEqual(warned, checkedIn);

  await withLock(warned, async (path) => {
    const toolsRoot = join(workspaceRoot, "tools");
    const loaderUrl = pathToFileURL(join(toolsRoot, "src", "runtime-lock.ts")).href;
    const script = [
      `import(${JSON.stringify(loaderUrl)})`,
      `.then(({ loadRuntimeLock }) => loadRuntimeLock(${JSON.stringify(path)}))`,
      ".then(() => { process.exitCode = 2; })",
      ".catch((error) => {",
      "console.error(error instanceof Error ? error.message : String(error));",
      "process.exitCode = 1;",
      "});",
    ].join("");
    const child = spawnSync(
      join(toolsRoot, "node_modules", ".bin", "tsx"),
      ["--eval", script],
      { cwd: toolsRoot, encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(child.status, 1);
    assert.match(child.stderr, /contains invalid or unsafe YAML/);
    assert.doesNotMatch(child.stdout, new RegExp(secret));
    assert.doesNotMatch(child.stderr, new RegExp(secret));
  });
});

test("runtime lock rejects non-RFC3339 and impossible selected_at timestamps", async () => {
  const invalidTimestamps = [
    "2026",
    "2026-13-01T00:00:00Z",
    "2026-02-30T00:00:00Z",
    "2026-07-24T24:00:00Z",
    "2026-07-24T12:59:16+24:00",
  ];

  for (const selectedAt of invalidTimestamps) {
    await withMutatedLock((lock) => {
      lock.selected_at = selectedAt;
    }, async (path) => {
      await assert.rejects(loadRuntimeLock(path), /selected_at must be a valid RFC3339 timestamp/);
    });
  }
});

test("runtime lock validates service relations while allowing additional services", async () => {
  await withMutatedLock((lock) => {
    const services = mapping(lock.runtime).services as string[];
    services.push("experiment-node");
  }, async (path) => {
    await assert.doesNotReject(loadRuntimeLock(path));
  });

  await withMutatedLock((lock) => {
    mapping(lock.runtime).services = ["lotus"];
  }, async (path) => {
    await assert.rejects(loadRuntimeLock(path), /must reference a runtime service/i);
  });

  await withMutatedLock((lock) => {
    delete mapping(lock.images).foundry;
  }, async (path) => {
    await assert.rejects(loadRuntimeLock(path), /images must exactly contain/i);
  });
});

test("runtime lock verify CLI is credential-free and reports typed public inputs", async () => {
  const toolsRoot = join(workspaceRoot, "tools");
  const result = await run(
    join(toolsRoot, "node_modules", ".bin", "tsx"),
    ["src/cli.ts", "runtime", "lock", "verify"],
    { cwd: toolsRoot, timeoutMs: 10_000 },
  );

  assert.match(result.stdout, /^network\t31415926\tNV27\/actors-v17\tepoch-20=NV28\/actors-v18$/m);
  assert.match(result.stdout, /^image\tlotus_devnet\t.*@sha256:[0-9a-f]{64}\tlinux\/amd64=sha256:/m);
  assert.match(result.stdout, /^tool\tnode\t24\.14\.0$/m);
  assert.match(result.stdout, /^tool\tfoundry\tv1\.7\.1\t4072e48705af9d93e3c0f6e29e93b5e9a40caed8$/m);
  assert.match(
    result.stdout,
    /^tool\tblst\tv0\.3\.14\t8c7db7fe8d2ce6e76dc398ebd4d475c0ec564355\tmanaged-source=blst$/m,
  );
  assert.match(result.stdout, /^runtime\tporep-market-curio-devnet\t7-services\t13-ports$/m);
  assert.match(result.stdout, /^service\tcontracts-bootstrap$/m);
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout + result.stderr, /credentials|password|token|userinfo/i);
});
