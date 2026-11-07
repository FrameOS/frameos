// @vitest-environment jsdom
// The top of the usage page (frontend/src/scenes/settings/account/plansLogic.ts):
// the plan the account is on and the one a downgrade lands on, the word
// after a price before tax, the invoices loaded once the plan says there is
// a billing account, and cancelling, which says the time left is not
// refunded before it cancels.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetContext } from "../../../../../../frontend/node_modules/kea";
import { loadersPlugin } from "../../../../../../frontend/node_modules/kea-loaders";

const mocks = vi.hoisted(() => ({
  apiCall: vi.fn(),
  apiFetch: vi.fn(),
  confirmDialog: vi.fn(),
  showErrorMessage: vi.fn(),
}));

vi.mock("../../../../../../frontend/src/utils/apiFetch", () => ({ apiFetch: mocks.apiFetch }));
vi.mock("../../../../../../frontend/src/utils/confirmDialogLogic", () => ({
  confirmDialog: mocks.confirmDialog,
}));
vi.mock("../../../../../../frontend/src/utils/workingMessage", () => ({
  showErrorMessage: mocks.showErrorMessage,
}));
vi.mock("../../../../../../frontend/src/scenes/settings/account/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  apiCall: mocks.apiCall,
}));

const { plansLogic } = await import("../../../../../../frontend/src/scenes/settings/account/plansLogic");

const stop = (code: string, usd: number, current = false) => ({
  code,
  current,
  features: [],
  limits: {
    backup_bytes: 0,
    cloud_rendered_frames: 0,
    frame_log_bytes: 0,
    frames: 0,
    people: 1,
    photo_bytes: 0,
    private_scene_bytes: 0,
  },
  price_micros: String(usd * 1_000_000),
  purchasable: true,
});

function planPayload(options: { manage?: boolean; nextPlan?: string | null; taxLabel?: string | null } = {}) {
  return {
    billing: {
      checkout: true,
      manage: options.manage ?? true,
      mode: "live",
      prices_exclude_tax: true,
      subscription: {
        cancel_at: null,
        past_due: false,
        plan_code: "private-9",
        renews_at: "2026-12-07T17:15:00.000Z",
        status: "active",
      },
      tax_label: options.taxLabel === undefined ? "VAT" : options.taxLabel,
    },
    cancel_at: null,
    catalog: {
      groups: [
        { available: true, key: "free", name: "Free", stops: [stop("free", 0)] },
        {
          available: true,
          key: "private",
          name: "Private",
          stops: [stop("private-2", 2), stop("private-5", 5), stop("private-9", 9, true)],
        },
      ],
    },
    links: null,
    next_plan_code: options.nextPlan ?? null,
  };
}

const invoice = {
  amount_due_micros: "0",
  created_at: "2026-11-07T17:15:00.000Z",
  currency: "USD",
  id: "in_1",
  number: "8985BD72-0001",
  pdf_url: "https://pay.stripe.com/invoice/in_1/pdf",
  refunded_micros: "0",
  status: "paid",
  tax_micros: "420000",
  total_micros: "2420000",
  url: "https://invoice.stripe.com/i/in_1",
};

function serve(plan: ReturnType<typeof planPayload>) {
  mocks.apiFetch.mockImplementation(async (path: string) => {
    if (path === "/api/account/plan") {
      return new Response(JSON.stringify(plan), { status: 200 });
    }
    if (path === "/api/account/plan/invoices") {
      return new Response(JSON.stringify({ invoices: [invoice] }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  });
}

async function settle() {
  for (let index = 0; index < 8; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

beforeEach(() => {
  resetContext({ plugins: [loadersPlugin({})] });
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, assign: vi.fn(), href: "http://localhost/account/usage" },
  });
  mocks.apiCall.mockReset();
  mocks.apiFetch.mockReset();
  mocks.confirmDialog.mockReset();
  mocks.showErrorMessage.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("the plan at the top of the usage page", () => {
  it("names the plan, the one a downgrade lands on, and the tax after its price", async () => {
    serve(planPayload({ nextPlan: "private-5" }));
    const logic = plansLogic();
    logic.mount();
    await settle();
    expect(logic.values.currentPlan).toEqual({ code: "private-9", name: "Private", priceMicros: "9000000" });
    expect(logic.values.nextPlan).toEqual({ code: "private-5", name: "Private", priceMicros: "5000000" });
    expect(logic.values.taxSuffix).toBe(" + VAT");
  });

  it("says tax elsewhere, and nothing when prices include it", async () => {
    serve(planPayload({ taxLabel: "tax" }));
    const logic = plansLogic();
    logic.mount();
    await settle();
    expect(logic.values.taxSuffix).toBe(" + tax");
    serve(planPayload({ taxLabel: null }));
    logic.actions.loadPlan();
    await settle();
    expect(logic.values.taxSuffix).toBe("");
  });

  it("loads the invoices once there is a billing account, and not before", async () => {
    serve(planPayload({ manage: false }));
    const logic = plansLogic();
    logic.mount();
    await settle();
    expect(mocks.apiFetch).not.toHaveBeenCalledWith("/api/account/plan/invoices");
    expect(logic.values.invoices).toBeNull();

    serve(planPayload());
    logic.actions.loadPlan();
    await settle();
    expect(logic.values.invoices).toEqual([invoice]);
  });

  it("keeps the invoice list's failure in the route's words", async () => {
    serve(planPayload());
    mocks.apiFetch.mockImplementation(async (path: string) =>
      path === "/api/account/plan/invoices"
        ? new Response(JSON.stringify({ detail: "The invoices could not be loaded. Try again in a moment." }), {
            status: 502,
          })
        : new Response(JSON.stringify(planPayload()), { status: 200 }),
    );
    const logic = plansLogic();
    logic.mount();
    await settle();
    expect(logic.values.invoices).toBeNull();
    expect(logic.values.invoicesError).toBe("The invoices could not be loaded. Try again in a moment.");
  });
});

describe("cancelling the plan", () => {
  it("says the time left is not refunded, then cancels at the end of the period", async () => {
    serve(planPayload());
    mocks.confirmDialog.mockResolvedValue(true);
    mocks.apiCall.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    const logic = plansLogic();
    logic.mount();
    await settle();
    logic.actions.cancelPlan();
    await settle();
    const dialog = mocks.confirmDialog.mock.calls[0]?.[0] as { confirmLabel: string; danger: boolean; message: string };
    expect(dialog.confirmLabel).toBe("Cancel plan");
    expect(dialog.danger).toBe(true);
    expect(dialog.message).toContain("You keep Private until 7 Dec 2026");
    expect(dialog.message).toContain("not refunded");
    expect(mocks.apiCall).toHaveBeenCalledWith("/api/account/plan", "PUT", { plan: "free" });
    expect(logic.values.busy).toBeNull();
  });

  it("changes nothing when the dialog is dismissed", async () => {
    serve(planPayload());
    mocks.confirmDialog.mockResolvedValue(false);
    const logic = plansLogic();
    logic.mount();
    await settle();
    logic.actions.cancelPlan();
    await settle();
    expect(mocks.apiCall).not.toHaveBeenCalled();
    expect(logic.values.busy).toBeNull();
  });
});
