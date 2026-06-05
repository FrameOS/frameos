import std/[strutils, unittest]

import ../js_runtime/transpiler

suite "native js transpiler":
  test "strips common TypeScript syntax":
    let output = transformFrameosScript("""
interface Removed { value: number }
type AlsoRemoved = { value: string };
const answer: number = 42;
function demo(input: number): number {
  return input as number;
}
const fn = ({count}: {count: number}) => count satisfies number;
""")
    check "interface Removed" notin output
    check "type AlsoRemoved" notin output
    check "answer: number" notin output
    check "input: number" notin output
    check "as number" notin output
    check "satisfies number" notin output
    check "const answer = 42" in output

  test "lowers classic JSX to FrameOS runtime calls":
    let output = transformFrameosScript("""
function demo(input: number) {
  return <card active={input > 0}>{input as number}</card>;
}
""")
    check "__frameosJsx(\"card\"" in output
    check "\"active\": input > 0" in output
    check "input: number" notin output
    check "as number" notin output

  test "rewrites simple app module exports":
    let output = transformFrameosModule("""
export const get = (app: { config: { message?: string } }) => {
  return <image width={3} height={2} color="#336699" />;
}
export function run(app: { config: { duration: number } }) {
  return app.config.duration;
}
""")
    check output.startsWith("\"use strict\";")
    check "const get = (app) =>" in output
    check "function run(app)" in output
    check "exports.get = get;" in output
    check "exports.run = run;" in output
    check "__frameosJsx(\"image\"" in output

  test "rewrites broader export declarations":
    let output = transformFrameosModule("""
export const first = 1, second = 2;
export async function load(): Promise<number> {
  return first + second;
}
export default async function namedDefault(): Promise<number> {
  return load();
}
""")
    check "const first = 1, second = 2;" in output
    check "exports.first = first;" in output
    check "exports.second = second;" in output
    check "async function load()" in output
    check "exports.load = load;" in output
    check "async function namedDefault()" in output
    check "exports.default = namedDefault;" in output

  test "lowers TypeScript enums":
    let output = transformFrameosModule("""
export enum Mode {
  First,
  Second = First + 2,
  Label = "label",
  "spaced key" = 9,
}
""")
    check "var Mode; (function (Mode)" in output
    check "const First = 0;" in output
    check "Mode[Mode[\"First\"] = First] = \"First\";" in output
    check "const Second = First + 2;" in output
    check "const Label = \"label\";" in output
    check "Mode[\"spaced key\"] = 9" in output
    check "exports.Mode = Mode;" in output

  test "rewrites static imports to CommonJS declarations":
    let output = transformFrameosModule("""
import "./setup";
import DefaultThing, { value as renamed, other } from "pkg";
import * as tools from "./tools";
export { renamed as publicName };
export { other as remoteOther } from "pkg2";
export * as everything from "pkg3";
export * from "pkg4";
""")
    check "require(\"./setup\");" in output
    check "require(\"pkg\")" in output
    check "var DefaultThing =" in output
    check "var renamed =" in output
    check ".value;" in output
    check "var other =" in output
    check ".other;" in output
    check "var tools =" in output
    check "exports.publicName = renamed;" in output
    check "exports.remoteOther =" in output
    check "exports.everything = require(\"pkg3\");" in output
    check "Object.keys(" in output

  test "rewrites TypeScript import equals":
    let output = transformFrameosModule("""
import tool = require("toolkit");
export const value = tool.value;
""")
    check "const tool = require(\"toolkit\");" in output
    check "exports.value = value;" in output

  test "lowers fragments and decodes JSX entities":
    let output = transformFrameosScript("""
const value = <><text label="Tom &amp; Jerry">A &lt; B &#33;</text></>;
""")
    check "__frameosJsx(__frameosFragment, null" in output
    check "\"Tom & Jerry\"" in output
    check "\"A < B !\"" in output

  test "strips generics and TypeScript-only modifiers":
    let output = transformFrameosScript("""
abstract class Box<T> {
  public readonly value: T;
  getValue(): T {
    return this.value;
  }
  constructor(value: T) {
    this.value = identity<T>(value);
  }
}
function identity<T>(value: T): T {
  return value;
}
const arrow = <T>(value: T): T => value;
""")
    check "abstract" notin output
    check "public" notin output
    check "readonly" notin output
    check "Box<T>" notin output
    check "identity<T>" notin output
    check "<T>(value" notin output
    check "getValue()" in output
    check "getValue(): T" notin output
    check "function identity(value)" in output
    check "const arrow = (value)" in output
    check "=> value" in output

  test "strips multiple variable declarator types without touching initializers":
    let output = transformFrameosScript("""
const first: number = 1, second: string = "two", obj = { label: "ok", nested: { count: 1 } };
let third: boolean, fourth: number = 4;
""")
    check "first: number" notin output
    check "second: string" notin output
    check "third: boolean" notin output
    check "fourth: number" notin output
    check "const first = 1, second = \"two\"" in output
    check "obj = { label: \"ok\", nested: { count: 1 } }" in output

  test "strips types inside template literal interpolations":
    let output = transformFrameosModule("""
export function get(app: FrameOSApp): string {
  const label = app.config.label as string;
  return `<svg><text>${label as string}</text><title>${(app.config.title satisfies string)}</title></svg>`;
}
""")
    check "app: FrameOSApp" notin output
    check "as string" notin output
    check "satisfies string" notin output
    check "<text>${label" in output
    check "<title>${(app.config.title" in output

  test "strips definite assignment member annotations":
    let output = transformFrameosScript("""
class AppState {
  value!: string;
  optional?: number;
}
""")
    check "value!: string" notin output
    check "optional?: number" notin output
    check "value;" in output
    check "optional;" in output

  test "preserves runtime type identifiers and object keys":
    let output = transformFrameosScript("""
type Alias = { label: string };
interface Removed { label: string }
const type = "image";
const spec = { type: "image", props: { type: "text" } };
function get(type: string) {
  return { type };
}
""")
    check "type Alias" notin output
    check "interface Removed" notin output
    check "const type = \"image\";" in output
    check "{ type: \"image\", props: { type: \"text\" } }" in output
    check "function get(type)" in output

  test "preserves runtime as and satisfies object keys":
    let output = transformFrameosScript("""
const metadata = { as: "alias", satisfies: true };
const alias = metadata.as as string;
const ok = metadata.satisfies satisfies boolean;
""")
    check "{ as: \"alias\", satisfies: true }" in output
    check "metadata.as as string" notin output
    check "metadata.satisfies satisfies boolean" notin output
    check "const alias = metadata.as" in output
    check "const ok = metadata.satisfies" in output

  test "preserves modern ES syntax supported by QuickJS":
    let output = transformFrameosScript("""
class Counter {
  value = 1_000;
  increment = () => this.value++;
}
try {
  const result = app.config?.nested?.count ?? 1_000;
  const regex = /type\s*:\s*image/g;
  const ratio = result / 2;
} catch {
  console.log("optional catch binding");
}
""")
    check "value = 1_000;" in output
    check "app.config?.nested?.count ?? 1_000" in output
    check "/type\\s*:\\s*image/g" in output
    check "result / 2" in output
    check "} catch {" in output

  test "lowers constructor parameter properties":
    let output = transformFrameosModule("""
class Box {
  constructor(public value: string, private readonly count: number = 1) {}
}
export function get() {
  return new Box("ok").value;
}
""")
    check "constructor(value, count" in output
    check "this.value = value;" in output
    check "this.count = count;" in output
    check "public value" notin output
    check "private readonly" notin output
