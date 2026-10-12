#!/usr/bin/env bash
set -euo pipefail

rust_target="${1:?Expected native GNU Rust target}"
case "$rust_target" in
  x86_64-unknown-linux-gnu) architecture=x86_64; docker_arch=amd64 ;;
  aarch64-unknown-linux-gnu) architecture=aarch64; docker_arch=arm64 ;;
  *) printf 'Unsupported GNU target: %s\n' "$rust_target" >&2; exit 1 ;;
esac
if [[ "$(uname -m)" != "$architecture" ]]; then
  printf 'GNU installed checks require a native %s host\n' "$architecture" >&2
  exit 1
fi
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
node_version="${EXPECTED_NODE:-$(node -p 'process.version.slice(1)')}"
node_path="$(EXPECTED_NODE="$node_version" node -p 'if (!["v22.19.0", "v26.7.0"].includes(process.version) || process.version !== "v" + process.env.EXPECTED_NODE) throw new Error("Installed GNU gate requires the expected supported official Node distribution"); process.execPath')"
node_root="$(cd "$(dirname "$node_path")/.." && pwd)"
image="occipital-gnu228-$docker_arch"
npm_cache_args=()
if [[ -n "${npm_config_cache:-}" ]]; then
  mkdir -p "$npm_config_cache"
  npm_cache="$(cd "$npm_config_cache" && pwd -P)"
  npm_cache_args=(-v "$npm_cache:$npm_cache" --env "npm_config_cache=$npm_cache")
fi

cache_args=(--build-arg BUILDKIT_INLINE_CACHE=1)
if docker image inspect "$image" >/dev/null 2>&1; then
  cache_args+=(--cache-from "$image")
fi
docker build "${cache_args[@]}" --platform "linux/$docker_arch" --tag "$image" \
  --file "$root/scripts/release/Dockerfile.linux-gnu" "$root/scripts/release"
# Installation and exact public acquisition need networking; native compilation remains separate and offline.
docker run --rm --platform "linux/$docker_arch" --user "$(id -u):$(id -g)" \
  -v "$root:$root" -v "$node_root:$node_root:ro" "${npm_cache_args[@]}" \
  --workdir "$root" --env HOME=/tmp/occipital-installed-home \
  --env EXPECTED_NODE="$node_version" --env EXPECTED_ARCHITECTURE="$architecture" \
  --env UV_THREADPOOL_SIZE \
  --env PATH="$node_root/bin:/usr/bin:/bin" \
  "$image" bash -euo pipefail -c '
    mkdir -p "$HOME"
    test "$(uname -m)" = "$EXPECTED_ARCHITECTURE"
    test "$(getconf GNU_LIBC_VERSION)" = "glibc 2.28"
    getconf GNU_LIBC_VERSION
    node --version
    npm run test:installed-native
  '
