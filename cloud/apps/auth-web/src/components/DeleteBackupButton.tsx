"use client";

import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function DeleteBackupButton({
  backupId,
  label,
}: {
  backupId: string;
  label: string;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<"idle" | "deleting" | "error">("idle");

  async function remove() {
    if (
      !window.confirm(
        `Delete the cloud backup "${label}"? The copy on your backend or frame is not touched, but the cloud copy cannot be recovered.`,
      )
    ) {
      return;
    }

    setStatus("deleting");
    const response = await fetch(`/api/account/backups/${backupId}`, {
      method: "DELETE",
    });

    if (response.ok) {
      router.refresh();
    } else {
      setStatus("error");
    }
  }

  return (
    <button
      className="button button--small button-danger"
      disabled={status === "deleting"}
      onClick={() => void remove()}
      type="button"
    >
      <Trash2 aria-hidden size={16} />
      {status === "error" ? "Failed — retry" : "Delete"}
    </button>
  );
}
