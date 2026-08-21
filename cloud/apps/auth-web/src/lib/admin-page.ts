import { redirect } from "next/navigation";
import { getSuperadminContext } from "./admin";

// Every /admin page starts the same way: prove superadmin or leave. Returns
// the signed-in superadmin's account id.
export async function requireSuperadmin(returnTo: string): Promise<string> {
  const context = await getSuperadminContext();
  if (context.kind === "unauthenticated") {
    redirect(`/login?return_to=${encodeURIComponent(returnTo)}`);
  }
  if (context.kind === "forbidden") {
    redirect("/account");
  }
  return context.accountId;
}

export function searchQueryOf(
  params: Record<string, string | string[] | undefined>,
): string | undefined {
  const raw = Array.isArray(params.q) ? params.q[0] : params.q;
  return raw?.trim() || undefined;
}
