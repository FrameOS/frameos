## The scene compiler: a scene's diagram, as scenes.json holds it, turned into
## one JavaScript program that QuickJS compiles once and the scene then runs
## (docs/scene-compiler.md).
##
## The interpreter used to walk the graph on every run: a table lookup per
## node and per edge, the cache configuration read out of the node's JSON on
## every pass, a JSON envelope each way around every code node. The graph does
## not change between deploys, so all of that is decided here, once: the flow
## after each node, which node feeds which field, which listeners an event
## reaches and what they filter on, where a cycle is. What is left at run time
## is the program: a function per node, calling the functions of the nodes
## that feed it.
##
## The values that travel between nodes stay the runtime's own (a Nim `Value`
## held by the scene, the program passing small integer handles), so an image,
## a spooled body or a colour reaches an app exactly as it did. Only a code
## node's arguments and result cross into JavaScript values, as they always
## did. The natives the program calls (`N.g`, `N.s`, …) are interpreter.nim's
## (`programOp`), handed to it through the kit (`ProgramKit`).
##
## Pure: no QuickJS here, so the host tests read what it writes.

import std/[json, tables, strutils]
import frameos/types
from frameos/node_config import readCacheConfig, jBoolOr
from frameos/values import eventFilterValue

{.push boundChecks: off, overflowChecks: off.}

type
  Input = object
    field: string
    source: int        ## the producer's node id, for a wired input
    snippet: string    ## the code, for an inline one
    inline: bool

  Graph = object
    nodes: seq[DiagramNode]
    index: Table[int, int]          ## node id -> position in `nodes`
    next: Table[int, int]
    appInputs: Table[int, seq[Input]]
    codeInputs: Table[int, seq[Input]]
    fieldTargets: seq[int]

const
  MaxProducerDepth* = 64
    ## A producer chain deeper than this is refused, naming the node (a scene
    ## error, not a stack overflow on a board's render task).

proc nodeType(node: DiagramNode): string {.inline.} = node.nodeType

proc keyword(node: DiagramNode): string =
  if node.data.isNil or node.data.kind != JObject: "" else: node.data{"keyword"}.getStr()

proc normalizeExpressionSnippet*(source: string): string =
  ## The UI has saved some expression snippets with a trailing comma or
  ## semicolon, which are invalid once wrapped as an arrow function's body.
  result = source.strip()
  while result.len > 0 and result[^1] in {',', ';'}:
    result.setLen(result.len - 1)
    result = result.strip()

proc codeSnippet*(node: DiagramNode): string =
  ## A code node's JavaScript: `codeJS`, else `code` (a Nim scene's, fed to
  ## QuickJS as it is, as before), else nothing.
  if node.data.isNil or node.data.kind != JObject: return ""
  let js = node.data{"codeJS"}
  if not js.isNil and js.kind == JString:
    return normalizeExpressionSnippet(js.getStr())
  let nim = node.data{"code"}
  if not nim.isNil and nim.kind == JString:
    return nim.getStr()
  ""

proc toJsIdent*(name: string): string =
  if name.len == 0: return "_"
  for i, ch in name:
    if ch in {'a'..'z', 'A'..'Z', '_', '$'} or (i > 0 and ch in {'0'..'9'}):
      result.add ch
    else:
      if i == 0: result.add '_'
      result.add '_'

proc addInput(table: var Table[int, seq[Input]], target: int, input: Input) =
  ## One input per field and kind, the last edge winning, as the tables the
  ## interpreter kept did; in the order the edges came.
  let list = addr table.mgetOrPut(target, @[])
  for existing in list[].mitems:
    if existing.field == input.field and existing.inline == input.inline:
      existing = input
      return
  list[].add input

proc buildGraph(nodes: seq[DiagramNode], edges: seq[DiagramEdge]): Graph =
  result.nodes = nodes
  for i, node in nodes:
    result.index[node.id.int] = i
  for edge in edges:
    let sh = edge.sourceHandle
    let th = edge.targetHandle
    let target = edge.target.int
    if sh == "next" and th == "prev":
      result.next[edge.source.int] = target
    elif th.startsWith("fieldInput/") or th.startsWith("codeField/"):
      let field = th.split("/")[1]
      var input = Input(field: field, source: edge.source.int)
      if sh.startsWith("code/"):
        input.inline = true
        input.snippet = sh.substr(5)
      elif sh != "fieldOutput" and sh != "stateOutput":
        continue
      if th[0] == 'f': result.appInputs.addInput(target, input)
      else: result.codeInputs.addInput(target, input)
    elif sh.startsWith("field/") and th == "prev":
      result.fieldTargets.add target

proc has(g: Graph, id: int): bool {.inline.} = g.index.hasKey(id)
proc node(g: Graph, id: int): DiagramNode {.inline.} = g.nodes[g.index[id]]

# ------------------------------------------------------------------ analysis

proc dataProducers(g: Graph, id: int): seq[int] =
  for input in g.appInputs.getOrDefault(id):
    if not input.inline and g.has(input.source): result.add input.source
  for input in g.codeInputs.getOrDefault(id):
    if not input.inline and g.has(input.source): result.add input.source

proc cyclicDataNodes(g: Graph): seq[bool] =
  ## The nodes on a cycle of the data graph (an input fed, through any number
  ## of producers, by the node itself): Tarjan's components, iteratively.
  let n = g.nodes.len
  result = newSeq[bool](n)
  var index = newSeq[int](n)
  var low = newSeq[int](n)
  var onStack = newSeq[bool](n)
  var stack: seq[int]
  var counter = 1
  var succ = newSeq[seq[int]](n)
  for i in 0 ..< n:
    for p in g.dataProducers(g.nodes[i].id.int):
      succ[i].add g.index[p]
  for root in 0 ..< n:
    if index[root] != 0: continue
    var work: seq[(int, int)] = @[(root, 0)]
    while work.len > 0:
      let (v, at) = work[^1]
      if at == 0:
        index[v] = counter
        low[v] = counter
        inc counter
        stack.add v
        onStack[v] = true
      if at < succ[v].len:
        work[^1] = (v, at + 1)
        let w = succ[v][at]
        if index[w] == 0:
          work.add((w, 0))
        elif onStack[w]:
          low[v] = min(low[v], index[w])
        continue
      discard work.pop()
      if work.len > 0:
        let parent = work[^1][0]
        low[parent] = min(low[parent], low[v])
      if low[v] == index[v]:
        var members: seq[int]
        while true:
          let w = stack.pop()
          onStack[w] = false
          members.add w
          if w == v: break
        if members.len > 1 or v in succ[v]:
          for w in members: result[w] = true

proc producerDepths(g: Graph, cyclic: seq[bool]): seq[int] =
  ## How deep each node's producer chain goes (1 = no producers), outside the
  ## cycles, which are guarded at run time instead.
  let n = g.nodes.len
  result = newSeq[int](n)
  var visiting = newSeq[bool](n)
  proc depth(g: Graph, i: int, cyclic: seq[bool], depths: var seq[int], visiting: var seq[bool]): int =
    if depths[i] > 0: return depths[i]
    if cyclic[i] or visiting[i]: return 1
    visiting[i] = true
    var deepest = 0
    for p in g.dataProducers(g.nodes[i].id.int):
      deepest = max(deepest, depth(g, g.index[p], cyclic, depths, visiting))
    visiting[i] = false
    depths[i] = deepest + 1
    depths[i]
  for i in 0 ..< n:
    discard depth(g, i, cyclic, result, visiting)

proc flowCycleNodes(g: Graph): seq[bool] =
  ## The nodes on a cycle of `next` edges. Each node has at most one next, so
  ## walking from every node finds them.
  let n = g.nodes.len
  result = newSeq[bool](n)
  var state = newSeq[int](n) # 0 new, 1 on the current walk, 2 done
  for start in 0 ..< n:
    if state[start] != 0: continue
    var path: seq[int]
    var at = start
    while true:
      if state[at] == 1:
        var k = path.len - 1
        while k >= 0:
          result[path[k]] = true
          if path[k] == at: break
          dec k
        break
      if state[at] == 2: break
      state[at] = 1
      path.add at
      let id = g.nodes[at].id.int
      if not g.next.hasKey(id) or not g.has(g.next[id]): break
      at = g.index[g.next[id]]
    for p in path: state[p] = 2

proc flowNodes(g: Graph): seq[bool] =
  ## The nodes a flow can reach: what an event node or a `field/<name>` edge
  ## (an app's execNode) leads to, and the chains of `next` from there, and
  ## any node a `next` edge touches. The others are only ever read for their
  ## value, and get no flow function.
  result = newSeq[bool](g.nodes.len)
  var work: seq[int]
  for i, node in g.nodes:
    if node.nodeType == "event" or g.next.hasKey(node.id.int):
      work.add i
  for target in g.fieldTargets:
    if g.has(target): work.add g.index[target]
  for _, target in g.next:
    if g.has(target): work.add g.index[target]
  while work.len > 0:
    let i = work.pop()
    if result[i]: continue
    result[i] = true
    let id = g.nodes[i].id.int
    if g.next.hasKey(id) and g.has(g.next[id]):
      work.add g.index[g.next[id]]

# ------------------------------------------------------------------ emitting
#
# The program has two scopes. The outer one is what the scene's own code
# sees: `state`, `args` and `context` (handed to every snippet), `console`,
# and the snippets themselves, as functions named `__c<id>` (a code node),
# `__i<n>` (an inline input) and `__x<n>` (a cache expression). They are
# defined in a function whose own `__K` (nothing) hides the kit and so the
# natives: scene code is untrusted, and a native it kept could be called
# after its scene is gone. The glue lives in an inner function with the
# natives under short names, and writes its own log lines (they cost the
# program's memory, not the firmware's flash).
#
# What is the same in every program is not in it: it is the kit below,
# evaluated once in each context programs run in (js_runtime/runtime.nim
# `programKit`, bytecode built into the ESP32's image) and handed to every
# program evaluated there. Parsing it in each program was most of a small
# scene's first load: ~105 µs of a three-node scene's 120 µs on a laptop,
# about 60 ms on an ESP32-S3.

const ProgramKit* = "\"use strict\";(N)=>{const T={a:0},\n" &
  # `T.a` is the node whose code runs, which a console line names.
  "__L=(l,a)=>N.L({event:\"interpreter:jsConsole\",level:l,nodeId:T.a,args:a});\n" &
  # What the snippets see.
  "return{console:{log:(...a)=>__L(\"log\",a),warn:(...a)=>__L(\"warn\",a),error:(...a)=>__L(\"error\",a)},\n" &
  "__S:new Proxy({},{get:(_,k)=>typeof k==\"string\"?N.st(k):undefined}),__C:new Proxy({},{get:(_,k)=>typeof k==\"string\"?N.cx(k):undefined}),__E:{},\n" &
  # The glue `G`, given the natives and its helpers, which read the
  # program's snippet table (`SN` where each snippet is, `SC` their texts).
  "glue(G,SN,SC){const{L,zv,v,j,ei}=N,MS=x=>x&&x.message||String(x),ST=x=>x&&(x.nimStack||x.stack)||String(x),\n" &
  # A location in the program, put back into the snippet it is in.
  "MAP=t=>String(t).replace(/<frameos:scene>:(\\d+)/g,(w,l)=>{for(const[a,b,n]of SN)if(l>=a&&l<=b)return n+\":\"+(l-a+1);return w}),\n" &
  # A snippet's error: logged with its location, and the zero of the type
  # its value was to have; `D` names the arguments defaulted on the way.
  "JE=(id,sr,x,ty,D)=>{const e={event:\"interpreter:jsError\",nodeId:id,message:MAP(MS(x)),stack:MAP(ST(x))};if(sr)e.sourceNodeId=sr;if(D){const p=[],a=[];for(let i=0;i<D.length;i+=2){const t=MS(D[i+1]);p.push(D[i]+\" failed: \"+(t.length>200?t.slice(0,200)+\"...\":t));a.push({arg:D[i],error:t})}e.message+=\" (defaulted inputs: \"+p.join(\"; \")+\")\";e.defaultedArgs=a}L(e);return zv(ty,1)},\n" &
  "I=(id,sr,f)=>{T.a=id;try{return v(f(),\"\")}catch(x){return JE(id,sr,x,\"\")}},X=(id,sr,f)=>{T.a=id;try{return[f()]}catch(x){JE(id,sr,x,\"\");return[null]}},A=H=>{const a={};for(const k in H)a[k]=j(H[k]);return a},\n" &
  # An input whose producer failed (kind 0 an app's wired input, 1 inline,
  # 2 a dispatch node's, 4 a scene node's): logged, and an app's image field
  # gets the error painted.
  "EI=(k,id,f,pr,x)=>{const e={event:[\"interpreter:setField:error\",\"interpreter:setField:error:inlineCode\",\"interpreter:dispatch:setField:error\",0,\"interpreter:setChildState:error\"][k],nodeId:id,input:f,error:MS(x),stacktrace:ST(x)};if(k==4)e.parentSceneId=1;if(k==1)e.code=SC[pr];else e.producer=pr;L(e);if(!k)ei(id,f,e.error)},\n" &
  # A code node's argument whose producer failed: its type's zero.
  "ZA=(id,a,pr,x,ty)=>{const h=zv(ty,0),e={event:\"interpreter:codeArg:error\",nodeId:id,arg:a,error:MS(x),stacktrace:ST(x),defaulted:true,defaultValue:j(h)};if(pr<0){e.event+=\":inlineCode\";e.code=SC[-1-pr]}else e.producer=pr;L(e);return h},\n" &
  "LE=(n,id,x)=>L({event:\"runEventInterpreted:error\",contextEvent:n,nodeId:id,error:MS(x),stacktrace:ST(x)}),NF=i=>L({event:\"interpreter:nodeNotFound\",nodeId:i}),CY=(id,V)=>L({event:\"interpreter:graph:cycle\",startNodeId:V.values().next().value,atNodeId:id}),XC=(id,k,m)=>{L({event:\"interpreter:cacheExpression:error\",nodeId:id,code:SC[k],error:m})},\n" &
  # Every listener filtered the event out: said, with the payload where the
  # event's may be logged (a key's never is, event_log.nim).
  "NL=(n,w)=>L({event:\"runEvent:noListenerMatched\",contextEvent:n,expected:w,error:'\"'+n+'\" reached the scene but every listener filtered it out'+(w.length?\" (nodes want \"+w.join(\", \")+\")\":\"\")},1);\n" &
  "return G(N,{T,JE,I,X,A,EI,ZA,LE,NF,CY,XC,NL})}}}\n"

const ProgramHead = "\"use strict\";(__K)=>{const{console,__S,__C,__E}=__K;\n" &
  "const __F=((__K)=>{\n"
const SnippetLines = 3
  ## The line of the first snippet function's header (its snippet starts on
  ## the next one).
const GlueHead = "const{g,r,s,p,q,t,j,v,d,ss,sc,ka,cq,cs,m,bg,n0,n1,lo}=N,{T,JE,I,X,A,EI,ZA,LE,NF,CY,XC,NL}=Z;\n"

type Emitter = object
  names: seq[string] ## the snippet functions, handed from their scope to the glue's
  snip: string       ## the outer scope: the scene's own code
  glue: string       ## the inner one
  snipLines: int     ## lines in `snip` so far
  snippets: seq[ProgramSnippet]

proc add(e: var Emitter, s: string) {.inline.} = e.glue.add s
proc addInt(e: var Emitter, i: int) {.inline.} = e.glue.add $i
proc addStr(e: var Emitter, s: string) =
  ## A JavaScript string literal (JSON's escaping is JavaScript's).
  escapeJson(s, e.glue)

proc put(e: var Emitter, fragment: string, id: int) =
  ## `fragment` with every `#` the node's id: most of a node's code is one
  ## call (the program's own text never needs a `#` of its own).
  let n = $id
  for c in fragment:
    if c == '#': e.glue.add n else: e.glue.add c

proc addSource(e: var Emitter, node: DiagramNode) =
  ## The id the scene JSON gave the node, which the editor puts errors on, or 0.
  let source = node.data{"__frameosSourceNodeId"}
  if not source.isNil and source.kind == JString: e.addStr source.getStr() else: e.add "0"

proc snippetFunction(e: var Emitter, nodeId: int, kind: ProgramSnippetKind, name, snippet: string,
    header = ""): string =
  ## A snippet as a function of the outer scope (`header` for a code node's);
  ## its name, for the glue to call.
  result = (if kind == psCode: "__c" & $nodeId elif kind == psCache: "__x" & $e.snippets.len
    else: "__i" & $e.snippets.len)
  e.names.add result
  if header.len > 0:
    e.snip.add header
  else:
    e.snip.add "const "
    e.snip.add result
    e.snip.add "=(state=__S,args=__E,context=__C)=>(\n"
  let first = SnippetLines + e.snipLines + 1
  let lines = snippet.count('\n')
  e.snippets.add ProgramSnippet(nodeId: nodeId.NodeId, kind: kind, name: name, snippet: snippet,
    firstLine: first, lastLine: first + lines)
  e.snip.add snippet
  e.snip.add(if header.len > 0: "\n))(__S,A,__C)}\n" else: "\n);\n")
  e.snipLines += lines + 3

proc addProducer(e: var Emitter, input: Input, node: DiagramNode) =
  ## The value for one input: its producer's, or its inline snippet's (`I`:
  ## an error in it is logged and becomes nothing, as evalInline did).
  if input.inline:
    let fn = e.snippetFunction(node.id.int, psInline, input.field, input.snippet)
    e.put "I(#,", node.id.int
    e.addSource node
    e.add ","
    e.add fn
    e.add ")"
  else:
    e.put "g#()", input.source

proc addFlowCall(e: var Emitter, g: Graph, id: int, passV: bool) =
  e.put(if not g.has(id): "NF(#)" elif passV: "f#(V)" else: "f#()", id)

proc addThrow(e: var Emitter, message: string) =
  e.add "throw Error("
  e.addStr message
  e.add ")"

iterator ordered(g: Graph, inputs: seq[Input]): Input =
  ## Wired inputs first, then inline ones, as the interpreter set them; a
  ## wired one whose producer is not in the scene is skipped, as it was.
  for input in inputs:
    if not input.inline and g.has(input.source): yield input
  for input in inputs:
    if input.inline: yield input

proc needsCatch(kind: int, input: Input): bool {.inline.} =
  ## A wired input's producer may throw, and so may an app's field refuse an
  ## inline value; an inline value alone never throws (`I` catches).
  not input.inline or kind == 0

proc addInputFailure(e: var Emitter, kind: int, id: int, input: Input) =
  ## `catch(x){EI(…)}` for an input whose producer threw (kind as in `EI`).
  if not needsCatch(kind, input):
    e.add ";\n"
    return
  e.add "}catch(x){EI("
  e.addInt kind + (if input.inline: 1 else: 0)
  e.add ","
  e.addInt id
  e.add ","
  e.addStr input.field
  e.add ","
  e.addInt(if input.inline: e.snippets.len - 1 else: input.source)
  e.add ",x)}\n"

proc emitCacheExpression(e: var Emitter, node: DiagramNode, id: int, broken: seq[(NodeId, string)]) =
  ## `,X(id, …)` after a cached node's id: the expression's value, which
  ## recomputes the node when it changes. One that did not compile says so
  ## on every run instead (`XC`), and the node caches without it.
  let cache = readCacheConfig(node.data)
  if not cache.expressionEnabled: return
  for (brokenId, error) in broken:
    if brokenId == node.id:
      # Its text only (for the log line), not in the program.
      e.snippets.add ProgramSnippet(nodeId: node.id, kind: psCache, name: "__cacheExpression",
        snippet: cache.expression, firstLine: 0, lastLine: -1)
      e.put ",XC(#,", id
      e.addInt e.snippets.len - 1
      e.add ","
      e.addStr error
      e.add ")"
      return
  let fn = e.snippetFunction(id, psCache, "__cacheExpression", cache.expression)
  e.put ",X(#,", id
  e.addSource node
  e.add ","
  e.add fn
  e.add ")"

proc codeType(node: DiagramNode, key, name: string): string =
  ## The type a code node declares for its first output (`codeOutputs`, name
  ## "") or for an argument (`codeArgs`).
  let declared = node.data{key}
  if not declared.isNil and declared.kind == JArray:
    for item in declared:
      if item.kind == JObject and (if name.len == 0: item{"name"}.getStr().len > 0 else: item{"name"}.getStr() == name):
        return item{"type"}.getStr()
  ""

proc emitCodeBody(e: var Emitter, g: Graph, node: DiagramNode, id: int, data: bool,
    broken: seq[(NodeId, string)]) =
  ## A code node's work, its result's handle left in `h`: each argument a
  ## handle (one that fails is its type's zero and named in `D`, so the result
  ## is not cached and an error says why), then the node's function on their
  ## values.
  let cache = readCacheConfig(node.data)
  let cached = data and cache.enabled
  e.add "const H={};let D;\n"
  for input in g.ordered(g.codeInputs.getOrDefault(id)):
    var producer = input.source
    e.add "try{H["
    e.addStr input.field
    e.add "]="
    if input.inline:
      # An inline argument that throws is defaulted like a producer that fails.
      let fn = e.snippetFunction(id, psInline, input.field, input.snippet)
      producer = -e.snippets.len
      e.put "(T.a=#,v(", id
      e.add fn
      e.add "(),\"\"))"
    else:
      e.put "g#()", producer
    if cached and cache.inputEnabled:
      e.put ";ka(#,", id
      e.addStr input.field
      e.add ",H["
      e.addStr input.field
      e.add "])"
    e.add "}catch(x){H["
    e.addStr input.field
    e.put "]=ZA(#,", id
    e.addStr input.field
    e.add ","
    e.addInt producer
    e.add ",x,"
    e.addStr codeType(node, "codeArgs", input.field)
    e.add ");(D||=[]).push("
    e.addStr input.field
    e.add ",x)}\n"
  let outputType = codeType(node, "codeOutputs", "")
  if cached:
    e.put "const K=cq(#,D?0:1", id
    emitCacheExpression(e, node, id, broken)
    e.add ");if(K>=0)return K;\n"
  e.put "T.a=#;try{h=v(__c#(A(H)),", id
  e.addStr outputType
  e.put ")}catch(x){h=JE(#,", id
  e.addSource node
  e.add ",x,"
  e.addStr outputType
  e.add ",D)}\n"
  if cached:
    e.put "cs(#,h,D?0:1);\n", id
  elif jBoolOr(node.data, "logOutput", false):
    e.put "lo(#,h);\n", id

proc emitCodeFunction(e: var Emitter, g: Graph, node: DiagramNode, id: int) =
  ## `__c<id>(A)`: the node's code, given its arguments' values by name and
  ## as `args`.
  var names: seq[string]
  let declared = node.data{"codeArgs"}
  if not declared.isNil and declared.kind == JArray:
    for arg in declared:
      if arg.kind == JObject:
        let name = arg{"name"}.getStr()
        if name.len > 0 and name notin names: names.add name
  for input in g.codeInputs.getOrDefault(id):
    if input.field notin names: names.add input.field
  var header = "function __c" & $id & "(A){"
  var idents: seq[string]
  for name in names:
    # These would shadow what the code is handed, and never did.
    if name.toLowerAscii in ["state", "args", "context", "console", "getargor",
        "parsets", "format", "now"]:
      continue
    let ident = toJsIdent(name)
    if ident in idents: continue
    idents.add ident
    header.add "const "
    header.add ident
    header.add "=A["
    escapeJson(name, header)
    header.add "];"
  header.add "return((state,args,context)=>(\n"
  discard e.snippetFunction(id, psCode, "codeJS", codeSnippet(node), header)

proc eventFilters(node: DiagramNode): tuple[match: seq[(string, string)], expected: seq[string]] =
  ## What a listener's payload must say (every filter it sets; an empty one
  ## matches anything; the node's own `label` when the config sets none), and
  ## the same as the log line names it.
  if node.data.isNil or node.data.kind != JObject: return
  var hasLabel = false
  let config = node.data{"config"}
  let hasConfig = not config.isNil and config.kind == JObject
  if hasConfig:
    for key, value in config.pairs:
      let expected = eventFilterValue(value)
      if expected.len > 0:
        if key == "label": hasLabel = true
        result.match.add((key, expected))
        result.expected.add(key & "=" & expected)
  let label = node.data{"label"}
  if not label.isNil:
    let expected = eventFilterValue(label)
    if expected.len > 0:
      if not hasLabel:
        result.match.add(("label", expected))
      if not hasConfig:
        result.expected.add("label=" & expected)

proc addNodeThrow(e: var Emitter, kind: string) =
  ## What running a node that cannot run says, as the interpreter said it.
  e.addThrow(case kind
    of "source": "Source nodes are not implemented for interpreted scenes"
    of "event": "Event nodes not implemented in interpreted scenes yet"
    else: "Unknown node type: " & kind)

proc wrapStart(e: var Emitter, id: int, cyclic, profile, isData: bool) =
  ## Around a node's work: on a cycle of its own inputs it keeps itself in
  ## `W` while it works, and a value read of a node already there is
  ## refused; with the debug profile on, it is measured.
  if cyclic:
    if isData:
      e.put "if(W.has(#))throw Error(\"Node # depends on itself: its input is produced by a node that is still resolving it (cycle through \"+W.size+\" node(s))\");", id
    e.put "W.add(#);try{", id
  if profile:
    e.put(if isData: "n0(#,1);" else: "n0(#,0);", id)

proc wrapEnd(e: var Emitter, id: int, cyclic, profile, isData: bool) =
  if profile:
    e.put(if isData: ";n1(#,1,h);" else: ";n1(#,0,0);", id)
  if isData:
    e.add ";return h"
  if cyclic:
    e.put "}finally{W.delete(#)}", id

proc compileScene*(nodes: seq[DiagramNode], edges: seq[DiagramEdge], profile = false,
    brokenCache: seq[(NodeId, string)] = @[]): CompiledScene =
  ## The program for a scene. It evaluates to a function of the kit
  ## (`ProgramKit` called with interpreter.nim's natives, `programOp`)
  ## returning the scene's three ways in:
  ## `ev(event)` runs the event's listeners and says how many ran,
  ## `flow(id)` runs the flow from a node (an app's `execNode`) and
  ## `data(id)` gives a node's value (`getDataNode`).
  ##
  ## `profile` puts the per-node debug profile around every node
  ## (`frameConfig.debug`); `brokenCache` names cached nodes whose expression
  ## did not compile, and why: they say so on every run instead.
  result = CompiledScene(profile: profile, brokenCache: brokenCache)
  let g = buildGraph(nodes, edges)
  let cyclic = cyclicDataNodes(g)
  let depths = producerDepths(g, cyclic)
  let looping = flowCycleNodes(g)
  let inFlow = flowNodes(g)
  var e: Emitter
  for c in cyclic:
    if c:
      e.add "const W=new Set();\n"
      break

  for i, node in g.nodes:
    let id = node.id.int
    let kind = node.nodeType
    let throws = kind notin ["app", "code", "dispatch", "scene", "state"]
    if kind == "code":
      emitCodeFunction(e, g, node, id)
    elif kind == "app" and g.appInputs.hasKey(id):
      # i<id>(): its fields set from their producers.
      e.put "function i#(){", id
      for input in g.ordered(g.appInputs[id]):
        e.put "try{s(#,", id
        e.addStr input.field
        e.add ","
        e.addProducer(input, node)
        e.add ")"
        e.addInputFailure(0, id, input)
      e.add "}\n"

    # ---- g<id>(): the node's value, a handle in `h`
    e.put "function g#(){", id
    if depths[i] > MaxProducerDepth:
      e.addThrow("Node " & $id & " is nested deeper than " & $MaxProducerDepth &
        " levels of producers; refusing to resolve it")
    elif throws:
      e.addNodeThrow(kind)
    else:
      e.wrapStart(id, cyclic[i], profile, true)
      e.add "let h;"
      case kind
      of "app":
        if g.appInputs.hasKey(id):
          e.put "i#();", id
        e.put "h=g(#", id
        if readCacheConfig(node.data).enabled:
          emitCacheExpression(e, node, id, brokenCache)
        e.add ")"
      of "code":
        e.add "\n"
        emitCodeBody(e, g, node, id, true, brokenCache)
      of "dispatch":
        # Its config with its inputs over it: the payload it sends.
        let config = node.data{"config"}
        e.add "const Y={..."
        e.add(if not config.isNil and config.kind == JObject: $config else: "{}")
        e.add "};\n"
        for input in g.ordered(g.appInputs.getOrDefault(id)):
          if needsCatch(2, input): e.add "try{"
          e.add "Y["
          e.addStr input.field
          e.add "]=j("
          e.addProducer(input, node)
          e.add ")"
          e.addInputFailure(2, id, input)
        e.put "h=d(#,Y)", id
      of "scene":
        for input in g.ordered(g.appInputs.getOrDefault(id)):
          if needsCatch(4, input): e.add "try{"
          e.put "ss(#,", id
          e.addStr input.field
          e.add ","
          e.addProducer(input, node)
          e.add ")"
          e.addInputFailure(4, id, input)
        e.put "sc(#);h=0", id
      else: # state
        e.add "h=t("
        e.addStr node.keyword
        e.add ")"
      e.wrapEnd(id, cyclic[i], profile, true)
    e.add "}\n"

    # ---- f<id>(V): the node in a flow, then the one after it
    if not inFlow[i]:
      continue
    e.put "function f#(V){", id
    if looping[i]:
      e.put "V||=new Set();if(V.has(#))return CY(#,V);V.add(#);", id
    if kind != "app":
      # Whatever draws first pays the background still owed; an app settles
      # it in `p` (a planned image edge may waive it).
      e.add "bg();"
    if throws:
      e.addNodeThrow(kind)
    elif kind in ["dispatch", "scene", "state"]:
      # Their flow is their value, dropped.
      e.put "g#();", id
    else:
      e.wrapStart(id, cyclic[i], profile, false)
      if kind == "app":
        e.put "const P=p(#);", id
        if g.appInputs.hasKey(id):
          e.put "i#();", id
        e.put "q(#,P);r(#);", id
      else:
        e.add "let h;\n"
        emitCodeBody(e, g, node, id, false, brokenCache)
      e.wrapEnd(id, cyclic[i], profile, false)
    if g.next.hasKey(id) and not throws:
      e.add ";"
      addFlowCall(e, g, g.next[id], true)
    e.add "}\n"

  # ---- the listeners
  var listeners: OrderedTable[string, seq[int]]
  for node in g.nodes:
    if node.nodeType == "event":
      listeners.mgetOrPut(node.keyword, @[]).add node.id.int
  e.add "return{ev(n){let M=0;switch(n){\n"
  for event, ids in listeners.pairs:
    result.listens.add event
    e.add "case "
    e.addStr event
    e.add ":"
    var canMiss = false
    var expected: seq[string]
    for id in ids:
      let next = g.next.getOrDefault(id, -1)
      if next == 0 or next == -1:
        # A listener with nowhere to go counts as filtered out.
        canMiss = true
        continue
      let filters = eventFilters(g.node(id))
      if filters.match.len > 0:
        canMiss = true
        for x in filters.expected: expected.add x
        e.add "if(m("
        for k, (key, value) in filters.match:
          if k > 0: e.add ","
          e.addStr key
          e.add ","
          e.addStr value
        e.add ")){"
      e.add "M++;try{"
      addFlowCall(e, g, next, false)
      e.put "}catch(x){LE(n,#,x)}", next
      if filters.match.len > 0: e.add "}"
      e.add "\n"
    if canMiss:
      e.add "if(!M)NL(n,["
      for k, x in expected:
        if k > 0: e.add ","
        e.addStr x
      e.add "]);"
    e.add "break;\n"
  e.add "}return M},\nflow(i){switch(i){"
  for k, node in g.nodes:
    # A node no flow reaches, run anyway (an execNode a config names by
    # hand): its value, dropped.
    e.put(if inFlow[k]: "case #:return f#();" else: "case #:return void g#();", node.id.int)
  e.add "}NF(i)},\ndata(i){switch(i){"
  for node in g.nodes:
    e.put "case #:return g#();", node.id.int
  e.add "}NF(i);return 0}}},"

  let renders = listeners.getOrDefault("render")
  if renders.len == 1:
    let first = g.next.getOrDefault(renders[0], -1)
    if first != 0 and first != -1:
      let after = g.next.getOrDefault(first, -1)
      result.wholeFrame = after == 0 or after == -1
  # The snippets' places and texts, for the kit's error lines: the glue's
  # last two arguments.
  var tables = "["
  for k, snippet in e.snippets:
    if k > 0: tables.add ','
    tables.add '['
    tables.add $snippet.firstLine
    tables.add ','
    tables.add $snippet.lastLine
    tables.add ','
    escapeJson((if snippet.kind == psCode: "<frameos:code:" & $snippet.nodeId.int & ">"
      else: "<frameos:inline:" & $snippet.nodeId.int & ":" & snippet.name & ">"), tables)
    tables.add ']'
  tables.add "],["
  for k, snippet in e.snippets:
    if k > 0: tables.add ','
    escapeJson(snippet.snippet, tables)
  tables.add "])}\n"
  result.source = ProgramHead
  result.source.add e.snip
  result.source.add "return{"
  result.source.add e.names.join(",")
  result.source.add "}})();\nreturn __K.glue((N,Z)=>{const{"
  result.source.add e.names.join(",")
  result.source.add "}=__F;\n"
  result.source.add GlueHead
  result.source.add e.glue
  result.source.add tables
  result.snippets = move e.snippets

{.pop.}
