# Book highlights: the reader's highlights as full-screen quotes

Two samples share one file. The **ePub reader** (`repo/scenes/samples/Books`,
scene id `books`) keeps every highlight in `Highlights.json`, and **Book
highlights** (`repo/scenes/samples/Book highlights`, scene id
`book-highlights`) shows them one at a time, as big as the screen takes. It is
CrossNext's sleep screen that cycles through your highlights, done as a scene
of its own: a frame's schedule, a layout's window or the scene list puts it up.

No scene can read another's fields, so the file is the way across. Neither
scene needs a runtime change for it: both use the asset calls every frame has.

## The file

`<books folder>/Notes/Highlights.json` in the assets (on an ESP32, the TF
card), the books folder being the reader's `folder` field, `Books` when it is
empty: the folder its Markdown, `My Clippings.txt` and backup exports go to.

```json
{
  "format": "frameos-highlights",
  "version": 1,
  "updated": "2026-11-28T12:00:00.000Z",
  "highlights": [
    {
      "id": "mf3k2a1",
      "book": "assets:Books/Walden.epub",
      "title": "Walden",
      "author": "Henry David Thoreau",
      "chapter": "Where I Lived, and What I Lived For",
      "text": "I went to the woods because I wished to live deliberately…",
      "note": "The reason for all of it.",
      "at": 1795000000000,
      "f": 0.22
    }
  ]
}
```

Newest first. `book` is the reader's key for the book (`<storage>:<path>`,
what its `file` field opens) and `id` the mark's (what its `mark` field opens
the book at); `text` keeps a highlight's paragraphs on lines of their own;
`at` is when it was made (ms) and `f` how far through the book it is (0 to 1).
`marks.ts` `toHighlights` writes it, `quotes.ts` `fromHighlights` reads it.

**The reader writes it** whenever a highlight is made, its note changed, one
deleted or a backup imported (`keepMarks` in `app.tsx`; a bookmark leaves it
alone), and once into a folder that has none while there are highlights (the
first render after this change, a books folder changed: `spot.hl` remembers
the path written). An empty list is written over the file when the last
highlight goes. A frame with internal storage alone writes nothing, as it
exports nothing (`writeAsset` reaches the assets folder alone).

**Opening a book at a mark.** The reader's public `mark` field (memory, like
`file`): with `file`, the id of one of that book's marks; the reader opens
the book and jumps to it (`jumpTo`, as Go to it in its marks list does), and
sets both back to `""`. A mark it does not have opens the book where it was
left.

## The scene

- **Which one.** The newest the first time; then a new one when the
  `interval` field (role `refreshInterval`, "Seconds per highlight", an hour)
  is up, worked out from when the one showing went up (`spot.t`), so a render
  for any other reason keeps it, and `setNextSleep` keeps the cadence after a
  tap. A highlight made since the last one shown (`at` past `spot.seen`)
  comes next, the oldest of them first. Otherwise `order`: shuffled (a round
  shows every one before any again, then a new order: `spot.start` is where
  the round began), newest first, or book by book in reading order.
  `quotes.ts` `pick` is the rule, pure and tested in `app.test.ts`.
- **Input.** A tap, a swipe left or up, `forward`, the arrow keys and the
  Next button go on; `back`, a swipe right or down and Prev go back. Steps
  made before a render add up (taps while e-paper refreshes). A long press,
  Enter or the Action key (`primary`) opens the book at the highlight in the
  first scene on the frame whose `opens` names `epub` (`app.frame.scenes`,
  2026.11.15+): `setCurrentScene {sceneId, state: {file, mark}}`. With no
  such scene, a line under the quote says to install the ePub reader.
- **The look.** Paragraphs are blocks of their own (a UI folds a line break
  into a space; `frameos.measureText` keeps it), sized by halves to the
  biggest that fits over the book, author, chapter and note
  (`fitted`); past the least size, clamped. A short one is centred in
  quotation marks unless it opens with its own; a long one is set from the
  left under an opening mark. Light, sepia or dark; on e-paper solid black
  and white with the accent in red where the panel has red. The typeface is
  a field (Cormorant Garamond by default): a frame without it in its fonts
  draws Ubuntu, and the sizes are measured in whatever it draws. A round
  panel sets it all in the square inside the circle.
- **A Kindle's clippings.** The `clippings` field names a `My Clippings.txt`
  in the assets (a Kindle's, CrossPoint's, the reader's own export); its
  highlights join the reader's, a passage both have once. A highlight made
  longer is written again by a Kindle, so the newer of two overlapping ones
  in a book is kept; a note goes with the highlight it ends; bookmarks are
  left out. A long file is read from its end (512 KB on an ESP32, 4 MB
  elsewhere), where a Kindle adds them.
- **What it asks for.** `"permissions": ["assets"]`: it reads, and writes
  nothing but its own `spot`. `settings.needs` is `[]`: it takes taps, keys
  and buttons and needs none of them.

## Tests

- `frameos/src/frameos/tests/test_book_highlights_scene.nim`: the scene over a
  folder with the file (newest first, its time, every way of stepping, one
  made since, one taken away, the long press and the Action key, no reader,
  a Kindle file, e-paper, dark, tall, none). `FRAMEOS_HIGHLIGHT_SHOTS=<dir>`
  writes the pictures.
- `test_books_scene.nim`: the reader writes the file when a highlight is made
  and not for a bookmark, writes highlights from before it once, and opens a
  book at a handed mark.
- `app.test.ts` in each app (`test_js_app_tests`): the file's reading, a
  Kindle file's, the order.
