#!/usr/bin/env bash
set -euo pipefail
exec bash "$(cd -L "$(dirname "${BASH_SOURCE[0]}")" && pwd -L)/bench-zigzag.sh" 512mib "$@"
