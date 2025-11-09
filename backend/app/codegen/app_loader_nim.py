import json
from typing import Optional, Dict, Any, List, Union
import os

Scalar = Union[str, int, float, bool, None]

def _nim_quote(s: str) -> str:
    if s is None:
        return '""'
    return '"' + s.replace('\\', '\\\\').replace('"', '\\"') + '"'

def _as_bool(v: Scalar, default: bool) -> bool:
    if isinstance(v, bool):
        return v
    if isinstance(v, str):
        return v.strip().lower() in ("1", "true", "yes", "y")
    return default

def _as_int(v: Scalar, default: int) -> int:
    if isinstance(v, int):
        return v
    if isinstance(v, float):
        return int(v)
    if isinstance(v, str) and v.strip():
        try:
            return int(v.strip())
        except ValueError:
            try:
                return int(float(v.strip()))
            except ValueError:
                pass
    return default

def _as_float(v: Scalar, default: float) -> float:
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str) and v.strip():
        try:
            return float(v.strip())
        except ValueError:
            pass
    return default

def _default_literal(field_name: str, field_type: str, default: Scalar, required: bool) -> str:
    """Return a Nim literal/expression usable as the fallback/default element value."""
    if field_type in ("string", "text", "select", "font", "date"):
        return _nim_quote(default if isinstance(default, str) else "")
    if field_type == "integer":
        return str(_as_int(default, 0))
    if field_type == "float":
        # ensure a decimal part to keep Nim type happy
        val = _as_float(default, 0.0)
        s = f"{val}"
        return s if "." in s else (s + ".0")
    if field_type == "boolean":
        return "true" if _as_bool(default, False) else "false"
    if field_type == "image":
        # For config defaults, use Option(Image) unless required
        return "nil" if required else "none(Image)"
    if field_type == "node":
        return "0.NodeId"
    if field_type == "json":
        return "newJObject()"
    if field_type == "color":
        # fallback to black if not provided
        s = default if isinstance(default, str) and default else "#000000"
        return f'parseHtmlColor({_nim_quote(s)})'
    raise ValueError(f"Unsupported field type: {field_type}, field name: {field_name}")

def _scalar_getter(field_name: str, field_type: str, default_expr: str, required: bool) -> str:
    """
    Build Nim expression to read a scalar from params with default, robust to numbers-as-strings, etc.
    Returns a Nim *expression* (often a 'block:' expression).
    """
    k = f'params{{"{field_name}"}}'
    if field_type in ("string", "text", "select", "font", "date"):
        return f'{k}.getStr({default_expr})'

    if field_type == "integer":
        return f"""block:
  var v = {default_expr}
  if params.hasKey("{field_name}"):
    let n = {k}
    if n.kind == JInt:
      v = n.getInt()
    elif n.kind == JFloat:
      v = int(n.getFloat())
    elif n.kind == JString:
      try: v = parseInt(n.getStr())
      except CatchableError: discard
  v"""

    if field_type == "float":
        return f"""block:
  var v = {default_expr}
  if params.hasKey("{field_name}"):
    let n = {k}
    if n.kind == JFloat:
        v = n.getFloat()
    elif n.kind == JInt:
        v = n.getInt().float
    elif n.kind == JString:
        try: v = parseFloat(n.getStr())
        except CatchableError: discard
  v"""

    if field_type == "boolean":
        return f"""block:
  var v = {default_expr}
  if params.hasKey("{field_name}"):
    let n = {k}
    if n.kind == JBool:
        v = n.getBool()
    elif n.kind == JString:
        let s = n.getStr().toLowerAscii()
        v = (s in ["true","1","yes","y"])
  v"""

    if field_type == "image":
        # Not read from config; use default (Option[Image] or Image if required)
        return default_expr

    if field_type == "node":
        return f"""block:
  var v: NodeId = 0.NodeId
  if params.hasKey("{field_name}"):
    let n = {k}
    if n.kind == JInt:
        v = n.getInt().NodeId
    elif n.kind == JFloat:
        v = int(n.getFloat()).NodeId
    elif n.kind == JString:
        try: v = int(parseFloat(n.getStr())).NodeId
        except CatchableError: discard
  v"""

    if field_type == "json":
        return k  # hand over the raw JsonNode

    if field_type == "color":
        # Respect the field's default from config (default_expr) instead of forcing black.
        return f"""block:
  var v: Color = {default_expr}
  if params.hasKey("{field_name}"):
    let n = {k}
    if n.kind == JString:
      let s = n.getStr()
      try:
        v = parseHtmlColor(s)
      except CatchableError:
        discard
  v"""
    raise ValueError(f"Unsupported field type: {field_type}, fieldName: {field_name}")

def _field_elem_nim_type(field_type: str, required: bool) -> str:
    """Element type (for seqs)."""
    if field_type in ("string", "text", "select", "font"):
        return "string"
    if field_type == "integer":
        return "int"
    if field_type == "float":
        return "float"
    if field_type == "boolean":
        return "bool"
    if field_type == "image":
        return "Image" if required else "Option[Image]"
    if field_type == "node":
        return "NodeId"
    if field_type == "json":
        return "JsonNode"
    if field_type == "color":
        return "Color"
    raise ValueError(f"Unsupported element type for seq: {field_type}")

def _size_expr(bound: Union[int, str], all_fields: Dict[str, Dict[str, Any]], default_if_ref: int) -> str:
    """
    Build Nim expression for a dimension bound: numeric literal or robust getter from another field.
    """
    if isinstance(bound, int):
        return str(bound)

    # bound references another field (e.g., "rows")
    ref = bound
    ref_meta = all_fields.get(ref, {})
    ref_default = ref_meta.get("value")
    # Build default literal as string -> int
    try:
        dflt = int(ref_default) if ref_default is not None else default_if_ref
    except Exception:
        dflt = default_if_ref

    k = f'params{{"{ref}"}}'
    return f"""block:
  var v = {dflt}
  if params.hasKey("{ref}"):
    let n = {k}
    if n.kind == JInt:
      v = n.getInt()
    elif n.kind == JFloat:
      v = int(n.getFloat())
    elif n.kind == JString:
      try: v = parseInt(n.getStr())
      except CatchableError: discard
  v"""

def _seq_init_expr(field: Dict[str, Any], all_fields: Dict[str, Dict[str, Any]]) -> list[str]:
    """
    Generate Nim code that builds a seq (possibly nested) based on seq spec:
      seq: [ [label1, start1, end1], [label2, start2, end2], ... ]
    The code:
      - Computes sizes from params and/or constants
      - Allocates nested seqs
      - Fills defaults
      - Applies overrides from bracketed keys like name[1][2]
    Returns a single Nim expression (a `block:`) that evaluates to the seq value.
    """
    name = field["name"]
    ftype = field["type"]
    required = bool(field.get("required", False))
    elem_type = _field_elem_nim_type(ftype, required)
    elem_default = _default_literal(name, ftype, field.get("value"), required)

    seq_spec: List[List[Union[str, int]]] = field.get("seq", [])
    dims = len(seq_spec)
    if dims == 0:
        raise AssertionError("Called _seq_init_expr on non-seq field")

    # Build dimension bounds and index vars
    starts: List[str] = []
    stops: List[str] = []
    idxs: List[str] = []
    sizes: List[str] = []
    for d, triplet in enumerate(seq_spec, start=1):
        # triplet = [label, start, end]
        start_bound = triplet[1]
        stop_bound = triplet[2]
        start_expr = _size_expr(start_bound, all_fields, default_if_ref=1)
        stop_expr = _size_expr(stop_bound, all_fields, default_if_ref=0)
        starts.append(start_expr)
        stops.append(stop_expr)
        idxs.append(f"i{d}")
        sizes.append(f"size{d}")

    # Helper: element override read code based on elem type
    def elem_override_from_params(var_name: str, key_var: str) -> str:
        # n = params[key]; then case by elem type
        if elem_type == "string":
            return (
                f'if params.hasKey({key_var}) and params[{key_var}].kind == JString:\n'
                f'      {var_name} = params[{key_var}].getStr()'
            )
        if elem_type == "int":
            return (
                f'if params.hasKey({key_var}):\n'
                f'      let n2 = params[{key_var}]\n'
                f'      if n2.kind == JInt: {var_name} = n2.getInt()\n'
                f'      elif n2.kind == JFloat: {var_name} = int(n2.getFloat())\n'
                f'      elif n2.kind == JString:\n'
                f'        try: {var_name} = parseInt(n2.getStr())\n'
                f'        except CatchableError: discard'
            )
        if elem_type == "float":
            return (
                f'if params.hasKey({key_var}):\n'
                f'      let n2 = params[{key_var}]\n'
                f'      if n2.kind == JFloat: {var_name} = n2.getFloat()\n'
                f'      elif n2.kind == JInt: {var_name} = n2.getInt().float\n'
                f'      elif n2.kind == JString:\n'
                f'        try: {var_name} = parseFloat(n2.getStr())\n'
                f'        except CatchableError: discard'
            )
        if elem_type == "bool":
            return (
                f'if params.hasKey({key_var}):\n'
                f'      let n2 = params[{key_var}]\n'
                f'      if n2.kind == JBool: {var_name} = n2.getBool()\n'
                f'      elif n2.kind == JString:\n'
                f'        let s = n2.getStr().toLowerAscii()\n'
                f'        {var_name} = (s in [\"true\",\"1\",\"yes\",\"y\"])'
            )
        if elem_type == "Color":
            return (
                f'if params.hasKey({key_var}) and params[{key_var}].kind == JString:\n'
                f'      {var_name} = parseHtmlColor(params[{key_var}].getStr())'
            )
        if elem_type == "NodeId":
            return (
                f'if params.hasKey({key_var}):\n'
                f'      let n2 = params[{key_var}]\n'
                f'      if n2.kind == JInt: {var_name} = n2.getInt().NodeId\n'
                f'      elif n2.kind == JFloat: {var_name} = int(n2.getFloat()).NodeId\n'
                f'      elif n2.kind == JString:\n'
                f'        try: {var_name} = int(parseFloat(n2.getStr())).NodeId\n'
                f'        except CatchableError: discard'
            )
        if elem_type == "JsonNode":
            return (
                f'if params.hasKey({key_var}):\n'
                f'      let n2 = params[{key_var}]\n'
                f'      if n2.kind in {{JObject, JArray}}: {var_name} = n2'
            )
        # Image and Option[Image] are not practical to pull from config;
        # keep default (none/newImage) – do nothing.
        return "discard"

    # Build nested loops and allocation
    lines: List[str] = []
    indent = "  "
    lines.append("block:")

    for d in range(dims):
        start_expr = starts[d]
        stop_expr = stops[d]

        # start{d+1}
        if isinstance(start_expr, str) and start_expr.startswith("block:"):
            bl = start_expr.splitlines()
            lines.append(f"{indent}let start{d+1} = block:")
            for b in bl[1:]:
                lines.append(f"{indent}  {b}")
        else:
            lines.append(f"{indent}let start{d+1} = {start_expr}")

        # stop{d+1}
        if isinstance(stop_expr, str) and stop_expr.startswith("block:"):
            bl = stop_expr.splitlines()
            lines.append(f"{indent}let stop{d+1} = block:")
            for b in bl[1:]:
                lines.append(f"{indent}  {b}")
        else:
            lines.append(f"{indent}let stop{d+1} = {stop_expr}")

    for d in range(dims):
        lines.append(f"{indent}let {sizes[d]} = (if stop{d+1} >= start{d+1}: stop{d+1} - start{d+1} + 1 else: 0)")

    # allocation
    # Build type like: seq[seq[Elem]] for dims>1
    outer_type = elem_type
    for _ in range(dims):
        outer_type = f"seq[{outer_type}]"
    lines.append(f"{indent}var output: {outer_type}")
    # allocate nested levels
    def alloc_level(level: int, prefix: str):
        if level == 0:
            lines.append(f"{indent}output = newSeq[{ 'seq['*(dims-1) + elem_type + ']'*(dims-1) }](size1)")
            return
        # allocate per row for 2+ dims
        if level < dims:
            idx = idxs[level-1]
            # size for next dimension:
            next_size = sizes[level]
            ty = elem_type if level == dims-1 else ("seq[" * (dims - level - 1)) + elem_type + ("]" * (dims - level - 1))
            lines.append(f"{indent*(level+1)}output[{idx} - start{level}] = newSeq[{ty}]({next_size})")

    # top allocation
    alloc_level(0, "")
    # loops
    for level in range(dims):
        idx = idxs[level]
        lines.append(f"{indent*(level+1)}for {idx} in start{level+1}..stop{level+1}:")
        if level+1 < dims:
            alloc_level(level+1, "")
    # inside deepest loop: fill default and override
    deepest = dims
    # Build key string: name[ i1 ][ i2 ]...
    key_expr = _nim_quote(name)
    for d in range(dims):
        key_expr = f"{key_expr} & \"[\" & ${idxs[d]} & \"]\""

    val_var = "v"
    lines.append(f"{indent*(deepest+1)}var {val_var}: {elem_type} = {elem_default}")
    lines.append(f"{indent*(deepest+1)}let k = {key_expr}")
    # override logic
    override = elem_override_from_params(val_var, "k")
    for line in override.splitlines():
        lines.append(f"{indent*(deepest+1)}{line}")
    # assign into output[...] using 0-based offsets
    index_expr = "".join(f"[{idxs[d]} - start{d+1}]" for d in range(dims))
    lines.append(f"{indent*(deepest+1)}output{index_expr} = {val_var}")
    lines.append(f"{indent}output")
    return lines

def _set_field_seq_case(field: Dict[str, Any]) -> List[str]:
    """
    Generate the 'case "name":' branch for seq fields.
    We accept fkJson with JArray/JArray-of-arrays depending on dimensions.
    """
    name = field["name"]
    ftype = field["type"]
    required = bool(field.get("required", False))
    elem_type = _field_elem_nim_type(ftype, required)
    seq_spec: List[List[Union[str, int]]] = field.get("seq", [])
    dims = len(seq_spec)

    lines: List[str] = [f'  of "{name}":']
    lines.append("    if value.kind == fkJson:")
    lines.append("      let n = value.asJson()")

    if dims == 1:
        lines.append("      if n.kind == JArray:")
        lines.append(f"        var arr: seq[{elem_type}] = @[]")
        # per-element parse
        parse_lines = []
        if elem_type == "string":
            parse_lines = ['if it.kind == JString: arr.add(it.getStr())']
        elif elem_type == "int":
            parse_lines = [
                'if it.kind == JInt: arr.add(it.getInt())',
                'elif it.kind == JFloat: arr.add(int(it.getFloat()))',
                'elif it.kind == JString:',
                '  try: arr.add(parseInt(it.getStr()))',
                '  except CatchableError: discard',
            ]
        elif elem_type == "float":
            parse_lines = [
                'if it.kind == JFloat: arr.add(it.getFloat())',
                'elif it.kind == JInt: arr.add(it.getInt().float)',
                'elif it.kind == JString:',
                '  try: arr.add(parseFloat(it.getStr()))',
                '  except CatchableError: discard',
            ]
        elif elem_type == "bool":
            parse_lines = [
                'if it.kind == JBool: arr.add(it.getBool())',
                'elif it.kind == JString:',
                '  let s = it.getStr().toLowerAscii()',
                '  arr.add(s in ["true","1","yes","y"])',
            ]
        elif elem_type == "Color":
            parse_lines = ['if it.kind == JString: arr.add(parseHtmlColor(it.getStr()))']
        elif elem_type == "NodeId":
            parse_lines = [
                'if it.kind == JInt: arr.add(it.getInt().NodeId)',
                'elif it.kind == JFloat: arr.add(int(it.getFloat()).NodeId)',
                'elif it.kind == JString:',
                '  try: arr.add(int(parseFloat(it.getStr())).NodeId)',
                '  except CatchableError: discard',
            ]
        elif elem_type == "JsonNode":
            parse_lines = ['if it.kind in {JObject, JArray}: arr.add(it)']
        else:
            parse_lines = ['discard']
        lines.append("        for it in n.items():")
        for pl in parse_lines:
            lines.append(f"          {pl}")
        lines.append(f"        app.appConfig.{name} = arr")
        lines.append("      else:")
        lines.append('        raise newException(ValueError, "Expected JSON array for seq field: ' + name + '")')
    else:
        # 2+ dimensions: expect array of arrays
        lines.append("      if n.kind == JArray:")
        lines.append(f"        var arr: seq[seq[{elem_type}]] = @[]")
        lines.append("        for row in n.items():")
        lines.append("          if row.kind == JArray:")
        lines.append(f"            var r: seq[{elem_type}] = @[]")
        # element parse (same as 1-D)
        parse_lines = []
        if elem_type == "string":
            parse_lines = ['if it.kind == JString: r.add(it.getStr())']
        elif elem_type == "int":
            parse_lines = [
                'if it.kind == JInt: r.add(it.getInt())',
                'elif it.kind == JFloat: r.add(int(it.getFloat()))',
                'elif it.kind == JString:',
                '  try: r.add(parseInt(it.getStr()))',
                '  except CatchableError: discard',
            ]
        elif elem_type == "float":
            parse_lines = [
                'if it.kind == JFloat: r.add(it.getFloat())',
                'elif it.kind == JInt: r.add(it.getInt().float)',
                'elif it.kind == JString:',
                '  try: r.add(parseFloat(it.getStr()))',
                '  except CatchableError: discard',
            ]
        elif elem_type == "bool":
            parse_lines = [
                'if it.kind == JBool: r.add(it.getBool())',
                'elif it.kind == JString:',
                '  let s = it.getStr().toLowerAscii()',
                '  r.add(s in ["true","1","yes","y"])',
            ]
        elif elem_type == "Color":
            parse_lines = ['if it.kind == JString: r.add(parseHtmlColor(it.getStr()))']
        elif elem_type == "NodeId":
            parse_lines = [
                'if it.kind == JInt: r.add(it.getInt().NodeId)',
                'elif it.kind == JFloat: r.add(int(it.getFloat()).NodeId)',
                'elif it.kind == JString:',
                '  try: r.add(int(parseFloat(it.getStr())).NodeId)',
                '  except CatchableError: discard',
            ]
        elif elem_type == "JsonNode":
            parse_lines = ['if it.kind in {JObject, JArray}: r.add(it)']
        else:
            parse_lines = ['discard']
        lines.append("            for it in row.items():")
        for pl in parse_lines:
            lines.append(f"              {pl}")
        lines.append("            arr.add(r)")
        lines.append(f"        app.appConfig.{name} = arr")
        lines.append("      else:")
        lines.append('        raise newException(ValueError, "Expected JSON 2D array for seq field: ' + name + '")')
    lines.append("    else:")
    lines.append('      raise newException(ValueError, "Expected JSON for seq field: ' + name + '")')
    return lines

def _format_block_value_after_colon(block_expr: str) -> str:
    """
    Format a Nim `block:` to be used as a field value:
        <indent>field: block:
        <indent+2>...
    Returns the multi-line string *without* a trailing comma.
    """
    lines = block_expr.splitlines()
    if not lines:
        return "block:\n      discard"
    head = lines[0].strip()
    body = lines[1:]
    if head != "block:":
        # Not a block – return as-is (caller will place it)
        return block_expr
    return "block:\n" + "\n".join("      " + line for line in body)

def _format_field_block(field_name: str, block_lines: list[str]) -> str:
    """
    Format a seq init block returned by _seq_init_expr (list of lines, first is 'block:').
    Produces:
        '    <field>: block:\n'
        '      ...\n'
        (with trailing comma at the end)
    """
    assert block_lines and block_lines[0].strip() == "block:"
    head = block_lines[0]
    body = "\n".join("      " + ln for ln in block_lines[1:])
    return f"    {field_name}: {head}\n{body},"

def write_app_loader_nim(app_dir, config: Optional[dict] = None) -> str:
    if not config:
        config_path = os.path.join(app_dir, "config.json")
        if not os.path.exists(config_path):
            raise FileNotFoundError(f"Config file not found: {config_path}")
        with open(config_path, "r") as f:
            config = json.load(f)
            assert config is not None

    fields = [f for f in config.get("fields", []) if not f.get("markdown")]
    # Build quick index for defaults/refs (used by seq bounds)
    fields_by_name: Dict[str, Dict[str, Any]] = {f["name"]: f for f in fields if "name" in f}

    app_config_lines: List[str] = []
    app_set_lines: List[str] = []

    for field in fields:
        field_name = field["name"]  # NOTE: assumes name matches AppConfig slot
        field_type = field["type"]
        field_default = field.get("value")
        field_required = bool(field.get("required", False))
        is_seq = isinstance(field.get("seq"), list) and len(field["seq"]) > 0

        if is_seq:
            # Build nested seq with sizes derived from seq spec
            field_getter_lines = _seq_init_expr(field, fields_by_name)
            app_config_lines.append(_format_field_block(field_name, field_getter_lines))
            # setField: accept JSON array(s)
            app_set_lines.extend(_set_field_seq_case(field))
            continue

        # Scalars
        default_expr = _default_literal(field_name, field_type, field_default, field_required)
        getter_expr = _scalar_getter(field_name, field_type, default_expr, field_required)
        if getter_expr.startswith("block:"):
            formatted = _format_block_value_after_colon(getter_expr)
            app_config_lines.append(f"    {field_name}: {formatted},")
        else:
            app_config_lines.append(f"    {field_name}: {getter_expr},")

        app_set_lines.append(f'  of "{field_name}":')
        if not field_required and field_type == "image":
            app_set_lines.append(
                f"    app.appConfig.{field_name} = (if value.kind == fkImage: some(value.asImage()) else: none(Image))"
            )
        else:
            # Map Value -> field setter
            if field_type in ("string", "text", "select", "font"):
                app_set_lines.append(f"    app.appConfig.{field_name} = value.asString()")
            elif field_type == "integer":
                app_set_lines.append(f"    app.appConfig.{field_name} = value.asInt()")
            elif field_type == "float":
                app_set_lines.append(f"    app.appConfig.{field_name} = value.asFloat()")
            elif field_type == "boolean":
                app_set_lines.append(f"    app.appConfig.{field_name} = value.asBool()")
            elif field_type == "image":
                # required image: set directly
                app_set_lines.append(f"    app.appConfig.{field_name} = value.asImage()")
            elif field_type == "node":
                app_set_lines.append(f"    app.appConfig.{field_name} = value.asNode()")
            elif field_type == "json":
                app_set_lines.append(f"    app.appConfig.{field_name} = value.asJson()")
            elif field_type == "color":
                app_set_lines.append(f"    app.appConfig.{field_name} = value.asColor()")
            else:
                app_set_lines.append(f'    raise newException(ValueError, "Unsupported field type for set: {field_type}")')

    newline = os.linesep
    nim_code = f"""{{.warning[UnusedImport]: off.}}
import json
import options
import strutils
import pixie
import frameos/values
import frameos/types
import ./app as app_module

proc init*(
    node: DiagramNode,
    scene: FrameScene,
): AppRoot =
  let params = node.data["config"]
  if params.kind != JObject:
    raise newException(Exception, "Invalid config format")
  let config = app_module.AppConfig(
{newline.join(app_config_lines)}
  )

  result = app_module.App(
    appConfig: config,
    nodeName: node.data{{"name"}}.getStr(),
    nodeId: node.id,
    scene: scene,
    frameConfig: scene.frameConfig,
  )

proc setField*(self: AppRoot, field: string, value: Value) =
  let app = app_module.App(self)
  case field:
{newline.join(app_set_lines)}
  else:
    raise newException(ValueError, "Unknown field: " & field)
"""
    if config.get("category") in ("data", "render"):
        nim_code += """
proc get*(self: AppRoot, context: ExecutionContext): Value =
  return app_module.get(app_module.App(self), context)
"""
    if config.get("category") in ("render", "logic"):
        nim_code += """
proc run*(self: AppRoot, context: ExecutionContext) =
  app_module.run(app_module.App(self), context)
"""

    return nim_code
