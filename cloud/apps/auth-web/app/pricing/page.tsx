import { createDb } from "@frameos-cloud/db";
import { fallbackPaygPlan, listPlans, paygPlanCode } from "@frameos-cloud/ledger";
import { PublicShell } from "../../src/components/PublicShell";
import { getAccountSettingsUrl, getCloudBaseUrl, hasDatabaseUrl } from "../../src/lib/env";
import { formatBytes } from "../../src/lib/format";
import { getSupportEmail } from "../../src/lib/legal";
import {
  catalogLimits,
  planGroups,
  plannedFeatures,
  type CatalogLimits,
  type PlanFeature,
} from "../../src/lib/plan-catalog";
import { readSession } from "../../src/lib/session";
import { accountIsSuperadmin } from "../../src/lib/superadmin";
import { freeTierLimits, limitsForPlan, type PlanLimits } from "../../src/lib/usage";

export const metadata = {
  description:
    "What FrameOS Cloud costs: a free plan for the frames you own, and paid plans from $2 a month with room for more frames and files.",
  title: "Pricing",
};
export const dynamic = "force-dynamic";

// The public price list. Readable signed out, because a price nobody can
// see before making an account is not a price. Every number comes from the
// same catalog (src/lib/plan-catalog.ts) the usage page's cards and the
// quota refusals read, so this page cannot promise what the service does
// not enforce.

const featureLabels: Record<PlanFeature, string> = {
  dedicated_support: "Dedicated support",
  priority_support: "Priority support",
  share_frames: "Share frames with the people on your plan",
  sso: "Single sign-on with SAML",
  virtual_frames: "Virtual frames, and thin clients like the Inky Frame",
};

// The same features, as a list of what is still to come.
const plannedLabels: Partial<Record<PlanFeature, string>> = {
  share_frames: "sharing frames with the people on your plan",
  sso: "single sign-on with SAML",
  virtual_frames: "virtual frames and thin clients like the Inky Frame",
};

const groupIntro: Record<string, string> = {
  business: "For teams, shops and offices running many frames.",
  free: "For the frames you own. No card needed.",
  private: "For a home with more frames or more photos than Free holds.",
};

// The free plan's numbers on this deployment. Without a database (a build,
// a broken connection) the page still has a price list: the built-in floor.
async function freePlanLimits(): Promise<PlanLimits> {
  if (!hasDatabaseUrl()) {
    return freeTierLimits;
  }
  try {
    const plans = await listPlans(createDb());
    return limitsForPlan(plans.find((plan) => plan.code === paygPlanCode) ?? fallbackPaygPlan);
  } catch {
    return freeTierLimits;
  }
}

// A price list rolls over to GB at 1000 MB, so ten times 100 MB reads "1.0 GB".
function planBytes(bytes: number): string {
  const gigabyte = 1024 * 1024 * 1024;
  return bytes >= 1000 * 1024 * 1024 && bytes < gigabyte
    ? `${(bytes / gigabyte).toFixed(1)} GB`
    : formatBytes(bytes);
}

function limitCells(limits: CatalogLimits): string[] {
  return [
    limits.frames.toLocaleString("en-US"),
    planBytes(limits.photoBytes),
    planBytes(limits.privateSceneBytes),
    planBytes(limits.backupBytes),
    planBytes(limits.frameLogBytes),
  ];
}

export default async function PricingPage() {
  const session = await readSession();
  const signedIn = Boolean(session);
  const [isSuperadmin, free] = await Promise.all([
    accountIsSuperadmin(session?.accountId),
    freePlanLimits(),
  ]);
  const supportEmail = getSupportEmail();
  const cloudBaseUrl = getCloudBaseUrl();
  const signupUrl = new URL("/signup", cloudBaseUrl).toString();
  const plansUrl = getAccountSettingsUrl("usage");
  const legalUrl = (path: string) => new URL(path, cloudBaseUrl).toString();
  const planned = (feature: PlanFeature) => plannedFeatures.includes(feature);

  return (
    <PublicShell brand="cloud" isSuperadmin={isSuperadmin} signedIn={signedIn} title="Pricing">
      <article className="section-block pricing">
        <h1>Pricing</h1>
        <p className="copy pricing__lead">
          FrameOS Cloud runs your FrameOS smart frames from the browser. Link an
          e-paper or LCD frame built on a Raspberry Pi or an ESP32, choose what
          it shows from the scene store or build a scene of your own, play your
          photo albums on it, and keep backups.
        </p>
        <p className="copy">
          <strong>FrameOS is free and open source</strong>, all of it: the
          software on your frame, the backend you can host at home, and the
          code behind this service. You never have to pay to use it. A frame
          on its own or a{" "}
          <a href="https://frameos.net/guide/backend">backend you host yourself</a>{" "}
          costs nothing and has no limits but your own hardware.
        </p>
        <p className="copy">
          FrameOS Cloud is for people who would rather not host anything, and
          it is mostly free too. The Free plan is meant to be all a household
          needs, with no card and no time limit. Hosting is the one part that
          costs money every month, so we charge when usage gets big: a paid
          plan buys room for more frames and more files, never a feature held
          back from free accounts.
        </p>

        <div className="pricing__groups">
          {planGroups.map((group) => {
            const stops = group.stops.map((stop) => ({ limits: catalogLimits(free, stop), stop }));
            const live = group.features.filter((feature) => !planned(feature));
            const later = (group.featuresFrom ?? []).filter((extra) => !planned(extra.feature));
            const coming = [
              ...group.features.filter(planned),
              ...(group.featuresFrom ?? []).map((extra) => extra.feature).filter(planned),
            ];
            const first = group.stops[0]?.usd ?? 0;
            const last = group.stops.at(-1)?.usd ?? 0;
            return (
              <section className="card pricing__group" data-plan={group.key} key={group.key}>
                <div className="pricing__group-head">
                  <div>
                    <h2>{group.name}</h2>
                    <p className="copy">{groupIntro[group.key]}</p>
                  </div>
                  <p className="pricing__price">
                    {first === last ? `$${first}` : `$${first} to $${last}`}
                    <span> a month</span>
                  </p>
                </div>
                <div className="pricing__table-wrap">
                  <table className="table pricing__table">
                    <thead>
                      <tr>
                        <th>Price a month</th>
                        <th>Frames</th>
                        <th>Photos</th>
                        <th>Private scenes</th>
                        <th>Backups</th>
                        <th>Frame logs</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stops.map(({ limits, stop }) => (
                        <tr key={stop.usd}>
                          <th scope="row">${stop.usd}</th>
                          {limitCells(limits).map((cell, index) => (
                            <td key={index}>{cell}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <ul className="pricing__features">
                  {group.key === "free" ? (
                    <>
                      <li>Frames you own, from a Raspberry Pi to an ESP32</li>
                      <li>The scene store and the scene editor</li>
                      <li>Photo albums and backups</li>
                    </>
                  ) : (
                    <li>Everything in {group.key === "business" ? "Private" : "Free"}</li>
                  )}
                  {live.map((feature) => (
                    <li key={feature}>{featureLabels[feature]}</li>
                  ))}
                  {later.map((extra) => (
                    <li key={extra.feature}>
                      {featureLabels[extra.feature]} at ${extra.usd} a month
                    </li>
                  ))}
                </ul>
                {coming.length > 0 ? (
                  <p className="copy pricing__planned">
                    Planned, not available yet and not part of what you pay for
                    today: {coming.map((feature) => plannedLabels[feature] ?? featureLabels[feature]).join("; ")}.
                  </p>
                ) : null}
                <p className="pricing__cta">
                  {group.key === "free" ? (
                    <a className="button button-primary" href={signedIn ? plansUrl : signupUrl}>
                      {signedIn ? "Go to your account" : "Create a free account"}
                    </a>
                  ) : group.selfServe ? (
                    <a className="button button-primary" href={signedIn ? plansUrl : signupUrl}>
                      {signedIn ? `Choose ${group.name}` : `Sign up, then choose ${group.name}`}
                    </a>
                  ) : supportEmail ? (
                    <a
                      className="button"
                      href={`mailto:${supportEmail}?subject=${encodeURIComponent(`FrameOS Cloud ${group.name}`)}`}
                    >
                      Contact us about {group.name}
                    </a>
                  ) : null}
                </p>
              </section>
            );
          })}
        </div>

        <h2 id="support">Paying is how you support FrameOS</h2>
        <p className="copy">
          FrameOS is a bootstrapped project. There are no investors behind it,
          no ads in it, and nothing about you or your frames is sold to anyone.
          The servers and the time that goes into the software are paid for by
          the people who choose a paid plan.
        </p>
        <p className="copy">
          So a paid plan is two things at once. If you run a lot of frames it
          is a fair price for what you use. And if you simply like FrameOS and
          want it to keep getting better, it is the most direct way to say so,
          even at $2 a month and even if the Free plan would have been enough.
        </p>

        <h2 id="how-billing-works">How billing works</h2>
        <ul className="copy">
          <li>
            A paid plan is a monthly subscription. You pay for the month ahead,
            and it renews each month until you cancel.
          </li>
          <li>
            Prices are in US dollars and do not include VAT or sales tax. Where
            tax applies it is added at checkout, and you see the total before
            you pay.
          </li>
          <li>
            Payments are handled by Creem (Armitage Labs OÜ), our merchant of
            record. Creem sells you the plan, charges your card, sends your
            receipt and invoice, and appears on your card statement. Its{" "}
            <a href="https://www.creem.io/buyer-terms" rel="noreferrer noopener" target="_blank">
              buyer terms
            </a>{" "}
            apply to the purchase.
          </li>
          <li>
            You can change plan at any time from your account. A larger plan
            starts at once and you pay the difference for the rest of the
            month. A smaller plan starts at your next renewal.
          </li>
        </ul>

        <h2 id="cancelling">Cancelling and refunds</h2>
        <ul className="copy">
          <li>
            Cancel whenever you like from the Usage page of your account, in two
            clicks. You keep the plan until the end of the month you paid for
            and are not charged again.
          </li>
          <li>
            Not happy? Write to us within 14 days of your first payment for a
            plan and we refund it in full. The details are in the{" "}
            <a href={legalUrl("/legal/refunds")}>refund policy</a>.
          </li>
          <li>
            Nothing is deleted when a plan ends. If you hold more than the Free
            plan allows you keep it all, and you cannot add more until you are
            back under the limit.
          </li>
        </ul>

        <h2 id="ai">AI</h2>
        <p className="copy">
          The scene editor has an AI assistant that writes and edits scenes for
          you. It works on every plan and costs the same on each. While FrameOS
          Cloud is in beta it is free, within a daily allowance. You can also
          add your own OpenAI key, or switch AI off for your account.
        </p>

        <h2 id="contact">Questions</h2>
        <p className="copy">
          {supportEmail ? (
            <>
              Write to <a href={`mailto:${supportEmail}`}>{supportEmail}</a>. A
              person answers, usually within two working days.{" "}
            </>
          ) : null}
          The fine print is in the <a href={legalUrl("/legal/terms")}>Terms of Service</a>, the{" "}
          <a href={legalUrl("/legal/privacy")}>Privacy Policy</a> and the{" "}
          <a href={legalUrl("/legal/refunds")}>refund policy</a>.
        </p>
      </article>
    </PublicShell>
  );
}
