import { createDb } from "@frameos-cloud/db";
import { AiUsageSections } from "../../../src/components/AiUsageSections";
import { StorageUsageMeters } from "../../../src/components/StorageUsageMeters";
import { getSupportEmail } from "../../../src/lib/legal";
import { readSession } from "../../../src/lib/session";
import { accountUsage } from "../../../src/lib/usage";

export const metadata = { title: "Usage" };

// Everything the account uses, on one page. Account usage first: the storage
// and frame quotas (the meters that used to sit in the account header) and
// where to ask for more. Then AI usage with its switch (AiUsageSections) and
// how pricing works. Every number comes from the same accountUsage() the
// quota refusals read.
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
  const contactEmail = getSupportEmail();

  return (
    <>
      <h2 className="page-section-title">Account usage</h2>

      <section className="card">
        <h2>Storage and frames</h2>
        <StorageUsageMeters showAiLink={false} size="large" usage={usage} />
      </section>

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

      <h2 className="page-section-title page-section-title--spaced">AI usage</h2>

      <AiUsageSections accountId={accountId} />
    </>
  );
}
