import { redirect } from "next/navigation";
import { AppShell } from "../../src/components/AppShell";
import { DeviceApprovalPanel } from "../../src/components/DeviceApprovalPanel";
import { readSession } from "../../src/lib/session";

export const metadata = { title: "Connect this FrameOS backend" };

type DevicePageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function DevicePage({ searchParams }: DevicePageProps) {
  const params = await searchParams;
  const userCode = params?.user_code;
  const returnTo = params?.return_to;
  const initialUserCode = Array.isArray(userCode) ? userCode[0] : userCode;
  const initialReturnTo = Array.isArray(returnTo) ? returnTo[0] : returnTo;

  // Connecting a device always needs a signed-in account; go through login
  // first and come straight back to this code.
  const session = await readSession();
  if (!session?.accountId) {
    const query = new URLSearchParams();
    if (initialUserCode) {
      query.set("user_code", initialUserCode);
    }
    if (initialReturnTo) {
      query.set("return_to", initialReturnTo);
    }
    const target = `/device${query.size > 0 ? `?${query.toString()}` : ""}`;
    redirect(`/login?return_to=${encodeURIComponent(target)}`);
  }

  return (
    // noCapture: the approval panel shows the connecting install's own
    // details, and the pairing code is in this page's URL.
    <AppShell noCapture title="Connect this FrameOS backend">
      <div className="content-header">
        <div>
          <p className="copy">
            Make sure this request matches the backend you just opened.
            Approving it links the backend to your account.
          </p>
        </div>
      </div>
      <DeviceApprovalPanel
        initialReturnTo={initialReturnTo}
        initialUserCode={initialUserCode}
      />
    </AppShell>
  );
}
