import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

// Headless "Realign nodes" for FrameOS scenes, used by the AI evals and the
// scene builder.
//
// AI-generated scenes carry no node positions. The editor lays a scene out
// itself (diagramLogic's arrangeSceneGraph) but only once reactflow has
// measured the rendered nodes — so a real browser is needed. This drives the
// new-scene page of the cloud app (/my-scenes/new, which exposes
// window.__frameosEditor for exactly this; see
// src/components/NewSceneWithAi.tsx) in a headless Chromium: load the scenes,
// wait until the selected scene's nodes are measured, press the editor's own
// "Realign nodes" button, wait until the editor reports the arranged
// positions, take those positions and nothing else.
//
// The button is pressed explicitly rather than relying on the editor's
// auto-arrange-on-load: that one fires from inside the nodesChanged listener
// and its stale `nodes` snapshot writes the sentinel positions straight back
// over the arranged ones (observed headlessly; cache.hasAutoArranged then
// blocks a retry). The button path has no such race.
//
// One Chromium is reused across many realign() calls; every call gets a
// fresh page, so no editor state leaks between scene sets.
//
// This file is imported by plain Node (tsx) as well as vitest: keep it free of
// Next imports.

export const DEFAULT_CLOUD_URL = "http://localhost:3000";
export const DEFAULT_ARRANGE_TIMEOUT_MS = 20_000;
export const DEFAULT_SETTLE_MS = 500;
const PAGE_READY_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 100;
// After pressing Realign, a report (debounced 150ms in the editor) that never
// comes within this long means the layout did not change.
const NO_REPORT_MS = 2_000;
const REALIGN_PAGE_PATH = "/my-scenes/new?realign=1";
const REALIGN_BUTTON = 'button[title="Realign nodes"]';
const SENTINEL = -9999;

export type HeadlessRealignerLaunchOptions = {
  /** Origin of the cloud dev server; defaults to http://localhost:3000. */
  cloudUrl?: string;
  email: string;
  password: string;
  headless?: boolean;
};

export type RealignOptions = {
  /** Receives one line per scene the editor did not arrange in time. */
  log?: (line: string) => void;
  /** Give up waiting for one scene's arrangement after this long; the scene
   * then keeps whatever positions the editor reported (or its own). */
  timeoutMs?: number;
  /** The editor's onScenesChanged must stay quiet this long before a scene
   * counts as arranged. */
  settleMs?: number;
};

export type SessionCookie = { name: string; value: string };

type JsonObject = Record<string, unknown>;
type Position = { x: number; y: number };

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

function nodesOf(scene: unknown): JsonObject[] {
  const record = asObject(scene);
  return Array.isArray(record?.nodes)
    ? record.nodes.map(asObject).filter((node): node is JsonObject => node !== null)
    : [];
}

function sceneIdOf(scene: unknown): string | null {
  const id = asObject(scene)?.id;
  return typeof id === "string" && id ? id : null;
}

/** The node's position when it is a real, placed one — not missing, not
 * the editor's "not placed yet" sentinel. */
export function realPosition(node: unknown): Position | null {
  const position = asObject(asObject(node)?.position);
  if (!position) {
    return null;
  }
  const { x, y } = position;
  if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }
  if (x === SENTINEL && y === SENTINEL) {
    return null;
  }
  return { x, y };
}

/**
 * True when the editor still has layout work to do on this scene: a node
 * without a real position, every node stacked on the same point (the
 * "everything at 0,0" default), or the autoArrangeOnLoad marker still set.
 * An empty scene has nothing to arrange.
 */
export function needsRealign(scene: unknown): boolean {
  const record = asObject(scene);
  if (!record) {
    return false;
  }
  if (asObject(record.settings)?.autoArrangeOnLoad) {
    return true;
  }
  const nodes = nodesOf(record);
  if (nodes.length === 0) {
    return false;
  }
  const positions = nodes.map(realPosition);
  if (positions.some((position) => position === null)) {
    return true;
  }
  if (nodes.length > 1) {
    const first = positions[0]!;
    if (positions.every((position) => position!.x === first.x && position!.y === first.y)) {
      return true;
    }
  }
  return false;
}

function withoutMarker(settings: unknown): JsonObject | undefined {
  const record = asObject(settings);
  if (!record) {
    return undefined;
  }
  if (!("autoArrangeOnLoad" in record)) {
    return record;
  }
  const { autoArrangeOnLoad: _marker, ...rest } = record;
  return rest;
}

/**
 * Copies the arranged positions onto the original scenes: node ids, data,
 * edges and everything else stay exactly as given; only `position` changes
 * (where the editor reported a real one) and the autoArrangeOnLoad marker
 * goes. Scenes or nodes the editor did not report keep their own positions.
 *
 * Throws when the editor reported a scene with fewer nodes than it was given
 * — nodes must never go missing through a layout pass.
 */
export function mergePositions(original: unknown[], arranged: unknown[] | null): unknown[] {
  const arrangedById = new Map<string, JsonObject>();
  for (const scene of arranged ?? []) {
    const id = sceneIdOf(scene);
    if (id) {
      arrangedById.set(id, asObject(scene)!);
    }
  }
  return original.map((scene) => {
    const record = asObject(scene);
    if (!record) {
      return scene;
    }
    const id = sceneIdOf(record);
    const counterpart = id ? arrangedById.get(id) : undefined;
    const originalNodes = nodesOf(record);
    const arrangedNodes = counterpart ? nodesOf(counterpart) : [];
    if (counterpart && arrangedNodes.length < originalNodes.length) {
      throw new Error(
        `realign: scene ${id} came back with ${arrangedNodes.length} nodes, expected ${originalNodes.length}`,
      );
    }
    const positionByNodeId = new Map<string, Position>();
    for (const node of arrangedNodes) {
      const position = realPosition(node);
      if (typeof node.id === "string" && position) {
        positionByNodeId.set(node.id, position);
      }
    }
    const nodes = Array.isArray(record.nodes)
      ? record.nodes.map((node) => {
          const entry = asObject(node);
          if (!entry || typeof entry.id !== "string") {
            return node;
          }
          const position = positionByNodeId.get(entry.id);
          return position ? { ...entry, position: { x: position.x, y: position.y } } : node;
        })
      : record.nodes;
    const settings = withoutMarker(record.settings);
    const next: JsonObject = { ...record, nodes };
    if ("settings" in record) {
      if (settings && Object.keys(settings).length > 0) {
        next.settings = settings;
      } else if (asObject(record.settings)?.autoArrangeOnLoad) {
        delete next.settings;
      }
    }
    return next;
  });
}

/**
 * Signs in with the password provider and returns the session cookie. The
 * login route wants the request's origin to match the app (CSRF), so the
 * cloud URL doubles as the Origin header.
 */
export async function loginSessionCookie(opts: {
  cloudUrl: string;
  email: string;
  password: string;
}): Promise<SessionCookie> {
  const response = await fetch(`${opts.cloudUrl}/api/auth/login`, {
    body: JSON.stringify({ email: opts.email, password: opts.password }),
    headers: { "content-type": "application/json", origin: opts.cloudUrl },
    method: "POST",
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`login failed: HTTP ${response.status} ${body.slice(0, 200)}`);
  }
  const cookies = response.headers.getSetCookie();
  for (const cookie of cookies) {
    const [pair] = cookie.split(";");
    const eq = pair?.indexOf("=") ?? -1;
    if (pair && eq > 0) {
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (name.includes("session") && !name.includes("pending") && value) {
        return { name, value };
      }
    }
  }
  throw new Error(
    "login returned no session cookie (is two-factor sign-in enabled on this account?)",
  );
}

// What src/components/NewSceneWithAi.tsx puts on the window; declared here
// too so this file stays typed without the client component's global.
type EditorHook = {
  load: (scenes: unknown[], sceneId?: string) => void;
  select: (sceneId: string) => void;
  scenes: () => unknown[] | null;
  version: number;
};
type HookWindow = { __frameosEditor?: EditorHook };

type InPageSnapshot = {
  ready: boolean;
  version: number;
  found: boolean;
  nodeCount: number;
  arranged: boolean;
};

export class HeadlessRealigner {
  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    readonly cloudUrl: string,
    readonly sessionCookie: SessionCookie,
  ) {}

  /** The cookie header for authenticated requests to the same cloud URL. */
  get cookieHeader(): string {
    return `${this.sessionCookie.name}=${this.sessionCookie.value}`;
  }

  static async launch(opts: HeadlessRealignerLaunchOptions): Promise<HeadlessRealigner> {
    const cloudUrl = (opts.cloudUrl ?? DEFAULT_CLOUD_URL).replace(/\/+$/, "");
    const sessionCookie = await loginSessionCookie({
      cloudUrl,
      email: opts.email,
      password: opts.password,
    });
    const browser = await chromium.launch({ headless: opts.headless ?? true });
    const context = await browser.newContext({ viewport: { height: 1200, width: 1800 } });
    await context.addCookies([{ name: sessionCookie.name, url: cloudUrl, value: sessionCookie.value }]);
    // tsx (esbuild with keepNames) rewrites inner closures into
    // `__name(fn, "fn")` calls, and Playwright serialises that source
    // verbatim into the page, where no `__name` exists. Give every page an
    // identity helper first. Kept as a string so esbuild leaves it alone.
    await context.addInitScript(
      "globalThis.__name = globalThis.__name || ((target) => target);",
    );
    // The page carries the site's analytics; layout passes are not visits.
    await context.route(/https?:\/\/[^/]*posthog\.com\//, (route) => route.abort());
    return new HeadlessRealigner(browser, context, cloudUrl, sessionCookie);
  }

  /**
   * Lays the scenes out with the editor and resolves with the same scenes,
   * node positions replaced by the arranged ones (nothing else changes).
   * Scenes the editor could not arrange in time keep their positions. Only
   * a broken harness (unreachable dev server, dead browser, the editor
   * losing nodes) rejects.
   */
  async realign(scenes: unknown[], opts: RealignOptions = {}): Promise<unknown[]> {
    // The dev server hot-reloads the page when source files change (an
    // engineer editing while a build runs), which destroys the evaluate
    // context mid-pass. That is a harness hiccup, not a scene failure.
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.realignOnce(scenes, opts);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempt < 2 && /Execution context was destroyed|Target (page|context) .* closed|navigation/i.test(message)) {
          continue;
        }
        throw error;
      }
    }
  }

  private async realignOnce(scenes: unknown[], opts: RealignOptions): Promise<unknown[]> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_ARRANGE_TIMEOUT_MS;
    const settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS;
    const sceneIds = scenes.map(sceneIdOf);
    if (sceneIds.some((id) => id === null)) {
      throw new Error("realign: every scene needs a string id");
    }
    const page = await this.context.newPage();
    try {
      await page.goto(`${this.cloudUrl}${REALIGN_PAGE_PATH}`, {
        timeout: PAGE_READY_TIMEOUT_MS,
        waitUntil: "domcontentloaded",
      });
      if (!page.url().includes("/my-scenes/new")) {
        throw new Error(`realign: the new-scene page redirected to ${page.url()} (session cookie rejected?)`);
      }
      await page.waitForFunction(() => Boolean((window as HookWindow).__frameosEditor), null, {
        timeout: PAGE_READY_TIMEOUT_MS,
      });
      // Everything in one go, first scene selected; the editor arranges only
      // the selected scene, so the others follow one select() at a time.
      await page.evaluate(
        ([input, firstId]) => (window as HookWindow).__frameosEditor!.load(input, firstId ?? undefined),
        [scenes, sceneIds[0]] as [unknown[], string | null],
      );
      for (const [index, sceneId] of sceneIds.entries()) {
        const nodeIds = nodesOf(scenes[index])
          .map((node) => node.id)
          .filter((id): id is string => typeof id === "string" && id !== "");
        if (nodeIds.length === 0) {
          continue;
        }
        if (index > 0) {
          await page.evaluate((id) => (window as HookWindow).__frameosEditor!.select(id), sceneId!);
        }
        const deadline = Date.now() + timeoutMs;
        const measured = await this.waitForMeasured(page, nodeIds, deadline);
        if (!measured) {
          opts.log?.(`realign: scene ${sceneId} never rendered its ${nodeIds.length} nodes within ${Math.round(timeoutMs / 1000)}s; keeping its positions`);
          continue;
        }
        const versionBefore = await page.evaluate(() => (window as HookWindow).__frameosEditor!.version);
        await page.click(REALIGN_BUTTON, { timeout: Math.max(1_000, deadline - Date.now()) });
        const arranged = await this.waitForArranged(page, sceneId!, versionBefore, deadline, settleMs);
        if (!arranged) {
          opts.log?.(`realign: scene ${sceneId} was not arranged within ${Math.round(timeoutMs / 1000)}s; keeping its positions`);
        }
      }
      const reported = (await page.evaluate(() => (window as HookWindow).__frameosEditor!.scenes())) as
        | unknown[]
        | null;
      return mergePositions(scenes, reported);
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  /** Every node of the selected scene is in the diagram with a non-zero box. */
  private async waitForMeasured(page: Page, nodeIds: string[], deadline: number): Promise<boolean> {
    while (Date.now() < deadline) {
      const measured = await page.evaluate((ids) => {
        return ids.every((id) => {
          const element = document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`);
          if (!element) {
            return false;
          }
          const box = element.getBoundingClientRect();
          return box.width > 0 && box.height > 0;
        });
      }, nodeIds);
      if (measured) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    return false;
  }

  /**
   * Resolves true once the editor has reported the scene with real, unstacked
   * positions and stayed quiet for settleMs — or, when no report follows the
   * button press at all, once the positions it already holds are real (the
   * layout was already the arranged one).
   */
  private async waitForArranged(
    page: Page,
    sceneId: string,
    versionBefore: number,
    deadline: number,
    settleMs: number,
  ): Promise<boolean> {
    const pressedAt = Date.now();
    let stableSince: number | null = null;
    let lastVersion = versionBefore;
    while (Date.now() < deadline) {
      const snapshot = await page.evaluate((id): InPageSnapshot => {
        const hook = (window as HookWindow).__frameosEditor;
        if (!hook) {
          return { arranged: false, found: false, nodeCount: 0, ready: false, version: 0 };
        }
        const scenes = hook.scenes() ?? [];
        const scene = scenes.find(
          (candidate) => Boolean(candidate) && (candidate as { id?: unknown }).id === id,
        ) as { nodes?: unknown[] } | undefined;
        if (!scene) {
          return { arranged: false, found: false, nodeCount: 0, ready: true, version: hook.version };
        }
        const nodes = Array.isArray(scene.nodes) ? scene.nodes : [];
        const positions = nodes.map((node) => {
          const position = (node as { position?: { x?: unknown; y?: unknown } } | null)?.position;
          const x = position?.x;
          const y = position?.y;
          if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
            return null;
          }
          return x === -9999 && y === -9999 ? null : { x, y };
        });
        let arranged = positions.every((position) => position !== null);
        if (arranged && positions.length > 1) {
          const first = positions[0]!;
          arranged = positions.some((position) => position!.x !== first.x || position!.y !== first.y);
        }
        return { arranged, found: true, nodeCount: nodes.length, ready: true, version: hook.version };
      }, sceneId);
      if (!snapshot.ready) {
        throw new Error("realign: the editor hook vanished from the page");
      }
      if (snapshot.version !== lastVersion) {
        lastVersion = snapshot.version;
        stableSince = null;
      }
      const reported = snapshot.version !== versionBefore;
      const unchanged = !reported && Date.now() - pressedAt >= NO_REPORT_MS;
      if (snapshot.arranged && (reported || unchanged)) {
        stableSince ??= Date.now();
        if (Date.now() - stableSince >= settleMs) {
          return true;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    return false;
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => undefined);
    await this.browser.close().catch(() => undefined);
  }
}
