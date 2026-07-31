import { describe, expect, it } from "vitest";
import {
  accountIdentities,
  accounts,
  connectedBackends,
  consentEvents,
  deviceAuthorizationRequests,
  linkedClients,
  auditEvents,
} from "./schema";

describe("cloud schema", () => {
  it("exports the current account and backend-linking tables", () => {
    expect(accounts).toBeDefined();
    expect(accountIdentities).toBeDefined();
    expect(linkedClients).toBeDefined();
    expect(connectedBackends).toBeDefined();
    expect(deviceAuthorizationRequests).toBeDefined();
    expect(consentEvents).toBeDefined();
    expect(auditEvents).toBeDefined();
  });
});
