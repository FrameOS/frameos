// @vitest-environment jsdom
//
// The People page (cloud/docs/sharing.md): the people on the plan, the
// invitations, the projects their frames are shared through, and an
// invitation link someone followed.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>());
vi.mock("../../../../../../frontend/src/utils/apiFetch", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, apiFetch: (input: RequestInfo | URL, init?: RequestInit) => fetchMock(input, init) };
});

import { initKea } from "../../../../../../frontend/src/initKea";
import { PeoplePage } from "../../../../../../frontend/src/scenes/settings/account/PeoplePage";
import {
  describePeopleError,
  type Organization,
  type PeoplePayload,
} from "../../../../../../frontend/src/scenes/settings/account/peopleLogic";
import { cloudSceneDeployErrorMessage } from "../../../../../../frontend/src/utils/cloudFrameApi";

type TestWindow = Window & { FRAMEOS_EMBEDDED_NO_BACKEND?: boolean };
const testWindow = window as TestWindow;

describe("a private scene on someone else's frame", () => {
  it("is refused in words", () => {
    expect(cloudSceneDeployErrorMessage("scene_private", 400)).toContain("shared with you");
    expect(cloudSceneDeployErrorMessage("scene_pulled", 400)).toBe("This scene is no longer available in the store");
  });
});

describe("the people page", () => {
  it("words the refusals of the organization routes", () => {
    expect(describePeopleError(403, "people_limit")).toContain("Every seat");
    expect(describePeopleError(409, "already_invited")).toContain("open invitation");
    expect(describePeopleError(429, undefined)).toContain("Too many attempts");
  });

  let organization: Organization;
  let memberships: PeoplePayload["memberships"];
  let routes: Record<string, (body: Record<string, unknown>) => Response>;

  function requestUrl(input: RequestInfo | URL): string {
    return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  }

  function calls(method: string): { body: Record<string, unknown>; path: string }[] {
    return fetchMock.mock.calls
      .filter(([, init]) => (init?.method ?? "GET") === method)
      .map(([input, init]) => ({
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
        path: requestUrl(input),
      }));
  }

  beforeEach(() => {
    testWindow.FRAMEOS_EMBEDDED_NO_BACKEND = true;
    window.history.replaceState(null, "", "/account/people");
    document.body.innerHTML = '<div id="popper"></div><div id="root"></div>';
    organization = {
      frames: [
        { id: "f-kitchen", name: "Kitchen", project_id: "p-home" },
        { id: "f-office", name: "Office", project_id: null },
      ],
      id: "o1",
      invitations: [
        {
          created_at: "2026-11-01T10:00:00.000Z",
          email: "sam@example.com",
          expires_at: "2026-11-08T10:00:00.000Z",
          id: "i1",
          project_ids: [],
          role: "member",
        },
      ],
      members: [
        {
          active: true,
          email: "milo@example.com",
          id: "m1",
          joined_at: "2026-10-01T10:00:00.000Z",
          name: "Milo",
          role: "member",
          you: false,
        },
      ],
      name: "Olive",
      owner: { email: "olive@example.com", name: "Olive", you: true },
      people: { limit: 5, used: 3 },
      projects: [{ frame_ids: ["f-kitchen"], id: "p-home", member_ids: ["m1"], name: "Home" }],
      role: "owner",
    };
    memberships = [];
    routes = {};
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (input, init) => {
      const method = init?.method ?? "GET";
      const path = requestUrl(input);
      const handler = routes[`${method} ${path}`];
      if (handler) {
        return handler(init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {});
      }
      if (method === "GET" && path.startsWith("/api/organization")) {
        return Response.json({ memberships, organization });
      }
      if (method === "GET" && path === "/api/frames") {
        return Response.json({ frames: [] });
      }
      return Response.json({}, { status: method === "GET" ? 404 : 200 });
    });
    initKea();
  });

  afterEach(() => {
    cleanup();
    delete testWindow.FRAMEOS_EMBEDDED_NO_BACKEND;
  });

  it("lists the people on the plan, the open invitations and the seats", async () => {
    render(<PeoplePage />);
    expect(await screen.findByText(/3 of 5 people on the plan/)).toBeTruthy();
    // In the people table (and again as a tick box in the project).
    expect(screen.getByText("milo@example.com")).toBeTruthy();
    expect(screen.getByText("sam@example.com")).toBeTruthy();
    expect(screen.getByText(/Invited, until 8 Nov 2026/)).toBeTruthy();
    // The owner's own row has no role to change and nothing to remove.
    expect(screen.getAllByRole("button", { name: "Remove" })).toHaveLength(1);
  });

  it("sends an invitation with the projects ticked, and shows the link once", async () => {
    routes["POST /api/organization/invitations"] = () =>
      Response.json({ invitation: { id: "i2" }, url: "https://cloud.example/account/people?invite=FOINV_x" }, { status: 201 });
    render(<PeoplePage />);
    const email = await screen.findByLabelText("Email address");
    fireEvent.change(email, { target: { value: " ada@example.com " } });
    const form = email.closest("form")!;
    fireEvent.click(within(form).getByLabelText("Home"));
    fireEvent.click(within(form).getByRole("button", { name: "Send invitation" }));
    await waitFor(() => expect(calls("POST")).toHaveLength(1));
    expect(calls("POST")[0]).toEqual({
      body: { email: "ada@example.com", project_ids: ["p-home"], role: "member" },
      path: "/api/organization/invitations",
    });
    // The link is offered once, beside the form (the toast says it was sent too).
    expect(await screen.findByRole("button", { name: "copy link" })).toBeTruthy();
    expect(screen.getByText(/It is valid for seven days/)).toBeTruthy();
  });

  it("says a free plan is one person, and offers no invitation", async () => {
    organization = { ...organization, invitations: [], members: [], people: { limit: 1, used: 1 }, projects: [] };
    render(<PeoplePage />);
    expect(await screen.findByText(/Your plan is for one person/)).toBeTruthy();
    expect(screen.getByText(/Sharing frames comes with a paid plan/)).toBeTruthy();
    expect(screen.queryByLabelText("Email address")).toBeNull();
  });

  it("shares a frame by ticking it in a project", async () => {
    render(<PeoplePage />);
    const project = await screen.findByTestId("people-project");
    expect((within(project).getByLabelText("Kitchen") as HTMLInputElement).checked).toBe(true);
    const office = within(project).getByLabelText("Office") as HTMLInputElement;
    expect(office.checked).toBe(false);
    fireEvent.click(office);
    await waitFor(() => expect(calls("PATCH")).toHaveLength(1));
    expect(calls("PATCH")[0]).toEqual({
      body: { frame_ids: ["f-kitchen", "f-office"] },
      path: "/api/organization/projects/p-home",
    });
    // And takes a person out by unticking them.
    fireEvent.click(within(project).getByLabelText("Milo"));
    await waitFor(() => expect(calls("PATCH")).toHaveLength(2));
    expect(calls("PATCH")[1]?.body).toEqual({ member_ids: [] });
  });

  it("shows an invitation someone followed a link to, and joins on Accept", async () => {
    window.history.replaceState(null, "", "/account/people?invite=FOINV_token");
    organization = { ...organization, invitations: [], members: [], people: { limit: 1, used: 1 }, projects: [] };
    routes["POST /api/organization/join"] = (body) =>
      body.accept === true
        ? Response.json({ organization: { id: "o9", name: "Rosa" }, status: "joined" })
        : Response.json({
            invitation: {
              already_member: false,
              email: "me@example.com",
              expires_at: "2026-11-08T10:00:00.000Z",
              organization: { id: "o9", name: "Rosa" },
              own_organization: false,
              owner_name: "Rosa",
              projects: ["Shop"],
              role: "member",
              state: "open",
            },
          });
    render(<PeoplePage />);
    const offer = await screen.findByTestId("people-invitation-offer");
    expect(within(offer).getByText("Rosa invited you to share their frames")).toBeTruthy();
    expect(within(offer).getByText(/as a member of Shop/)).toBeTruthy();
    fireEvent.click(within(offer).getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(screen.queryByTestId("people-invitation-offer")).toBeNull());
    expect(calls("POST").map((call) => call.body)).toEqual([
      { token: "FOINV_token" },
      { accept: true, token: "FOINV_token" },
    ]);
    // The spent link is out of the address bar.
    expect(window.location.search).toBe("");
  });

  it("lists other people's plans the account is on, with a way out", async () => {
    memberships = [
      {
        active: true,
        joined_at: "2026-10-01T10:00:00.000Z",
        member_id: "m7",
        organization: { id: "o9", name: "Rosa's shop" },
        owner_name: "Rosa",
        projects: [{ frame_count: 2, id: "p9", name: "Shop" }],
        role: "admin",
      },
    ];
    render(<PeoplePage />);
    expect(await screen.findByText("Rosa's shop")).toBeTruthy();
    expect(screen.getByText(/2 frames/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Leave" })).toBeTruthy();
    // An admin can manage that plan from here.
    fireEvent.click(screen.getByRole("button", { name: "Manage" }));
    await waitFor(() =>
      expect(calls("GET").some((call) => call.path === "/api/organization?organization_id=o9")).toBe(true),
    );
  });
});
