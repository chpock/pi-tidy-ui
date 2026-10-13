#!/usr/bin/env bash
set -euo pipefail

RUST_TARGET="${1:?Expected native GNU Rust target}"
case "$RUST_TARGET" in
  x86_64-unknown-linux-gnu) architecture=x86_64; docker_arch=amd64 ;;
  aarch64-unknown-linux-gnu) architecture=aarch64; docker_arch=arm64 ;;
  *) printf 'Unsupported GNU target: %s\n' "$RUST_TARGET" >&2; exit 1 ;;
esac
if [[ "$(uname -m)" != "$architecture" ]]; then
  printf 'GNU baseline checks require a native %s host\n' "$architecture" >&2
  exit 1
fi
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
rust_sysroot="$(rustc --print sysroot)"
node_path="$(node -p 'if (process.version !== "v22.19.0") throw new Error("GNU gate requires official Node 22.19.0"); process.execPath')"
node_root="$(cd "$(dirname "$node_path")/.." && pwd)"
cargo_home="$(cd "${CARGO_HOME:-$HOME/.cargo}" && pwd)"
target_dir="${CARGO_TARGET_DIR:-$root/target}"
mkdir -p "$target_dir"
target_dir="$(cd "$target_dir" && pwd)"
image="occipital-gnu228-$docker_arch"

# Imported images need inline metadata and --cache-from on a fresh builder:
# reuse the slow package-install layer while still evaluating the current recipe.
cache_args=(--build-arg BUILDKIT_INLINE_CACHE=1)
if docker image inspect "$image" >/dev/null 2>&1; then
  cache_args+=(--cache-from "$image")
fi
docker build "${cache_args[@]}" --platform "linux/$docker_arch" --tag "$image" \
  --file "$root/scripts/release/Dockerfile.linux-gnu" "$root/scripts/release"
# Cargo prioritizes Cargo-home proxies; keep their toolchain identical to the mounted SDK.
docker run --rm --platform "linux/$docker_arch" --network=none --user "$(id -u):$(id -g)" \
  -v "$root:$root" -v "$rust_sysroot:$rust_sysroot:ro" \
  -v "$node_root:$node_root:ro" -v "$cargo_home:$cargo_home" -v "$target_dir:$target_dir" \
  --workdir "$root" --env HOME=/tmp/occipital-gnu-home \
  --env CARGO_HOME="$cargo_home" --env CARGO_TARGET_DIR="$target_dir" --env CARGO_NET_OFFLINE=true \
  --env RUSTUP_TOOLCHAIN="$rust_sysroot" \
  --env PATH="$rust_sysroot/bin:$node_root/bin:/usr/bin:/bin" \
  --env RUST_TARGET="$RUST_TARGET" --env EXPECTED_ARCHITECTURE="$architecture" \
  "$image" bash -euo pipefail -c '
    mkdir -p "$HOME"
    test "$(uname -m)" = "$EXPECTED_ARCHITECTURE"
    test "$(getconf GNU_LIBC_VERSION)" = "glibc 2.28"
    getconf GNU_LIBC_VERSION
    rustc --version
    node --version
    exec make _gnu-native RUST_TARGET="$RUST_TARGET"
  '
