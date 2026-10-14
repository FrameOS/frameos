import { ActivityFeed } from "../../../src/components/ActivityFeed";
import { activityGroups } from "../../../src/lib/account-activity";
import { readSession } from "../../../src/lib/session";

export const metadata = { title: "Recent activity" };

// Everything recorded on this account, newest first. The feed itself is
// client-rendered (ActivityFeed) over /api/account/activity: the chart you
// drag to pick a time range, the filters and the cursor-paged list all read
// from that one route.
export default async function AccountActivityPage() {
  const session = await readSession();
  const groups = Object.entries(activityGroups).map(([value, group]) => ({
    label: group.label,
    value,
  }));

  return (
    <section className="section-block">
      <div className="content-header compact-header">
        <div>
          <h2>Recent activity</h2>
          <p className="copy">
            Everything recorded on this account: sign-ins, device links, frame
            changes, backups and store activity.
          </p>
        </div>
      </div>
      {session?.accountId ? (
        <ActivityFeed groups={groups} />
      ) : (
        <section className="card">
          <p>Sign in to see your activity.</p>
        </section>
      )}
    </section>
  );
}
