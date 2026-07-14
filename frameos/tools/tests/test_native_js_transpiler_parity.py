from __future__ import annotations

import json
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[3]
FRAMEOS_ROOT = ROOT / "frameos"
FRAME_FRONTEND_ROOT = FRAMEOS_ROOT / "frontend"
NATIVE_CLI = FRAMEOS_ROOT / "tools" / "native_js_transpile.nim"


JSX_PRELUDE = r"""
const __frameosFragment = Symbol.for("frameos.fragment");
const __frameosNormalizeChildren = (children) => {
  if (children.length === 0) return undefined;
  if (children.length === 1) return children[0];
  return children;
};
const __frameosJsx = (type, props, ...children) => {
  const nextProps = props ? { ...props } : {};
  const explicitChildren = __frameosNormalizeChildren(children);
  const propChildren = Object.prototype.hasOwnProperty.call(nextProps, "children")
    ? nextProps.children
    : undefined;
  if (Object.prototype.hasOwnProperty.call(nextProps, "children")) {
    delete nextProps.children;
  }
  const normalizedChildren = explicitChildren ?? propChildren;
  if (type === __frameosFragment) {
    return normalizedChildren ?? null;
  }
  if (normalizedChildren !== undefined) {
    nextProps.children = normalizedChildren;
  }
  return { type, props: nextProps };
};
"""


@dataclass(frozen=True)
class Fixture:
  name: str
  source: str
  app: dict
  context: dict
  xfail_native: str | None = None


FIXTURES = [
  Fixture(
    name="typed_jsx_and_modern_es",
    source=r'''
      export function get(app: { config?: { nested?: { count?: number }, label?: string } }, context: { event: string }) {
        class Counter {
          value = 1_000
          increment = () => ++this.value
        }
        const metadata = { type: "image", as: "alias", satisfies: true }
        const count = app.config?.nested?.count ?? new Counter().increment()
        const label = (app.config?.label ?? "FrameOS") as string
        const ok = /frame\s*os/i.test("Frame OS")
        return <image width={count} label={`${label}:${context.event}`} metadata={metadata} ok={ok} />
      }
    ''',
    app={"config": {"label": "Native", "nested": {"count": 42}}},
    context={"event": "render"},
  ),
  Fixture(
    name="quickjs_native_es_passthrough",
    source=r'''
      export function get(app: { config?: { nested?: { count?: number } } }) {
        class Counter {
          static label = "counter"
          #step = 1n
          value = 1_000
          increment = () => {
            this.value += Number(this.#step)
            return this.value
          }
        }
        const counter = new Counter()
        let configured = app.config?.nested?.count ?? 0
        configured ||= counter.increment()
        return Counter.label === "counter" ? configured : 0
      }
    ''',
    app={"config": {}},
    context={},
  ),
  Fixture(
    name="object_keys_after_template_interpolation",
    source=r'''
      export function get(app: { config: { base: string } }, context: { event: string }) {
        const request = (url: string, options: { method: string }) => `${url}#${options.method}`
        const post = request(`${app.config.base}/echo`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hello: `${context.event}` }),
        })
        return { post, ok: post.length !== 0, same: post === post }
      }
    ''',
    app={"config": {"base": "http://frame"}},
    context={"event": "render"},
  ),
  Fixture(
    name="enum_runtime_values",
    source=r'''
      export enum Mode {
        First,
        Second = First + 2,
        Label = "label",
      }
      export function get() {
        return [Mode.First, Mode[0], Mode.Second, Mode.Label]
      }
    ''',
    app={},
    context={},
  ),
  Fixture(
    name="complex_type_alias_and_predicate",
    source=r'''
      type Wrapped<T> = T extends string ? { [K in keyof T]: T[K] } : never
      interface Input<T> extends Record<string, unknown> {
        value?: T
      }
      function isString(value: unknown): value is string {
        return typeof value === "string"
      }
      export function get(app: { config: Input<string> }) {
        return isString(app.config.value) ? app.config.value : "missing"
      }
    ''',
    app={"config": {"value": "ok"}},
    context={},
  ),
  Fixture(
    name="constructor_parameter_property",
    source=r'''
      class Box {
        constructor(public value: string) {}
      }
      export function get() {
        return new Box("ok").value
      }
    ''',
    app={},
    context={},
  ),
  Fixture(
    name="function_overload_declarations",
    source=r'''
      function pick(value: string): string
      function pick(value: number): number
      function pick(value: string | number): string | number {
        return value
      }
      export function get() {
        return [pick("ok"), pick(3)]
      }
    ''',
    app={},
    context={},
  ),
  Fixture(
    name="const_enum_runtime_values",
    source=r'''
      const enum Mode {
        A,
        B = A + 2,
      }
      export function get() {
        return [Mode.A, Mode.B]
      }
    ''',
    app={},
    context={},
  ),
  Fixture(
    name="type_only_export_elision",
    source=r'''
      type Foo = string
      export type { Foo }
      export function get() {
        return "ok"
      }
    ''',
    app={},
    context={},
  ),
  Fixture(
    name="declare_const_elision",
    source=r'''
      declare const injected: any
      export function get() {
        return typeof injected
      }
    ''',
    app={},
    context={},
  ),
  Fixture(
    name="abstract_class_members",
    source=r'''
      abstract class Base {
        abstract value(): string
        concrete(): string {
          return "ok"
        }
      }
      class Child extends Base {
        value(): string {
          return "child"
        }
      }
      export function get() {
        return new Child().concrete()
      }
    ''',
    app={},
    context={},
  ),
]

TOKEN_FIXTURES = [
  pytest.param("5/3/1", id="division_sequence"),
  pytest.param("5 + /3/", id="regex_after_operator"),
  pytest.param("x<Hello>2", id="relational_not_jsx"),
  pytest.param("x + < Hello / >", id="jsx_after_operator"),
  pytest.param(
    '''
      <div className="foo">
        Hello, world!
        <span className={bar} />
      </div>
    ''',
    id="nested_jsx",
  ),
  pytest.param("`Hello, ${name} ${surname}`", id="template_expressions"),
  pytest.param(
    '''
      a = b
      ++c
      d++
      e = f++
      g = ++h
    ''',
    id="pre_post_increment",
  ),
  pytest.param(
    '''
      import foo from "./foo.json" with {type: "json"};
      export {val} from './foo.js' with {type: "javascript"};
    ''',
    id="import_attributes",
  ),
  pytest.param(
    '''
      class {
        #x = 3
      }
      this.#x = 3
      delete this?.#x
      if (#x in obj) { }
    ''',
    id="private_properties",
  ),
]

ANNOTATION_FIXTURES = [
  pytest.param(
    '''
      function outer(a: number) {
        const x: string = "x";
        var y = 1;
        class Inner {}
      }
    ''',
    id="declaration_roles_and_types",
  ),
  pytest.param(
    '''
      import DefaultThing, { value as renamed, other } from "pkg";
      export { renamed as publicName };
      export const answer = 42;
    ''',
    id="import_export_roles",
  ),
  pytest.param(
    '''
      const empty = <div />;
      const one = <div>{child}</div>;
      const many = <div><span />{child}</div>;
      const keyed = <div {...props} key={1} />;
    ''',
    id="jsx_roles",
  ),
]


def require_tool(name: str) -> str:
  path = shutil.which(name)
  if not path:
    pytest.skip(f"{name} is required for native/Sucrase parity tests")
  return path


@pytest.fixture(scope="session")
def native_cli(tmp_path_factory: pytest.TempPathFactory) -> Path:
  require_tool("nim")
  out = tmp_path_factory.mktemp("native-js-transpile") / "native_js_transpile"
  proc = subprocess.run(
    [
      "nim",
      "c",
      "--hints:off",
      "--verbosity:0",
      f"--nimcache:{out.parent / 'nimcache'}",
      f"--out:{out}",
      str(NATIVE_CLI),
    ],
    cwd=FRAMEOS_ROOT,
    text=True,
    capture_output=True,
    check=False,
  )
  assert proc.returncode == 0, proc.stderr + proc.stdout
  return out


def transform_native(native_cli: Path, source: str) -> str:
  with tempfile.NamedTemporaryFile("w", suffix=".tsx", encoding="utf-8", delete=False) as tmp:
    tmp.write(source)
    tmp_path = tmp.name
  try:
    proc = subprocess.run(
      [str(native_cli), "module", tmp_path],
      cwd=FRAMEOS_ROOT,
      text=True,
      capture_output=True,
      check=False,
    )
  finally:
    Path(tmp_path).unlink(missing_ok=True)
  assert proc.returncode == 0, proc.stderr + proc.stdout
  return proc.stdout


def tokenize_native(native_cli: Path, source: str) -> list[str]:
  with tempfile.NamedTemporaryFile("w", suffix=".tsx", encoding="utf-8", delete=False) as tmp:
    tmp.write(source)
    tmp_path = tmp.name
  try:
    proc = subprocess.run(
      [str(native_cli), "tokens", tmp_path],
      cwd=FRAMEOS_ROOT,
      text=True,
      capture_output=True,
      check=False,
    )
  finally:
    Path(tmp_path).unlink(missing_ok=True)
  assert proc.returncode == 0, proc.stderr + proc.stdout
  labels = []
  for line in proc.stdout.splitlines():
    if not line:
      continue
    match = re.match(r"^(.*?)\(\d+,\d+\)", line)
    assert match, line
    labels.append(match.group(1))
  return labels


def annotations_from_native(native_cli: Path, source: str) -> list[dict]:
  with tempfile.NamedTemporaryFile("w", suffix=".tsx", encoding="utf-8", delete=False) as tmp:
    tmp.write(source)
    tmp_path = tmp.name
  try:
    proc = subprocess.run(
      [str(native_cli), "parse", tmp_path],
      cwd=FRAMEOS_ROOT,
      text=True,
      capture_output=True,
      check=False,
    )
  finally:
    Path(tmp_path).unlink(missing_ok=True)
  assert proc.returncode == 0, proc.stderr + proc.stdout
  result = []
  for line in proc.stdout.splitlines():
    if not line:
      continue
    match = re.match(r"^(.*?)\((\d+),(\d+)\)(?:.*?\[(.*)\])?", line)
    assert match, line
    start = int(match.group(2))
    end = int(match.group(3))
    fields = {}
    if match.group(4):
      for field in match.group(4).split(","):
        if "=" in field:
          key, value = field.split("=", 1)
          fields[key] = value
        else:
          fields[field] = True
    result.append(
      {
        "label": match.group(1),
        "text": source[start:end],
        "type": bool(fields.get("type")),
        "role": fields.get("role"),
        "jsx": fields.get("jsx"),
      }
    )
  return result


def transform_sucrase(source: str) -> str:
  require_tool("node")
  script = r'''
    import { transform } from "sucrase";
    const chunks = [];
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) chunks.push(chunk);
    const source = chunks.join("");
    const result = transform(source, {
      transforms: ["typescript", "jsx", "imports"],
      jsxRuntime: "classic",
      jsxPragma: "__frameosJsx",
      jsxFragmentPragma: "__frameosFragment",
      production: true,
    });
    process.stdout.write(result.code);
  '''
  proc = subprocess.run(
    ["node", "--input-type=module", "-e", script],
    cwd=FRAME_FRONTEND_ROOT,
    input=source,
    text=True,
    capture_output=True,
    check=False,
  )
  assert proc.returncode == 0, proc.stderr + proc.stdout
  return proc.stdout


def tokenize_sucrase(source: str) -> list[str]:
  require_tool("node")
  script = r'''
    const {parse} = require("sucrase/dist/parser");
    const {formatTokenType} = require("sucrase/dist/parser/tokenizer/types");
    const chunks = [];
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => {
      const file = parse(chunks.join(""), true, true, false);
      process.stdout.write(JSON.stringify(file.tokens.map((token) => formatTokenType(token.type))));
    });
  '''
  proc = subprocess.run(
    ["node", "-e", script],
    cwd=FRAME_FRONTEND_ROOT,
    input=source,
    text=True,
    capture_output=True,
    check=False,
  )
  assert proc.returncode == 0, proc.stderr + proc.stdout
  return json.loads(proc.stdout)


def annotations_from_sucrase(source: str) -> list[dict]:
  require_tool("node")
  script = r'''
    const {parse} = require("sucrase/dist/parser");
    const {formatTokenType} = require("sucrase/dist/parser/tokenizer/types");
    const {IdentifierRole, JSXRole} = require("sucrase/dist/parser/tokenizer");
    const chunks = [];
    const lowerFirst = (value) => value ? value[0].toLowerCase() + value.slice(1) : null;
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => {
      const source = chunks.join("");
      const file = parse(source, true, true, false);
      process.stdout.write(JSON.stringify(file.tokens.map((token) => ({
        label: formatTokenType(token.type),
        text: source.slice(token.start, token.end),
        type: Boolean(token.isType),
        role: token.identifierRole == null ? null : lowerFirst(IdentifierRole[token.identifierRole]),
        jsx: token.jsxRole == null ? null : lowerFirst(JSXRole[token.jsxRole]),
      }))));
    });
  '''
  proc = subprocess.run(
    ["node", "-e", script],
    cwd=FRAME_FRONTEND_ROOT,
    input=source,
    text=True,
    capture_output=True,
    check=False,
  )
  assert proc.returncode == 0, proc.stderr + proc.stdout
  return json.loads(proc.stdout)


def interesting_annotations(tokens: list[dict]) -> list[dict]:
  return [
    token
    for token in tokens
    if token["type"] or token["role"] is not None or token["jsx"] is not None
  ]


def run_transformed(code: str, app: dict, context: dict):
  require_tool("node")
  runner = (
    JSX_PRELUDE
    + "\n"
    + "const exports = {};\n"
    + code
    + "\n"
    + "const value = exports.get("
    + json.dumps(app)
    + ", "
    + json.dumps(context)
    + ");\n"
    + "process.stdout.write(JSON.stringify(value));\n"
  )
  proc = subprocess.run(
    ["node", "--input-type=module", "-e", runner],
    cwd=FRAME_FRONTEND_ROOT,
    text=True,
    capture_output=True,
    check=False,
  )
  assert proc.returncode == 0, proc.stderr + proc.stdout + "\nCode:\n" + code
  return json.loads(proc.stdout)


@pytest.mark.parametrize("fixture", FIXTURES, ids=lambda fixture: fixture.name)
def test_native_transpiler_matches_sucrase_runtime(native_cli: Path, fixture: Fixture):
  sucrase_code = transform_sucrase(fixture.source)
  sucrase_output = run_transformed(sucrase_code, fixture.app, fixture.context)

  try:
    native_code = transform_native(native_cli, fixture.source)
    native_output = run_transformed(native_code, fixture.app, fixture.context)
  except AssertionError as error:
    if fixture.xfail_native:
      pytest.xfail(fixture.xfail_native + f": {error}")
    raise

  if fixture.xfail_native and native_output == sucrase_output:
    pytest.fail(f"Fixture marked xfail now matches Sucrase: {fixture.xfail_native}")
  if fixture.xfail_native:
    pytest.xfail(fixture.xfail_native)
  assert native_output == sucrase_output


@pytest.mark.parametrize("source", TOKEN_FIXTURES)
def test_native_tokenizer_matches_sucrase_tokens(native_cli: Path, source: str):
  assert tokenize_native(native_cli, source) == tokenize_sucrase(source)


@pytest.mark.parametrize("source", ANNOTATION_FIXTURES)
def test_native_parser_annotations_match_sucrase_subset(native_cli: Path, source: str):
  assert interesting_annotations(annotations_from_native(native_cli, source)) == interesting_annotations(
    annotations_from_sucrase(source)
  )
