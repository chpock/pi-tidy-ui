#!/usr/bin/env bash
set -euo pipefail

rust_target="${1:?Expected native GNU Rust target}"
suite="${2:?Expected native, consumer or published-consumer suite}"
preparation="${3:?Supply absolute host preparation directory}"
artifact="${4:?Supply absolute same-commit staged native artifact directory}"
release_ref="${5:-}"
case "$rust_target" in
  x86_64-unknown-linux-gnu) architecture=x86_64; docker_arch=amd64 ;;
  aarch64-unknown-linux-gnu) architecture=aarch64; docker_arch=arm64 ;;
  *) printf 'Unsupported GNU target: %s\n' "$rust_target" >&2; exit 1 ;;
esac
case "$suite" in
  native|consumer) network_args=(--network=none) ;;
  published-consumer)
    case "$release_ref" in refs/tags/pi-tidy-ui-v*) ;; *) printf 'Published verification requires an explicit pi-tidy-ui release ref\n' >&2; exit 1 ;; esac
    network_args=() ;;
  *) printf 'Unsupported GNU suite: %s\n' "$suite" >&2; exit 1 ;;
esac
[[ "$preparation" == /* && "$artifact" == /* ]] || { printf 'Prepared paths must be absolute\n' >&2; exit 1; }
if [[ "$(uname -m)" != "$architecture" ]]; then
  printf 'GNU installed checks require a native %s host\n' "$architecture" >&2
  exit 1
fi
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
node_path="${NODE:?Supply the absolute official Node executable}"
node_version="${EXPECTED_NODE:?Supply the exact expected Node version}"
[[ "$node_path" == /* ]] || { printf 'Node executable must be absolute\n' >&2; exit 1; }
EXPECTED_NODE="$node_version" "$node_path" -e 'if (!["v22.19.0", "v26.7.0"].includes(process.version) || process.version !== "v" + process.env.EXPECTED_NODE) throw new Error("GNU gate requires the expected supported official Node distribution")'
node_root="$(cd "$(dirname "$node_path")/.." && pwd)"
image="occipital-gnu228-$docker_arch"
cache_args=(--build-arg BUILDKIT_INLINE_CACHE=1)
if docker image inspect "$image" >/dev/null 2>&1; then
  cache_args+=(--cache-from "$image")
fi
docker build "${cache_args[@]}" --platform "linux/$docker_arch" --tag "$image" \
  --file "$root/scripts/release/Dockerfile.linux-gnu" "$root/scripts/release"
# Linked worktrees keep their source-authority metadata outside the checkout mount.
git_mounts=()
if [[ -f "$root/.git" ]]; then
  IFS= read -r pointer < "$root/.git"
  [[ "$pointer" == 'gitdir: '* ]] || { printf 'Invalid linked-worktree Git pointer\n' >&2; exit 1; }
  git_dir="$(cd "$root" && cd "${pointer#gitdir: }" && pwd -P)"
  git_common="$git_dir"
  if [[ -f "$git_dir/commondir" ]]; then
    IFS= read -r common < "$git_dir/commondir"
    git_common="$(cd "$git_dir" && cd "$common" && pwd -P)"
  fi
  git_mounts=(-v "$git_common:$git_common:ro")
  if [[ "$git_dir" != "$git_common" && "$git_dir" != "$git_common/"* ]]; then git_mounts+=(-v "$git_dir:$git_dir:ro"); fi
fi
# Re-prepare inside the baseline: every descriptor tool path must exist there.
# Only published-consumer is deliberately networked; its runner verifies tag authority.
docker run --rm --platform "linux/$docker_arch" "${network_args[@]}" --user "$(id -u):$(id -g)" \
  -v "$root:$root" "${git_mounts[@]}" -v "$node_root:$node_root:ro" -v "$preparation:$preparation" -v "$artifact:$artifact:ro" \
  --workdir "$root" --env HOME=/tmp/occipital-installed-home \
  --env EXPECTED_ARCHITECTURE="$architecture" --env NODE="$node_path" \
  --env PREPARATION="$preparation" --env ARTIFACT="$artifact" --env SUITE="$suite" --env RELEASE_REF="$release_ref" \
  --env PATH="$node_root/bin:/usr/bin:/bin" \
  "$image" bash -euo pipefail -c '
    mkdir -p "$HOME"
    test "$(uname -m)" = "$EXPECTED_ARCHITECTURE"
    test "$(getconf GNU_LIBC_VERSION)" = "glibc 2.28"
    getconf GNU_LIBC_VERSION
    retain_diagnostics() {
      "$NODE" --input-type=module << "JS"
      import {join} from "node:path";
      import {collectConsumerDiagnostics} from "./scripts/test/consumer-diagnostics.mjs";
      collectConsumerDiagnostics(join(process.env.PREPARATION,"gnu"));
JS
    }
    trap retain_diagnostics EXIT
    native_args=()
    if [[ "$SUITE" != published-consumer ]]; then native_args=(--native-artifact "$ARTIFACT"); fi
    "$NODE" scripts/test/prepare.mjs --pi-version 1.0.0 --offline --archives \
      --registry-inputs "$PREPARATION/inputs.json" --npm-cache "$PREPARATION/environment/cache/npm" "${native_args[@]}" --output "$PREPARATION/gnu"
    case "$SUITE" in
      native) "$NODE" scripts/test/run.mjs --inputs "$PREPARATION/gnu/inputs.json" --suite native --files occipital-native.test.ts \
        --pattern "^actual owned helper preserves compact UTF8 highlighting and incremental work counters$" ;;
      consumer) "$NODE" scripts/test/run.mjs --inputs "$PREPARATION/gnu/inputs.json" --suite consumer ;;
      published-consumer) "$NODE" scripts/test/run.mjs --inputs "$PREPARATION/gnu/inputs.json" --suite published-consumer --release-ref "$RELEASE_REF" ;;
    esac
  '
