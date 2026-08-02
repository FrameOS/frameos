"use client";

import { ShieldCheck, ShieldOff, Trash2, Unplug } from "lucide-react";
import { useState } from "react";
import { formatBytes, formatDate } from "../lib/format";

export type AdminUser = {
  activeSessions: number;
  backupBytes: number;
  backupCount: number;
  createdAt: string;
  displayName: string | null;
  id: string;
  identities: {
    providerKey: string;
    emailSnapshot: string | null;
    emailVerified: boolean;
  }[];
  isSuperadmin: boolean;
  linkedBackends: number;
  primaryEmail: string | null;
};

export function AdminUsersTable({
  selfAccountId,
  users: initialUsers,
}: {
  selfAccountId: string;
  users: AdminUser[];
}) {
  const [users, setUsers] = useState(initialUsers);
  const [busyId, setBusyId] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  async function callAdminApi(
    userId: string,
    path: string,
    init: RequestInit,
  ) {
    setBusyId(userId);
    setError(undefined);
    try {
      const response = await fetch(path, {
        headers: { "content-type": "application/json" },
        ...init,
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => undefined)) as
          | { error?: string }
          | undefined;
        setError(actionError(payload?.error));
        return false;
      }
      return true;
    } catch {
      setError("The request failed. Try again in a moment.");
      return false;
    } finally {
      setBusyId(undefined);
    }
  }

  async function toggleSuperadmin(user: AdminUser) {
    const ok = await callAdminApi(user.id, `/api/admin/users/${user.id}`, {
      body: JSON.stringify({ is_superadmin: !user.isSuperadmin }),
      method: "PATCH",
    });
    if (ok) {
      setUsers((current) =>
        current.map((entry) =>
          entry.id === user.id
            ? { ...entry, isSuperadmin: !entry.isSuperadmin }
            : entry,
        ),
      );
    }
  }

  async function revokeSessions(user: AdminUser) {
    const ok = await callAdminApi(
      user.id,
      `/api/admin/users/${user.id}/revoke-sessions`,
      { method: "POST" },
    );
    if (ok) {
      setUsers((current) =>
        current.map((entry) =>
          entry.id === user.id ? { ...entry, activeSessions: 0 } : entry,
        ),
      );
    }
  }

  async function deleteUser(user: AdminUser) {
    const label = user.primaryEmail ?? user.displayName ?? user.id;
    if (
      !window.confirm(
        `Delete the account "${label}" and all of its identities, sessions, and backend links? This cannot be undone.`,
      )
    ) {
      return;
    }

    const ok = await callAdminApi(user.id, `/api/admin/users/${user.id}`, {
      method: "DELETE",
    });
    if (ok) {
      setUsers((current) => current.filter((entry) => entry.id !== user.id));
    }
  }

  return (
    <>
      {error ? (
        <p className="notice-error" role="alert">
          {error}
        </p>
      ) : null}
      {users.length === 0 ? (
        <section className="card">
          <p>No matching users.</p>
        </section>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>User</th>
              <th>Sign-in methods</th>
              <th>Backends</th>
              <th>Backups</th>
              <th>Sessions</th>
              <th>Created</th>
              <th>Role</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => {
              const isSelf = user.id === selfAccountId;
              const busy = busyId === user.id;
              return (
                <tr key={user.id}>
                  <td>
                    <div>{user.displayName ?? "—"}</div>
                    <div className="copy">{user.primaryEmail ?? "no email"}</div>
                  </td>
                  <td>
                    {user.identities.length > 0 ? (
                      <div className="inline-actions">
                        {user.identities.map((identity, index) => (
                          <span
                            className={
                              identity.providerKey === "password" &&
                              !identity.emailVerified
                                ? "pill pill-warning"
                                : "pill"
                            }
                            key={`${identity.providerKey}-${index}`}
                          >
                            {identity.providerKey}
                            {identity.providerKey === "password"
                              ? identity.emailVerified
                                ? " · verified"
                                : " · unverified"
                              : null}
                          </span>
                        ))}
                      </div>
                    ) : (
                      "none"
                    )}
                  </td>
                  <td>{user.linkedBackends}</td>
                  <td>
                    {user.backupCount > 0
                      ? `${user.backupCount} · ${formatBytes(user.backupBytes)}`
                      : "0"}
                  </td>
                  <td>{user.activeSessions}</td>
                  <td>{formatDate(new Date(user.createdAt))}</td>
                  <td>
                    <span
                      className={user.isSuperadmin ? "pill pill-warning" : "pill"}
                    >
                      {user.isSuperadmin ? "Superadmin" : "User"}
                    </span>
                    {isSelf ? <span className="pill pill-ok">You</span> : null}
                  </td>
                  <td>
                    <div className="inline-actions">
                      <button
                        className="button"
                        disabled={busy || isSelf}
                        onClick={() => void toggleSuperadmin(user)}
                        title={
                          isSelf
                            ? "You cannot change your own superadmin flag"
                            : undefined
                        }
                        type="button"
                      >
                        {user.isSuperadmin ? (
                          <ShieldOff aria-hidden size={16} />
                        ) : (
                          <ShieldCheck aria-hidden size={16} />
                        )}
                        {user.isSuperadmin ? "Revoke admin" : "Make admin"}
                      </button>
                      <button
                        className="button"
                        disabled={busy || user.activeSessions === 0}
                        onClick={() => void revokeSessions(user)}
                        type="button"
                      >
                        <Unplug aria-hidden size={16} />
                        Sign out everywhere
                      </button>
                      <button
                        className="button button-danger"
                        disabled={busy || isSelf}
                        onClick={() => void deleteUser(user)}
                        title={
                          isSelf ? "You cannot delete your own account" : undefined
                        }
                        type="button"
                      >
                        <Trash2 aria-hidden size={16} />
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}

function actionError(code: string | undefined) {
  if (code === "cannot_change_self") {
    return "You cannot change your own superadmin flag.";
  }
  if (code === "cannot_delete_self") {
    return "You cannot delete your own account.";
  }
  if (code === "forbidden" || code === "unauthenticated") {
    return "Your session no longer has superadmin access. Reload the page.";
  }
  if (code === "not_found") {
    return "That user no longer exists. Reload the page.";
  }
  return "The request failed. Try again in a moment.";
}
