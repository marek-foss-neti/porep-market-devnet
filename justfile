set dotenv-load := false

bootstrap:
    @bash scripts/bootstrap.sh

build:
    @bash scripts/devnet-build.sh

build-contracts:
    @bash scripts/contracts-build.sh

test-contracts source='':
    @bash scripts/contracts-test-target.sh '{{source}}'

up:
    @bash scripts/devnet-up.sh

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

test-scenario name deployment='active':
    @bash scripts/devnet-use-deployment.sh '{{deployment}}' latest
    @node scripts/run-with-timeout.mjs --timeout-ms 7200000 -- npm --prefix e2e run scenario -- '{{name}}'

test-e2e suite='contract' deployment='active':
    @bash scripts/devnet-use-deployment.sh '{{deployment}}' latest
    @node scripts/run-with-timeout.mjs --timeout-ms 43200000 -- npm --prefix e2e run matrix -- '{{suite}}'

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

reset:
    @bash scripts/devnet-reset.sh
    @bash scripts/devnet-up.sh
