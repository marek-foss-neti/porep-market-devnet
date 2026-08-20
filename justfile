set dotenv-load := false

bootstrap:
    @bash scripts/bootstrap.sh

build:
    @bash scripts/devnet-build.sh

build-contracts:
    @bash scripts/contracts-build.sh

test-contracts source='':
    @bash scripts/contracts-test-target.sh '{{source}}'

up backend='stacked' sector_size='8mib':
    @bash scripts/devnet-up.sh '{{backend}}' '{{sector_size}}'

status:
    @bash scripts/devnet-status.sh

deploy source='':
    @bash scripts/devnet-deploy.sh '{{source}}'

use-deployment deployment revision='latest':
    @bash scripts/devnet-use-deployment.sh '{{deployment}}' '{{revision}}'

upgrade deployment contracts source='':
    @bash scripts/devnet-upgrade.sh '{{deployment}}' '{{source}}' '{{contracts}}'

test-upgrade deployment contracts source='':
    @bash scripts/devnet-test-upgrade.sh '{{deployment}}' '{{source}}' '{{contracts}}'

addresses deployment='active':
    @bash scripts/devnet-addresses.sh '{{deployment}}'

tooling-env deployment='active':
    @bash scripts/devnet-addresses.sh '{{deployment}}' tooling-env

test-unit:
    @node scripts/run-with-timeout.mjs --timeout-ms 60000 -- npm --prefix tools run typecheck
    @node scripts/run-with-timeout.mjs --timeout-ms 600000 -- npm --prefix tools test
    @node scripts/run-with-timeout.mjs --timeout-ms 60000 -- npm --prefix e2e run typecheck
    @node scripts/run-with-timeout.mjs --timeout-ms 600000 -- npm --prefix e2e run test:unit
    @node scripts/run-with-timeout.mjs --timeout-ms 60000 -- bash scripts/static-checks.sh

test-seal-unseal deployment='active' resume='':
    @SEAL_UNSEAL_RESUME_RUN_DIR='{{resume}}' just test-scenario seal-unseal-roundtrip '{{deployment}}'

test-deliver-seal-unseal-retrieval deployment='active':
    @just test-scenario deliver-seal-unseal-retrieval '{{deployment}}'

bench-deliver-seal-unseal-retrieval deployment='active':
    @just test-scenario bench-deliver-seal-unseal-retrieval '{{deployment}}' 14400000

bench-seal-unseal deployment='active':
    @just test-scenario bench-seal-unseal '{{deployment}}' 14400000

bench-retrieval mode='both' deployment='active':
    @RETRIEVAL_BENCH_MODE='{{mode}}' just test-scenario bench-retrieval '{{deployment}}' 14400000

bench-proof-micro backend='stacked' sector_size='8mib':
    @bash scripts/bench-proof-micro.sh '{{backend}}' '{{sector_size}}'

bench-proof-micro-prepare-fixture backend='stacked' sector_size='8mib' fixture='':
    @bash scripts/bench-proof-micro.sh '{{backend}}' '{{sector_size}}' prepare-fixture '{{fixture}}'

bench-proof-micro-unseal backend='stacked' sector_size='8mib' fixture='':
    @bash scripts/bench-proof-micro.sh '{{backend}}' '{{sector_size}}' unseal-only '{{fixture}}'

bench-proof-micro-backends sector_size='8mib':
    @bash scripts/bench-proof-micro.sh zigzag '{{sector_size}}'
    @bash scripts/bench-proof-micro.sh stacked '{{sector_size}}'

bench-proof-micro-unseal-backends sector_size='8mib':
    @bash scripts/bench-proof-micro.sh zigzag '{{sector_size}}' unseal-only
    @bash scripts/bench-proof-micro.sh stacked '{{sector_size}}' unseal-only

test-scenario name deployment='active' timeout_ms='7200000':
    @bash scripts/devnet-use-deployment.sh '{{deployment}}' latest
    @node scripts/run-with-timeout.mjs --timeout-ms '{{timeout_ms}}' -- npm --prefix e2e run scenario -- '{{name}}'

test-e2e suite='contract' deployment='active':
    @bash scripts/devnet-use-deployment.sh '{{deployment}}' latest
    @node scripts/run-with-timeout.mjs --timeout-ms 43200000 -- npm --prefix e2e run matrix -- '{{suite}}'

bench-proof-backends sector_size='8mib':
    @bash scripts/bench-proof-backends.sh '{{sector_size}}'

verify-runtime:
    @npm --prefix tools run cli -- runtime lock verify
    @bash scripts/devnet-status.sh

test-all source='' suite='contract':
    @just bootstrap
    @just build
    @just test-unit
    @just test-contracts '{{source}}'
    @just deploy '{{source}}'
    @just test-e2e '{{suite}}'

test-fresh:
    @just bootstrap
    @just build
    @just test-unit
    @just test-contracts
    @just reset
    @just deploy
    @just test-e2e contract
    @just test-e2e curio
    @just verify-runtime

logs service='':
    @bash scripts/devnet-logs.sh '{{service}}'

down:
    @bash scripts/devnet-down.sh

reset backend='stacked' sector_size='8mib':
    @bash scripts/devnet-reset.sh '{{backend}}' '{{sector_size}}'
    @bash scripts/devnet-up.sh '{{backend}}' '{{sector_size}}'
