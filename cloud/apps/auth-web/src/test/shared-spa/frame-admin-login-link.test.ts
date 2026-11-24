// @vitest-environment jsdom
//
// The on-frame admin's login page (frameos/frontend) used to sign in from its
// own address: `?__login_user=…&__login_pass=…`, in the query or the hash,
// filled the form and submitted it. Nothing makes such a link any more, and a
// password in a URL is in the browser's history, in a bookmark and in
// whatever logs the address. The page no longer reads them; an old link's
// parameters are only taken out of the address bar.
//
// kea must come from the frame frontend's node_modules: the logic resolves it there.
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetContext } from "../../../../../../frameos/frontend/node_modules/kea";
import {
  hasFrameAdminLoginParams,
  stripFrameAdminLoginParams,
} from "../../../../../../frameos/frontend/src/utils/frameAdminLoginParams";

// The on-frame admin's logics are written without kea's generated types and
// are no part of this package's type check: they are loaded by a computed
// path, which tsc does not follow, and typed here by what the test uses.
interface MountedLogic<Values, Actions> {
  mount(): void;
  unmount(): void;
  values: Values;
  actions: Actions;
}
const frameFrontend = join(__dirname, "../../../../../../frameos/frontend/src");

async function logicFrom<Values, Actions>(file: string, name: string): Promise<MountedLogic<Values, Actions>> {
  const path = join(frameFrontend, file);
  const loaded = (await import(/* @vite-ignore */ path)) as Record<string, () => MountedLogic<Values, Actions>>;
  return loaded[name]!();
}

const loginLogic = () =>
  logicFrom<
    { username: string; password: string },
    { setUsername: (username: string) => void; setPassword: (password: string) => void; submitLogin: () => void }
  >("scenes/login/loginLogic.tsx", "loginLogic");
const adminLogic = () =>
  logicFrom<{ isAuthenticated: boolean }, { checkSession: () => void }>("scenes/admin/adminLogic.tsx", "adminLogic");

const fetchMock = vi.fn<typeof fetch>();

function answer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status });
}

async function settled() {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

function requested(): string[] {
  return fetchMock.mock.calls.map(([input]) => String(input));
}

beforeEach(() => {
  resetContext();
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url === "/api/admin/session") {
      return answer({ authenticated: false });
    }
    if (url === "/api/cloud/login/options") {
      return answer({ available: false });
    }
    return answer({}, 401);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  window.history.replaceState(null, "", "/");
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe("the old login link's parameters", () => {
  it("are found in the query and in the hash, and taken out with everything else kept", () => {
    expect(hasFrameAdminLoginParams({ hash: "", pathname: "/login", search: "" })).toBe(false);
    expect(hasFrameAdminLoginParams({ hash: "", pathname: "/login", search: "?cloudError=denied" })).toBe(false);
    expect(hasFrameAdminLoginParams({ hash: "", pathname: "/login", search: "?__login_user=admin" })).toBe(true);
    expect(hasFrameAdminLoginParams({ hash: "#__login_pass=hunter2", pathname: "/login", search: "" })).toBe(true);
    expect(
      stripFrameAdminLoginParams({
        hash: "#tab=logs&__login_pass=hunter2",
        pathname: "/admin",
        search: "?__login_user=admin&__login_pass=hunter2&cloudError=denied",
      }),
    ).toBe("/admin?cloudError=denied#tab=logs");
    expect(
      stripFrameAdminLoginParams({ hash: "", pathname: "/login", search: "?__login_user=admin&__login_pass=x" }),
    ).toBe("/login");
  });
});

describe("the on-frame login page", () => {
  it("does not sign in from its address, and takes an old link's password out of it", async () => {
    window.history.replaceState(null, "", "/login?__login_user=admin&__login_pass=hunter2&cloudError=denied#__login_pass=other");
    const logic = await loginLogic();
    logic.mount();
    await settled();

    expect(requested()).toEqual(["/api/admin/session", "/api/cloud/login/options"]);
    expect(requested()).not.toContain("/api/admin/login");
    expect(logic.values.username).toBe("");
    expect(logic.values.password).toBe("");
    expect(window.location.pathname + window.location.search + window.location.hash).toBe("/login?cloudError=denied");
    logic.unmount();
  });

  it("signs in with what was typed, and only when asked", async () => {
    window.history.replaceState(null, "", "/login");
    const logic = await loginLogic();
    logic.mount();
    await settled();
    logic.actions.setUsername("admin");
    logic.actions.setPassword("typed");
    expect(requested()).not.toContain("/api/admin/login");
    logic.actions.submitLogin();
    await settled();
    const login = fetchMock.mock.calls.find(([input]) => String(input) === "/api/admin/login");
    expect(login?.[1]).toMatchObject({ body: JSON.stringify({ username: "admin", password: "typed" }), method: "POST" });
    logic.unmount();
  });
});

describe("the on-frame admin page", () => {
  it("takes an old link's password out of its address too, unread", async () => {
    window.history.replaceState(null, "", "/admin?__login_user=admin&__login_pass=hunter2");
    const logic = await adminLogic();
    logic.mount();
    await settled();
    expect(requested()).toEqual(["/api/admin/session"]);
    expect(window.location.pathname + window.location.search).toBe("/admin");
    logic.unmount();
  });
});
