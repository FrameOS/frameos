// Pass 1 of the converter: a small Nim *expression* grammar, translated to
// one JavaScript expression — the shape a code node holds in data.codeJS.
// It covers what code nodes actually contain (state reads, comparisons,
// arithmetic, if-expressions, string building, a little time formatting)
// and nothing more: anything outside the grammar throws NimConvertError
// with the position, and the caller hands that node to the model instead.
// The table this implements is docs/nim-to-js-conversion.md — keep both in
// step (prompt.test.ts checks the doc still lists every mapping).
//
// What the JavaScript targets: the code-node envelope of
// frameos/src/frameos/js_runtime/runtime.nim — `state` is a proxy over the
// scene state, `context` the execution context, `now()`/`format()` the time
// helpers, and every declared codeArg is a const of the same name.

export class NimConvertError extends Error {
  readonly position: number;

  constructor(message: string, position: number) {
    super(message);
    this.name = "NimConvertError";
    this.position = position;
  }
}

type TokenKind = "num" | "str" | "ident" | "op" | "eof";

type Token = {
  kind: TokenKind;
  /** Source text for ops/idents/nums; decoded value for strings. */
  text: string;
  pos: number;
};

type Kind =
  | "string"
  | "number"
  | "boolean"
  | "json"
  | "array"
  | "datetime"
  | "ffmode"
  | "scene"
  | "context"
  | "unknown";

type Emitted = {
  js: string;
  kind: Kind;
  prec: number;
  /** json only: the bare `state` / `context.payload` root, indexed without `?.`. */
  jsonRoot?: boolean;
  /** datetime only: the seconds-since-epoch expression behind it. */
  ts?: string;
};

const PREC_TERNARY = 3;
const PREC_OR = 4;
const PREC_AND = 5;
const PREC_CMP = 8;
const PREC_CONCAT = 10;
const PREC_ADD = 11;
const PREC_MUL = 12;
const PREC_UNARY = 14;
const PREC_POSTFIX = 16;
const PREC_ATOM = 20;

const KEYWORDS = new Set([
  "if",
  "elif",
  "else",
  "and",
  "or",
  "not",
  "xor",
  "mod",
  "div",
  "in",
  "notin",
  "let",
  "var",
  "case",
  "of",
  "true",
  "false",
  "nil",
]);

const MULTI_CHAR_OPS = ["==", "!=", "<=", ">=", "%*", "@[", "..", "->"];
const SINGLE_CHAR_OPS = new Set("<>=+-*/&$(){}[].,:;^%!@");

export type NimExpressionOptions = {
  /** Declared (or edge-fed) code-node arguments and their field types. */
  args?: { name: string; type?: string | undefined }[];
  /** Identifier renames to apply (reserved envelope names → new names). */
  rename?: Record<string, string>;
};

// --- tokenizer --------------------------------------------------------------

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i]!;
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      i += 1;
      continue;
    }
    if (ch === "#") {
      while (i < n && source[i] !== "\n") {
        i += 1;
      }
      continue;
    }
    if (ch === '"') {
      const start = i;
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) {
          throw new NimConvertError("unterminated string", start);
        }
        tokens.push({ kind: "str", pos: start, text: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      i += 1;
      let value = "";
      while (i < n && source[i] !== '"') {
        const c = source[i]!;
        if (c === "\\") {
          const next = source[i + 1];
          const escapes: Record<string, string> = {
            '"': '"',
            "'": "'",
            "\\": "\\",
            n: "\n",
            r: "\r",
            t: "\t",
            l: "\n",
            e: "",
            a: "",
            b: "\b",
          };
          if (next !== undefined && escapes[next] !== undefined) {
            value += escapes[next];
            i += 2;
            continue;
          }
          throw new NimConvertError(`unsupported string escape \\${next ?? ""}`, i);
        }
        if (c === "\n") {
          throw new NimConvertError("unterminated string", start);
        }
        value += c;
        i += 1;
      }
      if (i >= n) {
        throw new NimConvertError("unterminated string", start);
      }
      i += 1;
      tokens.push({ kind: "str", pos: start, text: value });
      continue;
    }
    if (ch === "'") {
      // A char literal is a one-character string on the JS side.
      const close = source.indexOf("'", i + 1);
      const inner = close > i ? source.slice(i + 1, close) : "";
      const value = inner === "\\n" ? "\n" : inner === "\\t" ? "\t" : inner === "\\\\" ? "\\" : inner === "\\'" ? "'" : inner;
      if (close < 0 || value.length !== 1) {
        throw new NimConvertError("only one-character literals are supported", i);
      }
      tokens.push({ kind: "str", pos: i, text: value });
      i = close + 1;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      const start = i;
      while (i < n && /[0-9_]/.test(source[i]!)) {
        i += 1;
      }
      if (source[i] === "." && /[0-9]/.test(source[i + 1] ?? "")) {
        i += 1;
        while (i < n && /[0-9_]/.test(source[i]!)) {
          i += 1;
        }
      }
      if ((source[i] === "e" || source[i] === "E") && /[0-9+-]/.test(source[i + 1] ?? "")) {
        i += 2;
        while (i < n && /[0-9]/.test(source[i]!)) {
          i += 1;
        }
      }
      if (source[i] === "'" || /[a-zA-Z_]/.test(source[i] ?? "")) {
        throw new NimConvertError("numeric literal suffixes are not supported", i);
      }
      tokens.push({ kind: "num", pos: start, text: source.slice(start, i).replace(/_/g, "") });
      continue;
    }
    if (/[a-zA-Z_]/.test(ch)) {
      const start = i;
      while (i < n && /[a-zA-Z0-9_]/.test(source[i]!)) {
        i += 1;
      }
      tokens.push({ kind: "ident", pos: start, text: source.slice(start, i) });
      continue;
    }
    const multi = MULTI_CHAR_OPS.find((op) => source.startsWith(op, i));
    if (multi) {
      tokens.push({ kind: "op", pos: i, text: multi });
      i += multi.length;
      continue;
    }
    if (SINGLE_CHAR_OPS.has(ch)) {
      tokens.push({ kind: "op", pos: i, text: ch });
      i += 1;
      continue;
    }
    throw new NimConvertError(`unexpected character ${JSON.stringify(ch)}`, i);
  }
  tokens.push({ kind: "eof", pos: n, text: "" });
  return tokens;
}

// --- helpers ------------------------------------------------------------------

const JS_IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const JS_RESERVED = new Set([
  "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do",
  "else", "enum", "export", "extends", "false", "finally", "for", "function", "if", "import",
  "in", "instanceof", "new", "null", "return", "super", "switch", "this", "throw", "true", "try",
  "typeof", "var", "void", "while", "with", "yield", "let", "static", "await",
]);

function isJsIdent(name: string): boolean {
  return JS_IDENT.test(name) && !JS_RESERVED.has(name);
}

function jsString(value: string): string {
  return JSON.stringify(value);
}

function wrap(e: Emitted, minPrec: number): string {
  return e.prec < minPrec ? `(${e.js})` : e.js;
}

function atom(js: string, kind: Kind, extra: Partial<Emitted> = {}): Emitted {
  return { js, kind, prec: PREC_ATOM, ...extra };
}

function kindForFieldType(type: string | undefined): Kind {
  switch (type) {
    case "string":
    case "text":
    case "select":
    case "color":
    case "font":
    case "date":
    case "image":
      return "string";
    case "float":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "json":
      return "json";
    default:
      return "unknown";
  }
}

/** `X ?? fallback` as one parenthesised atom. */
function coalesce(e: Emitted, fallback: string): string {
  return `(${e.js} ?? ${fallback})`;
}

function asString(e: Emitted): Emitted {
  if (e.kind === "string") {
    return e;
  }
  if (e.kind === "json") {
    return atom(`String${coalesce(e, '""')}`, "string");
  }
  return atom(`String(${e.js})`, "string");
}

function asNumber(e: Emitted): string {
  return e.kind === "number" ? wrap(e, PREC_POSTFIX) : `Number(${e.kind === "json" ? coalesce(e, "0") : e.js})`;
}

// Nim's std/times pattern letters (yyyy-MM-dd HH:mm) and strftime's (%H:%M)
// onto the chrono-style curly tokens the code-node format() takes.
const NIM_TIME_TOKENS: Record<string, string> = {
  yyyy: "{year/4}",
  YYYY: "{year/4}",
  uuuu: "{year/4}",
  yy: "{year/2}",
  MMMM: "{month/n}",
  MMM: "{month/n/3}",
  MM: "{month/2}",
  M: "{month}",
  dddd: "{weekday}",
  ddd: "{weekday/3}",
  dd: "{day/2}",
  d: "{day}",
  HH: "{hour/2}",
  H: "{hour}",
  hh: "{hour/2/ap}",
  h: "{hour/ap}",
  mm: "{minute/2}",
  m: "{minute}",
  ss: "{second/2}",
  s: "{second}",
  tt: "{am/pm}",
};

const STRFTIME_TOKENS: Record<string, string> = {
  Y: "{year/4}",
  y: "{year/2}",
  m: "{month/2}",
  B: "{month/n}",
  b: "{month/n/3}",
  d: "{day/2}",
  e: "{day}",
  H: "{hour/2}",
  I: "{hour/2/ap}",
  M: "{minute/2}",
  S: "{second/2}",
  p: "{am/pm}",
  A: "{weekday}",
  a: "{weekday/3}",
};

export function mapNimTimeFormat(pattern: string, position = 0): string {
  if (pattern.includes("{")) {
    // Already chrono-style (the Nim side used chrono's format too).
    return pattern;
  }
  if (pattern.includes("%")) {
    return pattern.replace(/%(.)/g, (whole, letter: string) => {
      if (letter === "%") {
        return "%";
      }
      const token = STRFTIME_TOKENS[letter];
      if (!token) {
        throw new NimConvertError(`time format ${whole} has no format() token`, position);
      }
      return token;
    });
  }
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === "'") {
      const end = pattern.indexOf("'", i + 1);
      if (end < 0) {
        throw new NimConvertError("unterminated quote in time format", position);
      }
      out += pattern.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (/[a-zA-Z]/.test(ch)) {
      let j = i;
      while (j < pattern.length && pattern[j] === ch) {
        j += 1;
      }
      const run = pattern.slice(i, j);
      const token = NIM_TIME_TOKENS[run];
      if (!token) {
        throw new NimConvertError(`time format letters "${run}" have no format() token`, position);
      }
      out += token;
      i = j;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

// --- parser -----------------------------------------------------------------

class Parser {
  private index = 0;
  private readonly scope = new Map<string, Emitted>();

  constructor(
    private readonly tokens: Token[],
    private readonly options: NimExpressionOptions,
  ) {
    for (const arg of options.args ?? []) {
      const name = options.rename?.[arg.name] ?? arg.name;
      this.scope.set(arg.name, atom(name, kindForFieldType(arg.type)));
    }
  }

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.index + offset, this.tokens.length - 1)]!;
  }

  private next(): Token {
    const token = this.peek();
    if (token.kind !== "eof") {
      this.index += 1;
    }
    return token;
  }

  private isOp(text: string, offset = 0): boolean {
    const token = this.peek(offset);
    return token.kind === "op" && token.text === text;
  }

  private isKeyword(text: string, offset = 0): boolean {
    const token = this.peek(offset);
    return token.kind === "ident" && token.text === text;
  }

  private expectOp(text: string): Token {
    const token = this.next();
    if (token.kind !== "op" || token.text !== text) {
      throw new NimConvertError(`expected "${text}", got ${describe(token)}`, token.pos);
    }
    return token;
  }

  private fail(message: string, token: Token = this.peek()): never {
    throw new NimConvertError(message, token.pos);
  }

  /** Entry: `let`/`var` bindings followed by one expression, or one expression. */
  parseProgram(): Emitted {
    const bindings: string[] = [];
    while (this.isKeyword("let") || this.isKeyword("var")) {
      this.next();
      const nameToken = this.next();
      if (nameToken.kind !== "ident") {
        this.fail("expected a name after let/var", nameToken);
      }
      if (this.isOp(":")) {
        // Skip a type annotation: everything up to the `=`.
        this.next();
        while (!this.isOp("=") && this.peek().kind !== "eof") {
          this.next();
        }
      }
      this.expectOp("=");
      const value = this.parseExpression();
      const jsName = isJsIdent(nameToken.text) ? nameToken.text : `${nameToken.text}_`;
      bindings.push(`const ${jsName} = ${value.js};`);
      this.scope.set(nameToken.text, atom(jsName, value.kind, value.ts ? { ts: value.ts } : {}));
      if (this.isOp(";")) {
        this.next();
      }
    }
    const result = this.parseExpression();
    if (this.isOp(";")) {
      this.next();
    }
    const trailing = this.peek();
    if (trailing.kind !== "eof") {
      this.fail(`unexpected ${describe(trailing)} after the expression`, trailing);
    }
    if (bindings.length === 0) {
      return result;
    }
    return atom(`(() => {\n  ${bindings.join("\n  ")}\n  return ${result.js};\n})()`, result.kind);
  }

  parseExpression(): Emitted {
    if (this.isKeyword("if")) {
      return this.parseIf();
    }
    if (this.isKeyword("case")) {
      return this.parseCase();
    }
    return this.parseOr();
  }

  private parseIf(): Emitted {
    this.next();
    const condition = this.parseOr();
    this.expectOp(":");
    const then = this.parseExpression();
    if (this.isKeyword("elif")) {
      const rest = this.parseIf();
      return this.ternary(condition, then, rest);
    }
    if (!this.isKeyword("else")) {
      this.fail("an if-expression needs an else branch");
    }
    this.next();
    this.expectOp(":");
    const otherwise = this.parseExpression();
    return this.ternary(condition, then, otherwise);
  }

  private parseCase(): Emitted {
    this.next();
    const subject = this.parseOr();
    const arms: { test: Emitted; value: Emitted }[] = [];
    while (this.isKeyword("of")) {
      this.next();
      const values: Emitted[] = [this.parseOr()];
      while (this.isOp(",")) {
        this.next();
        values.push(this.parseOr());
      }
      this.expectOp(":");
      const value = this.parseExpression();
      const test = values
        .map((v) => `${wrap(subject, PREC_CMP + 1)} === ${wrap(v, PREC_CMP + 1)}`)
        .join(" || ");
      arms.push({ test: { js: test, kind: "boolean", prec: values.length > 1 ? PREC_OR : PREC_CMP }, value });
    }
    if (!this.isKeyword("else")) {
      this.fail("a case-expression needs an else branch");
    }
    this.next();
    this.expectOp(":");
    let result = this.parseExpression();
    for (const arm of arms.reverse()) {
      result = this.ternary(arm.test, arm.value, result);
    }
    return result;
  }

  private ternary(condition: Emitted, then: Emitted, otherwise: Emitted): Emitted {
    const kind = then.kind === otherwise.kind ? then.kind : "unknown";
    return {
      js: `${wrap(condition, PREC_TERNARY + 1)} ? ${wrap(then, PREC_TERNARY)} : ${wrap(otherwise, PREC_TERNARY)}`,
      kind,
      prec: PREC_TERNARY,
    };
  }

  private parseOr(): Emitted {
    let left = this.parseAnd();
    while (this.isKeyword("or") || this.isKeyword("xor")) {
      const op = this.next().text;
      const right = this.parseAnd();
      left =
        op === "or"
          ? { js: `${wrap(left, PREC_OR)} || ${wrap(right, PREC_OR + 1)}`, kind: "boolean", prec: PREC_OR }
          : { js: `${wrap(left, PREC_CMP + 1)} !== ${wrap(right, PREC_CMP + 1)}`, kind: "boolean", prec: PREC_CMP };
    }
    return left;
  }

  private parseAnd(): Emitted {
    let left = this.parseComparison();
    while (this.isKeyword("and")) {
      this.next();
      const right = this.parseComparison();
      left = { js: `${wrap(left, PREC_AND)} && ${wrap(right, PREC_AND + 1)}`, kind: "boolean", prec: PREC_AND };
    }
    return left;
  }

  private parseComparison(): Emitted {
    let left = this.parseConcat();
    for (;;) {
      const token = this.peek();
      let op: string | undefined;
      if (token.kind === "op" && ["==", "!=", "<", "<=", ">", ">="].includes(token.text)) {
        op = token.text;
      } else if (token.kind === "ident" && (token.text === "in" || token.text === "notin")) {
        op = token.text;
      } else {
        return left;
      }
      this.next();
      const right = this.parseConcat();
      if (op === "in" || op === "notin") {
        const js = `${wrap(right, PREC_POSTFIX)}.includes(${left.js})`;
        left = op === "in" ? { js, kind: "boolean", prec: PREC_POSTFIX } : { js: `!${js}`, kind: "boolean", prec: PREC_UNARY };
        continue;
      }
      const jsOp = op === "==" ? "===" : op === "!=" ? "!==" : op;
      left = {
        js: `${wrap(left, PREC_CMP + 1)} ${jsOp} ${wrap(right, PREC_CMP + 1)}`,
        kind: "boolean",
        prec: PREC_CMP,
      };
    }
  }

  private parseConcat(): Emitted {
    let left = this.parseAdd();
    while (this.isOp("&")) {
      this.next();
      const right = this.parseAdd();
      left = {
        js: `${wrap(asString(left), PREC_CONCAT)} + ${wrap(asString(right), PREC_ADD + 1)}`,
        kind: "string",
        prec: PREC_CONCAT,
      };
    }
    return left;
  }

  private parseAdd(): Emitted {
    let left = this.parseMul();
    while (this.isOp("+") || this.isOp("-")) {
      const op = this.next().text;
      const right = this.parseMul();
      left = {
        js: `${wrap(left, PREC_ADD)} ${op} ${wrap(right, PREC_ADD + 1)}`,
        kind: "number",
        prec: PREC_ADD,
      };
    }
    return left;
  }

  private parseMul(): Emitted {
    let left = this.parseUnary();
    for (;;) {
      let op: string | undefined;
      if (this.isOp("*") || this.isOp("/")) {
        op = this.next().text;
      } else if (this.isKeyword("mod")) {
        this.next();
        op = "%";
      } else if (this.isKeyword("div")) {
        this.next();
        const right = this.parseUnary();
        left = atom(`Math.trunc(${left.js} / ${wrap(right, PREC_MUL + 1)})`, "number");
        continue;
      } else {
        return left;
      }
      const right = this.parseUnary();
      left = {
        js: `${wrap(left, PREC_MUL)} ${op} ${wrap(right, PREC_MUL + 1)}`,
        kind: "number",
        prec: PREC_MUL,
      };
    }
  }

  private parseUnary(): Emitted {
    const token = this.peek();
    if (token.kind === "op" && token.text === "-") {
      this.next();
      const operand = this.parseUnary();
      return { js: `-${wrap(operand, PREC_UNARY)}`, kind: "number", prec: PREC_UNARY };
    }
    if (token.kind === "op" && token.text === "+") {
      this.next();
      return this.parseUnary();
    }
    if (token.kind === "ident" && token.text === "not") {
      this.next();
      const operand = this.parseUnary();
      return { js: `!${wrap(operand, PREC_UNARY)}`, kind: "boolean", prec: PREC_UNARY };
    }
    if (token.kind === "op" && token.text === "$") {
      this.next();
      return asString(this.parseUnary());
    }
    if (token.kind === "op" && (token.text === "%*" || token.text === "%")) {
      this.next();
      const operand = this.parseUnary();
      return { ...operand, kind: "json" };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Emitted {
    let e = this.parsePrimary();
    for (;;) {
      if (this.isOp("{")) {
        const open = this.next();
        const key = this.parseExpression();
        this.expectOp("}");
        e = this.jsonIndex(e, key, open);
        continue;
      }
      if (this.isOp("[")) {
        const open = this.next();
        if (this.isOp("^")) {
          this.fail("indexing from the end ([^1]) is not supported", open);
        }
        const key = this.parseExpression();
        this.expectOp("]");
        if (e.kind === "json") {
          e = this.jsonIndex(e, key, open);
        } else {
          e = { js: `${wrap(e, PREC_POSTFIX)}[${key.js}]`, kind: e.kind === "string" ? "string" : "unknown", prec: PREC_POSTFIX };
        }
        continue;
      }
      if (this.isOp(".")) {
        this.next();
        const nameToken = this.next();
        if (nameToken.kind !== "ident") {
          this.fail("expected a name after '.'", nameToken);
        }
        const args = this.isOp("(") ? this.parseArgs() : [];
        e = this.member(e, nameToken.text, args, nameToken);
        continue;
      }
      return e;
    }
  }

  private parseArgs(): Emitted[] {
    this.expectOp("(");
    const args: Emitted[] = [];
    if (this.isOp(")")) {
      this.next();
      return args;
    }
    for (;;) {
      args.push(this.parseExpression());
      if (this.isOp(",")) {
        this.next();
        continue;
      }
      this.expectOp(")");
      return args;
    }
  }

  private parsePrimary(): Emitted {
    const token = this.next();
    switch (token.kind) {
      case "num":
        return atom(token.text, "number");
      case "str":
        return atom(jsString(token.text), "string");
      case "op":
        if (token.text === "(") {
          const inner = this.parseExpression();
          this.expectOp(")");
          return { ...inner, js: `(${inner.js})`, prec: PREC_ATOM };
        }
        if (token.text === "@[" || token.text === "[") {
          const items: Emitted[] = [];
          if (!this.isOp("]")) {
            for (;;) {
              items.push(this.parseExpression());
              if (this.isOp(",")) {
                this.next();
                continue;
              }
              break;
            }
          }
          this.expectOp("]");
          return atom(`[${items.map((item) => item.js).join(", ")}]`, "array");
        }
        this.fail(`unexpected "${token.text}"`, token);
        break;
      case "ident":
        return this.identifier(token);
      case "eof":
        this.fail("unexpected end of expression", token);
    }
    this.fail(`unexpected ${describe(token)}`, token);
  }

  private identifier(token: Token): Emitted {
    const name = token.text;
    if (name === "true" || name === "false") {
      return atom(name, "boolean");
    }
    if (name === "nil") {
      return atom("null", "unknown");
    }
    if (KEYWORDS.has(name)) {
      this.fail(`unexpected keyword "${name}"`, token);
    }
    const bound = this.scope.get(name);
    if (bound) {
      return bound;
    }
    switch (name) {
      case "state":
        return atom("state", "json", { jsonRoot: true });
      case "scene":
      case "self":
        return atom(name, "scene");
      case "context":
        return atom("context", "context");
      case "ffDecimal":
      case "ffDefault":
      case "ffScientific":
        return atom(name, "ffmode");
      case "Pi":
      case "PI":
        return atom("Math.PI", "number");
      case "E":
        return atom("Math.E", "number");
      default:
        break;
    }
    if (this.isOp("(")) {
      const args = this.parseArgs();
      return this.call(name, args, token);
    }
    this.fail(`unknown identifier "${name}"`, token);
  }

  private jsonIndex(e: Emitted, key: Emitted, at: Token): Emitted {
    if (e.kind !== "json") {
      this.fail("only JSON values (scene state, context.payload) can be indexed with {…}", at);
    }
    const keyLiteral = literalString(key);
    let js: string;
    if (keyLiteral !== undefined && isJsIdent(keyLiteral)) {
      js = `${e.js}${e.jsonRoot ? "." : "?."}${keyLiteral}`;
    } else {
      js = `${e.js}${e.jsonRoot ? "" : "?."}[${key.js}]`;
    }
    return { js, kind: "json", prec: PREC_POSTFIX };
  }

  /** `recv.name(args)` — a JSON accessor, a datetime field, or UFCS for a builtin. */
  private member(recv: Emitted, name: string, args: Emitted[], at: Token): Emitted {
    if (recv.kind === "scene") {
      if (name === "state" && args.length === 0) {
        return atom("state", "json", { jsonRoot: true });
      }
      if (name === "scene" && args.length === 0) {
        return recv;
      }
      this.fail(`scene.${name} has no code-node equivalent`, at);
    }
    if (recv.kind === "context") {
      if (args.length > 0) {
        this.fail(`context.${name}() is not a thing`, at);
      }
      switch (name) {
        case "event":
        case "loopKey":
          return atom(`context.${name}`, "string");
        case "loopIndex":
          return atom("context.loopIndex", "number");
        case "hasImage":
          return atom("context.hasImage", "boolean");
        case "payload":
          return atom("context.payload", "json", { jsonRoot: true });
        case "image":
          return atom("context.image", "unknown");
        default:
          this.fail(`context.${name} has no code-node equivalent`, at);
      }
    }
    if (recv.js === "context.image" && args.length === 0 && (name === "width" || name === "height")) {
      return atom(name === "width" ? "context.imageWidth" : "context.imageHeight", "number");
    }
    if (recv.kind === "datetime") {
      return this.datetimeMember(recv, name, args, at);
    }
    if (recv.kind === "json") {
      const handled = this.jsonMember(recv, name, args, at);
      if (handled) {
        return handled;
      }
    }
    return this.call(name, [recv, ...args], at);
  }

  private jsonMember(recv: Emitted, name: string, args: Emitted[], at: Token): Emitted | undefined {
    const fallback = (defaultValue: string) => (args[0] ? args[0].js : defaultValue);
    switch (name) {
      case "getStr":
        return atom(`String${coalesce(recv, fallback('""'))}`, "string");
      case "getInt":
      case "getBiggestInt":
        return atom(`Math.trunc(Number${coalesce(recv, fallback("0"))})`, "number");
      case "getFloat":
        return atom(`Number${coalesce(recv, fallback("0"))}`, "number");
      case "getBool":
        return atom(`Boolean${coalesce(recv, fallback("false"))}`, "boolean");
      case "getElems":
        return { js: coalesce(recv, fallback("[]")), kind: "array", prec: PREC_ATOM };
      case "getFields":
        return { js: coalesce(recv, fallback("{}")), kind: "json", prec: PREC_ATOM };
      case "isNil":
        return { js: `${wrap(recv, PREC_CMP + 1)} == null`, kind: "boolean", prec: PREC_CMP };
      case "hasKey": {
        if (args.length !== 1) {
          this.fail("hasKey takes one key", at);
        }
        return { js: `${coalesce(recv, "{}")}[${args[0]!.js}] !== undefined`, kind: "boolean", prec: PREC_CMP };
      }
      case "len":
        return atom(`${coalesce(recv, "[]")}.length`, "number");
      case "kind":
      case "pretty":
      case "get":
        this.fail(`.${name} on a JSON value has no code-node equivalent`, at);
        break;
      default:
        return undefined;
    }
  }

  private datetimeMember(recv: Emitted, name: string, args: Emitted[], at: Token): Emitted {
    const ts = recv.ts ?? "now()";
    switch (name) {
      case "format": {
        const pattern = args[0] ? literalString(args[0]) : undefined;
        if (pattern === undefined) {
          this.fail("format() needs a literal pattern string", at);
        }
        return atom(`format(${ts}, ${jsString(mapNimTimeFormat(pattern, at.pos))})`, "string");
      }
      case "toTime":
      case "utc":
      case "local":
      case "inZone":
        return { ...recv, ts };
      case "toUnix":
      case "toUnixFloat":
        return atom(ts, "number");
      case "hour":
      case "minute":
      case "second":
      case "year":
        return atom(`Number(format(${ts}, ${jsString(`{${name}}`)}))`, "number");
      case "monthday":
        return atom(`Number(format(${ts}, "{day}"))`, "number");
      default:
        this.fail(`.${name} on a date/time has no code-node equivalent`, at);
    }
  }

  private call(name: string, args: Emitted[], at: Token): Emitted {
    const arity = (min: number, max = min) => {
      if (args.length < min || args.length > max) {
        this.fail(`${name}() takes ${min === max ? min : `${min}–${max}`} argument(s), got ${args.length}`, at);
      }
    };
    const recv = () => args[0]!;
    const str = () => wrap(asString(recv()), PREC_POSTFIX);
    switch (name) {
      case "len":
        arity(1);
        return recv().kind === "json"
          ? atom(`${coalesce(recv(), "[]")}.length`, "number")
          : atom(`${wrap(recv(), PREC_POSTFIX)}.length`, "number");
      case "strip":
        arity(1);
        return atom(`${str()}.trim()`, "string");
      case "toLowerAscii":
      case "toLower":
        arity(1);
        return atom(`${str()}.toLowerCase()`, "string");
      case "toUpperAscii":
      case "toUpper":
        arity(1);
        return atom(`${str()}.toUpperCase()`, "string");
      case "capitalizeAscii":
        arity(1);
        return atom(`(${str()}.charAt(0).toUpperCase() + ${str()}.slice(1))`, "string");
      case "isEmptyOrWhitespace":
        arity(1);
        return { js: `${str()}.trim() === ""`, kind: "boolean", prec: PREC_CMP };
      case "split":
        arity(2);
        return atom(`${str()}.split(${args[1]!.js})`, "array");
      case "join":
        arity(1, 2);
        return atom(`${wrap(recv(), PREC_POSTFIX)}.join(${args[1] ? args[1].js : '""'})`, "string");
      case "contains":
        arity(2);
        return atom(`${wrap(recv(), PREC_POSTFIX)}.includes(${args[1]!.js})`, "boolean");
      case "startsWith":
      case "endsWith":
        arity(2);
        return atom(`${str()}.${name}(${args[1]!.js})`, "boolean");
      case "replace":
        arity(3);
        return atom(`${str()}.split(${args[1]!.js}).join(${args[2]!.js})`, "string");
      case "repeat":
        arity(2);
        return atom(`${str()}.repeat(${args[1]!.js})`, "string");
      case "alignLeft":
        arity(2, 3);
        return atom(`${str()}.padEnd(${args[1]!.js}${args[2] ? `, ${args[2].js}` : ""})`, "string");
      case "align":
        arity(2, 3);
        return atom(`${str()}.padStart(${args[1]!.js}${args[2] ? `, ${args[2].js}` : ""})`, "string");
      case "parseInt":
        arity(1);
        return atom(`parseInt(${recv().js}, 10)`, "number");
      case "parseFloat":
        arity(1);
        return atom(`parseFloat(${recv().js})`, "number");
      case "int":
      case "toInt":
        arity(1);
        return atom(`Math.trunc(${asNumber(recv())})`, "number");
      case "float":
      case "toFloat":
        arity(1);
        return atom(asNumber(recv()), "number");
      case "abs":
      case "round":
      case "floor":
      case "ceil":
      case "sqrt":
        arity(1);
        return atom(`Math.${name}(${asNumber(recv())})`, "number");
      case "min":
      case "max":
      case "pow":
        arity(2);
        return atom(`Math.${name}(${asNumber(args[0]!)}, ${asNumber(args[1]!)})`, "number");
      case "formatFloat": {
        arity(1, 3);
        const mode = args[1];
        const precision = args[2];
        if (mode && mode.js !== "ffDecimal") {
          this.fail(`formatFloat with ${mode.js} has no toFixed() equivalent`, at);
        }
        if (!precision) {
          return atom(`String(${asNumber(recv())})`, "string");
        }
        return atom(`${asNumber(recv())}.toFixed(${precision.js})`, "string");
      }
      case "epochTime":
        arity(0);
        return atom("now()", "number");
      case "now":
      case "getTime":
        arity(0);
        return atom("now()", "datetime", { ts: "now()" });
      case "fromUnix":
      case "fromUnixFloat":
      case "Timestamp":
        arity(1);
        return atom(recv().js, "datetime", { ts: recv().js });
      case "toUnix":
      case "toUnixFloat":
        arity(1);
        return atom(recv().ts ?? recv().js, "number");
      case "format": {
        arity(2);
        if (recv().kind !== "datetime" && recv().kind !== "number") {
          this.fail("format() needs a time on the left", at);
        }
        return this.datetimeMember({ ...recv(), ts: recv().ts ?? recv().js }, "format", [args[1]!], at);
      }
      case "newJString":
      case "newJInt":
      case "newJFloat":
      case "newJBool":
        arity(1);
        return { ...recv(), kind: "json" };
      case "parseJson":
        arity(1);
        return atom(`JSON.parse(${recv().js})`, "json");
      case "hasKey":
      case "getStr":
      case "getInt":
      case "getFloat":
      case "getBool":
      case "getElems":
      case "getFields":
      case "isNil": {
        const handled = this.jsonMember({ ...recv(), kind: "json" }, name, args.slice(1), at);
        if (handled) {
          return handled;
        }
        break;
      }
      default:
        break;
    }
    this.fail(`${name}() has no code-node equivalent`, at);
  }
}

function literalString(e: Emitted): string | undefined {
  if (e.kind !== "string" || !e.js.startsWith('"')) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(e.js);
    return typeof parsed === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function describe(token: Token): string {
  switch (token.kind) {
    case "eof":
      return "end of expression";
    case "str":
      return `string ${JSON.stringify(token.text)}`;
    default:
      return `"${token.text}"`;
  }
}

/**
 * Translate one Nim code-node expression to a JavaScript expression.
 * Throws NimConvertError when the expression leaves the supported grammar.
 */
export function nimExpressionToJs(source: string, options: NimExpressionOptions = {}): string {
  const trimmed = source.trim();
  if (!trimmed) {
    throw new NimConvertError("empty expression", 0);
  }
  const parser = new Parser(tokenize(trimmed), options);
  return parser.parseProgram().js;
}

/** The identifiers an expression references, for deciding which inbound edges matter. */
export function nimIdentifiers(source: string): Set<string> {
  const names = new Set<string>();
  try {
    for (const token of tokenize(source)) {
      if (token.kind === "ident" && !KEYWORDS.has(token.text)) {
        names.add(token.text);
      }
    }
  } catch {
    // Unlexable source references nothing we can name; the model gets it.
    for (const match of source.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
      names.add(match[0]);
    }
  }
  return names;
}
