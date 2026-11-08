//go:build go1.24

// Package main is a self-contained Go 1.24 syntax baseline.
package main

import "iter"

/* Integer and floating-point forms retain their literal spelling. */
const (
	decimal = 1_000_000
	hex     = 0x2A
	octal   = 0o52
	binary  = 0b10_1010
	ratio   = .5
	scale   = 1e3
)

type Number interface{ ~int | ~int64 | ~float64 }
type Set[E comparable] = map[E]struct{}
type Pair[A, B any] struct{ First A; Second B }
type Counter int

func (counter Counter) Add(value int) Counter {
	return counter + Counter(value)
}

func relay(input <-chan int, output chan<- int) {
	defer close(output)
	select {
	case value, ok := <-input:
		if ok {
			output <- value
		}
	}
}

var message = "line one\nline two\t\"quoted\""
var rawText = `first line
second line`
var symbol = '界'

func Sum[T Number](values ...T) (total T) {
	for index := range len(values) {
		total += values[index]
	}
	return total
}

func Values(values ...int) iter.Seq[int] {
	return func(yield func(int) bool) {
		for _, value := range values {
			if !yield(value) {
				return
			}
		}
	}
}

func Describe(value any) string {
	switch item := value.(type) {
	case string:
		return item
	case int, int64:
		return "integer"
	default:
		return "other"
	}
}

func MapValues[A, B any](values []A, convert func(A) B) []B {
	result := make([]B, 0, len(values))
	for index, value := range values {
		if index >= 0 {
			result = append(result, convert(value))
		}
	}
	return result
}

func main() {
	values := MapValues([]int{1, 2}, func(value int) int { return value * 2 })
	_ = Counter(Sum(values...)).Add(1)
}
