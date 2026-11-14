## The loops of `frameos.ops`: whole typed arrays at a time, so a scene's
## per-cell pass (a fade through a table, a blur, the arithmetic of a field of
## particles) runs at native speed with one call into the runtime instead of
## a few bytecodes a cell. Generic on purpose: what a scene simulates is its
## own JS; these are the array operations any such scene is made of.
##
## No QuickJS here (app_runtime.nim unpacks the arguments), so an ESP32 can
## compile it at -O2 (FRAMEOS_NIM_HOT_MODULES). An element is read and stored
## by its array's kind with JS's own conversions: Uint8Clamped clamps and
## rounds, the other integers wrap, Float32 is a float. Integer arrays compute
## in int32; anything with a float in it in float32, which an ESP32-S3 has in
## hardware (it has no double-precision unit).

type
  ArrayKind* = enum
    ## JSTypedArrayEnum's order (quickjs.h), so a class id less the first
    ## typed array's is one of these.
    akUint8Clamped, akInt8, akUint8, akInt16, akUint16, akInt32, akUint32,
    akBigInt64, akBigUint64, akFloat16, akFloat32, akFloat64

  Elements* = object
    data*: ptr UncheckedArray[uint8]
    length*: int ## in elements
    kind*: ArrayKind

  Operand* = object
    ## A typed array, or a number when `isArray` is false.
    isArray*: bool
    elements*: Elements
    value*: float32

func supported*(kind: ArrayKind): bool =
  kind notin {akBigInt64, akBigUint64, akFloat16, akFloat64}

func isFloat*(kind: ArrayKind): bool = kind == akFloat32

{.push boundChecks: off, overflowChecks: off, rangeChecks: off, raises: [].}

proc unaligned[T](p: pointer): T {.inline.} =
  # A typed array's bytes can sit at any offset (a subarray): never a direct
  # word load, which faults when unaligned on an ESP32.
  copyMem(addr result, p, sizeof(T))

proc storeUnaligned[T](p: pointer, v: T) {.inline.} =
  var x = v
  copyMem(p, addr x, sizeof(T))

proc readInt(e: Elements, i: int): int32 {.inline.} =
  let p = addr e.data[0]
  case e.kind
  of akUint8Clamped, akUint8: int32(e.data[i])
  of akInt8: int32(cast[int8](e.data[i]))
  of akInt16: int32(unaligned[int16](cast[pointer](cast[uint](p) + uint(i * 2))))
  of akUint16: int32(unaligned[uint16](cast[pointer](cast[uint](p) + uint(i * 2))))
  of akInt32, akUint32: unaligned[int32](cast[pointer](cast[uint](p) + uint(i * 4)))
  of akFloat32:
    let f = unaligned[float32](cast[pointer](cast[uint](p) + uint(i * 4)))
    if f != f or f >= 2147483648'f32 or f < -2147483648'f32: 0'i32 else: int32(f)
  else: 0'i32

proc readFloat(e: Elements, i: int): float32 {.inline.} =
  if e.kind == akFloat32:
    unaligned[float32](cast[pointer](cast[uint](addr e.data[0]) + uint(i * 4)))
  elif e.kind == akUint32:
    float32(cast[uint32](readInt(e, i)))
  else:
    float32(readInt(e, i))

proc writeInt(e: Elements, i: int, v: int32) {.inline.} =
  let p = addr e.data[0]
  case e.kind
  of akUint8Clamped: e.data[i] = uint8(if v < 0: 0'i32 elif v > 255: 255'i32 else: v)
  of akUint8, akInt8: e.data[i] = cast[uint8](v and 255)
  of akInt16, akUint16: storeUnaligned[uint16](cast[pointer](cast[uint](p) + uint(i * 2)), cast[uint16](v and 0xffff))
  of akInt32, akUint32: storeUnaligned[int32](cast[pointer](cast[uint](p) + uint(i * 4)), v)
  of akFloat32: storeUnaligned[float32](cast[pointer](cast[uint](p) + uint(i * 4)), float32(v))
  else: discard

proc writeFloat(e: Elements, i: int, v: float32) {.inline.} =
  case e.kind
  of akFloat32:
    storeUnaligned[float32](cast[pointer](cast[uint](addr e.data[0]) + uint(i * 4)), v)
  of akUint8Clamped:
    # JS rounds a clamped store half to even; to nearest is what any picture sees.
    e.data[i] = uint8(if v != v or v <= 0: 0'f32 elif v >= 255: 255'f32 else: v + 0.5'f32)
  else:
    writeInt(e, i, if v != v or v >= 2147483648'f32 or v < -2147483648'f32: 0'i32 else: int32(v))

proc mapTable*(dst, src, table: Elements, start, finish: int) =
  ## dst[i] = table[src[i]] for i in start ..< finish; an index past the
  ## table leaves dst[i] as it is.
  if dst.kind in {akUint8Clamped, akUint8} and src.kind in {akUint8Clamped, akUint8} and
      table.kind in {akUint8Clamped, akUint8}:
    # The common case, a byte table over bytes (a fade, a palette remap).
    for i in start ..< finish:
      let index = int(src.data[i])
      if index < table.length:
        dst.data[i] = table.data[index]
    return
  let floats = table.kind.isFloat or dst.kind.isFloat
  for i in start ..< finish:
    let index = readInt(src, i)
    if index < 0 or index >= table.length:
      continue
    if floats: writeFloat(dst, i, readFloat(table, index))
    else: writeInt(dst, i, readInt(table, index))

type Arith* = enum opAdd, opSub, opMul

func aligned(e: Elements, size: int): bool = (cast[uint](e.data) and uint(size - 1)) == 0

template sameKindArith(T: typedesc, dst, a: Elements, b: Operand, start, finish: int, op: Arith, scalar: T,
    store: untyped) =
  ## One kind throughout, read and written straight: the loops a particle
  ## field or a damping spends its frame in.
  let d = cast[ptr UncheckedArray[T]](dst.data)
  let x = cast[ptr UncheckedArray[T]](a.data)
  if b.isArray:
    let y = cast[ptr UncheckedArray[T]](b.elements.data)
    for i in start ..< finish:
      let p {.inject.} = x[i]
      let q {.inject.} = y[i]
      d[i] = (case op
        of opAdd: store(p, q, `+`)
        of opSub: store(p, q, `-`)
        of opMul: store(p, q, `*`))
  else:
    for i in start ..< finish:
      let p {.inject.} = x[i]
      let q {.inject.} = scalar
      d[i] = (case op
        of opAdd: store(p, q, `+`)
        of opSub: store(p, q, `-`)
        of opMul: store(p, q, `*`))

template floatStore(p, q, f: untyped): float32 = f(p, q)
template int16Store(p, q, f: untyped): int16 = cast[int16](f(int32(p), int32(q)) and 0xffff)
template byteStore(p, q, f: untyped): uint8 = cast[uint8](f(int32(p), int32(q)) and 255)
template clampStore(p, q, f: untyped): uint8 =
  (let v = f(int32(p), int32(q)); uint8(if v < 0: 0'i32 elif v > 255: 255'i32 else: v))

proc arith*(op: Arith, dst, a: Elements, b: Operand, start, finish: int) =
  ## dst[i] = a[i] (op) b[i], or (op) b when b is a number.
  let same = dst.kind == a.kind and (not b.isArray or b.elements.kind == dst.kind)
  let size = case dst.kind
    of akFloat32: 4
    of akInt16: 2
    else: 1
  let integral = b.isArray or b.value == float32(int32(b.value))
  if same and dst.aligned(size) and a.aligned(size) and (not b.isArray or b.elements.aligned(size)):
    case dst.kind
    of akFloat32:
      sameKindArith(float32, dst, a, b, start, finish, op, b.value, floatStore)
      return
    of akInt16:
      if integral:
        sameKindArith(int16, dst, a, b, start, finish, op, cast[int16](int32(b.value) and 0xffff), int16Store)
        return
    of akUint8:
      if integral:
        sameKindArith(uint8, dst, a, b, start, finish, op, cast[uint8](int32(b.value) and 255), byteStore)
        return
    of akUint8Clamped:
      if integral and b.value >= 0 and b.value <= 255:
        sameKindArith(uint8, dst, a, b, start, finish, op, uint8(b.value), clampStore)
        return
    else: discard
  let floats = dst.kind.isFloat or a.kind.isFloat or (b.isArray and b.elements.kind.isFloat) or
    (not b.isArray and b.value != float32(int32(b.value)))
  if floats:
    for i in start ..< finish:
      let x = readFloat(a, i)
      let y = if b.isArray: readFloat(b.elements, i) else: b.value
      writeFloat(dst, i, case op
        of opAdd: x + y
        of opSub: x - y
        of opMul: x * y)
  else:
    let scalar = int32(b.value)
    for i in start ..< finish:
      let x = readInt(a, i)
      let y = if b.isArray: readInt(b.elements, i) else: scalar
      writeInt(dst, i, case op
        of opAdd: x +% y
        of opSub: x -% y
        of opMul: x *% y)

proc convolve3x3*(dst, src: Elements, width, height: int, kernel: array[9, int32], shift: int) =
  ## dst = (the 3x3 neighbourhood of src, weighted by kernel) >> shift, for
  ## every cell but the edges (left as they are). Integer weights: a blur, a
  ## diffusion, a wave's neighbour sum.
  # The taps that weigh something, as offsets: a wave's sum is four of nine.
  var offsets, weights: array[9, int32]
  var taps = 0
  for k in 0 ..< 9:
    if kernel[k] != 0:
      offsets[taps] = int32((k div 3 - 1) * width + (k mod 3 - 1))
      weights[taps] = kernel[k]
      inc taps
  template direct(T: typedesc, store: untyped) =
    let s = cast[ptr UncheckedArray[T]](src.data)
    let d = cast[ptr UncheckedArray[T]](dst.data)
    for y in 1 ..< height - 1:
      for i in y * width + 1 ..< y * width + width - 1:
        var sum {.inject.} = 0'i32
        for t in 0 ..< taps:
          sum = sum +% weights[t] *% int32(s[i + offsets[t]])
        d[i] = store
    return
  if src.kind == dst.kind:
    case src.kind
    of akInt16:
      if src.aligned(2) and dst.aligned(2): direct(int16, cast[int16](ashr(sum, shift) and 0xffff))
    of akUint8: direct(uint8, cast[uint8](ashr(sum, shift) and 255))
    of akUint8Clamped:
      direct(uint8, (let v = ashr(sum, shift); uint8(if v < 0: 0'i32 elif v > 255: 255'i32 else: v)))
    else: discard
  for y in 1 ..< height - 1:
    for i in y * width + 1 ..< y * width + width - 1:
      var sum = 0'i32
      for t in 0 ..< taps:
        sum = sum +% weights[t] *% readInt(src, i + offsets[t])
      writeInt(dst, i, ashr(sum, shift))

{.pop.}
