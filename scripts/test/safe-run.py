#!/usr/bin/python3
"""Kernel-verified ordinary Linux test scope; 300s default, 600s maximum.

The target receives an empty environment unless --env-file supplies a complete
private JSON map, plus TIDY_TEST_SCOPE_RECEIPT locating its verified scope receipt.
The outer owner alone retains the user systemd bus environment. No fallback to
uncontained execution is permitted.
"""
import importlib.util
import pathlib
import sys

# Prepared source bytes must stay unchanged when loading the shared mechanism.
sys.dont_write_bytecode = True
# -I excludes the entry directory from sys.path; never import caller modules.
spec = importlib.util.spec_from_file_location(
    'tidy_scope_core', pathlib.Path(__file__).resolve().parent / 'scope_core.py')
assert spec is not None and spec.loader is not None
scope = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scope)


def main():
    return scope.main(entry_path=__file__, max_seconds=600, pin_cpus=False,
                      expose_receipt=True)


if __name__ == '__main__':
    sys.exit(main())
