import { createDb } from "@frameos-cloud/db";
import { AiUsageSections } from "../../../src/components/AiUsageSections";
import { StorageUsageMeters } from "../../../src/components/StorageUsageMeters";
import { getLegalEntity } from "../../../src/lib/legal";
import { readSession } from "../../../src/lib/session";
import { accountUsage } from "../../../src/lib/usage";

export const metadata = { title: "Usage" };

// Everything the account uses, on one page: the storage and frame quotas
// (the meters that used to sit in the account header), then AI usage with
// its switch (AiUsageSections), then where to ask for more. Every number
// comes from the same accountUsage() the quota refusals read.
export default async function AccountUsagePage() {
  const session = await readSession();
  const accountId = session?.accountId;
  if (!accountId) {
    return (
      <section className="card">
        <p className="copy">Sign in to see your usage.</p>
      </section>
    );
  }
  const db = createDb();
  const usage = await accountUsage(db, accountId);
  const contactEmail = getLegalEntity().contactEmail;

  return (
    <>
      <section className="card">
        <h2>Storage and frames</h2>
        <p className="copy">
          What this account holds, against what the {usage.plan.name} plan allows. Published scenes are free and
          listed for completeness.
        </p>
        <StorageUsageMeters showAiLink={false} usage={usage} />
      </section>

      <section className="card" id="ai">
        <h2>AI usage</h2>
        <p className="copy">
          What the AI features cost this account, where it went, and the switch that turns them off.
        </p>
      </section>
      <AiUsageSections accountId={accountId} />

      <section className="card">
        <h2>Need more?</h2>
        <p className="copy">
          More storage, more frames, or a bigger daily AI allowance: tell us what you are building and we will sort
          it out.{" "}
          {contactEmail ? (
            <>
              Write to <a href={`mailto:${contactEmail}`}>{contactEmail}</a>.
            </>
          ) : (
            "Contact us through the address in the footer."
          )}
        </p>
      </section>
    </>
  );
}
