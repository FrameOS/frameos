import { describe, expect, it, vi } from "vitest";
import {
  apiTokenAccessFromPrefix,
  authenticateApiToken,
  bearerToken,
  isApiToken,
  mintApiToken,
  serializeApiToken,
  tokenHint,
} from "./api-tokens";
import { hashSecret } from "./secrets";

// The token format is a contract with every script that ever stored one:
// the prefix tells the kind, the hint is what the list shows, and the
// database only ever holds the hash.

describe("api tokens", () => {
  it("mints full and read-only tokens with distinct prefixes", () => {
    const full = mintApiToken("full");
    const readOnly = mintApiToken("read_only");
    expect(full.token).toMatch(/^fc_api_[A-Za-z0-9_-]{40,}$/);
    expect(readOnly.token).toMatch(/^fc_apiro_[A-Za-z0-9_-]{40,}$/);
    expect(apiTokenAccessFromPrefix(full.token)).toBe("full");
    expect(apiTokenAccessFromPrefix(readOnly.token)).toBe("read_only");
    expect(full.tokenHash).toBe(hashSecret(full.token));
    expect(full.hint).toBe(tokenHint(full.token));
    expect(full.hint).toBe(full.token.slice(0, "fc_api_".length + 4));
    expect(isApiToken(full.token)).toBe(true);
    expect(isApiToken("fc_link_abc")).toBe(false);
    expect(isApiToken(undefined)).toBe(false);
  });

  it("parses the bearer header loosely", () => {
    expect(bearerToken("Bearer fc_api_x")).toBe("fc_api_x");
    expect(bearerToken("bearer   fc_api_x ")).toBe("fc_api_x");
    expect(bearerToken("Basic abc")).toBeUndefined();
    expect(bearerToken(null)).toBeUndefined();
  });

  it("serializes without the hash", () => {
    const now = new Date("2026-08-29T10:00:00Z");
    expect(
      serializeApiToken({
        access: "read_only",
        createdAt: now,
        expiresAt: null,
        id: "t1",
        lastUsedAt: null,
        name: "laptop",
        revokedAt: null,
        tokenHint: "fc_apiro_abcd",
      }),
    ).toEqual({
      access: "read_only",
      created_at: now.toISOString(),
      expires_at: null,
      id: "t1",
      last_used_at: null,
      name: "laptop",
      revoked_at: null,
      token_hint: "fc_apiro_abcd",
    });
  });

  function fakeDb(row: Record<string, unknown> | undefined) {
    const updates: Record<string, unknown>[] = [];
    const db = {
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            where: () => ({ limit: () => Promise.resolve(row ? [row] : []) }),
          }),
        }),
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => {
          updates.push(values);
          return { where: () => Promise.resolve(undefined) };
        },
      }),
    };
    return { db: db as never, updates };
  }

  const baseRow = (token: string) => ({
    access: "full",
    accountId: "acc-1",
    accountName: "Marius",
    email: "me@example.com",
    emailVerified: true,
    expiresAt: null,
    id: "tok-1",
    lastUsedAt: null,
    name: "laptop",
    tokenHash: hashSecret(token),
  });

  it("resolves a live token to its account and stamps last use", async () => {
    const { token } = mintApiToken("full");
    const { db, updates } = fakeDb(baseRow(token));
    const result = await authenticateApiToken(db, token);
    expect(result).toEqual({
      account: {
        email: "me@example.com",
        emailVerified: true,
        id: "acc-1",
        name: "Marius",
      },
      token: { access: "full", id: "tok-1", name: "laptop" },
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]?.lastUsedAt).toBeInstanceOf(Date);
  });

  it("reports an unverified account as such instead of vouching for it", async () => {
    const { token } = mintApiToken("full");
    const { db } = fakeDb({ ...baseRow(token), emailVerified: false });
    const result = await authenticateApiToken(db, token);
    expect(result?.account.emailVerified).toBe(false);
  });

  it("throttles the last-used write", async () => {
    const { token } = mintApiToken("full");
    const { db, updates } = fakeDb({ ...baseRow(token), lastUsedAt: new Date() });
    await authenticateApiToken(db, token);
    expect(updates).toHaveLength(0);
  });

  it("refuses expired tokens and prefix/row access mismatches", async () => {
    const { token } = mintApiToken("full");
    const expired = fakeDb({
      ...baseRow(token),
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(await authenticateApiToken(expired.db, token)).toBeUndefined();

    // A row that says read_only behind a full-access prefix (or the other
    // way round) is not a token we minted.
    const mismatched = fakeDb({ ...baseRow(token), access: "read_only" });
    expect(await authenticateApiToken(mismatched.db, token)).toBeUndefined();
    expect(mismatched.updates).toHaveLength(0);
  });

  it("ignores things that are not api tokens without touching the db", async () => {
    const select = vi.fn();
    const db = { select } as never;
    expect(await authenticateApiToken(db, "fc_link_something")).toBeUndefined();
    expect(select).not.toHaveBeenCalled();
  });
});
