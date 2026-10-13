.DEFAULT_GOAL := help
SHELL := sh

NODE ?= node
NPM ?= npm
CARGO ?= cargo
RUSTC ?= rustc
CARGO_TARGET_DIR ?= $(CURDIR)/target
RUST_TARGET ?= $(CARGO_BUILD_TARGET)
EXE := $(if $(filter Windows_NT,$(OS)),.exe,)
TARGET_ARGS = $(if $(strip $(RUST_TARGET)),--target "$(RUST_TARGET)",)
NATIVE_BIN = $(CARGO_TARGET_DIR)/$(if $(strip $(RUST_TARGET)),$(RUST_TARGET)/,)release/occipital$(EXE)
OCCIPITAL_TEST_BIN ?= $(CURDIR)/occipital$(EXE)
export CARGO_TARGET_DIR RUSTC TEST_FILES TEST_PATTERN
export RUSTUP_AUTO_INSTALL := 0

.PHONY: help deps build native-build native-toolchain check check-native test test-gc test-focus test-rust test-native test-syntax test-terminal test-release test-installed pack-check helper-check native-smoke _native-lint _gnu-native

help:
	@printf '%-22s %s\n' \
	  'deps' 'Install locked npm development dependencies, without scripts' \
	  'build' 'Build release Occipital and copy it beside the extension (no TS bundling)' \
	  'check' 'Strict TypeScript check' \
	  'check-native' 'Rust formatting and strict Clippy checks' \
	  'test' 'Ordinary unit/SDK suite (npm test; GC/native cases may skip)' \
	  'test-gc' 'Full unit/SDK suite with forced GC and CI truecolor environment' \
	  'test-focus' 'Selected TEST_FILES, optional TEST_PATTERN, with GC' \
	  'test-rust' 'Rust workspace tests and doctests' \
	  'test-native' 'Full unit/SDK/GC suite with a required existing Occipital helper' \
	  'test-syntax' 'Short physical syntax CLI suite; requires a helper' \
	  'test-terminal' 'Expensive full physical CLI/replay; final UI verification' \
	  'test-release' 'Inert packaging/version/release regressions' \
	  'test-installed' 'Networked clean npm install/download/cache/cleanup control' \
	  'pack-check' 'Inspect development npm archive contents, without creating/publishing it'

deps:
	"$(NPM)" ci --ignore-scripts

build: native-build
	cp "$(NATIVE_BIN)" "occipital$(EXE)"
	chmod +x "occipital$(EXE)"

native-toolchain:
	@set -eu; \
	  expected="$$("$(NODE)" --input-type=module -e 'import {rustToolchain} from "./scripts/release/version.mjs"; console.log(await rustToolchain(process.cwd()));')"; \
	  for tool in "$(CARGO)" "$(RUSTC)"; do \
	    actual="$$("$$tool" --version)"; \
	    case "$$actual" in *" $$expected "*) ;; \
	      *) printf 'Expected Rust %s from rust-toolchain.toml; found %s. Select the pinned toolchain on PATH.\n' "$$expected" "$$actual" >&2; exit 1 ;; \
	    esac; \
	  done

native-build: native-toolchain
	"$(CARGO)" build --release --locked -p occipital $(TARGET_ARGS)

check:
	"$(NPM)" run check

check-native: native-toolchain
	"$(CARGO)" fmt --all --check
	$(MAKE) _native-lint

_native-lint:
	"$(CARGO)" clippy --workspace --all-targets --locked $(TARGET_ARGS) -- -D warnings

test:
	"$(NPM)" test

test-gc:
	TERM=xterm-256color COLORTERM=truecolor "$(NODE)" --expose-gc --test --test-concurrency=2 tests/*.test.ts

test-focus:
	@test -n "$$TEST_FILES" || { printf 'Set TEST_FILES to the affected test files; TEST_PATTERN is optional.\n' >&2; exit 1; }
	TERM=xterm-256color COLORTERM=truecolor "$(NODE)" --expose-gc --test --test-concurrency=1 $(if $(strip $(TEST_PATTERN)),--test-name-pattern="$$TEST_PATTERN",) $$TEST_FILES

test-rust: native-toolchain
	"$(CARGO)" test --workspace --locked $(TARGET_ARGS)

helper-check:
	@test -x "$(OCCIPITAL_TEST_BIN)" || { printf 'Occipital helper not executable: %s. Run make build or set OCCIPITAL_TEST_BIN to an absolute path.\n' "$(OCCIPITAL_TEST_BIN)" >&2; exit 1; }

test-native: helper-check
	OCCIPITAL_TEST_BIN="$(OCCIPITAL_TEST_BIN)" $(MAKE) test-gc

test-syntax: helper-check
	OCCIPITAL_TEST_BIN="$(OCCIPITAL_TEST_BIN)" "$(NPM)" run test:syntax-terminal

test-terminal:
	"$(NPM)" run test:terminal

test-release:
	"$(NPM)" run test:native-release

test-installed:
	"$(NPM)" run test:installed-native

pack-check:
	"$(NPM)" pack --dry-run --ignore-scripts

native-smoke: helper-check
	OCCIPITAL_TEST_BIN="$(OCCIPITAL_TEST_BIN)" "$(NODE)" --test --test-name-pattern='^actual owned helper preserves compact UTF8 highlighting and incremental work counters$$' tests/occipital-native.test.ts

# linux-gnu.sh owns native architecture/glibc assertions, SDK mounts and network isolation.
# Separate recursive invocations keep these dependent phases ordered even under make -j.
_gnu-native: native-toolchain
	$(MAKE) test-rust
	"$(CARGO)" test --locked -p occipital --example engine_probe $(TARGET_ARGS) allocator_diagnostic_tracks_the_actual_glibc_api
	$(MAKE) _native-lint
	$(MAKE) native-build
	OCCIPITAL_TEST_BIN="$(NATIVE_BIN)" "$(NODE)" --input-type=module -e 'import {verifyLinuxRuntime} from "./scripts/release/native-ci.mjs"; await verifyLinuxRuntime(process.env.OCCIPITAL_TEST_BIN);'
	$(MAKE) native-smoke OCCIPITAL_TEST_BIN="$(NATIVE_BIN)"
