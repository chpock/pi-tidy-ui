# Independently authored syntax comparison specimen.
"""Compact positive syntax contexts; names need not exist at runtime."""

from collections.abc import AsyncIterable, Iterable, Iterator, Sequence
from dataclasses import dataclass as dc

# Literals retain neighboring identifier and escape context.
integer = 1_000_000
hexadecimal = 0x2A
octal = 0o52
binary = 0b10_1010
ratio, exponent, imaginary = .5, 1e3, 2j
escaped = "tab:\t newline:\n snowman:\u2603"
raw_path = r"C:\work\new"
octets = b"\x48\x69"
joined = "two " "adjacent"
multiline = """first line
second line"""
name, width = "Ada", 6
message = f"{name!r:>{width}} {0xFF=}"
nested = f"{(level := 2)} {f'{level=}' }"
multiline_f = f"""{
    name.upper()
}"""
café = "résumé"

# Soft keywords remain identifiers outside their grammar positions.
match = "ordinary name"
case = "ordinary name"
type = "ordinary name"
mask = (0b1101 & 0b1010) | (4 ^ 1) << 1
ordered = 1 < 2 <= 3 and integer is not None
window = list(range(10))[1:8:2]

values = [1, 2, 3, 4]
head, *middle, tail = values
mapping = {"a": 1, "b": 2}
merged = {**mapping, "c": 3}
odd_values = [value for value in values if value % 2]
squares = {value: value**2 for value in values}
unique = {value for value in values}
halves = (value / 2 for value in values)

type Pair[T, U = str] = tuple[T, U]
type Record = dict[str, object]

def render(label: str, /, *items: object, suffix: str = ".", **metadata: object) -> str:
    return f"{label}{items!r}{suffix}{metadata!r}"

@dc(frozen=True)
class Row:
    label: str
    values: tuple[int, ...] = ()

    @classmethod
    def empty(cls, label: str = "empty") -> "Row":
        return cls(label)

    def __str__(self) -> str:
        return self.label

def first[T](items: Sequence[T], fallback: T) -> T:
    return items[0] if items else fallback

scale = lambda value, factor=2: value * factor

def walk(items: Iterable[int], limit: int) -> Iterator[int]:
    for item in items:
        if item < 0:
            continue
        yield item
    else:
        while limit:
            limit -= 1
        yield from ()

def classify(value: object) -> str:
    match value:
        case {"name": str(label), "values": [first, *rest]} if first:
            return f"{label}:{len(rest)}"
        case Row(label=label, values=[first, *_]):
            return f"{label}:{first}"
        case ("ready" | "ok") as state:
            return state
        case [head, *_]:
            return str(head)
        case 0 | False:
            return "empty"
        case _:
            return "other"

def recover(action: object) -> object:
    try:
        return action()
    except FileNotFoundError as error:
        raise RuntimeError("missing input") from error
    except (OSError, ValueError) as error:
        return error
    else:
        return None
    finally:
        audit()

def handle_group(errors: Sequence[Exception]) -> None:
    try:
        raise ExceptionGroup("batch", errors)
    except* (OSError, ValueError) as group:
        report(group)

async def collect(items: AsyncIterable[str]) -> list[str]:
    result = []
    async for item in items:
        result.append(item)
    async with acquire() as stream:
        result.append(await stream.read())
    return result

async def forward(items: AsyncIterable[int]) -> AsyncIterable[int]:
    async for item in items:
        yield item
