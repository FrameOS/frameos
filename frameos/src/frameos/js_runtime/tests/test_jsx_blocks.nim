import std/[strutils, tables, unittest]
import pixie
import pixie/fileformats/svg

import frameos/js_runtime/burrito
import frameos/js_runtime/runtime
import frameos/js_runtime/jsx
import frameos/js_runtime/jsx_native

# quickts' block lowering (docs/quickts.md "Blocks"): `__frameosBlock`, the
# JavaScript reference and jsx_native.nim's, makes the elements the factory makes, and
# the walker builds the same nodes from their templates, taking back the
# ones whose values did not change.

proc dump(n: SvgNode): string =
  if n.isNil:
    return "nil"
  if n.tag.len == 0:
    return "'" & n.text & "'"
  result = "<" & n.tag
  for (k, v) in n.attrs:
    result.add " " & k & "=" & v
  if not n.image.isNil:
    result.add " [image]"
  result.add ">"
  for c in n.children:
    result.add dump(c)
  result.add "</" & n.tag & ">"

type Js = object
  js: QuickJS
  memo: JsxMemo
  images: Table[int, Image]

proc newJs(source: string, blocks, native: bool): Js =
  result.js = newQuickJS()
  result.images[7] = newImage(1, 1)
  discard result.js.eval(sceneJsPrelude, "prelude.js")
  if native:
    check result.js.installNativeJsx()
  elif blocks:
    discard result.js.eval(jsxBlockReferenceJs, "blocks.js") # the reference, in no prelude
  let flags = (JS_EVAL_FLAG_TYPESCRIPT or (if blocks: JS_EVAL_FLAG_JSX_BLOCKS else: JS_EVAL_FLAG_JSX)).cint
  discard result.js.eval(source, "app.tsx", flags)

proc make(j: var Js, call = "__make()", reuse = true): SvgNode =
  discard j.js.eval("globalThis.__frameosRender = (globalThis.__frameosRender | 0) + 1; globalThis.__out = " & call)
  let ctx = j.js.context
  let global = JS_GetGlobalObject(ctx)
  let value = JS_GetPropertyStr(ctx, global, "__out")
  result = jsxNode(ctx, value, addr j.images, if reuse: addr j.memo else: nil)
  JS_FreeValue(ctx, value)
  JS_FreeValue(ctx, global)

proc close(j: var Js) =
  releaseJsxMemo(j.memo, j.js.context)
  j.js.close() # QuickJS asserts that nothing it allocated is still held

const corpus = """
const Card = (p: any) => <section className="card" title={p.title}>{p.children}</section>;
const Ns = { In: (p: any) => <em data-z={p.z}>{p.children}</em> };
const Memo = memo((p: any) => <b className={p.c}>{p.c}</b>);
const img = { __frameosType: "imageRef", id: 7 };
const o = { a: 1, className: "spread", children: "from spread" };
const pts = [1, 2, 3, 4];
const T = "span";
function __make(n = 1) {
  const items = ["x", "y", "z"].slice(0, n + 1);
  return (
    <div className="flex gap-2" data-n={n} hidden flag={false} ratio={1.5} big={1e3} key="k" ref={null}>
      text {n} &amp; more{" "}{null}{undefined}{true}{false}{0}
      <Card title={`t${n}`}><i>{n > 0 && <u>yes</u>}</i>{n > 5 ? <s /> : "no"}</Card>
      <Ns.In z={n}><Card title="inner" /></Ns.In>
      <>
        <a href="#x" onClick={() => n} onSomething={() => n} notAHandler={() => n} />
        {items.map((t, i) => <li key={t} className={i === n ? "on" : "off"}>{t}{i}</li>)}
      </>
      <p {...o} b={2} className="after" />
      <p className="before" {...o} />
      <p children="attr only" />
      <p children="attr then jsx">jsx wins</p>
      <img src={img} icon=<i /> />
      <svg viewBox="0 0 10 10" strokeWidth={2}><polyline points={pts} /></svg>
      <T a={1}>{[[1, [2, "three"]], <i />]}</T>
      <Memo c={"m" + (n % 2)} />
      {Memo({ c: "direct" })}
    </div>
  );
}
"""

# The same without the shapes read off their props (a spread, a `children`
# attribute, an element as an attribute's value): built from the template.
const plainCorpus = corpus.multiReplace(
  ("      <p {...o} b={2} className=\"after\" />\n", ""),
  ("      <p className=\"before\" {...o} />\n", ""),
  ("      <p children=\"attr only\" />\n", ""),
  ("      <p children=\"attr then jsx\">jsx wins</p>\n", ""),
  (" icon=<i />", ""))

suite "jsx blocks":
  test "the template is read, not the props, where it can be":
    doAssert plainCorpus.len < corpus.len - 150
    var j = newJs(plainCorpus, blocks = true, native = true)
    discard j.make("__make(1)")
    check j.js.eval("typeof __out.__frameosSite") == "object" # its props were never built
    check j.js.eval("Object.getOwnPropertyDescriptor(__out, 'props').get !== undefined") == "true"
    j.close()

  for source in [corpus, plainCorpus]:
   test "the four ways build the same nodes and the same elements (" & $source.len & " B)":
    var dumps, jsons: seq[string]
    for blocks in [false, true]:
      for native in [false, true]:
        var j = newJs(source, blocks, native)
        var d = ""
        for n in [0, 1, 2]:
          d.add dump(j.make("__make(" & $n & ")", reuse = false)) & "\n"
        dumps.add d
        jsons.add j.js.eval("JSON.stringify([__make(0), __make(1)])")
        check j.js.eval("Object.keys(__out).join()") == "type,props"
        j.close()
    check "<li class=on>'y''1'</li>" in dumps[0]
    check "[image]" in dumps[0]
    check "<section class=card title=t1><i><u>'yes'</u></i>'no'</section>" in dumps[0]
    for i in 1 ..< dumps.len:
      check dumps[i] == dumps[0]
      check jsons[i] == jsons[0]

  test "a render with nothing changed takes the whole tree back, its handlers the new closures":
    var j = newJs("""
      let sel = 0, renders = 0;
      const items = ["a", "b", "c"];
      function __make() {
        const r = ++renders;
        return (
          <div className="list">
            {items.map((t, i) => (
              <div key={t} className={i === sel ? "on" : "off"} onClick={() => { globalThis.__clicked = t + r }}>
                <span>{t}</span>
              </div>
            ))}
            <p>{`sel ${sel}`}</p>
          </div>
        );
      }
    """, blocks = true, native = true)
    let first = j.make()
    let second = j.make()
    check first == second # the same node: nothing was walked
    discard j.js.eval("__frameosHandlers[1]()")
    check j.js.eval("__clicked") == "b2"
    discard j.js.eval("sel = 1")
    let third = j.make()
    check third != second
    check dump(third).contains("<div class=on on-click=1>")
    check third.children[0] != second.children[0] # its class changed
    check third.children[2] == second.children[2] # the third row did not
    check third.children[3] != second.children[3] # the text did
    discard j.js.eval("__frameosHandlers[2]()")
    check j.js.eval("__clicked") == "c3"
    check j.make() == third
    j.close()

  test "a component's output is what is compared, not its props":
    var j = newJs("""
      let label = "one";
      const Label = () => <b>{label}</b>;
      function __make() { return <div><Label /></div>; }
    """, blocks = true, native = true)
    let first = j.make()
    discard j.js.eval("label = 'two'")
    let second = j.make()
    check first != second
    check dump(second) == "<div><b>'two'</b></div>"
    check j.make() == second
    j.close()

  test "an element the factory made, or one changed by hand, is walked again":
    var j = newJs("""
      const plain = { type: "i", props: { className: "x" } };
      function __make() { return <div>{plain}</div>; }
    """, blocks = true, native = true)
    let first = j.make()
    discard j.js.eval("plain.props.className = 'y'")
    let second = j.make()
    check first != second
    check dump(second) == "<div><i class=y></i></div>"
    j.close()

  test "an element is made lazily; one whose props were read is read off them":
    var j = newJs("""
      let calls = 0;
      const Count = (p: any) => { calls++; return <b>{p.n}</b>; };
      function __make() {
        const e = <div><i className="x" /><span><Count n={1} /></span></div>;
        if ((globalThis as any).mut) e.props.children[0].props.className = "y";
        return e;
      }
    """, blocks = true, native = true)
    check dump(j.make()) == "<div><i class=x></i><span><b>'1'</b></span></div>"
    check j.js.eval("calls") == "1" # a component inside a lazy element ran once, at once
    check j.js.eval("Object.getOwnPropertyDescriptor(__out, 'props').get !== undefined") == "true"
    discard j.js.eval("globalThis.mut = true")
    check dump(j.make()) == "<div><i class=y></i><span><b>'1'</b></span></div>"
    check j.js.eval("calls") == "2"
    check j.js.eval("__out.__frameosSite") == "undefined" # read, so no longer a block's
    j.close()

  test "frameos.draw's walk reads templates and keeps nothing":
    var j = newJs("function __make() { return <div><p>{1}</p></div>; }", blocks = true, native = true)
    discard j.js.eval("globalThis.__out = __make()")
    let ctx = j.js.context
    let global = JS_GetGlobalObject(ctx)
    let value = JS_GetPropertyStr(ctx, global, "__out")
    let a = jsxNode(ctx, value, addr j.images, addr j.memo, drawing = true)
    let b = jsxNode(ctx, value, addr j.images, addr j.memo, drawing = true)
    check a != b
    check dump(a) == "<div><p>'1'</p></div>"
    JS_FreeValue(ctx, value)
    JS_FreeValue(ctx, global)
    j.close()
