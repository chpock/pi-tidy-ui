#include <array>
#include <concepts>
#include <cstdint>
#include <string_view>
#include <utility>

#define FIXTURE_SCALE 3
#if defined(__cplusplus) && __cplusplus >= 202302L
#define FIXTURE_CXX23 1
#else
#define FIXTURE_CXX23 0
#endif

// The fixture is syntax input only; main is never launched.
namespace specimen {
using Count = std::uint64_t;

constexpr int square(int value) {
    if consteval {
        return value * value;
    } else {
        return value * value;
    }
}

static_assert(square(4) == 16);

// Decimal, hexadecimal, digit separators, character and raw string literals.
constexpr auto amount = 1'000'000ULL;
constexpr auto mask = 0x2A'B3u;
constexpr auto ratio = 0.5e+2;
constexpr char marker = '\n';
constexpr std::string_view text = R"note(first line
second "quoted" line)note";
constexpr std::u8string_view utf8 = u8"café 🌿";

template <typename T>
concept Addable = requires(T left, T right) {
    { left + right } -> std::same_as<T>;
};

template <Addable T, std::size_t Size>
constexpr auto total(const std::array<T, Size>& values) {
    T result{};
    for (const auto& value : values) result = result + value;
    return result;
}

struct Point {
    double x{};
    double y{};
    [[nodiscard]] constexpr double norm_squared() const { return x * x + y * y; }
    friend constexpr Point operator+(Point left, Point right) {
        return {left.x + right.x, left.y + right.y};
    }
};

struct Record {
    explicit Record(std::string_view label, int level = 1) : label(label), level(level) {}
    std::string_view label;
    int level;
};

inline constexpr auto decorate = [factor = FIXTURE_SCALE](auto value) {
    return value * factor;
};
} // namespace specimen

int main() {
    using specimen::Point;
    const Point first{1.0, 2.0};
    const auto [x, y] = first;
    auto transformed = specimen::decorate(x + y);
    if (transformed > 0 && (transformed != 3 || specimen::amount > 1)) {
        transformed += static_cast<int>(specimen::mask & 0x0Fu);
    }
    return transformed == 0 ? 1 : 0;
}
