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
  JS_FreeValue(ctx, fragment);
  JS_FreeValue(ctx, global);
  return ok;
}
""".}

proc frameosInstallNativeJsx(ctx: ptr JSContext): cint {.importc: "frameos_install_native_jsx", nodecl.}

proc installNativeJsx*(js: QuickJS): bool =
  ## The C factory as `__frameosJsx` in `js`, whose prelude defined
  ## `__frameosFragment`; false (the JavaScript factory stays) otherwise.
  frameosInstallNativeJsx(js.context) != 0
