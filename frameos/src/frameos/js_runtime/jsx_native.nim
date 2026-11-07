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
/* One element, as the prelude's __frameosJsx makes it: `props` (owned) is
   an object or JS_NULL, `children` (owned, n of them) its children. */
static JSValue frameos_jsx_make(JSContext *ctx, JSValueConst type, JSValue props,
                                int n, JSValue *children, JSValueConst fragment) {
  if (!JS_IsObject(props)) {
    props = JS_NewObject(ctx);
    if (JS_IsException(props)) goto fail;
  }
  if (n > 0) {
    JSValue value;
    if (n == 1) {
      value = children[0];
      children[0] = JS_UNDEFINED;
    } else {
      value = JS_NewArray(ctx);
      if (JS_IsException(value)) goto fail;
      for (int i = 0; i < n; i++) {
        JSValue child = children[i];
        children[i] = JS_UNDEFINED;
        if (JS_SetPropertyUint32(ctx, value, (uint32_t)i, child) < 0) { JS_FreeValue(ctx, value); goto fail; }
      }
    }
    if (JS_SetPropertyStr(ctx, props, "children", value) < 0) goto fail;
  }
  if (JS_IsSymbol(type) && JS_VALUE_GET_PTR(type) == JS_VALUE_GET_PTR(fragment)) {
    JSValue value = JS_GetPropertyStr(ctx, props, "children");
    JS_FreeValue(ctx, props);
    if (JS_IsUndefined(value)) return JS_NULL;
    return value;
  }
  if (JS_IsFunction(ctx, type)) {
    /* A function component runs now: the tree an app returns is plain elements. */
    JSValue result = JS_Call(ctx, type, JS_UNDEFINED, 1, (JSValueConst *)&props);
    JS_FreeValue(ctx, props);
    return result;
  }
  {
    JSValue element = JS_NewObject(ctx);
    if (JS_IsException(element)) goto fail;
    if (JS_SetPropertyStr(ctx, element, "type", JS_DupValue(ctx, type)) < 0) {
      JS_FreeValue(ctx, element); goto fail;
    }
    if (JS_SetPropertyStr(ctx, element, "props", props) < 0) {
      JS_FreeValue(ctx, element); return JS_EXCEPTION;
    }
    return element;
  }
fail:
  JS_FreeValue(ctx, props);
  for (int i = 0; i < n; i++) JS_FreeValue(ctx, children[i]);
  return JS_EXCEPTION;
}

static JSValue frameos_jsx_native(JSContext *ctx, JSValueConst this_val, int argc,
                                  JSValueConst *argv, int magic, JSValue *func_data) {
  (void)this_val; (void)magic;
  JSValueConst type = argc > 0 ? argv[0] : JS_UNDEFINED;
  /* quickts hands every element a fresh object literal (or null): it is
     this element's own, as the JavaScript factory took it. */
  JSValue props = argc > 1 && JS_IsObject(argv[1]) ? JS_DupValue(ctx, argv[1]) : JS_NULL;
  int n = argc > 2 ? argc - 2 : 0;
  JSValue local[8];
  JSValue *children = n <= 8 ? local : js_malloc(ctx, sizeof(JSValue) * (size_t)n);
  if (!children) { JS_FreeValue(ctx, props); return JS_EXCEPTION; }
  for (int i = 0; i < n; i++) children[i] = JS_DupValue(ctx, argv[i + 2]);
  /* func_data[0]: the prelude's __frameosFragment symbol. */
  JSValue result = frameos_jsx_make(ctx, type, props, n, children, func_data[0]);
  if (children != local) js_free(ctx, children);
  return result;
}

/* quickts' block lowering (JS_EVAL_FLAG_JSX_BLOCKS, docs/quickts.md "Blocks"):
   a JSX site is one call, __frameosBlock(template, ...holes). Components run
   now, as the factory runs them, and get the props it would give them. A
   host element is made lazily: `{type, props}` with `props` a getter that
   builds them the first time anything reads them (an app that looks at
   `el.props`, JSON.stringify), plus, not enumerable, its node of the template
   (`__frameosSite`, the same sealed array every evaluation) and the site's
   values (`__frameosHoles`: the holes, a component's output in place of the
   component, as [output]). The walker reads the element from those two
   (js_runtime/jsx.nim) and never builds its props; an element whose props
   were read loses `__frameosSite` (it can have been changed since) and is
   read like the factory's. */
typedef struct {
  JSValue dyn;          /* the site's values; made only when an element needs them */
  int count;
  int running;          /* in the __frameosBlock call: components still to run */
  JSValueConst fragment;
  JSValueConst getter;  /* the shared `props` getter */
  JSAtom type_atom, props_atom, site_atom, holes_atom;  /* JS_ATOM_NULL until needed */
  JSValueConst *holes;  /* running: the call's arguments */
  JSValue *outs;        /* running: each tag hole's component output, JS_UNINITIALIZED if none */
  int no_components;    /* running: no hole is a function, so no node is a component */
} FrameosBlock;

static int frameos_block_atoms(JSContext *ctx, FrameosBlock *b) {
  if (b->type_atom != JS_ATOM_NULL) return 0;
  b->type_atom = JS_NewAtom(ctx, "type");
  b->props_atom = JS_NewAtom(ctx, "props");
  b->site_atom = JS_NewAtom(ctx, "__frameosSite");
  b->holes_atom = JS_NewAtom(ctx, "__frameosHoles");
  return b->holes_atom == JS_ATOM_NULL ? -1 : 0;
}

static void frameos_block_free_atoms(JSContext *ctx, FrameosBlock *b) {
  if (b->type_atom == JS_ATOM_NULL) return;
  JS_FreeAtom(ctx, b->type_atom);
  JS_FreeAtom(ctx, b->props_atom);
  JS_FreeAtom(ctx, b->site_atom);
  JS_FreeAtom(ctx, b->holes_atom);
}

static JSValue frameos_block_box(JSContext *ctx, JSValueConst value) {
  JSValue box = JS_NewArray(ctx);
  if (!JS_IsException(box) && JS_SetPropertyUint32(ctx, box, 0, JS_DupValue(ctx, value)) < 0) {
    JS_FreeValue(ctx, box);
    return JS_EXCEPTION;
  }
  return box;
}

static int frameos_block_dyn(JSContext *ctx, FrameosBlock *b) {
  /* The site's values as the array its elements keep: the holes, each
     component's output as [output] in its place. A site that makes no host
     element (a component alone, <Tile i={i} />) never makes it. */
  if (!JS_IsUndefined(b->dyn)) return 0;
  JSValue dyn = JS_NewArray(ctx);
  if (JS_IsException(dyn)) return -1;
  for (int i = 0; i < b->count; i++) {
    JSValue value = JS_IsUninitialized(b->outs[i]) ? JS_DupValue(ctx, b->holes[i]) : frameos_block_box(ctx, b->outs[i]);
    if (JS_IsException(value) || JS_SetPropertyUint32(ctx, dyn, (uint32_t)i, value) < 0) {
      JS_FreeValue(ctx, dyn);
      return -1;
    }
  }
  b->dyn = dyn;
  return 0;
}

static int frameos_block_hole_index(JSValueConst v) {
  /* The hole a template value names, -1 for a static value. */
  if (JS_VALUE_GET_TAG(v) == JS_TAG_INT && JS_VALUE_GET_INT(v) < 0) return -1 - JS_VALUE_GET_INT(v);
  return -1;
}

static JSValue frameos_block_hole(JSContext *ctx, FrameosBlock *b, int i) {
  /* While running, a tag hole reads as the component (its output is in outs). */
  if (i >= b->count) return JS_ThrowRangeError(ctx, "JSX template names a missing hole");
  if (b->running) return JS_DupValue(ctx, b->holes[i]);
  return JS_GetPropertyUint32(ctx, b->dyn, (uint32_t)i);
}

static int frameos_block_length(JSContext *ctx, JSValueConst v, uint32_t *length) {
  JSValue value = JS_GetPropertyStr(ctx, v, "length");
  int ok = JS_ToUint32(ctx, length, value) == 0;
  JS_FreeValue(ctx, value);
  return ok;
}

static JSValue frameos_block_value(JSContext *ctx, FrameosBlock *b, JSValueConst t, int depth);

static JSValue frameos_block_fill(JSContext *ctx, FrameosBlock *b, JSValueConst v, int depth) {
  int hole = frameos_block_hole_index(v);
  if (hole >= 0) return frameos_block_hole(ctx, b, hole);
  if (JS_IsArray(ctx, v) > 0) return frameos_block_value(ctx, b, v, depth + 1);
  return JS_DupValue(ctx, v);
}

static int frameos_block_spread(JSContext *ctx, JSValueConst props, JSValueConst from) {
  /* {...from} into props, as an object literal's spread copies. */
  if (!JS_IsObject(from)) return 0;
  JSPropertyEnum *tab;
  uint32_t count;
  if (JS_GetOwnPropertyNames(ctx, &tab, &count, from,
                             JS_GPN_STRING_MASK | JS_GPN_SYMBOL_MASK | JS_GPN_ENUM_ONLY) < 0) return -1;
  int ret = 0;
  for (uint32_t i = 0; i < count && ret == 0; i++) {
    JSValue value = JS_GetProperty(ctx, from, tab[i].atom);
    if (JS_IsException(value) ||
        JS_DefinePropertyValue(ctx, props, tab[i].atom, value, JS_PROP_C_W_E) < 0) ret = -1;
  }
  JS_FreePropertyEnum(ctx, tab, count);
  return ret;
}

/* Node t's props and children, as the factory would have them. */
static JSValue frameos_block_props(JSContext *ctx, FrameosBlock *b, JSValueConst t, int depth,
                                   int *n_out, JSValue **children_out, JSValue *local) {
  uint32_t length;
  *n_out = 0;
  if (!frameos_block_length(ctx, t, &length) || length < 2) return JS_ThrowTypeError(ctx, "not a JSX template");
  JSValue attrs = JS_GetPropertyUint32(ctx, t, 1);
  JSValue props = JS_NULL;
  if (!JS_IsNull(attrs)) {
    uint32_t count;
    props = JS_NewObject(ctx);
    if (JS_IsException(props) || !frameos_block_length(ctx, attrs, &count)) goto fail;
    for (uint32_t i = 0; i + 1 < count; i += 2) {
      JSValue name = JS_GetPropertyUint32(ctx, attrs, i);
      JSValue raw = JS_GetPropertyUint32(ctx, attrs, i + 1);
      JSValue value = frameos_block_fill(ctx, b, raw, depth);
      JS_FreeValue(ctx, raw);
      int bad = JS_IsException(value);
      if (!bad && JS_IsNull(name)) {
        bad = frameos_block_spread(ctx, props, value) < 0;
        JS_FreeValue(ctx, value);
      } else if (!bad) {
        JSAtom atom = JS_ValueToAtom(ctx, name);
        if (atom == JS_ATOM_NULL) { JS_FreeValue(ctx, value); bad = 1; }
        else {
          bad = JS_DefinePropertyValue(ctx, props, atom, value, JS_PROP_C_W_E) < 0;
          JS_FreeAtom(ctx, atom);
        }
      }
      JS_FreeValue(ctx, name);
      if (bad) goto fail;
    }
  }
  JS_FreeValue(ctx, attrs);
  attrs = JS_UNDEFINED;
  int n = (int)length - 2;
  JSValue *children = local;
  if (n > 8) {
    children = js_malloc(ctx, sizeof(JSValue) * (size_t)n);
    if (!children) goto fail;
  }
  for (int i = 0; i < n; i++) {
    JSValue raw = JS_GetPropertyUint32(ctx, t, (uint32_t)(i + 2));
    children[i] = frameos_block_fill(ctx, b, raw, depth);
    JS_FreeValue(ctx, raw);
    if (JS_IsException(children[i])) {
      for (int k = 0; k < i; k++) JS_FreeValue(ctx, children[k]);
      if (children != local) js_free(ctx, children);
      goto fail;
    }
  }
  *n_out = n;
  *children_out = children;
  return props;
fail:
  JS_FreeValue(ctx, attrs);
  JS_FreeValue(ctx, props);
  return JS_EXCEPTION;
}

static JSValue frameos_block_make(JSContext *ctx, FrameosBlock *b, JSValueConst t, JSValueConst type, int depth) {
  /* Node t made now, by the factory: a component, a fragment. */
  JSValue local[8], *children = local;
  int n;
  JSValue props = frameos_block_props(ctx, b, t, depth, &n, &children, local);
  if (JS_IsException(props)) return props;
  JSValue made = frameos_jsx_make(ctx, type, props, n, children, b->fragment);
  if (children != local) js_free(ctx, children);
  return made;
}

static int frameos_block_run(JSContext *ctx, FrameosBlock *b, JSValueConst t, int depth);

static int frameos_block_run_value(JSContext *ctx, FrameosBlock *b, JSValueConst v, int depth) {
  /* A component node runs (its output kept in the site's values); a host
     node or a fragment is looked into. */
  if (JS_IsArray(ctx, v) <= 0) return 0;
  JSValue tag = JS_GetPropertyUint32(ctx, v, 0);
  int hole = frameos_block_hole_index(tag);
  JS_FreeValue(ctx, tag);
  if (hole >= 0) {
    JSValue type = frameos_block_hole(ctx, b, hole);
    int component = !JS_IsException(type) && !JS_IsString(type);
    JS_FreeValue(ctx, type);
    if (component) {
      JSValue made = frameos_block_value(ctx, b, v, depth + 1);
      if (JS_IsException(made)) return -1;
      JS_FreeValue(ctx, made);
      return 0;
    }
  }
  return frameos_block_run(ctx, b, v, depth + 1);
}

static int frameos_block_run(JSContext *ctx, FrameosBlock *b, JSValueConst t, int depth) {
  /* The components inside host node t run now, in source order, children
     first, as the factory's calls would have run them. */
  if (b->no_components) return 0;
  if (depth > 64) { JS_ThrowRangeError(ctx, "JSX template too deep"); return -1; }
  uint32_t length;
  if (!frameos_block_length(ctx, t, &length) || length < 2) { JS_ThrowTypeError(ctx, "not a JSX template"); return -1; }
  JSValue attrs = JS_GetPropertyUint32(ctx, t, 1);
  int ret = 0;
  if (!JS_IsNull(attrs)) {
    uint32_t count;
    if (!frameos_block_length(ctx, attrs, &count)) ret = -1;
    for (uint32_t i = 1; ret == 0 && i < count; i += 2) {
      JSValue raw = JS_GetPropertyUint32(ctx, attrs, i);
      ret = frameos_block_run_value(ctx, b, raw, depth);
      JS_FreeValue(ctx, raw);
    }
  }
  JS_FreeValue(ctx, attrs);
  for (uint32_t i = 2; ret == 0 && i < length; i++) {
    JSValue raw = JS_GetPropertyUint32(ctx, t, i);
    ret = frameos_block_run_value(ctx, b, raw, depth);
    JS_FreeValue(ctx, raw);
  }
  return ret;
}

static JSValue frameos_block_lazy(JSContext *ctx, FrameosBlock *b, JSValueConst t, JSValueConst type) {
  if (frameos_block_atoms(ctx, b) < 0 || frameos_block_dyn(ctx, b) < 0) return JS_EXCEPTION;
  JSValue element = JS_NewObject(ctx);
  if (JS_IsException(element)) return element;
  if (JS_DefinePropertyValue(ctx, element, b->type_atom, JS_DupValue(ctx, type), JS_PROP_C_W_E) < 0 ||
      JS_DefinePropertyGetSet(ctx, element, b->props_atom, JS_DupValue(ctx, b->getter), JS_UNDEFINED,
                              JS_PROP_CONFIGURABLE | JS_PROP_ENUMERABLE) < 0 ||
      JS_DefinePropertyValue(ctx, element, b->site_atom, JS_DupValue(ctx, t),
                             JS_PROP_CONFIGURABLE | JS_PROP_WRITABLE) < 0 ||
      JS_DefinePropertyValue(ctx, element, b->holes_atom, JS_DupValue(ctx, b->dyn),
                             JS_PROP_CONFIGURABLE | JS_PROP_WRITABLE) < 0) {
    JS_FreeValue(ctx, element);
    return JS_EXCEPTION;
  }
  return element;
}

static JSValue frameos_block_value(JSContext *ctx, FrameosBlock *b, JSValueConst t, int depth) {
  /* The value node t stands for. */
  if (depth > 64) return JS_ThrowRangeError(ctx, "JSX template too deep");
  JSValue tag = JS_GetPropertyUint32(ctx, t, 0);
  JSValue result;
  int tag_hole = frameos_block_hole_index(tag);
  if (JS_IsNull(tag)) {
    result = frameos_block_make(ctx, b, t, b->fragment, depth);
  } else if (tag_hole >= 0) {
    JSValue type = frameos_block_hole(ctx, b, tag_hole);
    if (JS_IsException(type)) {
      result = type;
    } else if (JS_IsString(type)) {
      /* <Tag> with a string in Tag: a host element */
      result = b->running && frameos_block_run(ctx, b, t, depth) < 0 ? JS_EXCEPTION : frameos_block_lazy(ctx, b, t, type);
    } else if (!b->running && JS_IsArray(ctx, type) > 0) {
      /* made when the site ran: [output] */
      result = JS_GetPropertyUint32(ctx, type, 0);
    } else if (!b->running) {
      /* a tag that is neither a string nor a function: the factory's {type, props} */
      result = frameos_block_make(ctx, b, t, type, depth);
    } else {
      result = frameos_block_make(ctx, b, t, type, depth);
      if (!JS_IsException(result)) {
        JS_FreeValue(ctx, b->outs[tag_hole]);
        b->outs[tag_hole] = JS_DupValue(ctx, result);
        if (!JS_IsUndefined(b->dyn)) {
          /* an element made earlier in this site keeps the values already */
          JSValue box = frameos_block_box(ctx, result);
          if (JS_IsException(box) || JS_SetPropertyUint32(ctx, b->dyn, (uint32_t)tag_hole, box) < 0) {
            JS_FreeValue(ctx, result);
            result = JS_EXCEPTION;
          }
        }
      }
    }
    JS_FreeValue(ctx, type);
  } else if (JS_IsString(tag)) {
    result = b->running && frameos_block_run(ctx, b, t, depth) < 0 ? JS_EXCEPTION : frameos_block_lazy(ctx, b, t, tag);
  } else {
    result = JS_ThrowTypeError(ctx, "not a JSX template");
  }
  JS_FreeValue(ctx, tag);
  return result;
}

/* func_data: [fragment] for the getter, [fragment, getter] for the block. */
static JSValue frameos_block_getter(JSContext *ctx, JSValueConst this_val, int argc,
                                    JSValueConst *argv, int magic, JSValue *func_data) {
  (void)argc; (void)argv; (void)magic;
  JSValue site = JS_GetPropertyStr(ctx, this_val, "__frameosSite");
  JSValue dyn = JS_GetPropertyStr(ctx, this_val, "__frameosHoles");
  JSValue result = JS_UNDEFINED;
  uint32_t count;
  if (JS_IsArray(ctx, site) > 0 && JS_IsArray(ctx, dyn) > 0 && frameos_block_length(ctx, dyn, &count)) {
    FrameosBlock b = { dyn, (int)count, 0, func_data[0], JS_UNDEFINED,
                       JS_ATOM_NULL, JS_ATOM_NULL, JS_ATOM_NULL, JS_ATOM_NULL, NULL, NULL, 1 };
    frameos_block_atoms(ctx, &b);
    /* The getter itself, for the elements inside: the one on `props`. */
    JSValue getter = JS_UNDEFINED;
    JSPropertyDescriptor desc;
    if (JS_GetOwnProperty(ctx, &desc, this_val, b.props_atom) > 0) {
      getter = desc.getter;
      JS_FreeValue(ctx, desc.value);
      JS_FreeValue(ctx, desc.setter);
    }
    b.getter = getter;
    JSValue local[8], *children = local;
    int n;
    JSValue props = frameos_block_props(ctx, &b, site, 0, &n, &children, local);
    if (JS_IsException(props)) {
      result = props;
    } else {
      if (!JS_IsObject(props)) props = JS_NewObject(ctx);
      if (n > 0 && !JS_IsException(props)) {
        JSValue value;
        if (n == 1) {
          value = children[0];
        } else {
          value = JS_NewArray(ctx);
          for (int i = 0; i < n; i++) JS_SetPropertyUint32(ctx, value, (uint32_t)i, children[i]);
        }
        JS_SetPropertyStr(ctx, props, "children", value);
      } else {
        for (int i = 0; i < n; i++) JS_FreeValue(ctx, children[i]);
      }
      if (children != local) js_free(ctx, children);
      result = props;
      if (!JS_IsException(props)) {
        /* From now on a plain element, as the factory's: what it holds can
           be changed, so the walker reads it off its props. */
        JS_DefinePropertyValue(ctx, this_val, b.props_atom, JS_DupValue(ctx, props), JS_PROP_C_W_E);
        JS_DefinePropertyValue(ctx, this_val, b.site_atom, JS_UNDEFINED, JS_PROP_CONFIGURABLE | JS_PROP_WRITABLE);
      }
    }
    frameos_block_free_atoms(ctx, &b);
    JS_FreeValue(ctx, getter);
  }
  JS_FreeValue(ctx, site);
  JS_FreeValue(ctx, dyn);
  return result;
}

static JSValue frameos_block_native(JSContext *ctx, JSValueConst this_val, int argc,
                                    JSValueConst *argv, int magic, JSValue *func_data) {
  (void)this_val; (void)magic;
  if (argc < 1 || JS_IsArray(ctx, argv[0]) <= 0) return JS_ThrowTypeError(ctx, "not a JSX template");
  int count = argc - 1;
  JSValue local[8];
  JSValue *outs = count <= 8 ? local : js_malloc(ctx, sizeof(JSValue) * (size_t)count);
  if (!outs) return JS_EXCEPTION;
  for (int i = 0; i < count; i++) outs[i] = JS_UNINITIALIZED;
  FrameosBlock b = { JS_UNDEFINED, count, 1, func_data[0], func_data[1],
                     JS_ATOM_NULL, JS_ATOM_NULL, JS_ATOM_NULL, JS_ATOM_NULL, argv + 1, outs, 1 };
  for (int i = 0; i < count && b.no_components; i++)
    if (JS_IsFunction(ctx, argv[i + 1])) b.no_components = 0;
  JSValue result = frameos_block_value(ctx, &b, argv[0], 0);
  frameos_block_free_atoms(ctx, &b);
  JS_FreeValue(ctx, b.dyn);
  for (int i = 0; i < count; i++) JS_FreeValue(ctx, outs[i]);
  if (outs != local) js_free(ctx, outs);
  return result;
}

static int frameos_install_native_jsx(JSContext *ctx) {
  JSValue global = JS_GetGlobalObject(ctx);
  JSValue fragment = JS_GetPropertyStr(ctx, global, "__frameosFragment");
  int ok = 0;
  if (JS_IsSymbol(fragment)) {
    JSValue fn = JS_NewCFunctionData(ctx, frameos_jsx_native, 2, 0, 1, &fragment);
    JSValue data[2] = { fragment, JS_UNDEFINED };
    data[1] = JS_NewCFunctionData(ctx, frameos_block_getter, 0, 0, 1, data);
    JSValue block = JS_IsException(data[1]) ? JS_EXCEPTION : JS_NewCFunctionData(ctx, frameos_block_native, 1, 0, 2, data);
    JS_FreeValue(ctx, data[1]);
    if (JS_IsException(fn) || JS_IsException(block)) {
      JS_FreeValue(ctx, fn); JS_FreeValue(ctx, block);
    } else {
      /* Set takes each value, even when it fails. */
      ok = JS_SetPropertyStr(ctx, global, "__frameosJsx", fn) >= 0;
      ok = JS_SetPropertyStr(ctx, global, "__frameosBlock", block) >= 0 && ok;
    }
  }
  JS_FreeValue(ctx, fragment);
  JS_FreeValue(ctx, global);
  return ok;
}
""".}

proc frameosInstallNativeJsx(ctx: ptr JSContext): cint {.importc: "frameos_install_native_jsx", nodecl.}

proc installNativeJsx*(js: QuickJS): bool =
  ## The C factory as `__frameosJsx` and the C block as `__frameosBlock` in
  ## `js`, whose prelude defined `__frameosFragment`; false (the JavaScript
  ## ones stay) otherwise.
  frameosInstallNativeJsx(js.context) != 0
