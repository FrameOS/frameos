## The HTML digest (docs/html-digest.md): the records it makes of a page, a
## case a rule, and that any cut of the page into pieces makes the same ones.
## Records are written here with → for a tab, ⏎ for the end of a record, ␋ for
## a line break in a text and ␁ after a list item's mark.
##
## FRAMEOS_DIGEST_IN=<page> FRAMEOS_DIGEST_OUT=<file> [FRAMEOS_DIGEST_PIECE=<bytes>]
## writes a saved page's records instead, to compare with another reader's
## (the Browser sample's reference reader was checked against it this way,
## over 42 saved sites).

import std/[os, strutils, unittest]
import ../html_digest

proc digest(html: string, piece = 0, maxChars = 2_000_000): string =
  ## The records of `html`, given whole or in pieces of `piece` bytes.
  var d = initHtmlDigest(maxChars)
  if piece <= 0:
    discard d.push(html, true, result)
    return
  var at = 0
  while true:
    let to = min(html.len, at + piece)
    if not d.push(html.toOpenArray(at, to - 1), to >= html.len, result) or to >= html.len:
      break
    at = to

if getEnv("FRAMEOS_DIGEST_IN").len > 0:
  writeFile(getEnv("FRAMEOS_DIGEST_OUT"), digest(readFile(getEnv("FRAMEOS_DIGEST_IN")),
    parseInt(getEnv("FRAMEOS_DIGEST_PIECE", "0"))))
  quit(0)

proc shown(records: string): string =
  records.multiReplace(("\t", "→"), ("\n", "⏎"), ("\x0b", "␋"), ("\x01", "␁"))

var pages: seq[string] ## every page the cases read, to cut in pieces below

template same(html, records: string) =
  pages.add html
  check shown(digest(html)) == records

suite "the HTML digest":
  test "a block element starts a block; one that held nothing asks for no break":
    same "<p>One</p><p>Two <i>it</i> <code>c</code> <small>s</small> <s>x</s></p>",
      "p0→→One⏎p128→0,0,4,2,7,4,9,8,11,16→Two it c s x⏎"
    same "<h2>Head</h2>text<div>block</div><div></div>more",
      "h640→→Head⏎p0→→text⏎p0→→block⏎p0→→more⏎"
    same "a<span>b</span><div></div><em></em>c",
      "p0→→abc⏎"
    same "a<br>b<br><br>c",
      "p0→→a␋b⏎p128→→c⏎"
    same "<q>said</q> <sup>2</sup> <sub>i</sub><hr><p>after rule</p>",
      "p0→0,0,7,8→“said” 2 i⏎-0⏎p0→→after rule⏎"

  test "an entity in an attribute's value needs its semicolon; in text it does not":
    same "<a href=\"/p?a=1&copy=2&amp;b=3&times=4&#38;c&#38\" title=\"&lt;T&gt &quot;\">&copy &times=4 &amp</a>",
      "A/p?a=1&copy=2&b=3&times=4&c&#38⏎p0→0,256→© ×=4 &⏎"

  test "a tag's attributes are its own: a word inside another's value is none, and a name is one in either case":
    same "<p id=\"x\" data-mw='{\"t\":\"a hidden one\"}' title=\"id='b' style='display:none'\">shown</p><IMG ALT=\"\"Up SRC=p.png>",
      "#x⏎p0→→shown⏎i128→0→0→0→p.png→⏎"

  test "an anchor without an address is no link, and ends nothing of the link it is in":
    same "<a href=\"/x\"><a name=\"here\"></a>Text</a> <a name=\"top\"></a><a id=\"skip\"></a><a href=\"/y\">Y</a>",
      "A/x⏎#here⏎#top⏎#skip⏎A/y⏎p0→0,256,4,0,5,512→Text Y⏎"

  test "the cells of a row are one line, told apart in a table with headers; an empty cell breaks nothing (Hacker News)":
    same "<table><tr><td>1.</td><td><center><a id=\"up\" href=\"vote\"><div class=\"votearrow\" title=\"upvote\"></div></a></center></td><td><a href=\"/s\">Story</a> (<a href=\"from\">site</a>)</td></tr><tr><td></td><td>12 points</td></tr><tr class=\"spacer\"></tr><tr><td>2.</td><td>Next</td></tr></table>",
      "A/s⏎Afrom⏎w128→0,0,3,256,8,0,10,512,14,0→1. Story (site)⏎#up⏎w0→→12 points⏎w128→→2. Next⏎"
    same "<table><tr><th>Name</th><th>Size</th></tr><tr><td>a</td><td>1 KB</td></tr></table>",
      "w128→0,1,4,8,9,1→Name  |  Size⏎w0→0,0,1,8,6,0→a  |  1 KB⏎"

  test "white space is one space, entities are read, letters that show nothing go":
    same "a  b\n\tc &amp; &lt;d&gt; &#8212; &#x2014; &nbsp;x&shy;y&zwnj;z\xE2\x80\x8B &bogus; &copy",
      "p0→→a b c & <d> — — \xC2\xA0xyz &bogus; ©⏎"
    same "<p>&micro;m &frac12; &hellip; &#0; &#xD800; &#65; &#x1F600;</p>",
      "p0→→µm ½ … \xEF\xBF\xBD \xEF\xBF\xBD A 😀⏎"
    same "<p>a<!-- c --> b<![CDATA[ raw <x> ]]> < 3 <3 </ > c</p><?xml x?><!doctype html>",
      "p0→→a b raw <x>  < 3 <3 </ > c⏎"
    same "<p>café <b>😀 x</b> <i>y</i></p>",
      "p0→0,0,5,1,10,2→café 😀 x y⏎"

  test "what is hidden, and what only a script answers, is dropped with all inside it":
    same "<div hidden>h1</div><div aria-hidden=\"true\">h2</div><div style=\"display: none\">h3</div><div class=\"x hidden\">h4</div><span class=\"noprint\">h5</span><dialog>h6</dialog><button>h7</button><input name=\"q\"><select><option>o</option></select><script>var a = \"<p>no</p>\"</script><style>p{}</style><svg><text>t</text></svg><template>t</template><p style=\"visibility:hidden\">h8</p><DIV CLASS=\"hidden\">h9</DIV><div hidden><p>deep <div>er</div></div>shown",
      "p0→→shown⏎"

  test "a link's address comes before its words; a link around nothing shown takes its label, or is none":
    same "<a href=\"/a\">A</a><a href=\"/b\">B</a> <a href=\"javascript:x()\">js</a> <a>plain</a> <a href=\"/i\" aria-label=\"Icon\"><svg></svg></a><a href=\"/e\"></a><a href=\"/t\" title=\"T\"><img src=\"i.svg\" alt=\"alt text\"></a><a href=\"/k\"><img src=\"k.png\" width=\"16\" alt=\"K\"></a>",
      "A/a⏎A/b⏎A/i⏎A/t⏎A/k⏎p0→0,256,1,0,2,512,3,0,13,768,17,0,18,1024,19,0,20,1280→A B js plain Icon T K⏎"
    same "<A HREF=\"Up.html\" NAME=\"x\">Up</A> <a href=\" a\tb\n\">x y</a>",
      "AUp.html⏎#x⏎A ab⏎p0→0,256,2,0,3,512→Up x y⏎"

  test "a picture's source, or what a lazy loader would put there; an icon or an SVG is its words":
    same "<img src=\"p.jpg\" width=\"640\" height=\"480\" alt=\" A  photo \"><img src=\"data:image/gif;base64,R0\" data-src=\"lazy.jpg\"><img srcset=\"s.jpg 320w, m.jpg 640w, l.jpg 1280w\"><picture><source srcset=\"w.webp 1x, w2.webp 2x\"><img src=\"blank.gif\"></picture><img src=\"icon.png\" width=\"16\" height=\"16\" alt=\"icon\"><img src=\"logo.svg\" alt=\"Logo\"><a href=\"/x\"><img src=\"big.png\" alt=\"in link\"></a>",
      "i0→640→480→0→p.jpg→A photo⏎i0→0→0→0→lazy.jpg→⏎i0→0→0→0→m.jpg→⏎i0→0→0→0→w.webp→⏎A/x⏎p0→→[Logo]⏎i0→0→0→1→big.png→in link⏎"
    same "<video src=\"/v.mp4\"></video><audio src=\"https://www.example.com/a.mp3\">x</audio><iframe src=\"https://player.example.com/e\" title=\"Player\">x</iframe><iframe src=\"https://doubleclick.net/ad\"></iframe><iframe src=\"/local\"></iframe>",
      "A/v.mp4⏎p0→0,264→Video⏎Ahttps://www.example.com/a.mp3⏎p0→0,520→Sound (example.com)⏎Ahttps://player.example.com/e⏎p0→0,776→Player (player.example.com)⏎"

  test "list items carry their mark and depth; quotes their depth; preformatted text its lines":
    same "<ul><li>one<li>two<ul><li>deep</li></ul></li></ul><ol start=\"3\"><li>three</li><li>four</li></ol><dl><dt>Term</dt><dd>Def</dd></dl>",
      "l1→→•␁one⏎l1→→•␁two⏎l2→→•␁deep⏎l129→→3.␁three⏎l1→→4.␁four⏎w129→0,1→Term⏎w1→→Def⏎"
    same "<blockquote><p>quoted</p><blockquote>deeper</blockquote></blockquote>after",
      "p144→→quoted⏎p160→→deeper⏎p128→→after⏎"
    same "<pre>\n  line 1\n\tline 2 &lt;b&gt;\r\nend</pre><p>x<pre>y</pre>",
      "r128→→  line 1␋    line 2 <b>␋end⏎p128→→x⏎r128→→y⏎"

  test "a form's fields, each whole: a select with its options, a button with its words, a textarea with its text":
    same "<form action=\"/search\" method=\"POST\"><input type=\"text\" name=\"q\" placeholder=\"Find\"><input type=\"hidden\" name=\"h\" value=\"1\"><input type=\"checkbox\" name=\"c\" checked><input type=\"radio\" name=\"r\" value=\"a\"><select name=\"s\"><option value=\"1\">One</option><option selected>Two</option></select><textarea name=\"t\">\nhello\nthere</textarea><button name=\"go\" value=\"1\">Go <b>now</b></button><input type=\"submit\" value=\"Send\"><input type=\"password\" name=\"p\"><input type=\"file\" name=\"f\"></form>",
      "F1→/search⏎f0→0→text→0→q→→Find⏎f0→0→hidden→0→h→1→⏎f0→0→checkbox→1→c→on→⏎f0→0→radio→0→r→a→⏎f0→0→select→0→s→Two→→1→One→Two→Two⏎f0→0→textarea→0→t→hello␋there→⏎f0→0→submit→0→go→1→Go now⏎f0→0→submit→0→→Send→Send⏎f0→0→password→0→p→→⏎"
    same "<form><p>Before</p><button><img src=\"in.png\" alt=\"pic\"> Label</button><select name=\"s\"><option>a<option>b</select>after</form>",
      "F0→⏎p0→→Before⏎f128→0→submit→0→→→Label⏎i0→0→0→0→in.png→pic⏎f0→0→select→0→s→a→→a→a→b→b⏎p0→→after⏎"

  test "what is around the page is marked where it starts and ends, and the page's own part where it starts":
    same "<header><a href=\"/\">Home</a> <a href=\"/a\">About</a> <a href=\"/b\">Blog</a></header><nav aria-label=\"Main menu\"><a href=\"/1\">One</a><a href=\"/2\">Two</a></nav><div class=\"site-sidebar x\"><a href=\"/s\">S</a></div><main><h1>Title</h1><p>Body</p><aside>side</aside></main><footer>foot</footer>",
      "[0→Site header⏎A/⏎A/a⏎A/b⏎p0→0,256,4,0,5,512,10,0,11,768→Home About Blog⏎]0→1→13⏎[128→Main menu⏎A/1⏎A/2⏎p128→0,1024,3,0,4,1280→One Two⏎]1→0→6⏎[128→Sidebar⏎A/s⏎p128→0,1536→S⏎]2→1→1⏎M⏎h384→→Title⏎p0→→Body⏎[128→Sidebar⏎p128→→side⏎]3→0→0⏎[128→Footer⏎p128→→foot⏎]4→0→0⏎"
    same "<details><summary>More <b>info</b></summary><p>Inside</p></details><details open><summary>Open</summary>x</details>",
      "[0→⏎S0→More info⏎p0→→Inside⏎]0→0→0⏎[128→⏎S1→Open⏎p0→→x⏎]1→2→0⏎"
    same "<div role=\"navigation\"><a href=\"1\">a</a><a href=\"2\">b</a><a href=\"3\">c</a></div><div role=\"main\">m</div><section role=\"banner\">ban</section>",
      "[0→Navigation⏎A1⏎A2⏎A3⏎p0→0,256,1,0,2,512,3,0,4,768→a b c⏎]0→0→3⏎M⏎p128→→m⏎[0→Site header⏎p0→→ban⏎]1→1→0⏎"
    same "<ul class=\"nav-menu\"><li><a href=\"1\">a</a><li><a href=\"2\">b</a></ul><div class=\"wrap footer\"><main>in</main></div>",
      "[1→Navigation⏎A1⏎l1→0,256→•␁a⏎A2⏎l1→0,512→•␁b⏎]0→1→2⏎[128→Footer⏎M⏎p128→→in⏎"
    same "<nav></nav><p>after an empty one</p><aside><img src=\"a.png\"></aside>next",
      "[0→Navigation⏎]0→0→0⏎p0→→after an empty one⏎[128→Sidebar⏎i128→0→0→0→a.png→⏎]1→0→0⏎p128→→next⏎"

  test "an id names the block being written, or the next one to start":
    same "<p id=\"top\">para</p><h2 id=\"sec\">Sec</h2><a name=\"anchor\"></a><div id=\"content\">c</div><span id=\"tail\"></span>",
      "#top⏎p0→→para⏎#sec⏎h640→→Sec⏎M⏎#anchor⏎#content⏎p0→→c⏎#tail⏎"
    same "<p>start <b id=\"mid\">bold</b></p><hr id=\"rule\"><img id=\"pic\" src=\"a.png\">",
      "#mid⏎p0→0,0,6,1→start bold⏎#rule⏎-128⏎#pic⏎i128→0→0→0→a.png→⏎"

  test "the title, the base, the description, a soon refresh and a feed":
    same "<html><head><title> My  Page </title><base href=\"/base/\"><meta name=\"description\" content=\"About\nit\"><meta http-equiv=\"refresh\" content=\"5; url=/next\"><meta http-equiv=\"refresh\" content=\"60;url=/slow\"><link rel=\"alternate\" type=\"application/rss+xml\" href=\"/feed.xml\" title=\"Feed\"><link rel=\"stylesheet\" href=\"x.css\"></head><body>b</body></html>",
      "TMy Page⏎B/base/⏎DAbout it⏎R/next⏎E/feed.xml→Feed⏎p0→→b⏎"
    same "<script type=\"application/ld+json\">{\"articleBody\": \"The\nwhole text\"}</script><p>x</p>",
      "p0→→x⏎J{\"articleBody\": \"The whole text\"}⏎"

  test "any cut of a page gives the same records":
    check pages.len > 20
    for html in pages:
      let whole = digest(html)
      for piece in [1, 2, 3, 7, 61]:
        if digest(html, piece) != whole:
          checkpoint "pieces of " & $piece & ": " & html
          check digest(html, piece) == whole
      # Cut in two at every byte: a tag, an entity, an end tag or a letter split there waits for its other half.
      for cut in 1 ..< html.len:
        var d = initHtmlDigest()
        var records = ""
        discard d.push(html.toOpenArray(0, cut - 1), false, records)
        discard d.push(html.toOpenArray(cut, html.len - 1), true, records)
        if records != whole:
          checkpoint "cut at " & $cut & ": " & html
          check records == whole

  test "records come whole, and only when their element is":
    var d = initHtmlDigest()
    var records = ""
    check d.push("<p>One</p><p>Two <a href='/x'>li", false, records)
    check shown(records) == "p0→→One⏎A/x⏎" # the second paragraph is still being written; its link is one
    check d.push("nk</a> and a <form><button>Go", false, records)
    check shown(records) == "p0→→One⏎A/x⏎" # a button's record waits for its words, and what follows waits for it
    check d.push("</button></form>", true, records)
    check shown(records) == "p0→→One⏎A/x⏎F0→⏎p128→0,0,4,256,8,0→Two link and a⏎f128→0→submit→0→→→Go⏎"
    check d.push("<p>more</p>", true, records) # the page ended: nothing is added
    check shown(records).endsWith("→Go⏎")

  test "a page longer than is kept is cut, what is open closed":
    var d = initHtmlDigest(40)
    var records = ""
    let page = "<nav><ul><li>" & "word ".repeat(12) & "</li><li>second item</li></ul></nav><p>never</p>"
    check not d.push(page, true, records)
    check shown(records) == "[0→Navigation⏎l1→→•␁" & "word ".repeat(12).strip() & "⏎]0→0→0⏎X⏎"
    check not d.push("<p>more</p>", true, records)
    check shown(records).endsWith("X⏎")

  test "what a page sends that would end a record does not":
    same "<p title='a\tb'>tab\x0bvt\x01soh</p><a href='x\ny' title='t\nu'></a><img src='p.png' alt='a\nb'>",
      "Axy⏎p0→→tab vt soh⏎p128→0,256→t u⏎i0→0→0→0→p.png→a b⏎"
    same "<form><input name='a\tb' value='v\nw' placeholder='p\nq'></form>", "F0→⏎f0→0→text→0→a b→v␋w→p q⏎"

  test "megabytes of script and style cost what the page's words do":
    var page = "<html><head><style>" & "a{b:c}".repeat(100_000) & "</style></head><body><p>Words</p><script>"
    page.add "var x = '</p><p>not text';".repeat(100_000)
    page.add "</script><p>More</p></body></html>"
    check page.len > 3_000_000
    check shown(digest(page, 16384)) == "p0→→Words⏎p128→→More⏎"
