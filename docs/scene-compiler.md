# Scenes as compiled programs

A scene's diagram (the nodes and edges in scenes.json) runs as one
JavaScript program. `frameos/src/frameos/scene_compiler.nim` writes it when
the scene first starts; QuickJS compiles it once; the scene then runs it.
Nothing changed in scenes.json or on either control plane: the program is
made on the device, from the same JSON, on every host (Linux, the ESP32, the
wasm preview).

What it replaced: `interpreter.runNode`, which walked the graph on every run
(a table lookup per node and per edge, a `visited` table allocated per call,
each node's cache configuration read out of its JSON on every pass) and
wrapped each code node in a JSON envelope, stringified in JavaScript and
parsed again in Nim, every call. All of the graph's shape is decided once
now; what is left at run time is a function per node calling the functions
of the nodes that feed it.

## The program

```js
"use strict";(__N)=>{let __at=0;
const console={…}, __S=new Proxy(…state…), __C=new Proxy(…context…), __E={};
function __c42(A){const items=A["items"];return((state,args,context)=>(
items.map(i => i.title)
))(__S,A,__C)}
return(N=>{const{g,r,s,e,p,q,t,j,v,…}=N;
function i7(){try{s(7,"image",g3())}catch(x){e(0,7,"image",3,x)}}
function g3(){return g(3,X(3,__x0))}
function f7(V){const P=p(7);i7();q(7,P);r(7);f8(V)}
…
return{ev(n){…},flow(i){…},data(i){…}}})(__N)}
```

- **Two scopes.** The outer one is what the scene's own code sees: `state`,
  `args` and `context` (handed to every snippet), `console`, and the
  snippets as functions (`__c<id>` a code node, `__i<n>` an inline input,
  `__x<n>` a cache expression). The glue is an inner function; its natives
  have one-letter names a snippet cannot reach (a global `d` in a snippet is
  still a ReferenceError).
- **Per node:** `g<id>()` returns the node's value; `f<id>(V)` runs it in a
  flow and calls the next node's (only for nodes a flow can reach); an app
  with inputs gets `i<id>()`, which sets its fields from their producers.
- **Three ways in:** `ev(event)` runs the event's listeners (the filters
  checked by `N.m`, a listener filtered out that leaves none matched logged
  by `N.nl`) and says how many ran; `flow(id)` is an app's `execNode`
  (logic/ifElse, render/split, data/newImage); `data(id)` is `getDataNode`.
- **Decided at compile time:** cycles of a node's own inputs (those nodes
  keep themselves in a set while they work, and a read of one already there
  throws "depends on itself"), producer chains deeper than 64 (refused,
  naming the node), cycles of `next` edges (logged as `interpreter:graph:cycle`
  where the flow comes round again), the render flow that is one node
  (`ExecutionContext.wholeFrame`), the events the scene listens for
  (`sceneListensTo`).

## Values

A node's value is the runtime's own `Value`, kept by the scene in
`scene.values`; the program passes its handle (index + 1, 0 for nothing). An
image, a spooled body, a colour or an integer goes from one app to the next
exactly as it did. Only a code node's arguments become JavaScript values
(`N.j`, `valueToJS`) and its result a `Value` again (`N.v`, `jsValueToValue`
with the type its first output declares), as they always did: no JSON on the
way. The handles live for the run: `scene.values` is emptied when the
outermost run of the program ends.

## The natives (`interpreter.nim`, `programOp`)

`g`/`r`/`s` get, run and set an app (the node cache, keyed by what `s` set,
is `g`'s); `p`/`q` offer and withdraw the image hints the planner decided
(decode target, bounds) and pay the background owed; `t` reads a state node;
`d` a dispatch node; `ss`/`sc` a scene node's state and its run; `cq`/`cs`/`ka`
a code node's cache; `e`, `z`, `xe`, `le`, `nl`, `nf`, `cy` the error paths
and their log lines; `n0`/`n1` the debug profile (compiled in when
`frameConfig.debug` is on, the program made again when it changes). Each
takes node ids, strings and handles. The interpreter clock stops while a
native runs (an app may wait on the network); the run's wall-clock deadline
does not.

A Nim exception a native throws crosses the program as a JavaScript error
carrying its message and stack; one no JavaScript caught leaves the program
as itself (a `JsAppError` stays one).

## One context for every program

All scene programs run in one QuickJS context (`js_runtime/runtime.nim`,
`ensureSceneJs`): each program is a closure over natives that carry their own
scene. A frame pays for one context, not one per scene with code; a scene
without code of its own (a wrapper, a split's panels) costs only its program
(about 8 KB for a two-node scene on a 64-bit host, 1.7 KB a node beyond).
When the context is replaced (an out-of-memory abort, new `js` ceilings in
frame.json) every scene evaluates its program again on its next run. The JS
apps keep their own runtimes and their scene's heap budget.

## What changed for a scene

- A code node that runs past the interpreter-time budget ends the run of
  the program it is in (QuickJS makes the interrupt uncatchable), logged as
  the listener's error. Before, that node alone was defaulted and the flow
  went on.
- An inline argument of a code node that throws gets its type's zero and is
  logged as `interpreter:codeArg:error:inlineCode`, as a producer that fails
  is; before, it was `null` and an `interpreter:jsError`.
- A syntax error in a code node or an inline input fails the scene when it
  starts, naming the node (`interpreter:jsCompileError`), as before. One in a
  cache expression costs only that node its cache: the program is made again
  with the expression replaced by `interpreter:cacheExpression:error`.
- Error locations name the snippet: `<frameos:code:42>:3:18`, line and column
  in the code as written.

## Next

- The planner (`planner.nim`) still works on the graph in Nim at scene
  start; it could decide in the compiler instead, and the edge tables it
  reads (`appInputsForNodeId`) would go.
- The scene loader still parses scenes.json with jsony into typed nodes; the
  compiler only needs the JSON.
- JS apps could run inside the program's context instead of a runtime each
  (~150 KB of PSRAM per JS app node on an ESP32).
