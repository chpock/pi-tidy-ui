# GFM dialect additions

This CommonMark-derived paragraph keeps ~~retired text~~ beside **strong text**.

| State | Value | Note |
| :--- | ---: | :--- |
| ready | `true` | aligned cells |
| waiting | `false` | a second row |

- [x] checked task
- [ ] open task

Angle-bracket autolink stays literal source text: <https://example.invalid/guide>.

GFM also autolinks a bare URL: https://example.invalid/bare-guide

```yaml
state: ready
count: 2
```
