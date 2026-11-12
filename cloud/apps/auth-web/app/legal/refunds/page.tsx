import { getLegalEntity, getSupportEmail } from "../../../src/lib/legal";

export const metadata = { title: "Refund policy" };

const lastUpdated = "5 November 2026";

// Short on purpose: someone reads this when they want their money back, and
// the answer should be on the first screen.
export default function RefundsPage() {
  const entity = getLegalEntity();
  const supportEmail = getSupportEmail() || entity.contactEmail;

  return (
    <>
      <h1>Refund policy</h1>
      <p className="copy">
        Last updated: {lastUpdated}. This covers the paid plans of FrameOS
        Cloud. The Free plan costs nothing, so there is nothing to refund.
      </p>

      <h2>14 days, no questions</h2>
      <p className="copy">
        If a paid plan is not for you, write to{" "}
        <a href={`mailto:${supportEmail}`}>{supportEmail}</a> within 14 days of
        your first payment for it and we refund that payment in full. You do
        not have to give a reason. The same applies the first time you move to
        a larger plan: the extra you paid for it is refunded if you ask within
        14 days.
      </p>

      <h2>Renewals</h2>
      <p className="copy">
        A plan renews every month until you cancel, and a renewal is not
        refunded once the new month has started. To stop paying, cancel before
        the renewal date: the Usage page of your account shows the date and has
        the button. You keep the plan to the end of the month you paid for.
      </p>
      <p className="copy">
        If a renewal went through that you meant to cancel, write to us within
        a few days. We look at it and are reasonable about it.
      </p>

      <h2>When we always refund</h2>
      <ul className="copy">
        <li>You were charged twice, or charged the wrong amount.</li>
        <li>You were charged after you cancelled.</li>
        <li>
          The service was unusable for a large part of the month through our
          fault. We refund the part of the month you could not use.
        </li>
      </ul>

      <h2>How a refund reaches you</h2>
      <p className="copy">
        The refund goes back to the card or account you paid with, through
        Stripe, which took the payment, with the VAT that was charged on it. It usually shows within 5 to
        10 working days. We answer refund requests within three working days.
      </p>

      <h2>Your legal rights</h2>
      <p className="copy">
        If you are a consumer in the European Union or the United Kingdom you
        have a legal right to withdraw from a subscription within 14 days of
        buying it. The 14 days above are that right, and nothing on this page
        takes away any other right the law of your country gives you.
      </p>

      <h2>Contact</h2>
      <p className="copy">
        <a href={`mailto:${supportEmail}`}>{supportEmail}</a>. Tell us the
        email address of your account. We do not need your card details and
        will never ask for them.
      </p>
    </>
  );
}
