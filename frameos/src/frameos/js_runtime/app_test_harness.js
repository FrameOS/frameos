// The test harness for JavaScript apps (docs/js-apps-and-code-nodes.md,
// "Testing an app"). Evaluated by app_tests.nim after the app prelude and
// before the test module, in the same QuickJS context the app runs in, so a
// test exercises the app with the real `frameos` object around it.
//
// Globals a test file gets: describe, it / test (with .skip), beforeEach,
// afterEach, beforeAll, afterAll, expect, mock, makeApp, makeContext, useApp.
// Everything that would leave the interpreter (HTTP, images, assets,
// streams, settings) throws until the test mocks it, so a test never touches
// the network by accident; state, memory and the next sleep land on the app
// object makeApp returns. __frameosRunAppTests() runs what the module
// registered and returns the report as JSON.
"use strict";
(() => {
  const real = {};
  for (const key of Object.keys(frameos)) real[key] = frameos[key];

  const appConfig = (() => {
    try {
      const parsed = JSON.parse(globalThis.__frameosTestAppConfig || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (e) {
      return {};
    }
  })();

  // ------------------------------------------------------------ the tree
  const root = { kind: "suite", name: "", children: [], before: [], after: [], beforeAll: [], afterAll: [], skip: false };
  let defining = root;
  let running = null; // the test whose logs are being collected
  let currentApp = null;

  function suite(name, fn, skip) {
    const node = { kind: "suite", name: String(name), children: [], before: [], after: [], beforeAll: [], afterAll: [], skip: Boolean(skip) };
    defining.children.push(node);
    const parent = defining;
    defining = node;
    try {
      fn();
    } finally {
      defining = parent;
    }
  }
  function test(name, fn, skip) {
    defining.children.push({ kind: "test", name: String(name), fn, skip: Boolean(skip) || typeof fn !== "function" });
  }
  const describe = (name, fn) => suite(name, fn, false);
  describe.skip = (name, fn) => suite(name, fn, true);
  describe.only = describe;
  const it = (name, fn) => test(name, fn, false);
  it.skip = (name, fn) => test(name, fn, true);
  it.only = it;
  it.todo = (name) => test(name, undefined, true);

  // ------------------------------------------------------------ expect
  class AssertionError extends Error {
    constructor(message, expected, received) {
      super(message);
      this.name = "AssertionError";
      this.expected = expected;
      this.received = received;
    }
  }
  const show = (v) => {
    if (typeof v === "string") return JSON.stringify(v);
    if (typeof v === "function") return "[function " + (v.name || "anonymous") + "]";
    if (typeof v === "undefined") return "undefined";
    if (typeof v === "bigint") return v.toString() + "n";
    try {
      const text = JSON.stringify(v);
      return text === undefined ? String(v) : text.length > 400 ? text.slice(0, 400) + "…" : text;
    } catch (e) {
      return String(v);
    }
  };
  function deepEqual(a, b) {
    if (Object.is(a, b)) return true;
    if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
      return true;
    }
    const keysA = Object.keys(a).filter((k) => a[k] !== undefined);
    const keysB = Object.keys(b).filter((k) => b[k] !== undefined);
    if (keysA.length !== keysB.length) return false;
    for (const key of keysA) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
      if (!deepEqual(a[key], b[key])) return false;
    }
    return true;
  }
  function matchesObject(received, expected) {
    if (expected === null || typeof expected !== "object") return deepEqual(received, expected);
    if (received === null || typeof received !== "object") return false;
    if (Array.isArray(expected)) {
      if (!Array.isArray(received) || received.length !== expected.length) return false;
      return expected.every((item, i) => matchesObject(received[i], item));
    }
    return Object.keys(expected).every((key) => matchesObject(received[key], expected[key]));
  }
  function expect(received) {
    const make = (negate) => {
      const check = (pass, verb, expected, extra) => {
        if (pass === negate) {
          const not = negate ? "not " : "";
          const message =
            "expected " + show(received) + " " + not + verb + (expected === undefined ? "" : " " + show(expected)) + (extra || "");
          throw new AssertionError(message, expected, received);
        }
      };
      const matchers = {
        toBe: (expected) => check(Object.is(received, expected), "to be", expected),
        toEqual: (expected) => check(deepEqual(received, expected), "to equal", expected),
        toStrictEqual: (expected) => check(deepEqual(received, expected), "to equal", expected),
        toMatchObject: (expected) => check(matchesObject(received, expected), "to match", expected),
        toBeTruthy: () => check(Boolean(received), "to be truthy"),
        toBeFalsy: () => check(!received, "to be falsy"),
        toBeNull: () => check(received === null, "to be null"),
        toBeUndefined: () => check(received === undefined, "to be undefined"),
        toBeDefined: () => check(received !== undefined, "to be defined"),
        toBeNaN: () => check(Number.isNaN(received), "to be NaN"),
        toBeGreaterThan: (n) => check(received > n, "to be greater than", n),
        toBeGreaterThanOrEqual: (n) => check(received >= n, "to be at least", n),
        toBeLessThan: (n) => check(received < n, "to be less than", n),
        toBeLessThanOrEqual: (n) => check(received <= n, "to be at most", n),
        toBeCloseTo: (n, digits) => {
          const d = digits === undefined ? 2 : digits;
          check(Math.abs(received - n) < Math.pow(10, -d) / 2, "to be close to", n);
        },
        toHaveLength: (n) => check(received != null && received.length === n, "to have length", n, " (got " + (received == null ? "nothing" : received.length) + ")"),
        toContain: (item) =>
          check(
            typeof received === "string" ? received.includes(String(item)) : Array.isArray(received) && received.some((x) => Object.is(x, item)),
            "to contain",
            item,
          ),
        toContainEqual: (item) => check(Array.isArray(received) && received.some((x) => deepEqual(x, item)), "to contain", item),
        toHaveProperty: (path, value) => {
          const parts = String(path).split(".");
          let at = received;
          let found = true;
          for (const part of parts) {
            if (at === null || at === undefined || !(part in Object(at))) {
              found = false;
              break;
            }
            at = at[part];
          }
          check(found && (value === undefined || deepEqual(at, value)), "to have property", path);
        },
        toMatch: (pattern) =>
          check(
            typeof received === "string" && (pattern instanceof RegExp ? pattern.test(received) : received.includes(String(pattern))),
            "to match",
            pattern instanceof RegExp ? String(pattern) : pattern,
          ),
        toBeInstanceOf: (cls) => check(received instanceof cls, "to be an instance of", cls && cls.name),
        toThrow: (expected) => {
          if (typeof received !== "function") throw new AssertionError("expect(...).toThrow needs a function", undefined, received);
          let thrown = null;
          try {
            received();
          } catch (e) {
            thrown = e === undefined ? new Error("undefined") : e;
          }
          if (thrown === null) {
            check(false, "to throw", expected);
            return;
          }
          const message = thrown && thrown.message !== undefined ? String(thrown.message) : String(thrown);
          const ok =
            expected === undefined
              ? true
              : expected instanceof RegExp
                ? expected.test(message)
                : typeof expected === "string"
                  ? message.includes(expected)
                  : typeof expected === "function"
                    ? thrown instanceof expected
                    : false;
          check(ok, "to throw", expected instanceof RegExp ? String(expected) : expected, " (threw " + show(message) + ")");
        },
        toHaveBeenCalled: () => check(isMockFn(received) && received.calls.length > 0, "to have been called"),
        toHaveBeenCalledTimes: (n) => check(isMockFn(received) && received.calls.length === n, "to have been called times", n, isMockFn(received) ? " (called " + received.calls.length + ")" : ""),
        toHaveBeenCalledWith: (...args) => check(isMockFn(received) && received.calls.some((call) => deepEqual(call, args)), "to have been called with", args),
        toHaveBeenLastCalledWith: (...args) =>
          check(isMockFn(received) && received.calls.length > 0 && deepEqual(received.calls[received.calls.length - 1], args), "to have been last called with", args),
      };
      return matchers;
    };
    const positive = make(false);
    positive.not = make(true);
    return positive;
  }

  // ------------------------------------------------------------ mocks
  const isMockFn = (f) => typeof f === "function" && Array.isArray(f.calls);
  function mockFn(impl) {
    let implementation = impl;
    const f = function (...args) {
      f.calls.push(args);
      const result = typeof implementation === "function" ? implementation.apply(this, args) : implementation;
      f.results.push(result);
      return result;
    };
    f.calls = [];
    f.results = [];
    f.mockImplementation = (next) => {
      implementation = next;
      return f;
    };
    f.mockReturnValue = (value) => {
      implementation = () => value;
      return f;
    };
    f.mockReset = () => {
      f.calls.length = 0;
      f.results.length = 0;
      return f;
    };
    return f;
  }

  const notMocked = (name) => () => {
    throw new Error("frameos." + name + " is not mocked in this test: call mock." + name + "(impl) first");
  };
  const pureNames = ["image", "svg", "node", "scene", "color"];
  const logs = [];
  const record = (level) => (...args) => {
    const text = args.map((a) => (typeof a === "string" ? a : show(a))).join(" ");
    if (running) running.logs.push({ level, text });
    else logs.push({ level, text });
  };

  function defaults() {
    const app = () => currentApp || (currentApp = makeApp());
    return {
      log: record("log"),
      error: record("error"),
      setNextSleep: (seconds) => {
        app().nextSleep = Number(seconds || 0);
      },
      setState: (key, value) => {
        app().state[String(key || "")] = value === undefined ? null : JSON.parse(JSON.stringify(value));
      },
      remember: (key, value) => {
        if (value === undefined || value === null) app().memory.delete(String(key));
        else app().memory.set(String(key), JSON.stringify(value));
        return true;
      },
      recall: (key) => {
        const kept = app().memory.get(String(key));
        return kept === undefined ? undefined : JSON.parse(kept);
      },
      getSetting: (...path) => {
        let at = app().settings;
        for (const part of path.flat()) {
          if (at === null || typeof at !== "object") return undefined;
          at = at[String(part)];
        }
        return at;
      },
      fetchText: (url) => {
        const reply = frameos.httpRequest(String(url || ""), { method: "GET" });
        if (!reply || reply.status < 200 || reply.status >= 300) {
          throw new Error("fetchText " + String(url) + ": HTTP " + (reply ? reply.status : "none"));
        }
        return reply.body === undefined ? "" : String(reply.body);
      },
      fetchJson: (url) => JSON.parse(frameos.fetchText(url) || "null"),
    };
  }

  function installDefaults() {
    const d = defaults();
    for (const key of Object.keys(real)) {
      if (pureNames.includes(key)) frameos[key] = real[key];
      else if (key in d) frameos[key] = d[key];
      else frameos[key] = notMocked(key);
    }
    for (const level of ["log", "info", "debug"]) console[level] = record("log");
    console.warn = record("warn");
    console.error = record("error");
  }

  const mock = {
    fn: mockFn,
    frameos: (name, impl) => {
      if (!(name in real)) throw new Error("frameos." + String(name) + " does not exist");
      const f = isMockFn(impl) ? impl : mockFn(impl);
      frameos[name] = f;
      return f;
    },
    restore: installDefaults,
    /** A `{status, body}` reply for mock.httpRequest; `body` an object is sent as JSON. */
    response: (status, body, extra) => ({
      status,
      body: body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body),
      ...(extra || {}),
    }),
    json: (body, status) => ({ status: status === undefined ? 200 : status, body: JSON.stringify(body) }),
    /** A `frameos.fetchImage` reply: an image reference the app can return. */
    image: (spec) => {
      const width = (spec && spec.width) || 100;
      const height = (spec && spec.height) || 100;
      return { image: { __frameosType: "image", width, height, ...(spec && spec.image ? spec.image : {}) }, width, height, ...(spec || {}) };
    },
  };
  for (const key of Object.keys(real)) {
    if (!(key in mock)) mock[key] = (impl) => mock.frameos(key, impl);
  }

  // ------------------------------------------------------------ the app
  // config.json's values are text ("false", "3"); the runtime types them by
  // the field's type before the app sees them, and so does this.
  const fieldTypes = {};
  for (const field of Array.isArray(appConfig.fields) ? appConfig.fields : []) {
    if (field && typeof field === "object" && field.name) fieldTypes[field.name] = String(field.type || "");
  }
  function typedValue(name, value) {
    const type = fieldTypes[name];
    if (value === undefined || value === null) return value;
    if (type === "boolean") return value === true || String(value).trim().toLowerCase() === "true";
    if (type === "integer" || type === "float") {
      if (typeof value === "number") return value;
      const n = Number(String(value).trim());
      return String(value).trim() !== "" && Number.isFinite(n) ? n : value;
    }
    if (type === "json" && typeof value === "string") {
      try {
        return JSON.parse(value);
      } catch (e) {
        return value;
      }
    }
    return value;
  }
  function typedConfig(values) {
    const config = {};
    for (const [name, value] of Object.entries(values || {})) config[name] = typedValue(name, value);
    return config;
  }
  function fieldDefaults() {
    const config = {};
    for (const field of Array.isArray(appConfig.fields) ? appConfig.fields : []) {
      if (field && typeof field === "object" && field.name && field.value !== undefined) config[field.name] = field.value;
    }
    return config;
  }
  function makeApp(options) {
    const given = options || {};
    const app = {
      nodeId: given.nodeId === undefined ? 1 : given.nodeId,
      nodeName: given.nodeName === undefined ? String(appConfig.name || "app") : given.nodeName,
      category: String(appConfig.category || given.category || "data"),
      config: typedConfig({ ...fieldDefaults(), ...(given.config || {}) }),
      state: { ...(given.state || {}) },
      frame: {
        width: 800,
        height: 480,
        rotate: 0,
        assetsPath: "/srv/assets",
        timeZone: "UTC",
        debug: false,
        embedded: false,
        ...(given.frame || {}),
      },
      settings: given.settings || {},
      memory: new Map(),
      nextSleep: null,
      log: (...args) => frameos.log(...args),
      logError: (...args) => frameos.error(...args),
    };
    currentApp = app;
    return app;
  }
  const useApp = (app) => {
    currentApp = app;
    return app;
  };
  // A render context. It carries the canvas the runtime would hand the app: the
  // frame's size, turned with it (a render always has one). Give imageWidth /
  // imageHeight for a cell, or hasImage: false for a run that has no canvas.
  const makeContext = (context) => {
    const given = context || {};
    const base = { event: "render", payload: {}, hasImage: true };
    if (given.hasImage !== false && !("imageWidth" in given)) {
      const f = (currentApp || makeApp()).frame;
      const turned = f.rotate === 90 || f.rotate === 270;
      base.imageWidth = turned ? f.height : f.width;
      base.imageHeight = turned ? f.width : f.height;
    }
    return { ...base, ...given };
  };

  // ------------------------------------------------------------ running
  const now = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
  function errorInfo(error) {
    if (error && typeof error === "object") {
      return {
        message: error.message !== undefined ? String(error.message) : String(error),
        stack: typeof error.stack === "string" ? error.stack : "",
        expected: error instanceof AssertionError ? show(error.expected) : undefined,
        received: error instanceof AssertionError ? show(error.received) : undefined,
      };
    }
    return { message: String(error), stack: "" };
  }
  function hooks(chain, key) {
    const list = [];
    for (const node of chain) list.push(...node[key]);
    return list;
  }
  function runTest(node, chain, counts) {
    const result = { kind: "test", name: node.name, status: "passed", durationMs: 0, logs: [] };
    if (node.skip || chain.some((s) => s.skip)) {
      result.status = "skipped";
      counts.skipped += 1;
      return result;
    }
    const started = now();
    running = result;
    currentApp = null;
    installDefaults();
    try {
      for (const hook of hooks(chain, "before")) hook();
      node.fn();
      for (const hook of hooks(chain, "after").reverse()) hook();
      counts.passed += 1;
    } catch (error) {
      result.status = "failed";
      result.error = errorInfo(error);
      counts.failed += 1;
    } finally {
      running = null;
      installDefaults();
      result.durationMs = Math.round((now() - started) * 100) / 100;
    }
    return result;
  }
  function runSuite(node, chain, counts) {
    const result = { kind: "suite", name: node.name, status: "passed", children: [] };
    const here = [...chain, node];
    try {
      for (const hook of node.beforeAll) hook();
    } catch (error) {
      result.status = "failed";
      result.error = errorInfo(error);
      for (const child of node.children) if (child.kind === "test") counts.failed += 1;
      return result;
    }
    for (const child of node.children) {
      const childResult = child.kind === "suite" ? runSuite(child, here, counts) : runTest(child, here, counts);
      result.children.push(childResult);
      if (childResult.status === "failed") result.status = "failed";
    }
    try {
      for (const hook of node.afterAll.slice().reverse()) hook();
    } catch (error) {
      result.status = "failed";
      result.error = errorInfo(error);
    }
    if (result.status === "passed" && result.children.length > 0 && result.children.every((c) => c.status === "skipped")) {
      result.status = "skipped";
    }
    return result;
  }

  globalThis.__frameosRunAppTests = () => {
    const counts = { passed: 0, failed: 0, skipped: 0, total: 0 };
    const started = now();
    const tree = runSuite(root, [], counts);
    counts.total = counts.passed + counts.failed + counts.skipped;
    return JSON.stringify({
      ok: counts.failed === 0,
      counts,
      durationMs: Math.round((now() - started) * 100) / 100,
      children: tree.children,
      logs,
    });
  };

  Object.assign(globalThis, {
    describe,
    it,
    test: it,
    beforeEach: (fn) => defining.before.push(fn),
    afterEach: (fn) => defining.after.push(fn),
    beforeAll: (fn) => defining.beforeAll.push(fn),
    afterAll: (fn) => defining.afterAll.push(fn),
    expect,
    mock,
    makeApp,
    makeContext,
    useApp,
  });
  installDefaults();
})();
