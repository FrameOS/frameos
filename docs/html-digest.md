# The HTML digest: a page as records

A JS app that shows a web page (the Browser sample) cannot afford to read its
markup in JavaScript on an ESP32: QuickJS there runs a loop iteration in 4 to
6 µs and a regular expression over one tag in ~175 µs, so GitHub's front page
(356 KB, 4,000 tags) took 5.5 s to read and Wikipedia's ESP32 article nearly
10 s (a SenseCAP Indicator, 2026-11-24). So the runtime reads it:
`frameos/src/frameos/utils/html_digest.nim`, one implementation for a Pi, an
ESP32 and the wasm runtime, a few milliseconds a page. What reaches the app
is a **record a block**: a paragraph, a heading, a list item, a line of a
table, a picture, a form's field, with its text, where its links, bold and
code runs start, and marks around what is not the page's own (its navigation,
a sidebar, the footer). The app decides what to do with them; the Browser
folds what is around the page into one line each.

Scripts, style sheets, comments, inline SVG and what is hidden are dropped as
they pass and never become a JavaScript string: a news site's seven megabytes
are thirty kilobytes of records.

## How an app gets it

`fetch(url, { onChunk, digest: "html" })` (docs/async-js.md, "A response in
pieces"): a body that is HTML arrives as records, whole ones, a line each; a
body that is not (by its `Content-Type`, else its first bytes) arrives as its
text, and `info.digest` says which (`"html"` or `""`).

## The records

A record is a line (`\n`); its fields are apart by tabs. In a text a line
break (a `<br>`, a line of a `<pre>`) is `\x0b` and a tab is spaces. The first
character says what it is:

| | |
|---|---|
| `p` `h` `l` `r` `w` | a block of text: a paragraph, a heading, a list item, preformatted lines, a line of a table or of a list of terms. `<meta>\t<runs>\t<text>`; a list item's text is its mark, `\x01`, its words |
| `-` | a rule. `<meta>` |
| `i` | a picture. `<meta>\t<width>\t<height>\t<link>\t<src>\t<alt>` (0 where the page does not say; `link` the number of the link it is in) |
| `A` | a link's address as the page wrote it (its tabs and newlines dropped); links are numbered from 1 in the order they come. It goes out when something inside the link shows: a link around nothing shown gets none |
| `F` | a form opens (numbered from 0). `<post 0/1>\t<action>` |
| `f` | a field. `<meta>\t<form>\t<type>\t<on 0/1>\t<name>\t<value>\t<label>`, then a select's options as `\t<value>\t<text>` pairs. A `<select>`, a `<button>` (its words are its label) and a `<textarea>` (its text is its value) are written when their element ends, at the place where it started: the records of what is inside come after theirs. Types: `text`, `password`, `checkbox`, `radio`, `select`, `textarea`, `submit`, `hidden` (kept for the form, not shown) |
| `[` | something around the page starts (a `<nav>`, `<aside>`, `<footer>`, the page's `<header>`, a `<details>`, an element whose role or class says so). `<meta>\t<label>`. The `[` records are numbered from 0 as they come: that is the number its `S` and `]` name |
| `S` | a `<details>`'s `<summary>`. `<fold>\t<label>` |
| `]` | it ends. `<fold>\t<flag>\t<link letters>`: flag 0 it is around the page by what it is, 1 only by its name (the app folds it if it is mostly links), 2 a `<details open>`; then how many letters of the text since its `[` are in links. Whether it becomes a fold is the app's call, and the digest knows nothing of it |
| `M` | the page's own part starts here (`<main>`, the first `<article>`, an element with that role or id). What is still open around it holds the page and is around nothing: it gets no `]` |
| `#` | an id (or a named anchor). It names the block being written when it is met inside one, else the next block to start; either way its record stands before that block's own, and ids still waiting at the page's end come last |
| `T` `B` `D` `R` `E` | the title; `<base href>`; the description; where `<meta http-equiv="refresh">` sends the browser (a delay of ten seconds or less); a feed the page names, `<href>\t<title>` |
| `J` | the page's JSON-LD on one line, sent at its end when under 2,000 letters of text were written (a page its scripts write) |
| `X` | more came than is kept: what was open is closed (its `]` records come first) and the digest stopped here |

`meta` is a number: the list depth (0 to 15), plus 16 times the quote depth
(0 to 7), plus 128 for a gap above, plus 256 times a heading's level.

A name, a label or a description is one line (a tab or a newline in it is a space).

`runs` is `where,style,where,style,…`: from letter `where` (UTF-16 units, as
JavaScript counts) the text is in `style`, a sum of 1 bold, 2 italic, 4 code,
8 dim (small print, a caption), 16 struck through, and 256 times its link's
number. Empty: one plain run.

## What the digest decides

What a browser without style sheets or scripts can know from markup alone,
the way Lynx read a page:

- **Blocks.** A block element starts a new one; an element that held nothing
  asks for no break (a table cell around an icon). Cells of a row are one
  line, told apart with ` | ` in a table that has headers. Two `<br>` end a
  paragraph. White space is one space outside `<pre>`; entities are decoded;
  invisible letters (soft hyphens, zero-width spaces, direction marks) go.
  The block after something around the page that showed anything (a `]`
  with at least one block since its `[`) has the gap bit, whatever the app
  does with it; `M` changes no gap.
- **Attributes.** A tag's attributes are read once, by their names in either
  case (`<A HREF=…>`): a word inside another attribute's value is no
  attribute. In a value an entity needs its semicolon (`?a=1&copy=2` is an
  address, not a ©); in text it is read without one.
- **Hidden.** `hidden`, `aria-hidden="true"`, `display: none` or `visibility:
  hidden` in the element's own `style`, a class that says so (`hidden`,
  `d-none`, `noprint`, …), a `<dialog>` that is not open, a `<button>` or a
  field outside a form (only a script answers it), and `<script>`, `<style>`,
  `<template>`, `<svg>`, `<canvas>`, `<object>`, `<video>`, `<audio>` with
  all inside them. A video, a sound or an `<iframe>` leaves a line with a
  link to its source.
- **Links.** `href`s as written (the app resolves them); a link around
  nothing shown takes its `aria-label`, `title` or its picture's `alt`, or is
  no link. `javascript:` is none, and neither is an `<a>` without an `href`
  (an anchor: it ends nothing of a link it is in). Two links with nothing
  between them are a space apart.
- **Pictures.** `src`, else what a lazy loader would have put there
  (`data-src`, the candidate of a `srcset` nearest 640 px, a `<picture>`'s
  `<source>`); icons (under 40 px by their attributes) and SVG are their
  `alt` text.

The reference is the Nim module and its test
(`frameos/src/frameos/utils/tests/test_html_digest.nim`): the cases there are
the contract, and any cut of the input into pieces must give the same records.

## What it costs

In the ESP32-S3 image it is 26,044 bytes (2026-11-24); its C compiled alone
(`-Os`) is 29.8 KB with `-mlongcalls` and 25.2 KB with short calls, between
which the image's link order puts it: `open` (a start tag) 4.2 KB, `single`, `scan`
and `leave` about 1.5 KB each, the entity names 0.9 KB, the element names
0.6 KB. What made it smaller: one read of a tag's attributes into a table by
number in place of a scan per name (-1.1 KB), the elements that do the same
as one case (`Acts`, -0.8 KB), the entity table as a name and a two-byte
letter (-0.15 KB). What is left is the rules themselves; the next cuts are
features (forms about 2.5 KB, `srcset` 0.6 KB, the lines for video, sound and
frames 0.5 KB). See the firmware-size comment of the change that added it,
and `docs/esp32-image-size.md`.
