#!/usr/bin/env bash
# Run inside the Linux build container, not on the Docker client's host.
# Sourceable for fixture tests; execution configures only the child command.

build_resources_error() {
  printf 'error: build resources: %s\n' "$*" >&2
  return 1
}

build_resources_uint() {
  [[ "$1" =~ ^[0-9]{1,18}$ ]] || build_resources_error "invalid counter: $1"
}

build_resources_workers() {
  [[ "$2" == auto ]] && return 0
  [[ "$2" =~ ^[1-9][0-9]{0,3}$ ]] && (( $2 <= 4096 )) ||
    build_resources_error "$1 must be auto or an integer from 1 to 4096"
}

# Resolve v1 controllers before unified v2 on hybrid systems. Return the visible
# mount and process directory; a namespaced root can itself carry a limit.
build_resources_group() {
  local controller="$1" proc="$2" prefix="$3"
  local id controllers group selected='' unified='' version='' line before after
  local filesystem source options mount_root mount_path relative
  local -a fields
  while IFS=: read -r id controllers group; do
    if [[ ",${controllers}," == *",${controller},"* ]]; then selected="$group"; version=1; fi
    if [[ "$id" == 0 && -z "$controllers" ]]; then unified="$group"; fi
  done < "${proc}/self/cgroup"
  if [[ -z "$selected" && -n "$unified" ]]; then selected="$unified"; version=2; fi
  [[ -n "$selected" ]] || return 0
  [[ "$selected" == /* && "/${selected}/" != *'/../'* && "/${selected}/" != *'/./'* ]] ||
    { build_resources_error 'invalid cgroup membership path'; return 1; }
  while IFS= read -r line; do
    [[ "$line" == *' - '* ]] || continue
    before="${line%% - *}"; after="${line#* - }"
    read -r filesystem source options <<< "$after"
    if [[ "$version" == 2 ]]; then
      [[ "$filesystem" == cgroup2 ]] || continue
    else
      [[ "$filesystem" == cgroup && ",${options}," == *",${controller},"* ]] || continue
    fi
    read -r -a fields <<< "$before"
    ((${#fields[@]} >= 5)) || continue
    mount_root="$(printf '%b' "${fields[3]}")"
    mount_path="$(printf '%b' "${fields[4]}")"
    if [[ "$mount_root" == / ]]; then relative="${selected#/}"
    elif [[ "$selected" == "$mount_root" ]]; then relative=''
    elif [[ "$selected" == "${mount_root}/"* ]]; then relative="${selected#"${mount_root}/"}"
    else continue
    fi
    mount_path="${prefix}${mount_path%/}"
    printf '%s\t%s\t%s\n' "$version" "$mount_path" "${mount_path}${relative:+/$relative}"
    return 0
  done < "${proc}/self/mountinfo"
  build_resources_error "cannot resolve ${controller} cgroup mount"
}

build_resources_detect() {
  local proc="${1:-/proc}" prefix="${2:-}"
  local allowed available_kib record controller version mount current file value period usage bound
  allowed="$(awk '$1 == "Cpus_allowed_list:" {print $2}' "${proc}/self/status")" || return
  [[ "$allowed" =~ ^[0-9]+(-[0-9]+)?(,[0-9]+(-[0-9]+)?)*$ ]] ||
    { build_resources_error 'missing or invalid CPU affinity'; return 1; }
  build_available_cpus="$(awk -v list="$allowed" 'BEGIN {
    n=split(list, spans, ","); total=0;
    for (i=1;i<=n;i++) { k=split(spans[i], pair, "-");
      if (k==2 && pair[2]<pair[1]) exit 1;
      total += k==1 ? 1 : pair[2]-pair[1]+1;
    } print total;
  }')" || return
  available_kib="$(awk '$1 == "MemAvailable:" && $3 == "kB" {print $2}' "${proc}/meminfo")" || return
  build_resources_uint "$available_kib" || return
  build_available_memory_bytes=$((10#$available_kib * 1024))
  for controller in cpu memory; do
    record="$(build_resources_group "$controller" "$proc" "$prefix")" || return
    [[ -n "$record" ]] || continue
    IFS=$'\t' read -r version mount current <<< "$record"
    while :; do
      if [[ "$controller" == cpu ]]; then
        if [[ "$version" == 2 ]]; then
          file="${current}/cpu.max"
          # The real v2 root has no cpu.max or memory.max. Missing files below
          # that root must not discard an already discovered ancestor limit.
          if [[ "$current" == "$mount" && ! -e "$file" ]]; then break; fi
          read -r value period < "$file" || { build_resources_error "cannot read $file"; return 1; }
        else
          value="$(cat "${current}/cpu.cfs_quota_us")" || return
          period="$(cat "${current}/cpu.cfs_period_us")" || return
        fi
        build_resources_uint "$period" || return
        period=$((10#$period))
        ((period > 0)) || { build_resources_error 'zero CPU quota period'; return 1; }
        if [[ "$value" != max && "$value" != -1 ]]; then
          build_resources_uint "$value" || return
          value=$((10#$value))
          ((value > 0)) || { build_resources_error 'zero CPU quota'; return 1; }
          bound=$((value / period)); ((bound > 0)) || bound=1
          if ((bound < build_available_cpus)); then build_available_cpus="$bound"; fi
        fi
      else
        if [[ "$version" == 2 ]]; then file="${current}/memory.max"
        else file="${current}/memory.limit_in_bytes"
        fi
        if [[ "$version" == 2 && "$current" == "$mount" && ! -e "$file" ]]; then break; fi
        value="$(cat "$file")" || return
        if [[ "$value" != max ]]; then
          # v1 represents unlimited memory with a value close to signed 64-bit max.
          [[ "$value" =~ ^[0-9]{1,19}$ ]] || { build_resources_error 'invalid memory limit'; return 1; }
          if ((${#value} < 19)); then
            value=$((10#$value))
            if [[ "$version" == 2 ]]; then file="${current}/memory.current"
            else file="${current}/memory.usage_in_bytes"
            fi
            usage="$(cat "$file")" || return
            build_resources_uint "$usage" || return
            usage=$((10#$usage))
            bound=$((value > usage ? value - usage : 0))
            if ((bound < build_available_memory_bytes)); then build_available_memory_bytes="$bound"; fi
          fi
        fi
      fi
      [[ "$current" != "$mount" ]] || break
      current="${current%/*}"
    done
  done
}

build_resources_select() {
  local branches="$1" jobs="${2-auto}" procs="${3-auto}"
  local cpu_budget memory_budget cpu_jobs memory_jobs automatic
  [[ "$branches" =~ ^[1-9][0-9]?$ ]] || { build_resources_error 'invalid branch count'; return 1; }
  build_resources_workers DEVNET_BUILD_JOBS "$jobs" || return
  build_resources_workers DEVNET_BUILD_GO_PROCS "$procs" || return
  # One CPU for orchestration, 10% RAM (at least 2 GiB) for the OS/linkers.
  # Each possible concurrent branch gets a share, at an estimated 2 GiB/job.
  cpu_budget=$((build_available_cpus > 1 ? build_available_cpus - 1 : 1))
  build_memory_reserve_bytes=$((build_available_memory_bytes / 10))
  if ((build_memory_reserve_bytes < 2147483648)); then build_memory_reserve_bytes=2147483648; fi
  memory_budget=$((build_available_memory_bytes > build_memory_reserve_bytes ? build_available_memory_bytes - build_memory_reserve_bytes : 0))
  cpu_jobs=$((cpu_budget / branches))
  memory_jobs=$((memory_budget / branches / 2147483648))
  automatic="$cpu_jobs"
  if ((memory_jobs < automatic)); then automatic="$memory_jobs"; fi
  ((automatic > 0)) || automatic=1
  if ((automatic > 128)); then automatic=128; fi
  if [[ "$jobs" == auto ]]; then jobs="$automatic"; fi
  if [[ "$procs" == auto ]]; then procs="$automatic"; fi
  export CARGO_BUILD_JOBS="$jobs" GOMAXPROCS="$procs"
  # Bound the number of Go compiler processes too, including nested go builds.
  export GOFLAGS="${GOFLAGS:+${GOFLAGS} }-p=${procs}"
  build_resources_json="{\"available_cpus\":${build_available_cpus},\"available_memory_bytes\":${build_available_memory_bytes},\"memory_reserve_bytes\":${build_memory_reserve_bytes},\"concurrent_branches\":${branches},\"auto_jobs\":${automatic},\"cargo_build_jobs\":${jobs},\"go_max_procs\":${procs}}"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  (($# >= 2)) || { build_resources_error 'usage: build-resources.sh BRANCHES COMMAND [ARGS...]'; exit 1; }
  build_resources_detect
  build_resources_select "$1" "${DEVNET_BUILD_JOBS-auto}" "${DEVNET_BUILD_GO_PROCS-auto}"
  shift
  printf 'build_resources %s\n' "$build_resources_json" >&2
  if [[ "$1" == --print ]]; then printf '%s\n' "$build_resources_json"; exit 0; fi
  exec "$@"
fi
