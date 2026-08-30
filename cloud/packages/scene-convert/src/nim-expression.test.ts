import { describe, expect, it } from "vitest";
import { mapNimTimeFormat, nimExpressionToJs, nimIdentifiers, NimConvertError } from "./nim-expression";

const stateArg = { args: [{ name: "state", type: "string" }], rename: { state: "stateValue" } };

describe("nimExpressionToJs — the vannituba code nodes", () => {
  it("reads nested scene state as a string", () => {
    expect(nimExpressionToJs('$scene.state{"water_heater"}{"state"}.getStr')).toBe(
      'String(state.water_heater?.state ?? "")',
    );
  });

  it("reads one state key as a string", () => {
    expect(nimExpressionToJs('scene.state{"heatTimer"}.getStr')).toBe('String(state.heatTimer ?? "")');
  });

  it("renames a reserved argument", () => {
    expect(nimExpressionToJs('state == "heat"', stateArg)).toBe('stateValue === "heat"');
  });

  it("turns an if-expression into a ternary", () => {
    expect(nimExpressionToJs('if state == "heat": -40 else: 0', stateArg)).toBe(
      'stateValue === "heat" ? -40 : 0',
    );
  });
});

describe("nimExpressionToJs — the mapping table", () => {
  const cases: [string, string, Record<string, unknown>?][] = [
    ["arg + 50.0", "arg + 50.0", { args: [{ name: "arg", type: "float" }] }],
    ["50.0", "50.0"],
    ['state{"a"}.getInt', "Math.trunc(Number(state.a ?? 0))"],
    ['state{"a"}.getFloat', "Number(state.a ?? 0)"],
    ['state{"a"}.getBool', "Boolean(state.a ?? false)"],
    ['state{"a"}.getStr("x")', 'String(state.a ?? "x")'],
    ['state{"a"}{"b"}{"c"}.getStr', 'String(state.a?.b?.c ?? "")'],
    ['state{"a-b"}.getStr', 'String(state["a-b"] ?? "")'],
    ['state{"a"}.hasKey("b")', '(state.a ?? {})["b"] !== undefined'],
    ['state{"a"}.isNil', "state.a == null"],
    ['state{"items"}.len', "(state.items ?? []).length"],
    ['state{"items"}[0]{"name"}.getStr', 'String(state.items?.[0]?.name ?? "")'],
    ['context.payload{"x"}.getStr', 'String(context.payload.x ?? "")'],
    ["context.event", "context.event"],
    ["context.image.width", "context.imageWidth"],
    ["context.hasImage and context.image.height > 100", "context.hasImage && context.imageHeight > 100"],
    ['a == "x" and b != 1 or not c', 'a === "x" && b !== 1 || !c', {
      args: [{ name: "a", type: "string" }, { name: "b", type: "float" }, { name: "c", type: "boolean" }],
    }],
    ['"a" & $n & "b"', '"a" + String(n) + "b"', { args: [{ name: "n", type: "float" }] }],
    ['"a" & 1 + 2', '"a" + String(1 + 2)'],
    ["$1.5", "String(1.5)"],
    ["x.len", "x.length", { args: [{ name: "x", type: "string" }] }],
    ["x.int", "Math.trunc(x)", { args: [{ name: "x", type: "float" }] }],
    ["x.float", "x", { args: [{ name: "x", type: "float" }] }],
    ["x.float", "Number(x)", { args: [{ name: "x", type: "string" }] }],
    ["int(x / 2)", "Math.trunc((x / 2))", { args: [{ name: "x", type: "float" }] }],
    ["x mod 60", "x % 60", { args: [{ name: "x", type: "float" }] }],
    ["x div 60", "Math.trunc(x / 60)", { args: [{ name: "x", type: "float" }] }],
    ["(x + 1) * 2", "(x + 1) * 2", { args: [{ name: "x", type: "float" }] }],
    ["x * (y + 1)", "x * (y + 1)", { args: [{ name: "x", type: "float" }, { name: "y", type: "float" }] }],
    ["-x + 1", "-x + 1", { args: [{ name: "x", type: "float" }] }],
    ["epochTime()", "now()"],
    ["epochTime().int", "Math.trunc(now())"],
    ["epochTime() - t > 60", "now() - t > 60", { args: [{ name: "t", type: "float" }] }],
    ['now().format("HH:mm")', 'format(now(), "{hour/2}:{minute/2}")'],
    ['now().format("yyyy-MM-dd")', 'format(now(), "{year/4}-{month/2}-{day/2}")'],
    ['now().format("dddd, MMMM d")', 'format(now(), "{weekday}, {month/n} {day}")'],
    ['now().format("h:mm tt")', 'format(now(), "{hour/ap}:{minute/2} {am/pm}")'],
    ['getTime().format("%H:%M")', 'format(now(), "{hour/2}:{minute/2}")'],
    ['fromUnix(ts).format("HH")', 'format(ts, "{hour/2}")', { args: [{ name: "ts", type: "float" }] }],
    ["now().hour", 'Number(format(now(), "{hour}"))'],
    ["now().toTime().toUnix()", "now()"],
    ["getTime().toUnix()", "now()"],
    ['%*x', "x", { args: [{ name: "x", type: "string" }] }],
    ['newJString(x)', "x", { args: [{ name: "x", type: "string" }] }],
    ['parseJson(x){"a"}.getStr', 'String(JSON.parse(x)?.a ?? "")', { args: [{ name: "x", type: "string" }] }],
    ['x.split(",")', 'x.split(",")', { args: [{ name: "x", type: "string" }] }],
    ['x.split(",")[0]', 'x.split(",")[0]', { args: [{ name: "x", type: "string" }] }],
    ["x.strip", "x.trim()", { args: [{ name: "x", type: "string" }] }],
    ["x.strip()", "x.trim()", { args: [{ name: "x", type: "string" }] }],
    ["x.toLowerAscii", "x.toLowerCase()", { args: [{ name: "x", type: "string" }] }],
    ["x.toUpperAscii", "x.toUpperCase()", { args: [{ name: "x", type: "string" }] }],
    ['x.contains("a")', 'x.includes("a")', { args: [{ name: "x", type: "string" }] }],
    ['"a" in x', 'x.includes("a")', { args: [{ name: "x", type: "string" }] }],
    ['"a" notin x', '!x.includes("a")', { args: [{ name: "x", type: "string" }] }],
    ['x.startsWith("a")', 'x.startsWith("a")', { args: [{ name: "x", type: "string" }] }],
    ['x.replace("a", "b")', 'x.split("a").join("b")', { args: [{ name: "x", type: "string" }] }],
    ['replace(x, "a", "b")', 'x.split("a").join("b")', { args: [{ name: "x", type: "string" }] }],
    ["parseInt(x)", "parseInt(x, 10)", { args: [{ name: "x", type: "string" }] }],
    ["x.parseInt", "parseInt(x, 10)", { args: [{ name: "x", type: "string" }] }],
    ["parseFloat(x)", "parseFloat(x)", { args: [{ name: "x", type: "string" }] }],
    ["x.formatFloat(ffDecimal, 2)", "x.toFixed(2)", { args: [{ name: "x", type: "float" }] }],
    ["formatFloat(x, ffDecimal, 1)", "x.toFixed(1)", { args: [{ name: "x", type: "float" }] }],
    ["$x.formatFloat(ffDecimal, 2)", "x.toFixed(2)", { args: [{ name: "x", type: "float" }] }],
    ["abs(x)", "Math.abs(x)", { args: [{ name: "x", type: "float" }] }],
    ["x.abs", "Math.abs(x)", { args: [{ name: "x", type: "float" }] }],
    ["round(x)", "Math.round(x)", { args: [{ name: "x", type: "float" }] }],
    ["max(x, 0)", "Math.max(x, 0)", { args: [{ name: "x", type: "float" }] }],
    ["true", "true"],
    ["nil", "null"],
    ['x.isEmptyOrWhitespace', 'x.trim() === ""', { args: [{ name: "x", type: "string" }] }],
    ['x.alignLeft(5)', "x.padEnd(5)", { args: [{ name: "x", type: "string" }] }],
    ['x.align(5, \'0\')', "x.padStart(5, \"0\")", { args: [{ name: "x", type: "string" }] }],
    ['@["a", "b"]', '["a", "b"]'],
    ['@["a", "b"].join(", ")', '["a", "b"].join(", ")'],
    ['if a: "x" elif b: "y" else: "z"', 'a ? "x" : b ? "y" : "z"', {
      args: [{ name: "a", type: "boolean" }, { name: "b", type: "boolean" }],
    }],
    ['(if a: 1 else: 2) + 3', "(a ? 1 : 2) + 3", { args: [{ name: "a", type: "boolean" }] }],
    ['case x\n  of "a": 1\n  of "b", "c": 2\n  else: 3', 'x === "a" ? 1 : x === "b" || x === "c" ? 2 : 3', {
      args: [{ name: "x", type: "string" }],
    }],
    [
      'let v = state{"a"}.getFloat\nlet w = v * 2\nif w > 1: w else: 0',
      '(() => {\n  const v = Number(state.a ?? 0);\n  const w = v * 2;\n  return w > 1 ? w : 0;\n})()',
    ],
    ["if state == \"heat\":\n  -40\nelse:\n  0", 'stateValue === "heat" ? -40 : 0', stateArg],
    ["x # trailing comment", "x", { args: [{ name: "x", type: "string" }] }],
    ["self.scene.state{\"a\"}.getStr", 'String(state.a ?? "")'],
    ["1_000 * 2", "1000 * 2"],
    ["x xor y", "x !== y", { args: [{ name: "x", type: "boolean" }, { name: "y", type: "boolean" }] }],
  ];

  for (const [nim, js, options] of cases) {
    it(`${JSON.stringify(nim)} → ${JSON.stringify(js)}`, () => {
      expect(nimExpressionToJs(nim, options)).toBe(js);
    });
  }

  it("does not rename an argument that is not reserved", () => {
    expect(nimExpressionToJs("foo + 1", { args: [{ name: "foo", type: "float" }], rename: { state: "stateValue" } })).toBe(
      "foo + 1",
    );
  });

  it("renames a let-bound name that is not a JavaScript identifier", () => {
    expect(nimExpressionToJs("let class = 1\nclass + 1")).toBe("(() => {\n  const class_ = 1;\n  return class_ + 1;\n})()");
  });
});

describe("nimExpressionToJs — what falls through to the model", () => {
  const rejected: [string, RegExp][] = [
    ["someProc(x)", /unknown identifier|no code-node equivalent/],
    ["unknownName", /unknown identifier "unknownName"/],
    ["scene.frameConfig.width", /no code-node equivalent/],
    ['now().format("zzz")', /no format\(\) token/],
    ["x[^1]", /from the end/],
    ["if x: 1", /needs an else/],
    ['"unterminated', /unterminated string/],
    ["x.get()", /no code-node equivalent/],
    ["rand(10)", /no code-node equivalent/],
    ["", /empty/],
    ["1 +", /unexpected end/],
    ["'ab'", /character literal/],
    ["1.5'f32", /suffix/],
    ["for i in 0..3: i", /unexpected keyword|unknown identifier/],
  ];
  for (const [nim, message] of rejected) {
    it(`rejects ${JSON.stringify(nim)}`, () => {
      expect(() => nimExpressionToJs(nim, { args: [{ name: "x", type: "json" }] })).toThrowError(message);
    });
  }

  it("reports the position of the failure", () => {
    try {
      nimExpressionToJs('state{"a"}.getStr & unknownThing');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(NimConvertError);
      expect((error as NimConvertError).position).toBe(20);
    }
  });
});

describe("mapNimTimeFormat", () => {
  it("keeps chrono patterns as they are", () => {
    expect(mapNimTimeFormat("{hour/2}:{minute/2}")).toBe("{hour/2}:{minute/2}");
  });
  it("copies quoted literals verbatim", () => {
    expect(mapNimTimeFormat("HH'h'mm")).toBe("{hour/2}h{minute/2}");
  });
  it("maps strftime", () => {
    expect(mapNimTimeFormat("%A %d %B, %I:%M %p")).toBe("{weekday} {day/2} {month/n}, {hour/2/ap}:{minute/2} {am/pm}");
  });
});

describe("nimIdentifiers", () => {
  it("lists referenced names, keywords excluded", () => {
    expect([...nimIdentifiers('if state == "heat": arg else: other.len')]).toEqual(["state", "arg", "other", "len"]);
  });
  it("still answers for unlexable source", () => {
    expect(nimIdentifiers("foo & 'c'").has("foo")).toBe(true);
  });
});
