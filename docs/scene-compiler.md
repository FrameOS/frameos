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
const __F=((__N)=>{
function __c42(A){const items=A["items"];return((state,args,context)=>(
items.map(i => i.title)
))(__S,A,__C)}
return{__c42}})();
return(N=>{const{__c42}=__F;const{g,r,s,ei,p,q,t,j,v,…,L}=N;
function i7(){try{s(7,"image",g3())}catch(x){EI(0,7,"image",3,x)}}
function g3(){let h;h=g(3);return h}
function f7(V){const P=p(7);i7();q(7,P);r(7);;f8(V)}
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
  checked by the `m` native; when every listener filtered the event out, the
  program says so) and says how many ran; `flow(id)` is an app's `execNode`
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
(decode target, bounds) and pay the background owed; `ei` paints a failed
producer's error into an image field; `t` reads a state node; `d` sends a
dispatch node's payload; `ss`/`sc` set a scene node's state and run it;
`cq`/`cs`/`ka` are a code node's cache; `j`/`v` convert, `zv` gives a type's
zero; `n0`/`n1` are the debug profile (compiled in when `frameConfig.debug`
is on, the program made again when it changes); `L` writes a log line.
Each takes node ids, strings and handles. The interpreter clock stops while
a native runs (an app may wait on the network); the run's wall-clock
deadline does not.

The log lines (an input that failed, a defaulted argument, a snippet's
error with its location put back into the snippet, a listener's error, a
filtered event, a cycle) are built by the program and handed to `L`, which
adds the scene's id: their text costs the program's memory, not the
firmware's flash.

A Nim exception a native throws crosses the program as a JavaScript error
carrying its message and stack; one no JavaScript caught leaves the program
as itself (a `JsAppError` stays one).

## One runtime, a context per scene with code

All scene programs run in one QuickJS runtime (`js_runtime/runtime.nim`,
`ensureSceneJs`): one heap, one atom table, one garbage collector, one heap
budget for programs. A scene with code of its own (a code node, an inline
input, a cache expression) gets a context of its own in that runtime: a realm
with its own globals and built-ins, so what one scene's code does to
`globalThis` or `Array.prototype` no other scene sees. A scene without code
(a scene of Nim apps, a split's wrapper) runs its program, which the
compiler wrote and nothing untrusted is in, in the runtime's first context,
shared.

Measured on a 64-bit host: a runtime with its first context is 155 KB, one
more context in it 40 KB. On main every scene with code paid the 155 KB (and
a scene with none paid nothing); here the frame pays the runtime once, a
scene with code 40 KB more, a scene without only its program (about 8 KB for
two nodes, 1.7 KB a node beyond).

The context closes with its scene, and the garbage collector runs right
after so the next scene gets the memory. When the runtime is replaced (an
out-of-memory abort) every scene sets its context up and evaluates its program
again on its next run; frame.json's `js` ceilings are applied to the runtime
in place. The JS apps keep their own runtimes and their scene's heap budget.

## What changed for a scene

- A code node that runs past the interpreter-time budget ends the run of
  the program it is in (QuickJS makes the interrupt uncatchable), logged as
  the listener's error. Before, that node alone was defaulted and the flow
  went on.
- An inline argument of a code node that throws gets its type's zero and is
  logged as `interpreter:codeArg:error:inlineCode`, as a producer that fails
  is; before, it was `null` and an `interpreter:jsError`.
- A syntax error in a code node or an inline input fails the scene when it
  starts, naming the node (`interpreter:jsCompileError`), as before: the
  snippet the error's line is in, or the one just before it (a snippet that
  leaves a bracket open fails on the line after it). One in a cache
  expression costs only that node its cache: the program is made again with
  the expression left out, and `interpreter:cacheExpression:error` on every
  run.
- Error locations name the snippet: `<frameos:code:42>:3:18`, line and column
  in the code as written.

## Next

- The planner (`planner.nim`) still works on the graph in Nim at scene
  start (on `scene.appInputs`, the edges into fields); it could decide in the
  compiler instead.
- Code node to code node, a value still goes through a Nim `Value` (with the
  type the producer declares): passing the JavaScript value along where the
  conversion is the identity would make a scene that hands big JSON between
  code nodes much faster (as it is, about as fast as before).
- JS apps could run inside the program's context instead of a runtime each
  (~150 KB of PSRAM per JS app node on an ESP32).
