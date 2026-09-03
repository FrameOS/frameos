import { afterEach, describe, expect, it } from "vitest";
import {
  INITIAL_TURN_RESERVATION_MICROS,
  inFlightSpendMicros,
  releaseTurnSpend,
  reserveTurnSpend,
  resetSpendReservationsForTests,
  updateTurnSpend,
} from "./spend-reservations";

afterEach(() => {
  resetSpendReservationsForTests();
});

describe("spend reservations", () => {
  it("reserves the floor for an admitted turn and releases it when it ends", () => {
    reserveTurnSpend("acct", "t1");
    expect(inFlightSpendMicros("acct")).toBe(INITIAL_TURN_RESERVATION_MICROS);
    releaseTurnSpend("t1");
    expect(inFlightSpendMicros("acct")).toBe(0n);
  });

  it("sums the account's turns and ignores other accounts", () => {
    reserveTurnSpend("acct", "t1");
    reserveTurnSpend("acct", "t2");
    reserveTurnSpend("other", "t3");
    expect(inFlightSpendMicros("acct")).toBe(2n * INITIAL_TURN_RESERVATION_MICROS);
    expect(inFlightSpendMicros("other")).toBe(INITIAL_TURN_RESERVATION_MICROS);
  });

  it("excludes the caller's own turn on request", () => {
    reserveTurnSpend("acct", "t1");
    reserveTurnSpend("acct", "t2");
    expect(inFlightSpendMicros("acct", "t1")).toBe(INITIAL_TURN_RESERVATION_MICROS);
  });

  // The floor is what stops a burst of turns admitted in the same second
  // from being counted as free; the priced cost takes over once it is
  // larger, so a long tool loop's reservation tracks what it actually costs.
  it("keeps the floor until the priced cost exceeds it", () => {
    reserveTurnSpend("acct", "t1");
    updateTurnSpend("t1", 1_000n);
    expect(inFlightSpendMicros("acct")).toBe(INITIAL_TURN_RESERVATION_MICROS);
    updateTurnSpend("t1", 900_000n);
    expect(inFlightSpendMicros("acct")).toBe(900_000n);
  });

  it("ignores updates for turns it never reserved", () => {
    updateTurnSpend("ghost", 5_000_000n);
    expect(inFlightSpendMicros("acct")).toBe(0n);
  });

  it("re-reserving a turn replaces rather than adds", () => {
    reserveTurnSpend("acct", "t1");
    reserveTurnSpend("acct", "t1", 10n);
    expect(inFlightSpendMicros("acct")).toBe(10n);
  });
});
