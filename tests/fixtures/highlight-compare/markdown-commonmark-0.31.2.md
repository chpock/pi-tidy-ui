# Block and inline contexts

A short **strong phrase** beside *emphasis*, `code`, an escaped \*marker\*, and an entity &amp;.

A [reference link][guide] can end a paragraph with a hard break.  
The next line continues it.

[guide]: #sections "Local reference"

## Sections

> A quote keeps its marker.
>
> - A nested list item
> - Another item

1. An ordered item
2. A second item

---

A setext heading
----------------

```ts
interface Entry { readonly label: string }
```

<details>
<summary>Raw HTML block</summary>

Its contents remain part of the document.
</details>

An inline [link](#sections "Inline title") and ![image](../diagram.svg "Image title"), plus ``code `ticks` span``.

    Indented code block with four-space indentation.
