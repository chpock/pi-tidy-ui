.DEFAULT_GOAL := help
SHELL := sh

NODE ?= node
NPM ?= npm
INPUTS ?=
FEATURES ?=
PI_VERSION ?= 1.0.0
PREPARE_OUTPUT ?= $(CURDIR)/.test-artifacts/harness/$(PI_VERSION)
RUST_ROOT ?=
CARGO_HOME ?=
CARGO_TARGET_DIR ?= $(CURDIR)/target
RUST_TARGET ?=
EXE := $(if $(filter Windows_NT,$(OS)),.exe,)
CARGO = $(RUST_ROOT)/bin/cargo$(EXE)
RUSTC = $(RUST_ROOT)/bin/rustc$(EXE)
NATIVE_BIN = $(CARGO_TARGET_DIR)/$(if $(strip $(RUST_TARGET)),$(RUST_TARGET)/,)release/occipital$(EXE)
export TEST_FILES TEST_PATTERN
RUN = "$(NODE)" scripts/test/run.mjs --inputs "$(INPUTS)"
RUST_ENV = env -i PATH="$(RUST_ROOT)/bin:/usr/bin:/bin" HOME="$(CARGO_HOME)/test-home" CARGO_HOME="$(CARGO_HOME)" CARGO_TARGET_DIR="$(CARGO_TARGET_DIR)" CARGO_NET_OFFLINE=true RUSTC="$(RUSTC)" RUSTUP_TOOLCHAIN="$(RUST_ROOT)" RUSTUP_AUTO_INSTALL=0 TIDY_TEST_ROOT="$(CARGO_HOME)/test-root" TIDY_TEST_GETCONF=/usr/bin/getconf LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC

# Cargo also discovers ancestor .cargo/config independently of CARGO_HOME.
# Copy one verified native snapshot into a neutral external tree for every direct gate.
define NATIVE_RUN
$(RUST_ENV) "$(NODE)" --input-type=module -e ' \
  import {existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync} from "node:fs"; \
  import {join} from "node:path"; \
  import {spawnSync} from "node:child_process"; \
  import {materializeSource, snapshotIdentity} from "./scripts/test/prepare.mjs"; \
  import {verifyLinuxRuntime} from "./scripts/release/native-ci.mjs"; \
  const [phase, target, cargo, binary] = process.argv.slice(1), source = process.cwd(); \
  const files = ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml"].filter(name => existsSync(join(source, name))); \
  const collect = directory => { if (!existsSync(join(source, directory))) return; for (const name of readdirSync(join(source, directory))) { const path = directory + "/" + name; if (statSync(join(source, path)).isDirectory()) collect(path); else if (statSync(join(source, path)).isFile()) files.push(path); } }; \
  collect("crates"); collect(".cargo"); files.sort(); \
  const expected = snapshotIdentity(source, files).nativeTree, work = mkdtempSync("/tmp/tt-native-"); \
  let status = 0; \
  try { \
    if (materializeSource(source, work, files).nativeTree !== expected) throw new Error("Native source changed during materialization"); \
    const testRoot = join(work, "test-root"), home = join(work, "home"); mkdirSync(testRoot); mkdirSync(home); \
    const env = {...process.env, HOME: home, TIDY_TEST_ROOT: testRoot, TMPDIR: testRoot, TMP: testRoot, TEMP: testRoot}; \
    const targets = target ? ["--target", target] : []; \
    const build = ["build", "--release", "--locked", "--offline", "-p", "occipital", ...targets]; \
    const lint = ["clippy", "--workspace", "--all-targets", "--locked", "--offline", ...targets, "--", "-D", "warnings"]; \
    const phases = phase === "gnu" ? [["fmt", "--all", "--check"], ["test", "--workspace", "--locked", "--offline", ...targets], ["test", "--locked", "--offline", "-p", "occipital", "--example", "engine_probe", ...targets, "allocator_diagnostic_tracks_the_actual_glibc_api"], lint, build] : [phase === "lint" ? lint : build]; \
    for (const args of phases) { const result = spawnSync(cargo, args, {cwd: work, env, stdio: "inherit"}); if (result.status !== 0) { status = result.status ?? 1; break; } } \
    if (status === 0 && phase === "gnu") await verifyLinuxRuntime(binary); \
  } finally { rmSync(work, {recursive: true, force: true}); } \
  process.exitCode = status; \
' -- "$(1)" "$(RUST_TARGET)" "$(CARGO)" "$(NATIVE_BIN)"
endef

.PHONY: help deps build native-build native-toolchain inputs-check check check-native test test-gc test-focus test-feature test-product test-rust test-rust-harness test-native test-syntax test-terminal test-release test-installed test-published pack-check native-smoke _native-lint _gnu-native

help:
	@printf '%-22s %s\n' \
	  'deps' 'Prepare the exact PI_VERSION dependency graph (no implicit native build)' \
	  'build' 'Offline pinned native build; requires explicit RUST_ROOT and owned CARGO_HOME' \
	  'check' 'Strict selected-host TypeScript check; requires absolute INPUTS' \
	  'check-native' 'Prepared offline Rust formatting and strict Clippy checks' \
	  'test' 'Required same-source unit/SDK/GC coverage from prepared INPUTS' \
	  'test-gc' 'Alias for the same mandatory GC-enabled unit suite' \
	  'test-focus' 'Comma-separated TEST_FILES basenames and optional TEST_PATTERN' \
	  'test-feature' 'Types + product baseline + FEATURES comma-list and actual affected CLI; refresh owned source' \
	  'test-product' 'Common product SDK/logic/GC without native/shared/profile inputs' \
	  'test-rust' 'Prepared offline workspace tests and doctests' \
	  'test-rust-harness' 'Actual pinned Cargo ancestor-configuration isolation control' \
	  'test-native' 'Required same-source native helper controls' \
	  'test-syntax' 'Physical syntax CLI with required prepared real shared host' \
	  'test-terminal' 'Full physical CLI/replay with locked integration inputs' \
	  'test-release' 'Inert packaging/version/release regressions' \
	  'test-installed' 'Offline-fixture same-commit clean npm consumer' \
	  'test-published' 'External delivery verification ONLY for explicit pi-tidy-ui RELEASE_REF' \
	  'pack-check' 'Inspect development npm archive without publishing'

deps:
	"$(NODE)" scripts/test/prepare.mjs --pi-version "$(PI_VERSION)" --output "$(PREPARE_OUTPUT)"

inputs-check:
	@case "$(INPUTS)" in /*|[A-Za-z]:/*|[A-Za-z]:\\*) ;; *) printf 'Supply INPUTS=/absolute/path/inputs.json from explicit preparation.\n' >&2; exit 1 ;; esac
	@test -f "$(INPUTS)" || { printf 'Prepared INPUTS not found: %s\n' "$(INPUTS)" >&2; exit 1; }

build: native-build
	cp "$(NATIVE_BIN)" "occipital$(EXE)"
	chmod +x "occipital$(EXE)"

native-toolchain:
	@set -eu; \
	  case "$(RUST_ROOT):$(CARGO_HOME)" in /*:/*) ;; *) printf 'Supply absolute RUST_ROOT and owned CARGO_HOME.\n' >&2; exit 1 ;; esac; \
	  test -d "$(CARGO_HOME)"; test ! -f "$(CARGO_HOME)/config"; test ! -f "$(CARGO_HOME)/config.toml"; \
	  mkdir -p "$(CARGO_HOME)/test-home" "$(CARGO_HOME)/test-root"; \
	  expected="$$("$(NODE)" --input-type=module -e 'import {rustToolchain} from "./scripts/release/version.mjs"; console.log(await rustToolchain(process.cwd()));')"; \
	  for tool in "$(CARGO)" "$(RUSTC)"; do \
	    actual="$$( $(RUST_ENV) "$$tool" --version)"; \
	    case "$$actual" in *" $$expected "*) ;; *) printf 'Expected Rust %s; found %s.\n' "$$expected" "$$actual" >&2; exit 1 ;; esac; \
	  done

native-build: native-toolchain
	$(call NATIVE_RUN,build)

check: inputs-check
	$(RUN) --suite check

check-native: inputs-check
	$(RUN) --suite rust-check

_native-lint: native-toolchain
	$(call NATIVE_RUN,lint)

test test-gc: inputs-check
	$(RUN) --suite unit

test-focus: inputs-check
	@test -n "$(TEST_FILES)" || { printf 'Set comma-separated TEST_FILES basenames; TEST_PATTERN is optional.\n' >&2; exit 1; }
	$(RUN) --suite unit --files "$$TEST_FILES" $(if $(strip $(TEST_PATTERN)),--pattern "$$TEST_PATTERN",)

test-feature: inputs-check
	"$(NODE)" scripts/test/feature.mjs --inputs "$(INPUTS)" --features "$(FEATURES)" --refresh

test-product: inputs-check
	$(RUN) --suite product

test-rust: inputs-check
	$(RUN) --suite rust

test-rust-harness: inputs-check
	$(RUN) --suite rust-harness

test-native: inputs-check
	$(RUN) --suite native

test-syntax: inputs-check
	$(RUN) --suite syntax-terminal

test-terminal: inputs-check
	$(RUN) --suite terminal

test-release: inputs-check
	$(RUN) --suite native-release

test-installed: inputs-check
	$(RUN) --suite consumer

test-published: inputs-check
	$(RUN) --suite published-consumer --release-ref "$(RELEASE_REF)"

pack-check:
	"$(NPM)" pack --dry-run --ignore-scripts

native-smoke: inputs-check
	$(RUN) --suite native --files occipital-native.test.ts --pattern '^actual owned helper preserves compact UTF8 highlighting and incremental work counters$$'

# The GNU wrapper supplies pinned tool paths and owned stores inside network=none.
# Staging and prepared actual-helper smoke follow this gate in CI; no published input.
_gnu-native: native-toolchain
	$(call NATIVE_RUN,gnu)
