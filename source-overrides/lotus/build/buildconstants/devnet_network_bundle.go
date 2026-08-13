//go:build debug || 2k

package buildconstants

import "os"

func init() {
	bundle := os.Getenv("LOTUS_DEVNET_NETWORK_BUNDLE")
	switch bundle {
	case "":
		return
	case "devnet", "testing":
		NetworkBundle = bundle
	default:
		log.Panicf("unsupported LOTUS_DEVNET_NETWORK_BUNDLE: %s", bundle)
	}
}
