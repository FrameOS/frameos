// @vitest-environment jsdom
// Switching to a larger plan when the bank wants the payment confirmed
// (frontend/src/scenes/settings/account/plansLogic.ts). The plan route then
// answers 402 with the URL of Stripe's invoice page for the change
// (billing-provider.ts changePaidPlan); the page offers to open it rather
// than reporting an error, and a 402 without a URL is reported in the
// route's own words.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetContext } from "../../../../../../frontend/node_modules/kea";
import { loadersPlugin } from "../../../../../../frontend/node_modules/kea-loaders";

const mocks = vi.hoisted(() => ({
  apiCall: vi.fn(),
  confirmDialog: vi.fn(),
  showErrorMessage: vi.fn(),
}));

vi.mock("../../../../../../frontend/src/utils/apiFetch", () => ({
  apiFetch: vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
}));
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

const assign = vi.fn();

beforeEach(() => {
  resetContext({ plugins: [loadersPlugin({})] });
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, assign, href: "http://localhost/account/usage" },
  });
  mocks.apiCall.mockReset();
  mocks.confirmDialog.mockReset();
  mocks.showErrorMessage.mockReset();
  assign.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

async function settle() {
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("switching plan when the bank wants the payment confirmed", () => {
  it("offers Stripe's invoice page and goes there when asked", async () => {
    // Confirm the switch, then confirm opening the invoice.
    mocks.confirmDialog.mockResolvedValue(true);
    mocks.apiCall.mockResolvedValue(
      new Response(
        JSON.stringify({
          detail: "Your bank needs to confirm this payment. The plan changes once it is paid.",
          error: "payment_action_required",
          url: "https://invoice.stripe.com/i/abc",
        }),
        { status: 402 },
      ),
    );
    const logic = plansLogic();
    logic.mount();
    logic.actions.switchPlan("private-9", "Private at $9/month", true);
    await settle();
    expect(mocks.apiCall).toHaveBeenCalledWith("/api/account/plan", "PUT", { plan: "private-9" });
    expect(mocks.confirmDialog).toHaveBeenCalledTimes(2);
    expect(mocks.confirmDialog.mock.calls[1]?.[0]).toMatchObject({
      confirmLabel: "Open the invoice",
      title: "Confirm the payment",
    });
    expect(assign).toHaveBeenCalledWith("https://invoice.stripe.com/i/abc");
    expect(mocks.showErrorMessage).not.toHaveBeenCalled();
    expect(logic.values.busy).toBeNull();
  });

  it("stays on the page when the invoice is declined", async () => {
    mocks.confirmDialog.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    mocks.apiCall.mockResolvedValue(
      new Response(JSON.stringify({ error: "payment_action_required", url: "https://invoice.stripe.com/i/abc" }), {
        status: 402,
      }),
    );
    const logic = plansLogic();
    logic.mount();
    logic.actions.switchPlan("private-9", "Private at $9/month", true);
    await settle();
    expect(assign).not.toHaveBeenCalled();
  });

  it("reports a 402 without a URL in the route's own words", async () => {
    mocks.confirmDialog.mockResolvedValue(true);
    mocks.apiCall.mockResolvedValue(
      new Response(JSON.stringify({ detail: "An earlier change is waiting for its payment.", error: "payment_action_required" }), {
        status: 402,
      }),
    );
    const logic = plansLogic();
    logic.mount();
    logic.actions.switchPlan("private-9", "Private at $9/month", true);
    await settle();
    expect(mocks.showErrorMessage).toHaveBeenCalledWith("An earlier change is waiting for its payment.");
    expect(assign).not.toHaveBeenCalled();
  });
});
