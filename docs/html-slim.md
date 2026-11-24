# The HTML slimmer: a page's markup made small on its way to an app

A JS app that shows a web page (the Browser sample) reads its markup in
JavaScript, and on an ESP32 that is dear: QuickJS there runs a loop
iteration in 4 to 6 µs and a regular expression over one tag in ~175 µs
(a SenseCAP Indicator, 2026-11-24). A page as its server sends it is mostly
what such an app has no use for: CNN's front page is 7 MB of scripts, style
sheets and class names around 26 KB of words. So the runtime takes that out
as the page streams, in `frameos/src/frameos/utils/html_slim.nim`: one
implementation for a Pi, an ESP32 and the wasm runtime, a few milliseconds a
megabyte, 4.3 KB of an ESP32's flash. What reaches the app is still
HTML, written one way, a tenth to a half of its size.

The slimmer knows what HTML itself says (what a tag is, a comment, the
elements whose text is not markup, `<pre>`) and nothing of what a page
means. What is a block, a link, navigation, hidden: that is the app's, in
its own JavaScript, where anyone can change it. An earlier version read the
page whole in the runtime (30 KB of flash for 0.03 s a page instead of one
second); it was taken out for its size on 2026-11-24.

## How an app gets it

`fetch(url, { onChunk, slim: { keep, drop, bare, classes } })`
(docs/async-js.md, "A response in pieces"): a body that is HTML arrives
slimmed, and `info.slim` is `"html"`; a body that is not (by its
`Content-Type`, else its first bytes) arrives as its text, and `info.slim`
is `""`. Each of the four is a string of words a space apart (192 words in
all at most), and each may be left out:

| | |
|---|---|
| `keep` | the attributes that stay; every other is dropped. Left out: all stay |
| `drop` | elements dropped with all inside them (`svg`, `template`, …): only ones that have an end tag |
| `bare` | elements dropped, tag and end tag, when none of their attributes stays (`span`): what an app gives no meaning to by itself |
| `classes` | of a `class`, only the words on this list stay, and words with a part on it (parts are apart at `-` and `_`, compared in lower case): `Site-Nav__list` stays for `nav`. A class with nothing left is no attribute. Left out: a class stays as it is |

## What slimmed markup is

- **Gone**: comments, the doctype, `<?…>`; `<script>` and `<style>` with
  their text (a `<script>` whose `type` has `ld+json`, the data a page
  states about itself, stays with its text as it is); what `drop`, `bare`
  and `keep` say; an attribute whose value is over 2,048 bytes (a picture
  inlined as `data:`).
- **A tag** is `<name a="v" b="w">` or `</name>`: names in lower case, every
  attribute `name="value"` (one without a value is `name=""`), in the order
  the page wrote them. In a value `"`, `<` and `>` are `&quot;`, `&lt;` and
  `&gt;`; other entities are left for the app. No `/` before the `>`. So the
  first `>` after a `<` ends its tag, ` name="` finds an attribute and the
  next `"` ends its value: an app reads a tag with `indexOf`, no regular
  expression.
- **Every `<` starts a tag**: one that starts nothing in the page's text is
  `&lt;`. The exception is the text of a `<textarea>`, a `<title>` and a
  kept `<script>`, which is no markup in HTML and is left as it is up to its
  end tag.
- **Text** outside `<pre>`: a run of white space is one space, and letters
  that show nothing are gone (U+00AD, U+200B to U+200F, U+2028 to U+202E,
  U+2060 to U+2064, U+FEFF). A space next to a tag that was dropped joins
  the one around it (`a <span> b</span>` is `a b`). Inside `<pre>` text is
  untouched. Entities are not decoded.
- **A tag comes whole or not yet**: a piece handed to `onChunk` ends
  between tags or inside text, never inside a tag. Any cut of the page into
  pieces on its way in gives the same markup out.

What a page gets wrong is taken as a browser takes it: a tag with no end is
dropped with the page's rest, a quote never closed ends at the page's end
or, 64 KB on, at the next `>`.

## What it does to a page

Slimmed with the Browser's lists (2026-11-24), and what an ESP32 spends
slimming at a few tens of megabytes a second:

| page | as sent | slimmed | tags left |
|---|---:|---:|---:|
| Hacker News | 34 KB | 23 KB | 1,306 |
| GitHub, a repository | 365 KB | 75 KB | 3,268 |
| BBC News | 381 KB | 70 KB | 2,628 |
| Wikipedia, ESP32 | 352 KB | 201 KB | 6,369 |
| The Guardian | 1,442 KB | 277 KB | 7,806 |
| CNN | 7,014 KB | 341 KB | 6,434 |

## What it costs, and what reading the rest costs

The module is 4,268 bytes of the ESP32-S3 image. A stream that asked keeps
its lists as one table of words by their hash (1 KB and the words): a name
is looked up once, whatever is asked of it. Walking a list for every
attribute and class word was half a second of a long article; hashed, and
with runs of text and values copied whole, slimming Wikipedia's ESP32
article adds 0.14 s to its download on a SenseCAP Indicator, The Guardian's
front page 0.05 to 0.08 s, and CNN's is faster slimmed than not (less to
make JavaScript strings of).

Reading what is left is the app's. The Browser's reader (`read.ts`: blocks,
links, forms, what is around a page, what is hidden, the colours a page's
markup states) on a reTerminal E1003, and on the SenseCAP, where an RGB
panel's refresh shares the PSRAM with the interpreter:

| page | tags | E1003 | SenseCAP |
|---|---:|---:|---:|
| Hacker News | 1,306 | 0.19 s | 0.40 s |
| BBC News | 2,628 | 0.33 s | 0.67 s |
| GitHub, a repository | 3,268 | 0.41 s | 0.81 s |
| Wikipedia, ESP32 | 6,369 | 1.1 s | 2.4 s |

The same reader on markup as sent, with a regular expression per attribute,
took 5.5 s for the GitHub page. What it is made of, on the E1003 (QuickJS,
2026-11-24): a function call 1 µs, an array load or store 0.5 µs, `push`
3.2 µs, `Map.get` 4.4 µs, `charCodeAt` 2.7 µs, `slice` 5.3 µs, `indexOf`
3.5 µs and 0.3 µs a letter it passes over, `toLowerCase` of 75 letters
40 µs, a regular expression of six alternatives over 75 letters 445 µs. So
a reader of slimmed markup reads a tag's attributes once and tells them
apart by their first letter and length, matches an end tag against the open
element without a lookup, and decodes an entity only where there is a `&`.

Next, if a second is too long:

- **`indexOf` in QuickJS** compares the whole needle at every position
  (`js_string_indexOf`); `split` and `replace` scan for its first letter
  and are twice as fast. A page is scanned two to three times over: about
  0.12 s of the Wikipedia article's 1.1. It is a quickts release of its own.
- **A `keep` per element.** `title` and `rel` are kept on every element for
  the few that use them: 44 KB of the Wikipedia article's 196.
- **A list for `style`'s declarations**, as `classes` is for a class: of
  1,404 `style` attributes in the saved corpus 573 say anything the Browser
  reads (display, visibility, a colour), and CNN's front page carries 80 KB
  of the rest.

The reference is the module and its test
(`frameos/src/frameos/utils/tests/test_html_slim.nim`): the cases there are
the contract.
