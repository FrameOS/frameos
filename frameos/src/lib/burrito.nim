# FrameOS notice!
# This file is copied from https://github.com/tapsterbot/burrito/blob/main/src/burrito/qjs.nim
# Burrito is not a nimble package, and I couldn't get the NixOS build to work with all the workarounds.
# I'm happy to work with upstream and change it to a dependency in the future, but I inlined it now to move fast.
# Thanks for all the hard work!
#
## Burrito - QuickJS Nim Wrapper
##
## A wrapper for the QuickJS JavaScript engine.
## This module provides comprehensive functionality to create JS contexts,
## evaluate JavaScript code, and expose Nim functions to JavaScript.
##
## **Example: Basic Usage**
## ```nim
## import burrito
##
## # Create a QuickJS instance
## var js = newQuickJS()
##
## # Evaluate JavaScript expressions
## echo js.eval("2 + 3")                    # Output: 5
## echo js.eval("'Hello ' + 'World!'")      # Output: Hello World!
##
## # Expose Nim functions to JavaScript
## proc greet(ctx: ptr JSContext, name: JSValue): JSValue =
##   let nameStr = toNimString(ctx, name)
##   result = nimStringToJS(ctx, "Hello from Nim, " & nameStr & "!")
##
## js.registerFunction("greet", greet)
## echo js.eval("greet('Burrito')")        # Output: Hello from Nim, Burrito!
## js.close()
## ```
##
## **Example: Embedded REPL**
## ```nim
## import burrito
##
## # Create QuickJS with full standard library support
## var js = newQuickJS(configWithBothLibs())
##
## # Add custom functions accessible in the REPL
## proc getCurrentTime(ctx: ptr JSContext): JSValue =
##   nimStringToJS(ctx, now().format("yyyy-MM-dd HH:mm:ss"))
##
## js.registerFunction("getCurrentTime", getCurrentTime)
##
## # Load and start the REPL
## let replCode = readFile("quickjs/repl.js")
## discard js.evalModule(replCode, "<repl>")
## js.runPendingJobs()
## js.processStdLoop()  # Interactive REPL runs here
## js.close()
## ```
##
## **Example: Bytecode Compilation**
## ```nim
## import burrito
##
## var js = newQuickJS()
##
## # Add a simple function
## proc multiply(ctx: ptr JSContext, a: JSValue, b: JSValue): JSValue =
##   let numA = toNimFloat(ctx, a)
##   let numB = toNimFloat(ctx, b)
##   result = nimFloatToJS(ctx, numA * numB)
##
## js.registerFunction("multiply", multiply)
##
## # Compile JavaScript to bytecode
## let code = "multiply(5, 6);"
## let bytecode = js.compileToBytecode(code)
##
## # Execute bytecode (faster, no compilation needed) - works with any bytecode!
## let result = js.evalBytecode(bytecode)
##
## # For REPL: Use pre-compiled bytecode (run: nimble compile_repl_bytecode)
## import ../build/src/repl_bytecode
## discard js.evalBytecodeModule(qjsc_replBytecode)
## js.close()
## ```
##

import std/[tables, macros, json, strutils, os]

const
  quickjsPath = when defined(windows):
    "quickjs/libquickjs.a"
  else:
    "quickjs/libquickjs.a"

{.passC: "-I.".} # Add current directory to include path for local headers
{.passL: quickjsPath.}
{.passL: "-lm".}

# Link QuickJS standard library (contains std and os modules)
when fileExists("quickjs/libquickjs.libc.a"):
  {.passL: "quickjs/libquickjs.libc.a".}
else:
  # If separate libc library doesn't exist, the std/os modules
  # should be included in the main libquickjs.a
  discard

type
  JSRuntime* {.importc: "struct JSRuntime", header: "quickjs/quickjs.h".} = object
  JSContext* {.importc: "struct JSContext", header: "quickjs/quickjs.h".} = object
  JSModuleDef* {.importc: "struct JSModuleDef", header: "quickjs/quickjs.h".} = object
  JSAtom* = uint32
  JSClassID* = uint32

  # Pointer types for runtime and context
  JSRuntimePtr* = ptr JSRuntime
  JSContextPtr* = ptr JSContext

  # Import JSValue as opaque struct from C
  JSValue* {.importc, header: "quickjs/quickjs.h".} = object
  JSValueConst* = JSValue

  # Function pointer type for JavaScript C functions
  JSCFunction* = proc(ctx: ptr JSContext, thisVal: JSValueConst, argc: cint, argv: ptr JSValueConst): JSValue {.cdecl.}
  JSCFunctionMagic* = proc(ctx: ptr JSContext, thisVal: JSValueConst, argc: cint, argv: ptr JSValueConst,
      magic: cint): JSValue {.cdecl.}
  JSCFunctionData* = proc(ctx: ptr JSContext, thisVal: JSValueConst, argc: cint, argv: ptr JSValueConst, magic: cint,
      data: ptr JSValue): JSValue {.cdecl.}

# Standard library module bindings from quickjs-libc.h
{.push importc, header: "quickjs/quickjs-libc.h".}

proc js_init_module_std*(ctx: ptr JSContext, module_name: cstring): ptr JSModuleDef
proc js_init_module_os*(ctx: ptr JSContext, module_name: cstring): ptr JSModuleDef
proc js_std_add_helpers*(ctx: ptr JSContext, argc: cint, argv: ptr cstring)
proc js_std_init_handlers*(rt: ptr JSRuntime)
proc js_std_free_handlers*(rt: ptr JSRuntime)
proc js_std_await*(ctx: ptr JSContext, val: JSValue): JSValue
proc js_std_loop*(ctx: ptr JSContext)
proc js_module_loader*(ctx: ptr JSContext, module_name: cstring, opaque: pointer): ptr JSModuleDef {.cdecl.}

{.pop.}

# Core QuickJS API bindings
{.push importc, header: "quickjs/quickjs.h".}

proc JS_NewRuntime*(): ptr JSRuntime
proc JS_FreeRuntime*(rt: ptr JSRuntime)
proc JS_NewContext*(rt: ptr JSRuntime): ptr JSContext
proc JS_FreeContext*(ctx: ptr JSContext)

# Value operations
proc JS_NewInt32*(ctx: ptr JSContext, val: int32): JSValue
proc JS_NewFloat64*(ctx: ptr JSContext, val: float64): JSValue
proc JS_NewStringLen*(ctx: ptr JSContext, str: cstring, len: csize_t): JSValue
proc JS_NewBool*(ctx: ptr JSContext, val: cint): JSValue
proc JS_NewObject*(ctx: ptr JSContext): JSValue

# Getting values from JSValue
proc JS_ToInt32*(ctx: ptr JSContext, pres: ptr int32, val: JSValueConst): cint
proc JS_ToFloat64*(ctx: ptr JSContext, pres: ptr float64, val: JSValueConst): cint
proc JS_ToCString*(ctx: ptr JSContext, val: JSValueConst): cstring
proc JS_FreeCString*(ctx: ptr JSContext, str: cstring)
proc JS_ToBool*(ctx: ptr JSContext, val: JSValueConst): cint

# Function and property operations
proc JS_NewCFunction*(ctx: ptr JSContext, `func`: JSCFunction, name: cstring, length: cint): JSValue
proc JS_NewCFunction2*(ctx: ptr JSContext, `func`: JSCFunction, name: cstring, length: cint, cproto: cint,
    magic: cint): JSValue
proc JS_NewCFunctionMagic*(ctx: ptr JSContext, `func`: JSCFunctionMagic, name: cstring, length: cint, cproto: cint,
    magic: cint): JSValue
proc JS_NewCFunctionData*(ctx: ptr JSContext, `func`: JSCFunctionData, length: cint, magic: cint, dataLen: cint,
    data: ptr JSValue): JSValue
proc JS_DefinePropertyValueStr*(ctx: ptr JSContext, thisObj: JSValueConst, prop: cstring, val: JSValue,
    flags: cint): cint

# Context opaque data operations
proc JS_SetContextOpaque*(ctx: ptr JSContext, opaque: pointer)
proc JS_GetContextOpaque*(ctx: ptr JSContext): pointer

# Evaluation
proc JS_Eval*(ctx: ptr JSContext, input: cstring, inputLen: csize_t, filename: cstring, evalFlags: cint): JSValue
proc JS_EvalFunction*(ctx: ptr JSContext, fun_obj: JSValue): JSValue

# Memory management
proc JS_FreeValue*(ctx: ptr JSContext, v: JSValue)
proc JS_DupValue*(ctx: ptr JSContext, v: JSValueConst): JSValue

# Exception handling
proc JS_IsException*(v: JSValueConst): cint
proc JS_GetException*(ctx: ptr JSContext): JSValue
proc JS_Throw*(ctx: ptr JSContext, obj: JSValueConst): JSValue
proc JS_ThrowTypeError*(ctx: ptr JSContext, fmt: cstring): JSValue {.varargs.}
proc JS_ThrowReferenceError*(ctx: ptr JSContext, fmt: cstring): JSValue {.varargs.}
proc JS_ThrowRangeError*(ctx: ptr JSContext, fmt: cstring): JSValue {.varargs.}
proc JS_ThrowInternalError*(ctx: ptr JSContext, fmt: cstring): JSValue {.varargs.}

# Global object
proc JS_GetGlobalObject*(ctx: ptr JSContext): JSValue

# Type checking functions - removed since inline functions are problematic

# Object and property manipulation
proc JS_GetProperty*(ctx: ptr JSContext, thisObj: JSValueConst, prop: JSAtom): JSValue
proc JS_GetPropertyStr*(ctx: ptr JSContext, thisObj: JSValueConst, prop: cstring): JSValue
proc JS_GetPropertyUint32*(ctx: ptr JSContext, thisObj: JSValueConst, idx: uint32): JSValue
proc JS_SetProperty*(ctx: ptr JSContext, thisObj: JSValueConst, prop: JSAtom, val: JSValue): cint
proc JS_SetPropertyStr*(ctx: ptr JSContext, thisObj: JSValueConst, prop: cstring, val: JSValue): cint
proc JS_SetPropertyUint32*(ctx: ptr JSContext, thisObj: JSValueConst, idx: uint32, val: JSValue): cint
proc JS_HasProperty*(ctx: ptr JSContext, thisObj: JSValueConst, prop: JSAtom): cint
proc JS_DeleteProperty*(ctx: ptr JSContext, thisObj: JSValueConst, prop: JSAtom, flags: cint): cint

# Array functions
proc JS_NewArray*(ctx: ptr JSContext): JSValue

# Atom functions (for property names)
proc JS_NewAtom*(ctx: ptr JSContext, str: cstring): JSAtom
proc JS_NewAtomLen*(ctx: ptr JSContext, str: cstring, len: csize_t): JSAtom
proc JS_FreeAtom*(ctx: ptr JSContext, atom: JSAtom)
proc JS_AtomToString*(ctx: ptr JSContext, atom: JSAtom): JSValue

# Module loading
proc JS_SetModuleLoaderFunc*(rt: ptr JSRuntime, module_normalize: pointer, module_loader: proc(ctx: ptr JSContext,
    moduleName: cstring, opaque: pointer): ptr JSModuleDef {.cdecl.}, opaque: pointer)

# Promise-related functions
proc JS_PromiseState*(ctx: ptr JSContext, promise: JSValueConst): cint
proc JS_PromiseResult*(ctx: ptr JSContext, promise: JSValueConst): JSValue

# Module-related functions
proc JS_DetectModule*(input: cstring, inputLen: csize_t): cint
proc JS_GetModuleNamespace*(ctx: ptr JSContext, m: ptr JSModuleDef): JSValue

# Job execution (needed for proper module cleanup)
proc JS_ExecutePendingJob*(rt: ptr JSRuntime, pctx: ptr ptr JSContext): cint

# Garbage collection
proc JS_RunGC*(rt: ptr JSRuntime)

# Bytecode serialization
proc JS_WriteObject*(ctx: ptr JSContext, psize: ptr csize_t, obj: JSValueConst, flags: cint): ptr uint8
proc JS_ReadObject*(ctx: ptr JSContext, buf: ptr uint8, bufLen: csize_t, flags: cint): JSValue

{.pop.}

# Bytecode evaluation from quickjs-libc.h
{.push importc, header: "quickjs/quickjs-libc.h".}
proc js_std_eval_binary*(ctx: ptr JSContext, buf: ptr uint8, bufLen: csize_t, flags: cint)
{.pop.}

# JavaScript evaluation flags
const
  JS_EVAL_TYPE_GLOBAL* = 0
  JS_EVAL_TYPE_MODULE* = 1
  JS_EVAL_FLAG_STRICT* = (1 shl 3)
  JS_EVAL_FLAG_STRIP* = (1 shl 5)
  JS_EVAL_FLAG_COMPILE_ONLY* = (1 shl 6)

# Property flags
const
  JS_PROP_CONFIGURABLE* = (1 shl 0)
  JS_PROP_WRITABLE* = (1 shl 1)
  JS_PROP_ENUMERABLE* = (1 shl 2)

# Bytecode serialization flags
const
  JS_WRITE_OBJ_BYTECODE* = (1 shl 0)
  JS_WRITE_OBJ_BSWAP* = (1 shl 1)
  JS_READ_OBJ_BYTECODE* = (1 shl 0)

# C Function types
const
  JS_CFUNC_generic* = 0
  JS_CFUNC_generic_magic* = 1

# Constants as procs that call the C macros
proc jsUndefined*(ctx: ptr JSContext): JSValue =
  ## Return JavaScript undefined value
  {.emit: "return JS_UNDEFINED;".}

proc jsNull*(ctx: ptr JSContext): JSValue =
  ## Return JavaScript null value
  {.emit: "return JS_NULL;".}

proc jsTrue*(ctx: ptr JSContext): JSValue =
  ## Return JavaScript true value
  {.emit: "return JS_TRUE;".}

proc jsFalse*(ctx: ptr JSContext): JSValue =
  ## Return JavaScript false value
  {.emit: "return JS_FALSE;".}

# High-level wrapper types
type
  # Nim function signatures that can be registered (context-aware)
  #
  # AUTOMATIC MEMORY MANAGEMENT:
  # JSValue arguments passed to fixed-arity functions (NimFunction1/2/3) are
  # automatically freed by the trampoline - you don't need to call JS_FreeValue!
  #
  # For variadic functions (NimFunctionVariadic), the args sequence elements
  # are also automatically freed by the trampoline.
  #
  # Example (no manual freeing needed):
  #   proc myFunc(ctx: ptr JSContext, arg: JSValue): JSValue =
  #     let str = toNimString(ctx, arg)
  #     # No need to call JS_FreeValue(ctx, arg) - handled automatically!
  #     return nimStringToJS(ctx, "processed: " & str)
  #
  NimFunction0* = proc(ctx: ptr JSContext): JSValue {.nimcall.}
  NimFunction1* = proc(ctx: ptr JSContext, arg: JSValue): JSValue {.nimcall.}
  NimFunction2* = proc(ctx: ptr JSContext, arg1, arg2: JSValue): JSValue {.nimcall.}
  NimFunction3* = proc(ctx: ptr JSContext, arg1, arg2, arg3: JSValue): JSValue {.nimcall.}
  NimFunctionVariadic* = proc(ctx: ptr JSContext, args: seq[JSValue]): JSValue {.nimcall.}

  # Function registry entry
  NimFunctionKind* = enum
    nimFunc0 = 0, nimFunc1, nimFunc2, nimFunc3, nimFuncVar

  NimFunctionEntry* = object
    case kind*: NimFunctionKind
    of nimFunc0: func0*: NimFunction0
    of nimFunc1: func1*: NimFunction1
    of nimFunc2: func2*: NimFunction2
    of nimFunc3: func3*: NimFunction3
    of nimFuncVar: funcVar*: NimFunctionVariadic

  # Context data to pass to C callbacks
  BurritoContextData* = object
    functions*: Table[cint, NimFunctionEntry]
    context*: ptr JSContext

  QuickJSConfig* = object
    ## Configuration for QuickJS instance creation
    includeStdLib*: bool     ## Include std module (default: false)
    includeOsLib*: bool      ## Include os module (default: false)
    enableStdHandlers*: bool ## Enable std event handlers (default: false)

  QuickJS* = object
    ## QuickJS wrapper object containing runtime and context
    ##
    ## ⚠️  THREAD SAFETY WARNING:
    ## QuickJS instances are NOT thread-safe. You must either:
    ## 1. Access each QuickJS instance from only one thread (recommended), OR
    ## 2. Use external synchronization (Lock/Mutex) around ALL QuickJS method calls
    ##    if sharing an instance across threads
    ##
    ## Each thread should ideally have its own QuickJS instance for best performance.
    runtime*: ptr JSRuntime
    context*: ptr JSContext
    contextData*: ptr BurritoContextData
    nextFunctionId*: cint
    config*: QuickJSConfig

  JSException* = object of CatchableError
    jsValue*: JSValue

# Value conversion helpers
proc toNimString*(ctx: ptr JSContext, val: JSValueConst): string =
  let cstr = JS_ToCString(ctx, val)
  if cstr != nil:
    result = $cstr
    JS_FreeCString(ctx, cstr) # Important: free the C string
  else:
    result = ""

proc toNimInt*(ctx: ptr JSContext, val: JSValueConst): int32 =
  var res: int32
  if JS_ToInt32(ctx, addr res, val) != 0: # Check for error
    # Consider getting more specific error info if possible, or a generic conversion error
    raise newException(JSException, "Failed to convert JSValue to int32")
  result = res

proc toNimFloat*(ctx: ptr JSContext, val: JSValueConst): float64 =
  var res: float64
  if JS_ToFloat64(ctx, addr res, val) != 0: # Check for error
    raise newException(JSException, "Failed to convert JSValue to float64")
  result = res

proc toNimBool*(ctx: ptr JSContext, val: JSValueConst): bool =
  JS_ToBool(ctx, val) != 0

# Conversion from Nim types to JSValue
proc nimStringToJS*(ctx: ptr JSContext, str: string): JSValue =
  JS_NewStringLen(ctx, str.cstring, str.len.csize_t)

proc nimIntToJS*(ctx: ptr JSContext, val: int32): JSValue =
  JS_NewInt32(ctx, val)

proc nimFloatToJS*(ctx: ptr JSContext, val: float64): JSValue =
  JS_NewFloat64(ctx, val)

proc nimBoolToJS*(ctx: ptr JSContext, val: bool): JSValue =
  JS_NewBool(ctx, if val: 1 else: 0)

# Advanced type marshaling functions are added after basic functions are defined

# High-level type checking helpers (fallback implementation for compatibility)
proc isUndefined*(ctx: ptr JSContext, val: JSValueConst): bool =
  # Check if converting to string gives "undefined"
  let str = toNimString(ctx, val)
  result = str == "undefined"

proc isNull*(ctx: ptr JSContext, val: JSValueConst): bool =
  # Check if converting to string gives "null"
  let str = toNimString(ctx, val)
  result = str == "null"

proc isBool*(ctx: ptr JSContext, val: JSValueConst): bool =
  # Try converting to bool and check if the string representation is "true" or "false"
  let str = toNimString(ctx, val)
  result = str == "true" or str == "false"

proc isNumber*(ctx: ptr JSContext, val: JSValueConst): bool =
  # Try to convert to number - if it throws, it's not a number
  try:
    discard toNimFloat(ctx, val)
    result = true
  except:
    result = false

proc isString*(ctx: ptr JSContext, val: JSValueConst): bool =
  # Check if it's quoted in JSON representation
  let str = toNimString(ctx, val)
  var isNumeric = false
  try:
    discard parseFloat(str)
    isNumeric = true
  except:
    isNumeric = false
  result = not (str == "null" or str == "undefined" or str == "true" or str == "false" or isNumeric)

proc isObject*(ctx: ptr JSContext, val: JSValueConst): bool =
  # Check if string representation starts with { or [
  let str = toNimString(ctx, val)
  result = str.startsWith("{") or str == "[object Object]"

proc isArray*(ctx: ptr JSContext, val: JSValueConst): bool =
  # Check if string representation starts with [
  let str = toNimString(ctx, val)
  result = str.startsWith("[") and not str.startsWith("[object")

proc isFunction*(ctx: ptr JSContext, val: JSValueConst): bool =
  # Check if string representation contains "function"
  let str = toNimString(ctx, val)
  result = str.contains("function")

# High-level object manipulation helpers
proc getProperty*(ctx: ptr JSContext, obj: JSValueConst, key: string): JSValue =
  ## Get a property from a JavaScript object by string key
  JS_GetPropertyStr(ctx, obj, key.cstring)

proc setProperty*(ctx: ptr JSContext, obj: JSValueConst, key: string, value: JSValue): bool =
  ## Set a property on a JavaScript object by string key
  JS_SetPropertyStr(ctx, obj, key.cstring, value) >= 0

proc getArrayElement*(ctx: ptr JSContext, arr: JSValueConst, index: uint32): JSValue =
  ## Get an element from a JavaScript array by index
  JS_GetPropertyUint32(ctx, arr, index)

proc setArrayElement*(ctx: ptr JSContext, arr: JSValueConst, index: uint32, value: JSValue): bool =
  ## Set an element in a JavaScript array by index
  JS_SetPropertyUint32(ctx, arr, index, value) >= 0

proc newArray*(ctx: ptr JSContext): JSValue =
  ## Create a new JavaScript array
  JS_NewArray(ctx)

proc getArrayLength*(ctx: ptr JSContext, arr: JSValueConst): uint32 =
  ## Get the length of a JavaScript array
  let lengthVal = getProperty(ctx, arr, "length")
  defer: JS_FreeValue(ctx, lengthVal)
  if isNumber(ctx, lengthVal):
    result = toNimInt(ctx, lengthVal).uint32
  else:
    result = 0

# Auto-freeing convenience functions for common patterns

proc getPropertyValue*[T](ctx: ptr JSContext, obj: JSValueConst, key: string, target: typedesc[T]): T =
  ## Get a property value and automatically convert to Nim type with automatic memory management
  let jsVal = getProperty(ctx, obj, key)
  defer: JS_FreeValue(ctx, jsVal)

  when T is string:
    result = toNimString(ctx, jsVal)
  elif T is int32:
    result = toNimInt(ctx, jsVal)
  elif T is int:
    result = toNimInt(ctx, jsVal).int
  elif T is float64:
    # Use type checking for robust conversion
    if isNumber(ctx, jsVal):
      result = toNimFloat(ctx, jsVal)
    else:
      result = 0.0
  elif T is float:
    # Use type checking for robust conversion
    if isNumber(ctx, jsVal):
      result = toNimFloat(ctx, jsVal).float
    else:
      result = 0.0
  elif T is bool:
    result = toNimBool(ctx, jsVal)
  else:
    {.error: "Unsupported type for getPropertyValue".}

proc getArrayElementValue*[T](ctx: ptr JSContext, arr: JSValueConst, index: uint32, target: typedesc[T]): T =
  ## Get an array element value and automatically convert to Nim type with automatic memory management
  let jsVal = getArrayElement(ctx, arr, index)
  defer: JS_FreeValue(ctx, jsVal)

  when T is string:
    result = toNimString(ctx, jsVal)
  elif T is int32:
    result = toNimInt(ctx, jsVal)
  elif T is int:
    result = toNimInt(ctx, jsVal).int
  elif T is float64:
    # Use type checking for robust conversion
    if isNumber(ctx, jsVal):
      result = toNimFloat(ctx, jsVal)
    else:
      result = 0.0
  elif T is float:
    # Use type checking for robust conversion
    if isNumber(ctx, jsVal):
      result = toNimFloat(ctx, jsVal).float
    else:
      result = 0.0
  elif T is bool:
    result = toNimBool(ctx, jsVal)
  else:
    {.error: "Unsupported type for getArrayElementValue".}

template withGlobalObject*(ctx: ptr JSContext, globalVar: untyped, body: untyped): untyped =
  ## Automatically manage the global object lifetime in a scoped block
  let globalVar = JS_GetGlobalObject(ctx)
  defer: JS_FreeValue(ctx, globalVar)
  body

template withProperty*(ctx: ptr JSContext, obj: JSValueConst, key: string, propVar: untyped, body: untyped): untyped =
  ## Automatically manage a property value lifetime in a scoped block
  let propVar = getProperty(ctx, obj, key)
  defer: JS_FreeValue(ctx, propVar)
  body

template withArrayElement*(ctx: ptr JSContext, arr: JSValueConst, index: uint32, elemVar: untyped,
    body: untyped): untyped =
  ## Automatically manage an array element lifetime in a scoped block
  let elemVar = getArrayElement(ctx, arr, index)
  defer: JS_FreeValue(ctx, elemVar)
  body

# High-level convenience functions that combine common patterns

proc setGlobalProperty*[T](ctx: ptr JSContext, name: string, value: T): bool =
  ## Set a global property with automatic memory management
  withGlobalObject(ctx, globalObj):
    when T is string:
      result = setProperty(ctx, globalObj, name, nimStringToJS(ctx, value))
    elif T is int32:
      result = setProperty(ctx, globalObj, name, nimIntToJS(ctx, value))
    elif T is int:
      result = setProperty(ctx, globalObj, name, nimIntToJS(ctx, value.int32))
    elif T is float64:
      result = setProperty(ctx, globalObj, name, nimFloatToJS(ctx, value))
    elif T is float:
      result = setProperty(ctx, globalObj, name, nimFloatToJS(ctx, value.float64))
    elif T is bool:
      result = setProperty(ctx, globalObj, name, nimBoolToJS(ctx, value))
    else:
      result = setProperty(ctx, globalObj, name, nimStringToJS(ctx, $value))

proc getGlobalProperty*[T](ctx: ptr JSContext, name: string, target: typedesc[T]): T =
  ## Get a global property value with automatic memory management
  withGlobalObject(ctx, globalObj):
    result = getPropertyValue(ctx, globalObj, name, T)

# More idiomatic Nim syntax using explicit type helpers
proc get*[T](ctx: ptr JSContext, name: string, t: typedesc[T]): T =
  ## Get a global property value: ctx.get("userName", string)
  getGlobalProperty(ctx, name, T)

proc set*[T](ctx: ptr JSContext, name: string, value: T) =
  ## Set a global property value: ctx.set("userName", "Alice")
  discard setGlobalProperty(ctx, name, value)

# Even more idiomatic with method call syntax
proc `[]=`*[T](ctx: ptr JSContext, name: string, value: T) =
  ## Set a global property value using idiomatic syntax for assignment to JavaScript globals
  discard setGlobalProperty(ctx, name, value)

# Type-specific getters for the most common cases
proc getString*(ctx: ptr JSContext, name: string): string =
  ## Get a global string property: ctx.getString("userName")
  getGlobalProperty(ctx, name, string)

proc getInt*(ctx: ptr JSContext, name: string): int =
  ## Get a global int property: ctx.getInt("userAge")
  getGlobalProperty(ctx, name, int)

proc getFloat*(ctx: ptr JSContext, name: string): float64 =
  ## Get a global float property: ctx.getFloat("userScore")
  getGlobalProperty(ctx, name, float64)

proc getBool*(ctx: ptr JSContext, name: string): bool =
  ## Get a global bool property: ctx.getBool("isActive")
  getGlobalProperty(ctx, name, bool)

# Create a special return type that can auto-convert to many types
type
  JSAutoValue* = object
    ctx: ptr JSContext
    name: string

proc get*(ctx: ptr JSContext, name: string): JSAutoValue =
  ## Get a property that can auto-convert to the expected type
  ## Usage: let magicText: string = ctx.get("magic")  # auto-converts to string
  ##        let magicNumber: int = ctx.get("number")   # auto-converts to int
  JSAutoValue(ctx: ctx, name: name)

# Converter procs for automatic type conversion
converter toStringFromAuto*(val: JSAutoValue): string =
  getGlobalProperty(val.ctx, val.name, string)

converter toIntFromAuto*(val: JSAutoValue): int =
  getGlobalProperty(val.ctx, val.name, int)

converter toInt32FromAuto*(val: JSAutoValue): int32 =
  getGlobalProperty(val.ctx, val.name, int32)

converter toFloatFromAuto*(val: JSAutoValue): float64 =
  getGlobalProperty(val.ctx, val.name, float64)

converter toBoolFromAuto*(val: JSAutoValue): bool =
  getGlobalProperty(val.ctx, val.name, bool)

# String representation for JSAutoValue (defaults to string conversion)
proc `$`*(val: JSAutoValue): string =
  getGlobalProperty(val.ctx, val.name, string)

# Auto-type detection and conversion
type
  JSValueKind* = enum
    jvkString, jvkInt, jvkFloat, jvkBool, jvkNull, jvkUndefined, jvkObject, jvkArray

  JSAutoDetectedValue* = object
    case kind*: JSValueKind
    of jvkString: strVal*: string
    of jvkInt: intVal*: int
    of jvkFloat: floatVal*: float64
    of jvkBool: boolVal*: bool
    of jvkNull: discard
    of jvkUndefined: discard
    of jvkObject: objRepr*: string # JSON representation
    of jvkArray: arrRepr*: string  # JSON representation

proc autoDetect*(ctx: ptr JSContext, name: string): JSAutoDetectedValue =
  ## Automatically detect the JavaScript type and return appropriate Nim value
  withGlobalObject(ctx, globalObj):
    let jsVal = getProperty(ctx, globalObj, name)
    defer: JS_FreeValue(ctx, jsVal)

    if isUndefined(ctx, jsVal):
      result = JSAutoDetectedValue(kind: jvkUndefined)
    elif isNull(ctx, jsVal):
      result = JSAutoDetectedValue(kind: jvkNull)
    elif isBool(ctx, jsVal):
      result = JSAutoDetectedValue(kind: jvkBool, boolVal: toNimBool(ctx, jsVal))
    elif isNumber(ctx, jsVal):
      let floatVal = toNimFloat(ctx, jsVal)
      # Check if it's an integer
      if floatVal == floatVal.int.float64:
        result = JSAutoDetectedValue(kind: jvkInt, intVal: floatVal.int)
      else:
        result = JSAutoDetectedValue(kind: jvkFloat, floatVal: floatVal)
    elif isArray(ctx, jsVal):
      result = JSAutoDetectedValue(kind: jvkArray, arrRepr: toNimString(ctx, jsVal))
    elif isObject(ctx, jsVal):
      result = JSAutoDetectedValue(kind: jvkObject, objRepr: toNimString(ctx, jsVal))
    elif isString(ctx, jsVal):
      result = JSAutoDetectedValue(kind: jvkString, strVal: toNimString(ctx, jsVal))
    else:
      # Fallback to string
      result = JSAutoDetectedValue(kind: jvkString, strVal: toNimString(ctx, jsVal))

# String representation for auto-detected values
proc `$`*(val: JSAutoDetectedValue): string =
  case val.kind
  of jvkString: val.strVal
  of jvkInt: $val.intVal
  of jvkFloat: $val.floatVal
  of jvkBool: $val.boolVal
  of jvkNull: "null"
  of jvkUndefined: "undefined"
  of jvkObject: val.objRepr
  of jvkArray: val.arrRepr

# Convenience function for auto-detection
proc detectType*(ctx: ptr JSContext, name: string): JSAutoDetectedValue =
  ## Detect the actual JavaScript type and return the appropriate Nim value
  ## Usage: let value = ctx.detectType("someProperty")
  ##        echo "Type: ", value.kind, ", Value: ", value
  autoDetect(ctx, name)

# Scoped template for idiomatic property access within a context
template withIdiomatic*(ctx: ptr JSContext, body: untyped): untyped =
  ## Enable idiomatic syntax for JS objects and arrays within a scope
  template `[]`[T](obj: JSValueConst, name: string): T =
    getPropertyValue(ctx, obj, name, T)

  template `[]=`[T](obj: JSValueConst, name: string, value: T) =
    when T is string:
      discard setProperty(ctx, obj, name, nimStringToJS(ctx, value))
    elif T is int32:
      discard setProperty(ctx, obj, name, nimIntToJS(ctx, value))
    elif T is int:
      discard setProperty(ctx, obj, name, nimIntToJS(ctx, value.int32))
    elif T is float64:
      discard setProperty(ctx, obj, name, nimFloatToJS(ctx, value))
    elif T is float:
      discard setProperty(ctx, obj, name, nimFloatToJS(ctx, value.float64))
    elif T is bool:
      discard setProperty(ctx, obj, name, nimBoolToJS(ctx, value))
    else:
      discard setProperty(ctx, obj, name, nimStringToJS(ctx, $value))

  template `[]`[T](arr: JSValueConst, index: uint32): T =
    getArrayElementValue(ctx, arr, index, T)

  template `[]=`[T](arr: JSValueConst, index: uint32, value: T) =
    when T is string:
      discard setArrayElement(ctx, arr, index, nimStringToJS(ctx, value))
    elif T is int32:
      discard setArrayElement(ctx, arr, index, nimIntToJS(ctx, value))
    elif T is int:
      discard setArrayElement(ctx, arr, index, nimIntToJS(ctx, value.int32))
    elif T is float64:
      discard setArrayElement(ctx, arr, index, nimFloatToJS(ctx, value))
    elif T is float:
      discard setArrayElement(ctx, arr, index, nimFloatToJS(ctx, value.float64))
    elif T is bool:
      discard setArrayElement(ctx, arr, index, nimBoolToJS(ctx, value))
    else:
      discard setArrayElement(ctx, arr, index, nimStringToJS(ctx, $value))

  body

proc iterateArray*(ctx: ptr JSContext, arr: JSValueConst, callback: proc(ctx: ptr JSContext, index: uint32,
    element: JSValueConst)) =
  ## Iterate over array elements with automatic memory management for each element
  let length = getArrayLength(ctx, arr)
  for i in 0..<length:
    withArrayElement(ctx, arr, i, element):
      callback(ctx, i, element)

proc collectArray*[T](ctx: ptr JSContext, arr: JSValueConst, target: typedesc[T]): seq[T] =
  ## Collect array elements into a Nim sequence with automatic memory management
  let length = getArrayLength(ctx, arr)
  result = newSeq[T](length)
  for i in 0..<length:
    result[i] = getArrayElementValue(ctx, arr, i, T)

# Advanced type marshaling functions

# Sequence to JavaScript array conversion
proc seqToJS*[T](ctx: ptr JSContext, s: seq[T]): JSValue =
  ## Convert a Nim sequence to a JavaScript array
  let arr = newArray(ctx)
  for i, item in s:
    when T is string:
      discard setArrayElement(ctx, arr, i.uint32, nimStringToJS(ctx, item))
    elif T is int or T is int32:
      discard setArrayElement(ctx, arr, i.uint32, nimIntToJS(ctx, item.int32))
    elif T is float or T is float64:
      discard setArrayElement(ctx, arr, i.uint32, nimFloatToJS(ctx, item.float64))
    elif T is bool:
      discard setArrayElement(ctx, arr, i.uint32, nimBoolToJS(ctx, item))
    else:
      # For complex types, convert to string representation
      discard setArrayElement(ctx, arr, i.uint32, nimStringToJS(ctx, $item))
  return arr

# Table to JavaScript object conversion
proc tableToJS*[K, V](ctx: ptr JSContext, t: Table[K, V]): JSValue =
  ## Convert a Nim Table to a JavaScript object
  let obj = JS_NewObject(ctx)
  for key, value in t:
    let keyStr = when K is string: key else: $key
    when V is string:
      discard setProperty(ctx, obj, keyStr, nimStringToJS(ctx, value))
    elif V is int or V is int32:
      discard setProperty(ctx, obj, keyStr, nimIntToJS(ctx, value.int32))
    elif V is float or V is float64:
      discard setProperty(ctx, obj, keyStr, nimFloatToJS(ctx, value.float64))
    elif V is bool:
      discard setProperty(ctx, obj, keyStr, nimBoolToJS(ctx, value))
    else:
      # For complex types, convert to string representation
      discard setProperty(ctx, obj, keyStr, nimStringToJS(ctx, $value))
  return obj

# Tuple conversions for common tuple types
proc nimTupleToJSArray*[T](ctx: ptr JSContext, tup: T): JSValue =
  ## Convert a Nim tuple to a JavaScript array
  let arr = newArray(ctx)

  when T is (string, int):
    discard setArrayElement(ctx, arr, 0, nimStringToJS(ctx, tup[0]))
    discard setArrayElement(ctx, arr, 1, nimIntToJS(ctx, tup[1].int32))
  elif T is (string, string):
    discard setArrayElement(ctx, arr, 0, nimStringToJS(ctx, tup[0]))
    discard setArrayElement(ctx, arr, 1, nimStringToJS(ctx, tup[1]))
  elif T is (int, int):
    discard setArrayElement(ctx, arr, 0, nimIntToJS(ctx, tup[0].int32))
    discard setArrayElement(ctx, arr, 1, nimIntToJS(ctx, tup[1].int32))

  return arr

# Convert JSValue arguments to a sequence
proc jsArgsToSeq*(ctx: ptr JSContext, argc: cint, argv: ptr JSValueConst): seq[JSValue] =
  result = newSeq[JSValue](argc)
  for i in 0..<argc:
    result[i] = JS_DupValue(ctx, cast[ptr UncheckedArray[JSValueConst]](argv)[i])

# Generic C function trampoline for Nim function calls
proc nimFunctionTrampoline(ctx: ptr JSContext, thisVal: JSValueConst, argc: cint, argv: ptr JSValueConst,
    magic: cint): JSValue {.cdecl.} =
  ## Generic trampoline that calls registered Nim functions from JavaScript
  ## Uses magic parameter as function ID to lookup the actual Nim function
  try:
    let contextData = cast[ptr BurritoContextData](JS_GetContextOpaque(ctx))
    if contextData == nil:
      return jsUndefined(ctx)

    if magic notin contextData.functions:
      return jsUndefined(ctx)

    let funcEntry = contextData.functions[magic]

    case funcEntry.kind
    of nimFunc0:
      # No arguments
      return funcEntry.func0(ctx)
    of nimFunc1:
      # One argument - automatically free the duplicated argument
      if argc >= 1:
        let arg = JS_DupValue(ctx, cast[ptr UncheckedArray[JSValueConst]](argv)[0])
        defer: JS_FreeValue(ctx, arg)
        return funcEntry.func1(ctx, arg)
      else:
        let arg = jsUndefined(ctx)
        defer: JS_FreeValue(ctx, arg)
        return funcEntry.func1(ctx, arg)
    of nimFunc2:
      # Two arguments - automatically free the duplicated arguments
      let arg1 = if argc >= 1: JS_DupValue(ctx, cast[ptr UncheckedArray[JSValueConst]](argv)[0]) else: jsUndefined(ctx)
      let arg2 = if argc >= 2: JS_DupValue(ctx, cast[ptr UncheckedArray[JSValueConst]](argv)[1]) else: jsUndefined(ctx)
      defer:
        JS_FreeValue(ctx, arg1)
        JS_FreeValue(ctx, arg2)
      return funcEntry.func2(ctx, arg1, arg2)
    of nimFunc3:
      # Three arguments - automatically free the duplicated arguments
      let arg1 = if argc >= 1: JS_DupValue(ctx, cast[ptr UncheckedArray[JSValueConst]](argv)[0]) else: jsUndefined(ctx)
      let arg2 = if argc >= 2: JS_DupValue(ctx, cast[ptr UncheckedArray[JSValueConst]](argv)[1]) else: jsUndefined(ctx)
      let arg3 = if argc >= 3: JS_DupValue(ctx, cast[ptr UncheckedArray[JSValueConst]](argv)[2]) else: jsUndefined(ctx)
      defer:
        JS_FreeValue(ctx, arg1)
        JS_FreeValue(ctx, arg2)
        JS_FreeValue(ctx, arg3)
      return funcEntry.func3(ctx, arg1, arg2, arg3)
    of nimFuncVar:
      # Variadic
      let args = jsArgsToSeq(ctx, argc, argv)
      result = funcEntry.funcVar(ctx, args)
      # CRITICAL: Free the duplicated JSValue arguments
      for arg in args:
        JS_FreeValue(ctx, arg)
  except JSException as e:
    # Convert JSException to JavaScript exception
    let errorObj = nimStringToJS(ctx, e.msg)
    return JS_Throw(ctx, errorObj)
  except ValueError as e:
    # Convert ValueError to JavaScript TypeError
    return JS_ThrowTypeError(ctx, e.msg.cstring)
  except RangeDefect as e:
    # Convert RangeDefect to JavaScript RangeError
    return JS_ThrowRangeError(ctx, e.msg.cstring)
  except Exception as e:
    # Convert other exceptions to JavaScript Error
    let errorObj = nimStringToJS(ctx, "Nim Error: " & e.msg)
    return JS_Throw(ctx, errorObj)

# Configuration helpers
proc defaultConfig*(): QuickJSConfig =
  ## Create default configuration (no std/os modules)
  QuickJSConfig(includeStdLib: false, includeOsLib: false, enableStdHandlers: false)

proc configWithStdLib*(): QuickJSConfig =
  ## Create configuration with std module enabled
  QuickJSConfig(includeStdLib: true, includeOsLib: false, enableStdHandlers: true)

proc configWithOsLib*(): QuickJSConfig =
  ## Create configuration with os module enabled
  QuickJSConfig(includeStdLib: false, includeOsLib: true, enableStdHandlers: true)

proc configWithBothLibs*(): QuickJSConfig =
  ## Create configuration with both std and os modules enabled
  QuickJSConfig(includeStdLib: true, includeOsLib: true, enableStdHandlers: true)

# Core QuickJS wrapper
proc newQuickJS*(config: QuickJSConfig = defaultConfig()): QuickJS =
  ## Create a new QuickJS instance with runtime and context
  ##
  ## ⚠️  THREAD SAFETY: The returned QuickJS instance is NOT thread-safe.
  ## Use one instance per thread or implement external locking.
  ##
  ## Parameters:
  ## - config: Configuration specifying which modules to include
  let rt = JS_NewRuntime()
  if rt == nil:
    raise newException(JSException, "Failed to create QuickJS runtime")

  let ctx = JS_NewContext(rt)
  if ctx == nil:
    JS_FreeRuntime(rt)
    raise newException(JSException, "Failed to create QuickJS context")

  # Initialize standard handlers if requested
  if config.enableStdHandlers:
    js_std_init_handlers(rt)

  # Set up module loader for ES6 modules (critical for std/os modules)
  if config.includeStdLib or config.includeOsLib:
    JS_SetModuleLoaderFunc(rt, nil, js_module_loader, nil)

  # Initialize std module if requested
  if config.includeStdLib:
    discard js_init_module_std(ctx, "std")

  # Initialize os module if requested
  if config.includeOsLib:
    discard js_init_module_os(ctx, "os")

  # Add std helpers if any standard library is enabled
  if config.includeStdLib or config.includeOsLib:
    js_std_add_helpers(ctx, 0, nil)

    # Set up module loader for proper module resolution
    JS_SetModuleLoaderFunc(rt, nil, js_module_loader, nil)

  # Create context data for function registry
  let contextData = cast[ptr BurritoContextData](alloc0(sizeof(BurritoContextData)))
  contextData.functions = initTable[int32, NimFunctionEntry]()
  contextData.context = ctx

  # Set context opaque data
  JS_SetContextOpaque(ctx, contextData)

  result = QuickJS(runtime: rt, context: ctx, contextData: contextData, nextFunctionId: 1, config: config)

proc close*(js: var QuickJS) =
  ## Clean up QuickJS instance with proper sequence to avoid memory issues
  if js.context != nil and js.runtime != nil:
    # Clear context opaque data first to avoid circular references
    JS_SetContextOpaque(js.context, nil)

    # Process the std event loop to complete any pending operations
    # This is critical when modules have been evaluated
    if js.config.enableStdHandlers:
      js_std_loop(js.context)

    # Free std handlers BEFORE freeing context (same as qjs.c)
    if js.config.enableStdHandlers:
      js_std_free_handlers(js.runtime)

    # Free context and runtime in proper order
    JS_FreeContext(js.context)
    js.context = nil

    JS_FreeRuntime(js.runtime)
    js.runtime = nil

  # Free Nim-side data last
  if js.contextData != nil:
    dealloc(js.contextData)
    js.contextData = nil

proc eval*(js: QuickJS, code: string, filename: string = "<eval>"): string =
  ## Evaluate JavaScript code and return result as string
  let val = JS_Eval(js.context, code.cstring, code.len.csize_t, filename.cstring, JS_EVAL_TYPE_GLOBAL)
  defer: JS_FreeValue(js.context, val)

  result = toNimString(js.context, val)

proc evalWithGlobals*(js: QuickJS, code: string, globals: Table[string, string] = initTable[string, string]()): string =
  ## Evaluate JavaScript code with some global variables set as strings
  # Set global variables as strings
  for key, value in globals:
    let jsVal = JS_NewStringLen(js.context, value.cstring, value.len.csize_t)
    let globalObj = JS_GetGlobalObject(js.context)
    discard JS_DefinePropertyValueStr(js.context, globalObj, key.cstring, jsVal,
                                     JS_PROP_WRITABLE or JS_PROP_CONFIGURABLE)
    JS_FreeValue(js.context, globalObj)

  # Evaluate the code
  return js.eval(code)

proc setJSFunction*(js: QuickJS, name: string, value: string) =
  ## Set a JavaScript function as a string in the global scope
  let code = name & " = " & value
  discard js.eval(code)

proc evalModule*(js: QuickJS, code: string, filename: string = "<module>"): string =
  ## Evaluate JavaScript code as a module (enables import/export syntax)
  ## This is useful when using std/os modules with ES6 import syntax
  ##
  ## Note: ES6 modules return undefined by specification.
  ## IMPORTANT: Due to QuickJS internals, using modules with std library
  ## imports may cause issues during cleanup. Consider using regular eval()
  ## for simple scripts.
  var val = JS_Eval(js.context, code.cstring, code.len.csize_t, filename.cstring, JS_EVAL_TYPE_MODULE)

  # Check if evaluation failed
  if JS_IsException(val) != 0:
    let exception = JS_GetException(js.context)
    defer: JS_FreeValue(js.context, exception)
    let errorMsg = toNimString(js.context, exception)
    JS_FreeValue(js.context, val)
    raise newException(JSException, "Module evaluation failed: " & errorMsg)

  # Modules return promises, but we just return a string representation
  # Using js_std_await here causes reference counting issues on cleanup
  result = toNimString(js.context, val)
  JS_FreeValue(js.context, val)

  # Run the event loop to execute the module
  if js.config.enableStdHandlers:
    js_std_loop(js.context)

proc compileToBytecode*(js: QuickJS, code: string, filename: string = "<input>", isModule: bool = false): seq[byte] =
  ## Compile JavaScript code to bytecode format
  ## Returns a `byte` value containing the compiled bytecode
  ##
  ## The bytecode can be saved and later executed with evalBytecode
  ## Note: The bytecode format is tied to the QuickJS version

  # Auto-detect module if not explicitly specified (like qjsc does)
  let isModuleCode = if isModule:
    true
  else:
    # Check for module syntax (simplified detection)
    code.contains("import ") or code.contains("export ")

  var evalFlags = JS_EVAL_FLAG_COMPILE_ONLY
  if isModuleCode:
    evalFlags = evalFlags or JS_EVAL_TYPE_MODULE
  else:
    evalFlags = evalFlags or JS_EVAL_TYPE_GLOBAL

  let compiled = JS_Eval(js.context, code.cstring, code.len.csize_t, filename.cstring, evalFlags.cint)

  if JS_IsException(compiled) != 0:
    let exception = JS_GetException(js.context)
    defer: JS_FreeValue(js.context, exception)
    let errorMsg = toNimString(js.context, exception)
    JS_FreeValue(js.context, compiled)
    raise newException(JSException, "Compilation failed: " & errorMsg)

  # Serialize to bytecode
  var size: csize_t
  let buf = JS_WriteObject(js.context, addr size, compiled, JS_WRITE_OBJ_BYTECODE)
  JS_FreeValue(js.context, compiled)

  if buf.isNil:
    raise newException(JSException, "Failed to serialize bytecode")

  # Copy to Nim seq
  result = newSeq[byte](size)
  copyMem(addr result[0], buf, size)

  # Free the buffer allocated by JS_WriteObject
  {.emit: """js_free(`js`->context, `buf`);""".}

proc loadBytecodeModule*(js: QuickJS, bytecode: openArray[byte]): ptr JSModuleDef =
  ## Load a module from bytecode without executing it
  ## Returns the module definition that can be used with JS_GetModuleNamespace
  let obj = JS_ReadObject(js.context, cast[ptr uint8](unsafeAddr bytecode[0]), bytecode.len.csize_t, JS_READ_OBJ_BYTECODE)

  if JS_IsException(obj) != 0:
    let exception = JS_GetException(js.context)
    defer: JS_FreeValue(js.context, exception)
    let errorMsg = toNimString(js.context, exception)
    JS_FreeValue(js.context, obj)
    raise newException(JSException, "Failed to load bytecode: " & errorMsg)

  # Extract module definition pointer
  {.emit: """
  if (JS_VALUE_GET_TAG(`obj`) == JS_TAG_MODULE) {
    JSModuleDef *m = JS_VALUE_GET_PTR(`obj`);
    JS_FreeValue(`js`->context, `obj`);
    `result` = m;
  } else {
    JS_FreeValue(`js`->context, `obj`);
    `result` = NULL;
  }
  """.}

  if result.isNil:
    raise newException(JSException, "Bytecode does not contain a module")

proc evalBytecode*(js: QuickJS, bytecode: openArray[byte], loadOnly: bool = false): string =
  ## Evaluate JavaScript bytecode - works with any bytecode (qjsc or compileToBytecode)
  ##
  ## Parameters:
  ## - bytecode: The compiled bytecode to execute
  ## - loadOnly: If true, load but don't execute (for module dependencies)
  ##
  ## This automatically detects the bytecode type and handles it appropriately.
  ## Works with both std/os libraries (configWithBothLibs) and isolated mode (defaultConfig).
  ## Returns the result as a string, or empty string for void operations.
  if bytecode.len == 0:
    raise newException(ValueError, "Empty bytecode")

  # First, check if this is qjsc-compiled bytecode (larger, complex bytecode)
  # vs. simple compiled values from compileToBytecode
  let shouldUseStdEval = js.config.enableStdHandlers and bytecode.len > 100

  if shouldUseStdEval:
    # Use js_std_eval_binary for qjsc-compiled bytecode (REPL, complex modules)
    let flags = if loadOnly: 1'i32 else: 0'i32
    js_std_eval_binary(js.context, cast[ptr uint8](unsafeAddr bytecode[0]), bytecode.len.csize_t, flags)
    return "" # js_std_eval_binary doesn't return values

  # Fallback to lower-level execution for isolated/minimal contexts
  let obj = JS_ReadObject(js.context, cast[ptr uint8](unsafeAddr bytecode[0]), bytecode.len.csize_t, JS_READ_OBJ_BYTECODE)

  if JS_IsException(obj) != 0:
    let exception = JS_GetException(js.context)
    defer: JS_FreeValue(js.context, exception)
    let errorMsg = toNimString(js.context, exception)
    JS_FreeValue(js.context, obj)
    raise newException(JSException, "Failed to load bytecode: " & errorMsg)

  # Execute the bytecode object
  var evalResult: JSValue
  {.emit: """
  if (JS_VALUE_GET_TAG(`obj`) == JS_TAG_MODULE) {
    if (JS_ResolveModule(`js`->context, `obj`) < 0) {
      `evalResult` = JS_EXCEPTION;
    } else {
      `evalResult` = JS_EvalFunction(`js`->context, `obj`);
    }
  } else if (JS_VALUE_GET_TAG(`obj`) == JS_TAG_FUNCTION_BYTECODE) {
    `evalResult` = JS_EvalFunction(`js`->context, `obj`);
  } else {
    // For simple values, just return them
    `evalResult` = `obj`;
    `obj` = JS_UNDEFINED;  // Don't free twice
  }
  """.}

  if JS_IsException(evalResult) != 0:
    let exception = JS_GetException(js.context)
    defer: JS_FreeValue(js.context, exception)
    let errorMsg = toNimString(js.context, exception)
    JS_FreeValue(js.context, obj)
    JS_FreeValue(js.context, evalResult)
    raise newException(JSException, "Bytecode execution failed: " & errorMsg)

  let resultStr = toNimString(js.context, evalResult)
  JS_FreeValue(js.context, obj)
  JS_FreeValue(js.context, evalResult)

  return resultStr

proc evalBytecodeModule*(js: QuickJS, bytecode: openArray[byte]): string =
  ## Evaluate JavaScript module bytecode
  ## The bytecode is executed immediately (equivalent to evalBytecode with loadOnly=false)
  result = js.evalBytecode(bytecode, loadOnly = false)

proc canUseStdLib*(js: QuickJS): bool =
  ## Check if std module is available in this QuickJS instance
  js.config.includeStdLib

proc canUseOsLib*(js: QuickJS): bool =
  ## Check if os module is available in this QuickJS instance
  js.config.includeOsLib

# Native C function registration methods
proc registerFunction*(js: var QuickJS, name: string, nimFunc: NimFunction0) =
  ## Register a Nim function with no arguments to be callable from JavaScript
  ##
  ## Note: Since this function takes no arguments, no JSValue memory management is required.
  let functionId = js.nextFunctionId
  js.nextFunctionId += 1

  js.contextData.functions[functionId] = NimFunctionEntry(kind: nimFunc0, func0: nimFunc)

  let jsFunc = JS_NewCFunctionMagic(js.context, cast[JSCFunctionMagic](nimFunctionTrampoline),
                                   name.cstring, 0, JS_CFUNC_generic_magic, functionId)
  let globalObj = JS_GetGlobalObject(js.context)
  discard JS_DefinePropertyValueStr(js.context, globalObj, name.cstring, jsFunc,
                                   JS_PROP_WRITABLE or JS_PROP_CONFIGURABLE)
  JS_FreeValue(js.context, globalObj)

proc registerFunction*(js: var QuickJS, name: string, nimFunc: NimFunction1) =
  ## Register a Nim function with one argument to be callable from JavaScript
  ##
  ## AUTOMATIC MEMORY MANAGEMENT: The JSValue argument is automatically freed
  ## by the trampoline - you don't need to call JS_FreeValue manually!
  let functionId = js.nextFunctionId
  js.nextFunctionId += 1

  js.contextData.functions[functionId] = NimFunctionEntry(kind: nimFunc1, func1: nimFunc)

  let jsFunc = JS_NewCFunctionMagic(js.context, cast[JSCFunctionMagic](nimFunctionTrampoline),
                                   name.cstring, 1, JS_CFUNC_generic_magic, functionId)
  let globalObj = JS_GetGlobalObject(js.context)
  discard JS_DefinePropertyValueStr(js.context, globalObj, name.cstring, jsFunc,
                                   JS_PROP_WRITABLE or JS_PROP_CONFIGURABLE)
  JS_FreeValue(js.context, globalObj)

proc registerFunction*(js: var QuickJS, name: string, nimFunc: NimFunction2) =
  ## Register a Nim function with two arguments to be callable from JavaScript
  ##
  ## AUTOMATIC MEMORY MANAGEMENT: The JSValue arguments are automatically freed
  ## by the trampoline - you don't need to call JS_FreeValue manually!
  let functionId = js.nextFunctionId
  js.nextFunctionId += 1

  js.contextData.functions[functionId] = NimFunctionEntry(kind: nimFunc2, func2: nimFunc)

  let jsFunc = JS_NewCFunctionMagic(js.context, cast[JSCFunctionMagic](nimFunctionTrampoline),
                                   name.cstring, 2, JS_CFUNC_generic_magic, functionId)
  let globalObj = JS_GetGlobalObject(js.context)
  discard JS_DefinePropertyValueStr(js.context, globalObj, name.cstring, jsFunc,
                                   JS_PROP_WRITABLE or JS_PROP_CONFIGURABLE)
  JS_FreeValue(js.context, globalObj)

proc registerFunction*(js: var QuickJS, name: string, nimFunc: NimFunction3) =
  ## Register a Nim function with three arguments to be callable from JavaScript
  ##
  ## AUTOMATIC MEMORY MANAGEMENT: The JSValue arguments are automatically freed
  ## by the trampoline - you don't need to call JS_FreeValue manually!
  let functionId = js.nextFunctionId
  js.nextFunctionId += 1

  js.contextData.functions[functionId] = NimFunctionEntry(kind: nimFunc3, func3: nimFunc)

  let jsFunc = JS_NewCFunctionMagic(js.context, cast[JSCFunctionMagic](nimFunctionTrampoline),
                                   name.cstring, 3, JS_CFUNC_generic_magic, functionId)
  let globalObj = JS_GetGlobalObject(js.context)
  discard JS_DefinePropertyValueStr(js.context, globalObj, name.cstring, jsFunc,
                                   JS_PROP_WRITABLE or JS_PROP_CONFIGURABLE)
  JS_FreeValue(js.context, globalObj)

proc registerFunction*(js: var QuickJS, name: string, nimFunc: NimFunctionVariadic) =
  ## Register a Nim function with variadic arguments to be callable from JavaScript
  ##
  ## AUTOMATIC MEMORY MANAGEMENT: The JSValue arguments in the args sequence are
  ## automatically freed by the trampoline - you don't need to call JS_FreeValue manually!
  let functionId = js.nextFunctionId
  js.nextFunctionId += 1

  js.contextData.functions[functionId] = NimFunctionEntry(kind: nimFuncVar, funcVar: nimFunc)

  let jsFunc = JS_NewCFunctionMagic(js.context, cast[JSCFunctionMagic](nimFunctionTrampoline),
                                   name.cstring, -1, JS_CFUNC_generic_magic, functionId)
  let globalObj = JS_GetGlobalObject(js.context)
  discard JS_DefinePropertyValueStr(js.context, globalObj, name.cstring, jsFunc,
                                   JS_PROP_WRITABLE or JS_PROP_CONFIGURABLE)
  JS_FreeValue(js.context, globalObj)

proc runPendingJobs*(js: QuickJS) =
  ## Execute all pending JavaScript jobs (promises, async operations)
  ## This is needed after loading modules or running async code
  var pctx: ptr JSContext = nil
  while JS_ExecutePendingJob(js.runtime, addr pctx) > 0:
    discard

proc processStdLoop*(js: QuickJS) =
  ## Process the QuickJS standard event loop once
  ## This handles timers, I/O, and other async operations
  ## Note: Only available when enableStdHandlers is true
  if js.config.enableStdHandlers:
    js_std_loop(js.context)
