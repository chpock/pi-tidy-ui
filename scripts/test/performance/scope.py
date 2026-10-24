#!/usr/bin/python3
"""Kernel-verified benchmark scope with fixed two-CPU affinity and a 300s cap."""
import importlib.util
import pathlib
import sys

# -I excludes the entry directory from sys.path; never import caller modules.
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location(
    'tidy_scope_core', pathlib.Path(__file__).resolve().parent.parent / 'scope_core.py')
assert spec is not None and spec.loader is not None
scope = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scope)


def main():
    return scope.main(entry_path=__file__)


if __name__ == '__main__':
    sys.exit(main())
