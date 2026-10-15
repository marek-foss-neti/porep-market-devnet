#!/usr/bin/env bash
# Runs inside the dedicated CUDA benchmark container; profiler stdout is not JSON.
set -euo pipefail
umask 0002
run=/bench-run
[[ "${ZIGZAG_GPU_TRACE:-0}" == 1 ]] || exec "$@"
command -v nsys >/dev/null
command -v nvidia-smi >/dev/null
nsys --version > "${run}/nsight-version.txt"
nvidia-smi --query-gpu=uuid,name,memory.total,driver_version --format=csv > "${run}/gpu-device.csv"
monitor=""
cleanup() {
  if [[ -n "${monitor}" ]]; then kill "${monitor}" 2>/dev/null || true; wait "${monitor}" 2>/dev/null || true; fi
}
trap cleanup EXIT
(
  while :; do
    nvidia-smi --query-gpu=timestamp,uuid,memory.used,utilization.gpu --format=csv,noheader,nounits
    sleep 1
  done
) > "${run}/gpu-samples.csv" 2> "${run}/gpu-sampling-errors.log" &
monitor=$!
set +e
nsys profile --trace=cuda --sample=none --cpuctxsw=none --cuda-memory-usage=true \
  --force-overwrite=true --output="${run}/cuda-trace" \
  sh -c '"$@" > /bench-run/summary.json 2> /bench-run/stderr.log; code=$?; printf "%s\n" "$code" > /bench-run/gpu-child-exit.txt; exit "$code"' sh "$@" \
  > "${run}/nsight.log" 2>&1
profiler_status=$?
set -e
cleanup
monitor=""
child_status=1
[[ ! -s "${run}/gpu-child-exit.txt" ]] || read -r child_status < "${run}/gpu-child-exit.txt"
export_status=1
if [[ -s "${run}/cuda-trace.nsys-rep" ]]; then
  if nsys export --type=sqlite --force-overwrite=true --output="${run}/cuda-trace.sqlite" \
    "${run}/cuda-trace.nsys-rep" >> "${run}/nsight.log" 2>&1; then export_status=0; fi
fi
python3 /usr/local/share/zigzag/summarize-gpu.py "${run}" \
  "${profiler_status}" "${export_status}" "${child_status}"
exit "${child_status}"
