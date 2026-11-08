# Independently authored Python 3.14 syntax additions.
"""Positive syntax samples for grammar features added in Python 3.14."""

def describe(status: str, rows: int) -> object:
    return t"status={status!r}, rows={rows:>3}"

def recover(error: Exception) -> str:
    try:
        raise error
    except TypeError, ValueError:
        return "known error"
