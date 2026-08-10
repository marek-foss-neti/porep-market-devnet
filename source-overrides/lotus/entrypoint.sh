#!/usr/bin/env bash
set -e

without_zigzag_proofs() {
	env -u FIL_PROOFS_USE_ZIGZAG -u FIL_PROOFS_ZIGZAG_GENERATE_MISSING_PARAMS "$@"
}

if [ ! -f $LOTUS_PATH/.init.params ]; then
	echo Initializing fetch params ...
	lotus fetch-params $SECTOR_SIZE
	touch $LOTUS_PATH/.init.params
	echo Done
fi

if [ ! -f $LOTUS_PATH/.init.genesis ]; then
  pushd $LOTUS_PATH
	echo Generate root-key-1 for FIL plus
  ROOT_KEY_1=`lotus-shed keyinfo new bls`
  echo $ROOT_KEY_1 > rootkey-1
	echo Generate root-key-2 for FIL plus
  ROOT_KEY_2=`lotus-shed keyinfo new bls`
  echo $ROOT_KEY_2 > rootkey-2
  popd

	echo Initializing pre seal ...
	without_zigzag_proofs lotus-seed --sector-dir $GENESIS_PATH pre-seal --sector-size $SECTOR_SIZE --num-sectors 1
	echo Initializing genesis ...
	without_zigzag_proofs lotus-seed --sector-dir $GENESIS_PATH genesis new $LOTUS_PATH/localnet.json
	echo Setting signers ...
  without_zigzag_proofs lotus-seed --sector-dir $GENESIS_PATH genesis set-signers --threshold=2 --signers $ROOT_KEY_1 --signers $ROOT_KEY_2 $LOTUS_PATH/localnet.json
	echo Initializing address ...
	without_zigzag_proofs lotus-seed --sector-dir $GENESIS_PATH genesis add-miner $LOTUS_PATH/localnet.json $GENESIS_PATH/pre-seal-t01000.json
	touch $LOTUS_PATH/.init.genesis
	echo Done
fi

echo Starting lotus deamon ...
exec lotus daemon --lotus-make-genesis=$LOTUS_PATH/devgen.car --genesis-template=$LOTUS_PATH/localnet.json --bootstrap=false
