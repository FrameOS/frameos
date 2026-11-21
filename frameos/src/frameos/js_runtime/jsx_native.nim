## The JSX factory in C.
##
## quickts lowers `<div className="x">{a}</div>` to a call of the global
## `__frameosJsx(type, props, ...children)`, and the prelude's factory in
## JavaScript was every element's cost in a UI's get(): a call with rest
## arguments, a property set, an object literal, the component call — on an
## ESP32-S3 each bytecode of it a fetch from flash and a PSRAM read. This
## does the same in one native call: what it returns is what the JavaScript
## returned, `{type, props}` with `props.children` set from the trailing
## arguments, a function component called on the spot, a fragment its
## children. `installNativeJsx` replaces the prelude's factory in a context
## the prelude has run in; the JavaScript one stays the reference (and the
## factory wherever this is not installed).

import frameos/js_runtime/burrito

{.emit: """/*TYPESECTION*/
#include "quickjs/quickjs.h"
""".}

{.emit: """
static JSValue frameos_jsx_native(JSContext *ctx, JSValueConst this_val, int argc,
                                  JSValueConst *argv, int magic, JSValue *func_data) {
  (void)this_val; (void)magic;
  JSValueConst type = argc > 0 ? argv[0] : JS_UNDEFINED;
  JSValue props;
  if (argc > 1 && JS_IsObject(argv[1])) {
    /* quickts hands every element a fresh object literal (or null): it is
       this element's own, as the JavaScript factory took it. */
    props = JS_DupValue(ctx, argv[1]);
  } else {
    props = JS_NewObject(ctx);
    if (JS_IsException(props)) return props;
  }
  if (argc > 2) {
    JSValue children;
    if (argc == 3) {
      children = JS_DupValue(ctx, argv[2]);
    } else {
      children = JS_NewArray(ctx);
      if (JS_IsException(children)) { JS_FreeValue(ctx, props); return children; }
      for (int i = 2; i < argc; i++) {
        if (JS_SetPropertyUint32(ctx, children, (uint32_t)(i - 2), JS_DupValue(ctx, argv[i])) < 0) {
          JS_FreeValue(ctx, children); JS_FreeValue(ctx, props); return JS_EXCEPTION;
        }
      }
    }
    if (JS_SetPropertyStr(ctx, props, "children", children) < 0) {
      JS_FreeValue(ctx, props); return JS_EXCEPTION;
    }
  }
  /* func_data[0]: the prelude's __frameosFragment symbol. */
  if (JS_IsSymbol(type) && JS_VALUE_GET_PTR(type) == JS_VALUE_GET_PTR(func_data[0])) {
    JSValue children = JS_GetPropertyStr(ctx, props, "children");
    JS_FreeValue(ctx, props);
    if (JS_IsUndefined(children)) return JS_NULL;
    return children;
  }
  if (JS_IsFunction(ctx, type)) {
    /* A function component runs now: the tree an app returns is plain elements. */
    JSValue result = JS_Call(ctx, type, JS_UNDEFINED, 1, (JSValueConst *)&props);
    JS_FreeValue(ctx, props);
    return result;
  }
  JSValue element = JS_NewObject(ctx);
  if (JS_IsException(element)) { JS_FreeValue(ctx, props); return element; }
  if (JS_SetPropertyStr(ctx, element, "type", JS_DupValue(ctx, type)) < 0 ||
      JS_SetPropertyStr(ctx, element, "props", props) < 0) {
    JS_FreeValue(ctx, element); return JS_EXCEPTION;
  }
  return element;
}

/* memo(Component) in C, the prelude's memo() as it behaves: a call with
   props shallow-equal (Object.is per own key) to the last render's call at
   the same place (its turn among this render's calls, or its `key`) returns
   the element made then. What the last render used and what this one does
   are two arrays of slots, swapped when a new get() begins
   (frameos_memo_epoch, moved by __frameosNextRender). A call that read a
   signal() has a record (FosMemoRec): what the signal subscribes, marked
   dirty when it is set, and what a partial render runs alone
   (frameos_signal_op).

   The JavaScript memo() was about 1.1 ms a call on the SenseCAP Indicator,
   hit or miss: a Map lookup, Object.keys twice and a loop, each a builtin
   fetched from flash. Six memo()'d cards were 6 to 7 ms of a home panel's
   11 ms get(), and a hundred memo()'d cells made a tap's render 165 ms where
   the same cells without memo() took 115. Here: a get() of 6.7 ms, a render
   of 87 (docs/perf-todo.md). */
static int32_t frameos_memo_epoch = 0;
static JSClassID frameos_memo_class_id = 0;
static JSClassID frameos_memo_rec_class_id = 0;

/* A call site's record, made only once a signal() is read under it (or under
   a memo()'d call inside it): what the signal subscribes, and what a partial
   render runs again on its own. A memo() whose components read no signal
   makes none, and its calls cost what they did before signals. */
typedef struct {
  JSValue component, props, element;
  JSValue parent;  /* the record of the memo()'d call it ran inside, or undefined */
  JSValue deps;    /* the subscriber Sets it is in (a JS array), or undefined */
  uint8_t dirty;   /* a signal it read was set */
  uint8_t stale;   /* a call inside it ran again on its own: its element holds the old one */
} FosMemoRec;

typedef struct { JSValue key, props, element, rec; } FosMemoSlot;
typedef struct {
  JSValue component;
  int32_t render, turn, cursor;
  FosMemoSlot *last, *used;
  int32_t lastN, usedN, lastCap, usedCap;
} FosMemo;

/* The memo()'d calls running now, innermost last: a signal read finds its
   call here. A partial render's call has its record and no slot. */
typedef struct FosMemoFrame { FosMemo *m; int32_t slot; JSValue rec; struct FosMemoFrame *up; } FosMemoFrame;
static FosMemoFrame *frameos_top = NULL; /* on the C stack of the calls running */
/* Records marked dirty since start: a handler that set a signal says so. */
uint32_t frameos_dirty_marks = 0;
/* Records made since start: until one is, the walker keeps no paths. */
uint32_t frameos_records_made = 0;

static FosMemoRec *frameos_rec(JSValueConst v) {
  return JS_GetOpaque(v, frameos_memo_rec_class_id);
}

static void frameos_rec_finalizer(JSRuntime *rt, JSValue val) {
  FosMemoRec *r = frameos_rec(val);
  if (!r) return;
  JS_FreeValueRT(rt, r->component);
  JS_FreeValueRT(rt, r->props);
  JS_FreeValueRT(rt, r->element);
  JS_FreeValueRT(rt, r->parent);
  JS_FreeValueRT(rt, r->deps);
  js_free_rt(rt, r);
}

static void frameos_rec_mark(JSRuntime *rt, JSValueConst val, JS_MarkFunc *mark_func) {
  FosMemoRec *r = frameos_rec(val);
  if (!r) return;
  JS_MarkValue(rt, r->component, mark_func);
  JS_MarkValue(rt, r->props, mark_func);
  JS_MarkValue(rt, r->element, mark_func);
  JS_MarkValue(rt, r->parent, mark_func);
  JS_MarkValue(rt, r->deps, mark_func);
}

static void frameos_memo_free_slots(JSRuntime *rt, FosMemoSlot *slots, int32_t n) {
  for (int32_t i = 0; i < n; i++) {
    JS_FreeValueRT(rt, slots[i].key);
    JS_FreeValueRT(rt, slots[i].props);
    JS_FreeValueRT(rt, slots[i].element);
    JS_FreeValueRT(rt, slots[i].rec);
  }
}

static void frameos_memo_finalizer(JSRuntime *rt, JSValue val) {
  FosMemo *m = JS_GetOpaque(val, frameos_memo_class_id);
  if (!m) return;
  frameos_memo_free_slots(rt, m->last, m->lastN);
  frameos_memo_free_slots(rt, m->used, m->usedN);
  js_free_rt(rt, m->last);
  js_free_rt(rt, m->used);
  JS_FreeValueRT(rt, m->component);
  js_free_rt(rt, m);
}

static void frameos_memo_mark_slots(JSRuntime *rt, FosMemoSlot *slots, int32_t n, JS_MarkFunc *mark_func) {
  for (int32_t i = 0; i < n; i++) {
    JS_MarkValue(rt, slots[i].key, mark_func);
    JS_MarkValue(rt, slots[i].props, mark_func);
    JS_MarkValue(rt, slots[i].element, mark_func);
    JS_MarkValue(rt, slots[i].rec, mark_func);
  }
}

static void frameos_memo_mark(JSRuntime *rt, JSValueConst val, JS_MarkFunc *mark_func) {
  FosMemo *m = JS_GetOpaque(val, frameos_memo_class_id);
  if (!m) return;
  JS_MarkValue(rt, m->component, mark_func);
  frameos_memo_mark_slots(rt, m->last, m->lastN, mark_func);
  frameos_memo_mark_slots(rt, m->used, m->usedN, mark_func);
}

static JSClassDef frameos_memo_class = { "FrameOSMemo", frameos_memo_finalizer, frameos_memo_mark, NULL, NULL };
static JSClassDef frameos_memo_rec_class = { "FrameOSMemoRecord", frameos_rec_finalizer, frameos_rec_mark, NULL, NULL };

static int frameos_same_props(JSContext *ctx, JSValueConst a, JSValueConst b) {
  if (!JS_IsObject(a) || !JS_IsObject(b)) return 0;
  JSPropertyEnum *ta = NULL, *tb = NULL;
  uint32_t na = 0, nb = 0;
  if (JS_GetOwnPropertyNames(ctx, &ta, &na, a, JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) < 0) return 0;
  if (JS_GetOwnPropertyNames(ctx, &tb, &nb, b, JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) < 0) {
    JS_FreePropertyEnum(ctx, ta, na);
    return 0;
  }
  int same = na == nb;
  for (uint32_t i = 0; same && i < na; i++) {
    JSValue va = JS_GetProperty(ctx, a, ta[i].atom);
    JSValue vb = JS_GetProperty(ctx, b, ta[i].atom);
    same = JS_SameValue(ctx, va, vb);
    JS_FreeValue(ctx, va);
    JS_FreeValue(ctx, vb);
  }
  JS_FreePropertyEnum(ctx, ta, na);
  JS_FreePropertyEnum(ctx, tb, nb);
  return same;
}

static int frameos_same_key(JSContext *ctx, JSValueConst a, JSValueConst b) {
  if (JS_VALUE_GET_TAG(a) == JS_TAG_INT && JS_VALUE_GET_TAG(b) == JS_TAG_INT)
    return JS_VALUE_GET_INT(a) == JS_VALUE_GET_INT(b);
  if (JS_IsString(a) && JS_IsString(b)) return JS_StrictEq(ctx, a, b);
  return 0;
}

/* The record leaves every signal it read: its next run reads them again. */
static void frameos_rec_unsubscribe(JSContext *ctx, JSValueConst recValue) {
  FosMemoRec *r = frameos_rec(recValue);
  if (!r || JS_IsUndefined(r->deps)) return;
  JSValue deps = r->deps;
  r->deps = JS_UNDEFINED;
  int32_t n = 0;
  JSValue len = JS_GetPropertyStr(ctx, deps, "length");
  JS_ToInt32(ctx, &n, len);
  JS_FreeValue(ctx, len);
  JSAtom del = JS_NewAtom(ctx, "delete");
  for (int32_t i = 0; i < n; i++) {
    JSValue set = JS_GetPropertyUint32(ctx, deps, i);
    JS_FreeValue(ctx, JS_Invoke(ctx, set, del, 1, (JSValueConst *)&recValue));
    JS_FreeValue(ctx, set);
  }
  JS_FreeAtom(ctx, del);
  JS_FreeValue(ctx, deps);
}

static int frameos_memo_push(JSContext *ctx, FosMemo *m, JSValue key, JSValue props, JSValue element, JSValue rec) {
  if (m->usedN == m->usedCap) {
    int32_t cap = m->usedCap ? m->usedCap * 2 : 8;
    FosMemoSlot *grown = js_realloc(ctx, m->used, sizeof(FosMemoSlot) * cap);
    if (!grown) {
      JS_FreeValue(ctx, key); JS_FreeValue(ctx, props); JS_FreeValue(ctx, element); JS_FreeValue(ctx, rec);
      return -1;
    }
    m->used = grown;
    m->usedCap = cap;
  }
  m->used[m->usedN] = (FosMemoSlot){ key, props, element, rec };
  m->usedN++;
  return 0;
}

/* component with props, the call on the frames for a signal read to find. */
static JSValue frameos_memo_run(JSContext *ctx, JSValueConst component, JSValueConst props,
                                FosMemo *m, int32_t slot, JSValueConst rec) {
  FosMemoFrame frame = { m, slot, rec, frameos_top };
  frameos_top = &frame;
  JSValue result = JS_Call(ctx, component, JS_UNDEFINED, 1, &props);
  frameos_top = frame.up;
  if (!JS_IsException(result) && JS_IsObject(result) && !JS_IsArray(ctx, result))
    JS_SetPropertyStr(ctx, result, "__frameosNode", JS_NewInt32(ctx, 0));
  return result;
}

static JSValue frameos_memo_call(JSContext *ctx, JSValueConst this_val, int argc,
                                 JSValueConst *argv, int magic, JSValue *func_data) {
  (void)this_val; (void)magic;
  FosMemo *m = JS_GetOpaque(func_data[0], frameos_memo_class_id);
  JSValueConst props = argc > 0 ? argv[0] : JS_UNDEFINED;
  if (!m) return JS_ThrowInternalError(ctx, "memo: no state");
  if (m->render != frameos_memo_epoch) {
    /* A new render: what the last one used is what this one may take back.
       A record the last render did not carry over leaves its signals. */
    for (int32_t i = 0; i < m->lastN; i++)
      if (!JS_IsUndefined(m->last[i].rec)) frameos_rec_unsubscribe(ctx, m->last[i].rec);
    frameos_memo_free_slots(JS_GetRuntime(ctx), m->last, m->lastN);
    FosMemoSlot *t = m->last; int32_t tc = m->lastCap;
    m->last = m->used; m->lastN = m->usedN; m->lastCap = m->usedCap;
    m->used = t; m->usedN = 0; m->usedCap = tc;
    m->turn = 0; m->cursor = 0;
    m->render = frameos_memo_epoch;
  }
  JSValue key;
  JSValue keyProp = JS_IsObject(props) ? JS_GetPropertyStr(ctx, props, "key") : JS_UNDEFINED;
  if (!JS_IsUndefined(keyProp)) key = JS_ToString(ctx, keyProp);
  else key = JS_NewInt32(ctx, m->turn++);
  JS_FreeValue(ctx, keyProp);
  if (JS_IsException(key)) return key;
  JSValue rec = JS_UNDEFINED;
  /* From where the last slot was found: a render's calls come back in the
     order they were made, so a list of a hundred finds each at the cursor. */
  for (int32_t step = 0; step < m->lastN; step++) {
    int32_t i = (m->cursor + step) % m->lastN;
    FosMemoSlot *s = &m->last[i];
    if (!frameos_same_key(ctx, s->key, key)) continue;
    m->cursor = i + 1;
    FosMemoRec *r = JS_IsUndefined(s->rec) ? NULL : frameos_rec(s->rec);
    if ((!r || (!r->dirty && !r->stale)) && frameos_same_props(ctx, s->props, props)) {
      /* A record's element is the newest: a partial render may have made it. */
      JSValue element = JS_DupValue(ctx, r ? r->element : s->element);
      if (frameos_memo_push(ctx, m, key, JS_DupValue(ctx, s->props), JS_DupValue(ctx, element),
                            JS_DupValue(ctx, s->rec)) < 0) {
        JS_FreeValue(ctx, element);
        return JS_EXCEPTION;
      }
      /* Carried over: the swap that drops the old slot must not unsubscribe it. */
      JS_FreeValue(ctx, s->rec);
      s->rec = JS_UNDEFINED;
      return element;
    }
    rec = s->rec;            /* the record goes with the call, whatever ran */
    s->rec = JS_UNDEFINED;
    break;
  }
  if (!JS_IsUndefined(rec)) {
    FosMemoRec *r = frameos_rec(rec);
    frameos_rec_unsubscribe(ctx, rec);
    JS_FreeValue(ctx, r->props);
    r->props = JS_DupValue(ctx, props);
  }
  int32_t slot = m->usedN;
  if (frameos_memo_push(ctx, m, key, JS_DupValue(ctx, props), JS_UNDEFINED, rec) < 0) return JS_EXCEPTION;
  JSValue result = frameos_memo_run(ctx, m->component, props, m, slot, JS_UNDEFINED);
  if (JS_IsException(result)) return result;
  FosMemoSlot *s = &m->used[slot];
  s->element = JS_DupValue(ctx, result);
  FosMemoRec *r = JS_IsUndefined(s->rec) ? NULL : frameos_rec(s->rec);
  if (r) {
    JS_FreeValue(ctx, r->element);
    r->element = JS_DupValue(ctx, result);
    r->dirty = 0;
    r->stale = 0;
  }
  return result;
}

/* The record of a running call, made if it has none, with its parents'. */
static JSValue frameos_frame_rec(JSContext *ctx, FosMemoFrame *f) {
  if (!JS_IsUndefined(f->rec)) return f->rec;
  FosMemoSlot *s = &f->m->used[f->slot];
  if (JS_IsUndefined(s->rec)) {
    JSRuntime *rt = JS_GetRuntime(ctx);
    if (frameos_memo_rec_class_id == 0) JS_NewClassID(&frameos_memo_rec_class_id);
    if (!JS_IsRegisteredClass(rt, frameos_memo_rec_class_id) &&
        JS_NewClass(rt, frameos_memo_rec_class_id, &frameos_memo_rec_class) < 0)
      return JS_EXCEPTION;
    JSValue rec = JS_NewObjectClass(ctx, frameos_memo_rec_class_id);
    if (JS_IsException(rec)) return rec;
    FosMemoRec *r = js_mallocz(ctx, sizeof(FosMemoRec));
    if (!r) { JS_FreeValue(ctx, rec); return JS_EXCEPTION; }
    r->component = JS_DupValue(ctx, f->m->component);
    r->props = JS_DupValue(ctx, s->props);
    r->element = JS_UNDEFINED;
    r->deps = JS_UNDEFINED;
    r->parent = JS_UNDEFINED;
    JS_SetOpaque(rec, r);
    frameos_records_made++;
    if (f->up) {
      JSValue parent = frameos_frame_rec(ctx, f->up);
      if (!JS_IsException(parent)) r->parent = JS_DupValue(ctx, parent);
    }
    s = &f->m->used[f->slot]; /* a parent's record may have grown its own array, never this one */
    s->rec = rec;
  }
  return s->rec;
}

/* signal()'s one native (the prelude's), by op:
   0 the record of the memo()'d call running now (null outside one);
   1 (rec, set): the call read a signal, whose subscribers are set;
   2 (rec): a signal it read was set, true when it was not dirty yet;
   3 (rec): its component again, alone: [the walker's number of the element it
     made last, the new element] for jsx.nim's jsxSplice, undefined when it is
     not dirty any more, null when it cannot be spliced (never drawn);
   4: a partial render begins (memo()'d calls inside the ones run again take
     their slots afresh). */
static JSValue frameos_signal_op(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
  (void)this_val;
  int32_t op = -1;
  if (argc > 0) JS_ToInt32(ctx, &op, argv[0]);
  FosMemoRec *r = argc > 1 ? frameos_rec(argv[1]) : NULL;
  switch (op) {
  case 0:
    if (!frameos_top) return JS_NULL;
    return JS_DupValue(ctx, frameos_frame_rec(ctx, frameos_top));
  case 1: {
    if (!r || argc < 3) return JS_UNDEFINED;
    if (JS_IsUndefined(r->deps)) {
      r->deps = JS_NewArray(ctx);
      if (JS_IsException(r->deps)) { r->deps = JS_UNDEFINED; return JS_EXCEPTION; }
    }
    int32_t n = 0;
    JSValue len = JS_GetPropertyStr(ctx, r->deps, "length");
    JS_ToInt32(ctx, &n, len);
    JS_FreeValue(ctx, len);
    JS_SetPropertyUint32(ctx, r->deps, n, JS_DupValue(ctx, argv[2]));
    return JS_UNDEFINED;
  }
  case 2:
    if (!r || r->dirty) return JS_FALSE;
    r->dirty = 1;
    frameos_dirty_marks++;
    return JS_TRUE;
  case 3: {
    if (!r || !r->dirty) return JS_UNDEFINED;
    int32_t old = 0;
    if (JS_IsObject(r->element)) {
      JSValue mark = JS_GetPropertyStr(ctx, r->element, "__frameosNode");
      JS_ToInt32(ctx, &old, mark);
      JS_FreeValue(ctx, mark);
    }
    if (old <= 0) return JS_NULL;
    for (JSValue p = r->parent; !JS_IsUndefined(p);) {
      FosMemoRec *pr = frameos_rec(p);
      if (!pr) break;
      pr->stale = 1;
      p = pr->parent;
    }
    frameos_rec_unsubscribe(ctx, argv[1]);
    JSValue element = frameos_memo_run(ctx, r->component, r->props, NULL, -1, argv[1]);
    if (JS_IsException(element)) return element;
    JS_FreeValue(ctx, r->element);
    r->element = JS_DupValue(ctx, element);
    r->dirty = 0;
    r->stale = 0;
    JSValue pair = JS_NewArray(ctx);
    JS_SetPropertyUint32(ctx, pair, 0, JS_NewInt32(ctx, old));
    JS_SetPropertyUint32(ctx, pair, 1, element);
    return pair;
  }
  case 4:
    frameos_memo_epoch++;
    return JS_UNDEFINED;
  }
  return JS_UNDEFINED;
}

static JSValue frameos_next_render(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
  (void)ctx; (void)this_val; (void)argc; (void)argv;
  frameos_memo_epoch++;
  return JS_UNDEFINED;
}

static JSValue frameos_memo(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
  (void)this_val;
  JSValueConst component = argc > 0 ? argv[0] : JS_UNDEFINED;
  JSRuntime *rt = JS_GetRuntime(ctx);
  if (frameos_memo_class_id == 0) JS_NewClassID(&frameos_memo_class_id);
  if (!JS_IsRegisteredClass(rt, frameos_memo_class_id) &&
      JS_NewClass(rt, frameos_memo_class_id, &frameos_memo_class) < 0)
    return JS_EXCEPTION;
  JSValue state = JS_NewObjectClass(ctx, frameos_memo_class_id);
  if (JS_IsException(state)) return state;
  FosMemo *m = js_mallocz(ctx, sizeof(FosMemo));
  if (!m) { JS_FreeValue(ctx, state); return JS_EXCEPTION; }
  m->component = JS_DupValue(ctx, component);
  m->render = frameos_memo_epoch - 1;
  JS_SetOpaque(state, m);
  JSValue fn = JS_NewCFunctionData(ctx, frameos_memo_call, 1, 0, 1, &state);
  JS_FreeValue(ctx, state);
  return fn;
}

static int frameos_install_native_jsx(JSContext *ctx) {
  JSValue global = JS_GetGlobalObject(ctx);
  JSValue fragment = JS_GetPropertyStr(ctx, global, "__frameosFragment");
  int ok = 0;
  if (JS_IsSymbol(fragment)) {
    JSValue fn = JS_NewCFunctionData(ctx, frameos_jsx_native, 2, 0, 1, &fragment);
    if (!JS_IsException(fn)) {
      ok = JS_SetPropertyStr(ctx, global, "__frameosJsx", fn) >= 0;
    }
  }
  if (ok) {
    /* memo() and the render count it keeps slots by (__frameosInvoke moves
       it at every get()), over the prelude's memo(). */
    JSValue memo = JS_NewCFunction(ctx, frameos_memo, "memo", 1);
    if (!JS_IsException(memo)) JS_SetPropertyStr(ctx, global, "memo", memo);
    JSValue next = JS_NewCFunction(ctx, frameos_next_render, "__frameosNextRender", 0);
    if (!JS_IsException(next)) JS_SetPropertyStr(ctx, global, "__frameosNextRender", next);
    /* What the prelude's signal() needs of the records (docs/jsx-ui.md "Signals"). */
    JS_SetPropertyStr(ctx, global, "__frameosSignal", JS_NewCFunction(ctx, frameos_signal_op, "__frameosSignal", 3));
  }
  JS_FreeValue(ctx, fragment);
  JS_FreeValue(ctx, global);
  return ok;
}
""".}

proc frameosInstallNativeJsx(ctx: ptr JSContext): cint {.importc: "frameos_install_native_jsx", nodecl.}

proc installNativeJsx*(js: QuickJS): bool =
  ## The C factory as `__frameosJsx` and the C `memo` in `js`, whose prelude
  ## defined `__frameosFragment`; false (the JavaScript ones stay) otherwise.
  frameosInstallNativeJsx(js.context) != 0

var frameosDirtyMarks {.importc: "frameos_dirty_marks", nodecl.}: uint32

proc signalMarks*(): uint32 =
  ## How many memo()'d calls a signal() set has marked since start: a
  ## handler that moved it set signals (app_runtime.callJsxHandler).
  frameosDirtyMarks

var frameosRecordsMade {.importc: "frameos_records_made", nodecl.}: uint32

proc signalRecords*(): uint32 =
  ## How many signal() records were made since start: until one is, no app
  ## can ask for a partial render, and the walker keeps no paths for one.
  frameosRecordsMade
