#!/usr/bin/env bash
set -euo pipefail

script_directory="${BASH_SOURCE[0]%/*}"
repository_root="$(cd -- "$script_directory/.." && pwd -P)"

bootstrap_install_system_deps="${BOOTSTRAP_INSTALL_SYSTEM_DEPS:-auto}"
bootstrap_docker_data_root="${BOOTSTRAP_DOCKER_DATA_ROOT:-}"
bootstrap_docker_log_driver="${BOOTSTRAP_DOCKER_LOG_DRIVER:-local}"
bootstrap_configure_docker_group="${BOOTSTRAP_CONFIGURE_DOCKER_GROUP:-1}"
bootstrap_docker_socket_acl="${BOOTSTRAP_DOCKER_SOCKET_ACL:-1}"
bootstrap_require_microbench32="${BOOTSTRAP_REQUIRE_32GIB_MICROBENCH:-0}"
bootstrap_microbench32_min_cpus="${BOOTSTRAP_MICROBENCH32_MIN_CPUS:-32}"
bootstrap_microbench32_min_memory_bytes="${BOOTSTRAP_MICROBENCH32_MIN_MEMORY_BYTES:-193273528320}"
bootstrap_microbench32_min_repo_free_bytes="${BOOTSTRAP_MICROBENCH32_MIN_REPO_FREE_BYTES:-2199023255552}"
bootstrap_microbench32_min_docker_free_bytes="${BOOTSTRAP_MICROBENCH32_MIN_DOCKER_FREE_BYTES:-214748364800}"
apt_updated=0
docker_daemon_needs_restart=0

progress() {
  printf '[bootstrap] %s\n' "$*" >&2
}

warn() {
  printf '[bootstrap] warning: %s\n' "$*" >&2
}

die() {
  printf '[bootstrap] error: %s\n' "$*" >&2
  exit 1
}

have_command() {
  command -v "$1" >/dev/null 2>&1
}

require_command() {
  have_command "$1" || die "required command not found on PATH: $1"
}

bool_is_enabled() {
  local value
  value="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
  case "$value" in
    1|true|yes|on) return 0 ;;
    0|false|no|off|'') return 1 ;;
    *) die "invalid boolean value: ${1}" ;;
  esac
}

is_debian_linux() {
  [[ "$(uname -s)" == Linux ]] || return 1
  [[ -r /etc/os-release ]] || return 1
  (
    # shellcheck disable=SC1091
    . /etc/os-release
    [[ "${ID:-}" == debian || " ${ID_LIKE:-} " == *" debian "* ]]
  )
}

can_install_system_deps() {
  case "${bootstrap_install_system_deps}" in
    1|true|yes|on) return 0 ;;
    0|false|no|off) return 1 ;;
    auto|'') is_debian_linux ;;
    *) die "invalid BOOTSTRAP_INSTALL_SYSTEM_DEPS=${bootstrap_install_system_deps}; expected auto, 1, or 0" ;;
  esac
}

run_privileged() {
  if ((EUID == 0)); then
    "$@"
  elif have_command sudo; then
    sudo "$@"
  else
    die "root privileges are required; rerun as root or install sudo"
  fi
}

apt_update_once() {
  ((apt_updated == 1)) && return 0
  progress "updating apt package indexes"
  run_privileged apt-get update
  apt_updated=1
}

apt_install() {
  apt_update_once
  progress "installing apt packages: $*"
  run_privileged env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@"
}

install_debian_base_packages() {
  apt_install \
    acl \
    apt-transport-https \
    ca-certificates \
    coreutils \
    curl \
    findutils \
    gawk \
    git \
    gnupg \
    grep \
    gzip \
    jq \
    lsof \
    make \
    openssh-client \
    perl \
    procps \
    sed \
    tar \
    unzip \
    util-linux \
    xz-utils
}

lock_node_version() {
  awk '
    /^build_tools:/ { in_build_tools = 1; next }
    in_build_tools && /^  node:/ { in_node = 1; next }
    in_node && /^    version:/ { print $2; exit }
  ' "${repository_root}/versions.lock.yaml"
}

lock_npm_version() {
  awk '
    /^build_tools:/ { in_build_tools = 1; next }
    in_build_tools && /^  npm:/ { in_npm = 1; next }
    in_npm && /^    version:/ { print $2; exit }
  ' "${repository_root}/versions.lock.yaml"
}

node_download_arch() {
  case "$(uname -m)" in
    x86_64|amd64) printf 'x64\n' ;;
    aarch64|arm64) printf 'arm64\n' ;;
    *) die "unsupported Node.js binary architecture: $(uname -m)" ;;
  esac
}

install_node_from_official_tarball() {
  local version node_arch dist archive install_dir tmp checksum_line
  version="$1"
  node_arch="$(node_download_arch)"
  dist="node-v${version}-linux-${node_arch}"
  archive="${dist}.tar.xz"
  install_dir="/usr/local/lib/${dist}"

  if [[ -x "${install_dir}/bin/node" ]]; then
    progress "Node.js ${version} already installed at ${install_dir}"
  else
    if [[ -e "${install_dir}" ]]; then
      run_privileged mv -- "${install_dir}" "${install_dir}.broken.$(date -u +%Y%m%dT%H%M%SZ)"
    fi
    tmp="$(mktemp -d)"
    (
      trap 'rm -rf "${tmp}"' EXIT
      progress "downloading Node.js ${version} official linux-${node_arch} tarball"
      curl -fsSL "https://nodejs.org/dist/v${version}/${archive}" -o "${tmp}/${archive}"
      curl -fsSL "https://nodejs.org/dist/v${version}/SHASUMS256.txt" -o "${tmp}/SHASUMS256.txt"
      checksum_line="$(grep -F " ${archive}" "${tmp}/SHASUMS256.txt" || true)"
      [[ -n "${checksum_line}" ]] || die "Node.js checksum entry missing for ${archive}"
      printf '%s\n' "${checksum_line}" > "${tmp}/${archive}.sha256"
      (
        cd "${tmp}"
        sha256sum -c "${archive}.sha256"
      )
      run_privileged install -d -m 0755 /usr/local/lib
      run_privileged tar -xJf "${tmp}/${archive}" -C /usr/local/lib
    )
  fi

  for binary in node npm npx corepack; do
    if [[ -x "${install_dir}/bin/${binary}" ]]; then
      run_privileged ln -sfn "${install_dir}/bin/${binary}" "/usr/local/bin/${binary}"
    fi
  done
  hash -r
}

ensure_node_and_npm() {
  local expected_node expected_npm node_major npm_version
  expected_node="$(lock_node_version)"
  expected_npm="$(lock_npm_version)"
  [[ "${expected_node}" =~ ^[0-9]+[.][0-9]+[.][0-9]+$ ]] ||
    die "could not read build_tools.node.version from versions.lock.yaml"

  if have_command node && have_command npm; then
    node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
    if [[ "${node_major}" =~ ^[0-9]+$ ]] && ((node_major >= 20)); then
      if [[ "${expected_npm}" =~ ^[0-9]+[.][0-9]+[.][0-9]+$ ]] && can_install_system_deps && is_debian_linux; then
        npm_version="$(npm -v)"
        if [[ "${npm_version}" != "${expected_npm}" ]]; then
          progress "aligning npm ${npm_version} to locked npm ${expected_npm}"
          run_privileged env PATH="/usr/local/bin:${PATH}" npm install -g "npm@${expected_npm}"
          hash -r
        fi
      fi
      progress "Node.js $(node -v) and npm $(npm -v) are available"
      return 0
    fi
  fi

  if can_install_system_deps && is_debian_linux; then
    install_node_from_official_tarball "${expected_node}"
  else
    require_command node
    require_command npm
  fi

  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  [[ "${node_major}" =~ ^[0-9]+$ ]] && ((node_major >= 20)) ||
    die "bootstrap requires Node.js 20 or newer"

  if [[ "${expected_npm}" =~ ^[0-9]+[.][0-9]+[.][0-9]+$ ]]; then
    npm_version="$(npm -v)"
    if [[ "${npm_version}" != "${expected_npm}" ]]; then
      progress "aligning npm ${npm_version} to locked npm ${expected_npm}"
      run_privileged env PATH="/usr/local/bin:${PATH}" npm install -g "npm@${expected_npm}"
      hash -r
    fi
  fi

  progress "Node.js $(node -v) and npm $(npm -v) are ready"
}

install_just_from_release() {
  local version target archive tmp
  version="${BOOTSTRAP_JUST_VERSION:-1.46.0}"
  case "$(uname -m)" in
    x86_64|amd64) target="x86_64-unknown-linux-musl" ;;
    aarch64|arm64) target="aarch64-unknown-linux-musl" ;;
    *) die "unsupported just binary architecture: $(uname -m)" ;;
  esac
  archive="just-${version}-${target}.tar.gz"
  tmp="$(mktemp -d)"
  (
    trap 'rm -rf "${tmp}"' EXIT
    progress "downloading just ${version} for ${target}"
    curl -fsSL "https://github.com/casey/just/releases/download/${version}/${archive}" -o "${tmp}/${archive}"
    tar -xzf "${tmp}/${archive}" -C "${tmp}" just
    run_privileged install -m 0755 "${tmp}/just" /usr/local/bin/just
  )
}

ensure_just() {
  if have_command just; then
    progress "$(just --version) is available"
    return 0
  fi

  if can_install_system_deps && is_debian_linux; then
    apt_update_once
    if apt-cache show just >/dev/null 2>&1; then
      apt_install just
    else
      install_just_from_release
    fi
  fi

  require_command just
  progress "$(just --version) is ready"
}

debian_codename() {
  if [[ -n "${BOOTSTRAP_DEBIAN_CODENAME:-}" ]]; then
    printf '%s\n' "${BOOTSTRAP_DEBIAN_CODENAME}"
    return 0
  fi
  # shellcheck disable=SC1091
  . /etc/os-release
  [[ -n "${VERSION_CODENAME:-}" ]] || die "Debian VERSION_CODENAME is missing; set BOOTSTRAP_DEBIAN_CODENAME"
  printf '%s\n' "${VERSION_CODENAME}"
}

install_docker_apt_repository() {
  local tmp sources_file architecture codename
  architecture="$(dpkg --print-architecture)"
  codename="$(debian_codename)"
  tmp="$(mktemp -d)"
  (
    trap 'rm -rf "${tmp}"' EXIT
    progress "configuring Docker apt repository for Debian ${codename}/${architecture}"
    curl -fsSL https://download.docker.com/linux/debian/gpg -o "${tmp}/docker.asc"
    run_privileged install -D -m 0644 "${tmp}/docker.asc" /etc/apt/keyrings/docker.asc
    sources_file="${tmp}/docker.sources"
    {
      printf 'Types: deb\n'
      printf 'URIs: https://download.docker.com/linux/debian\n'
      printf 'Suites: %s\n' "${codename}"
      printf 'Components: stable\n'
      printf 'Architectures: %s\n' "${architecture}"
      printf 'Signed-By: /etc/apt/keyrings/docker.asc\n'
    } > "${sources_file}"
    run_privileged install -D -m 0644 "${sources_file}" /etc/apt/sources.list.d/docker.sources
  )
  apt_updated=0
  apt_update_once
}

configure_docker_daemon_json() {
  local tmp current desired data_root_changed
  [[ -n "${bootstrap_docker_data_root}" || -n "${bootstrap_docker_log_driver}" ]] || return 0
  require_command jq
  tmp="$(mktemp -d)"
  run_privileged install -d -m 0755 /etc/docker
  current="${tmp}/daemon.current.json"
  desired="${tmp}/daemon.desired.json"
  if [[ -f /etc/docker/daemon.json ]]; then
    cp /etc/docker/daemon.json "${current}"
  else
    printf '{}\n' > "${current}"
  fi

  data_root_changed=0
  if [[ -n "${bootstrap_docker_data_root}" ]]; then
    run_privileged install -d -m 0711 "${bootstrap_docker_data_root}"
    jq \
      --arg logDriver "${bootstrap_docker_log_driver}" \
      --arg dataRoot "${bootstrap_docker_data_root}" \
      '
        (if $logDriver == "" or has("log-driver") then . else . + {"log-driver": $logDriver} end)
        | . + {"data-root": $dataRoot}
      ' "${current}" > "${desired}"
    data_root_changed=1
  else
    jq \
      --arg logDriver "${bootstrap_docker_log_driver}" \
      '
        if $logDriver == "" or has("log-driver") then .
        else . + {"log-driver": $logDriver}
        end
      ' "${current}" > "${desired}"
  fi

  if ! cmp -s "${current}" "${desired}"; then
    run_privileged install -m 0644 "${desired}" /etc/docker/daemon.json
    docker_daemon_needs_restart=1
    if ((data_root_changed == 1)); then
      warn "Docker data-root set to ${bootstrap_docker_data_root}; existing Docker data is not migrated"
    else
      progress "Docker daemon log driver configured in /etc/docker/daemon.json"
    fi
  fi
  rm -rf "${tmp}"
}

start_or_restart_docker() {
  if have_command systemctl; then
    if ((docker_daemon_needs_restart == 1)); then
      progress "restarting Docker daemon"
      run_privileged systemctl restart docker.service
    else
      progress "starting Docker daemon"
      run_privileged systemctl enable --now docker.service
      run_privileged systemctl enable containerd.service >/dev/null 2>&1 || true
    fi
  elif have_command service; then
    run_privileged service docker start
  fi
}

install_docker_engine_debian() {
  local conflicts
  if have_command docker && docker compose version >/dev/null 2>&1 && docker buildx version >/dev/null 2>&1; then
    progress "Docker CLI, compose plugin, and buildx plugin are available"
  else
    conflicts=(docker.io docker-compose docker-doc docker-buildx podman-docker containerd runc)
    apt_update_once
    progress "removing Debian Docker packages that conflict with Docker Engine, if present"
    run_privileged env DEBIAN_FRONTEND=noninteractive apt-get remove -y "${conflicts[@]}" || true
    install_docker_apt_repository
    apt_install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  fi

  configure_docker_daemon_json
  start_or_restart_docker
}

configure_docker_access() {
  local current_user
  docker info >/dev/null 2>&1 && return 0
  ((EUID != 0)) || return 0
  bool_is_enabled "${bootstrap_configure_docker_group}" || return 0

  current_user="$(id -un)"
  if ! getent group docker >/dev/null; then
    progress "creating docker group"
    run_privileged groupadd docker
  fi
  progress "adding ${current_user} to docker group"
  run_privileged usermod -aG docker "${current_user}"

  if bool_is_enabled "${bootstrap_docker_socket_acl}" && have_command setfacl && [[ -S /var/run/docker.sock ]]; then
    progress "granting current shell temporary Docker socket access via ACL"
    run_privileged setfacl -m "u:${current_user}:rw" /var/run/docker.sock || true
  fi
}

ensure_docker_ready() {
  install_docker_engine_debian
  configure_docker_access

  if ! docker info >/dev/null 2>&1; then
    die "Docker is installed but this shell cannot access it; run 'newgrp docker' or reconnect to the VPS"
  fi
  docker compose version >/dev/null 2>&1 || die "docker compose plugin is not available"
  docker buildx version >/dev/null 2>&1 || die "docker buildx plugin is not available"

  if ! docker buildx inspect >/dev/null 2>&1; then
    progress "creating Docker buildx builder"
    docker buildx create --use --name porep-market-builder >/dev/null
  fi
  docker buildx inspect --bootstrap >/dev/null
  progress "Docker $(docker version --format '{{.Server.Version}}') is ready with compose and buildx"
}

run_with_timeout() {
  local timeout_ms="$1"
  shift
  node "$repository_root/scripts/run-with-timeout.mjs" --timeout-ms "$timeout_ms" -- "$@"
}

format_bytes() {
  local bytes="${1:-0}"
  awk -v bytes="${bytes}" 'BEGIN {
    if (bytes < 1024) {
      printf "%d B", bytes
    } else if (bytes < 1048576) {
      printf "%.1f KiB", bytes / 1024
    } else if (bytes < 1073741824) {
      printf "%.1f MiB", bytes / 1048576
    } else if (bytes < 1099511627776) {
      printf "%.1f GiB", bytes / 1073741824
    } else {
      printf "%.1f TiB", bytes / 1099511627776
    }
  }'
}

free_bytes_for_path() {
  local path="$1"
  df -Pk "${path}" | awk 'NR == 2 { printf "%.0f\n", $4 * 1024 }'
}

check_resource_floor() {
  local label actual minimum
  label="$1"
  actual="$2"
  minimum="$3"
  [[ "${actual}" =~ ^[0-9]+$ && "${minimum}" =~ ^[0-9]+$ ]] || return 0
  if ((actual < minimum)); then
    if bool_is_enabled "${bootstrap_require_microbench32}"; then
      die "${label} ${actual} is below recommended 32GiB microbench floor ${minimum}"
    else
      warn "${label} $(format_bytes "${actual}") is below recommended 32GiB microbench floor $(format_bytes "${minimum}")"
    fi
  fi
}

report_host_preflight() {
  local docker_cpus docker_memory docker_root docker_root_free repo_free storage_driver compose_version buildx_version
  require_command docker
  docker_cpus="$(docker info --format '{{.NCPU}}')"
  docker_memory="$(docker info --format '{{.MemTotal}}')"
  docker_root="$(docker info --format '{{.DockerRootDir}}')"
  storage_driver="$(docker info --format '{{.Driver}}')"
  docker_root_free="$(free_bytes_for_path "${docker_root}")"
  repo_free="$(free_bytes_for_path "${repository_root}")"
  compose_version="$(docker compose version --short 2>/dev/null || docker compose version)"
  buildx_version="$(docker buildx version | awk '{print $2}')"

  progress "host: arch=$(uname -m) cpus=${docker_cpus} memory=$(format_bytes "${docker_memory}") repo_free=$(format_bytes "${repo_free}")"
  progress "docker: root=${docker_root} root_free=$(format_bytes "${docker_root_free}") storage=${storage_driver} compose=${compose_version} buildx=${buildx_version}"

  check_resource_floor "Docker CPUs" "${docker_cpus}" "${bootstrap_microbench32_min_cpus}"
  check_resource_floor "Docker memory" "${docker_memory}" "${bootstrap_microbench32_min_memory_bytes}"
  check_resource_floor "repository filesystem free space" "${repo_free}" "${bootstrap_microbench32_min_repo_free_bytes}"
  check_resource_floor "Docker root filesystem free space" "${docker_root_free}" "${bootstrap_microbench32_min_docker_free_bytes}"
}

main() {
  local verified_sources
  progress "starting bootstrap in ${repository_root}"

  if can_install_system_deps; then
    is_debian_linux || die "automatic system dependency installation is supported only on Debian-like Linux hosts"
    install_debian_base_packages
  else
    progress "system dependency installation disabled; checking existing host tools"
  fi

  ensure_node_and_npm
  ensure_just
  require_command git
  require_command jq
  require_command lsof
  require_command shasum

  if can_install_system_deps && is_debian_linux; then
    ensure_docker_ready
    report_host_preflight
  else
    require_command docker
  fi

  progress "installing Node packages"
  run_with_timeout 600000 npm ci --prefix "$repository_root/tools" >/dev/null
  run_with_timeout 600000 npm ci --prefix "$repository_root/e2e" >/dev/null

  progress "verifying lockfile and fetching managed sources"
  run_with_timeout 60000 npm --prefix "$repository_root/tools" run cli -- lock verify >/dev/null
  run_with_timeout 1200000 npm --prefix "$repository_root/tools" run cli -- sources fetch >/dev/null
  verified_sources="$(run_with_timeout 300000 npm --prefix "$repository_root/tools" run cli -- sources verify)"

  while IFS=$'\t' read -r name managed_path expected_commit actual_commit _; do
    if [[ -n "$actual_commit" ]]; then
      printf '%s\t%s\t%s\n' "$name" "$actual_commit" "$managed_path"
    fi
  done <<< "$verified_sources"

  progress "bootstrap complete"
}

main "$@"
