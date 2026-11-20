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
   (frameos_memo_epoch, moved by __frameosNextRender).

   The JavaScript memo() was about 1.1 ms a call on the SenseCAP Indicator,
   hit or miss: a Map lookup, Object.keys twice and a loop, each a builtin
   fetched from flash. Six memo()'d cards were 6 to 7 ms of a home panel's
   11 ms get(), and a hundred memo()'d cells made a tap 175 ms where the
   same cells without memo() took 115 (docs/perf-todo.md). Here: 5 ms and
   89 ms. */
static int32_t frameos_memo_epoch = 0;
static JSClassID frameos_memo_class_id = 0;

typedef struct { JSValue key, props, element; } FosMemoSlot;
typedef struct {
  JSValue component;
  int32_t render, turn, cursor;
  FosMemoSlot *last, *used;
  int32_t lastN, usedN, lastCap, usedCap;
} FosMemo;

static void frameos_memo_free_slots(JSRuntime *rt, FosMemoSlot *slots, int32_t n) {
  for (int32_t i = 0; i < n; i++) {
    JS_FreeValueRT(rt, slots[i].key);
    JS_FreeValueRT(rt, slots[i].props);
    JS_FreeValueRT(rt, slots[i].element);
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

static void frameos_memo_mark(JSRuntime *rt, JSValueConst val, JS_MarkFunc *mark_func) {
  FosMemo *m = JS_GetOpaque(val, frameos_memo_class_id);
  if (!m) return;
  JS_MarkValue(rt, m->component, mark_func);
  for (int32_t i = 0; i < m->lastN; i++) {
    JS_MarkValue(rt, m->last[i].key, mark_func);
    JS_MarkValue(rt, m->last[i].props, mark_func);
    JS_MarkValue(rt, m->last[i].element, mark_func);
  }
  for (int32_t i = 0; i < m->usedN; i++) {
    JS_MarkValue(rt, m->used[i].key, mark_func);
    JS_MarkValue(rt, m->used[i].props, mark_func);
    JS_MarkValue(rt, m->used[i].element, mark_func);
  }
}

static JSClassDef frameos_memo_class = { "FrameOSMemo", frameos_memo_finalizer, frameos_memo_mark, NULL, NULL };

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

static int frameos_memo_push(JSContext *ctx, FosMemo *m, JSValue key, JSValue props, JSValue element) {
  if (m->usedN == m->usedCap) {
    int32_t cap = m->usedCap ? m->usedCap * 2 : 8;
    FosMemoSlot *grown = js_realloc(ctx, m->used, sizeof(FosMemoSlot) * cap);
    if (!grown) {
      JS_FreeValue(ctx, key); JS_FreeValue(ctx, props); JS_FreeValue(ctx, element);
      return -1;
    }
    m->used = grown;
    m->usedCap = cap;
  }
  m->used[m->usedN].key = key;
  m->used[m->usedN].props = props;
  m->used[m->usedN].element = element;
  m->usedN++;
  return 0;
}

static JSValue frameos_memo_call(JSContext *ctx, JSValueConst this_val, int argc,
                                 JSValueConst *argv, int magic, JSValue *func_data) {
  (void)this_val; (void)magic;
  FosMemo *m = JS_GetOpaque(func_data[0], frameos_memo_class_id);
  JSValueConst props = argc > 0 ? argv[0] : JS_UNDEFINED;
  if (!m) return JS_ThrowInternalError(ctx, "memo: no state");
  if (m->render != frameos_memo_epoch) {
    /* A new render: what the last one used is what this one may take back. */
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
  /* From where the last slot was found: a render's calls come back in the
     order they were made, so a list of a hundred finds each at the cursor. */
  for (int32_t step = 0; step < m->lastN; step++) {
    int32_t i = (m->cursor + step) % m->lastN;
    if (!frameos_same_key(ctx, m->last[i].key, key)) continue;
    m->cursor = i + 1;
    if (frameos_same_props(ctx, m->last[i].props, props)) {
      JSValue element = JS_DupValue(ctx, m->last[i].element);
      if (frameos_memo_push(ctx, m, key, JS_DupValue(ctx, m->last[i].props), JS_DupValue(ctx, element)) < 0) {
        JS_FreeValue(ctx, element);
        return JS_EXCEPTION;
      }
      return element;
    }
    break;
  }
  JSValue result = JS_Call(ctx, m->component, JS_UNDEFINED, 1, &props);
  if (JS_IsException(result)) {
    JS_FreeValue(ctx, key);
    return result;
  }
  if (JS_IsObject(result) && !JS_IsArray(ctx, result))
    JS_SetPropertyStr(ctx, result, "__frameosNode", JS_NewInt32(ctx, 0));
  if (frameos_memo_push(ctx, m, key, JS_DupValue(ctx, props), JS_DupValue(ctx, result)) < 0) {
    JS_FreeValue(ctx, result);
    return JS_EXCEPTION;
  }
  return result;
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
