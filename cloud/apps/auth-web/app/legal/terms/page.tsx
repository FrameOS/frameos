import { getLegalEntity, placeholder } from "../../../src/lib/legal";

export const metadata = { title: "Terms of Service" };

const lastUpdated = "15 August 2026";

export default function TermsPage() {
  const entity = getLegalEntity();
  const incomplete = entity.name === placeholder;

  return (
    <>
      <h1>Terms of Service</h1>
      <p className="copy">
        Last updated: {lastUpdated}. These terms are the agreement between you
        and {entity.name} for the use of FrameOS Cloud. We have tried to write
        them so you can actually read them.
      </p>

      {incomplete ? (
        <p className="notice-error" role="alert">
          The operator has not yet configured its legal identity, so the
          company details below read {placeholder}. Set the{" "}
          <code>FRAMEOS_LEGAL_*</code> environment variables before opening
          signups to the public.
        </p>
      ) : null}

      <h2>1. What this service is</h2>
      <p className="copy">
        FrameOS Cloud is a hosted service for FrameOS e-ink picture frames. It
        lets you link frames and FrameOS installations to an account, write and
        deploy scenes to them, keep backups, and publish scenes to the Scene
        Store.
      </p>
      <p className="copy">
        FrameOS itself is free and open-source software (AGPL-3.0). Nothing
        here obliges you to use this service: you can run the whole thing
        yourself, and your frames will work without us. That is deliberate, and
        it is the safety net behind every other clause on this page.
      </p>

      <h2>2. Your account</h2>
      <p className="copy">
        You need an account, and you must give a real email address and verify
        it — password resets and security notices depend on it. You are
        responsible for keeping your password to yourself and for what happens
        under your account. Tell us promptly if you think someone else has got
        in.
      </p>
      <p className="copy">
        You must be at least 16 years old. One person or organisation per
        account; do not share credentials with people who should not have your
        access.
      </p>

      <h2>3. What it costs</h2>
      <p className="copy">
        FrameOS Cloud is currently free to use. If we introduce paid plans, we
        will say so clearly before you are asked for anything, existing
        accounts will keep working, and no charge will ever appear without you
        agreeing to it first. If you are a consumer in the EU, your statutory
        right of withdrawal applies to any future paid subscription and we will
        set out how to use it at the point of sale.
      </p>
      <p className="copy">
        There are no published quotas yet. We may set fair-use limits on frame
        count, storage and backup size; we will announce them before enforcing
        them, and they will not be set so as to strand data you have already
        stored.
      </p>

      <h2>4. Your content stays yours</h2>
      <p className="copy">
        You keep every right you have in the scenes, images, files and
        configuration you put into FrameOS Cloud. We claim no ownership.
      </p>
      <p className="copy">
        To run the service we need a licence to do the obvious things with it:
        store it, back it up, transmit it to your frames, and display it back
        to you. So you grant us a worldwide, non-exclusive, royalty-free
        licence to host, copy and transmit your content{" "}
        <strong>for the sole purpose of operating the service for you</strong>.
        It ends when you delete the content or your account. We do not use your
        private content to train models, and we do not show it to anyone else.
      </p>
      <p className="copy">
        Publishing a scene to the Scene Store is different, and it is your
        choice: a published scene is visible to everyone and downloadable,
        installable and modifiable by anyone, along with its name, description,
        preview images and your display name. You grant that licence to the
        public, not to us, and you cannot take it back from people who already
        downloaded it. Unpublishing removes it from the store going forward.
      </p>
      <p className="copy">
        Only publish what you have the rights to publish. If a scene includes
        someone else&rsquo;s code, images or fonts, make sure their licence
        allows it.
      </p>

      <h2>5. What you must not do</h2>
      <ul className="copy">
        <li>Break the law, or help anyone else break it.</li>
        <li>
          Upload or publish content that is illegal, infringes someone
          else&rsquo;s rights, sexualises minors, or is designed to harass a
          person or group.
        </li>
        <li>
          Upload malware, or publish a scene that does something other than
          what it says it does.
        </li>
        <li>
          Attack the service: no attempts to break authentication, access other
          accounts, overload the infrastructure, or scrape it wholesale. Good
          faith security research is welcome — tell us at{" "}
          <a href={`mailto:${entity.contactEmail}`}>{entity.contactEmail}</a>{" "}
          before publishing, and we will not come after you for it.
        </li>
        <li>
          Circumvent rate limits, quotas or abuse checks, or create accounts in
          bulk.
        </li>
        <li>Resell the service as if it were yours.</li>
      </ul>

      <h2>6. Moderation</h2>
      <p className="copy">
        Scenes submitted to the Scene Store are screened automatically and may
        be reviewed by us. We may refuse, unpublish, or remove content that
        breaks these terms, and in serious or repeated cases suspend an
        account&rsquo;s ability to publish, or the account itself.
      </p>
      <p className="copy">
        We will tell you why, and you can appeal by replying to us — a human
        will look at it. If content is removed because it is illegal rather
        than merely against these terms, we may be required to keep a record of
        it and to inform the authorities. Anyone can report a scene using the
        report button on its page.
      </p>

      <h2>7. Availability</h2>
      <p className="copy">
        We run this carefully — monitored, backed up, and with restores
        rehearsed — but we do not promise any particular uptime, and there is
        no SLA. There will be maintenance, and there will be outages. We will
        avoid unannounced downtime where we reasonably can.
      </p>
      <p className="copy">
        Your frames do not depend on us to keep displaying what they already
        have. If this service disappeared tomorrow, your hardware would keep
        working and the software to run it yourself is public.
      </p>

      <h2>8. Ending it</h2>
      <p className="copy">
        You can stop at any moment: delete your account from the{" "}
        <a href="/account/security">account security page</a>. It takes effect
        immediately and removes your data — export it first if you want a copy
        (there is a button on the same page).
      </p>
      <p className="copy">
        We may suspend or close an account that seriously or repeatedly breaks
        these terms, or where we must for legal reasons. Except where the law
        or an ongoing abuse makes that impossible, we will warn you first and
        give you a chance to export your data. If we discontinue the service
        entirely, we will give you at least 30 days&rsquo; notice and a way to
        get your data out.
      </p>

      <h2>9. Warranties and liability</h2>
      <p className="copy">
        The service is provided as is. To the extent the law allows, we exclude
        implied warranties and are not liable for indirect or consequential
        loss, lost profits, or lost data beyond what our backups hold.
      </p>
      <p className="copy">
        We do <strong>not</strong> exclude or limit liability for death or
        personal injury caused by our negligence, for fraud or fraudulent
        misrepresentation, for gross negligence or wilful misconduct, or for
        anything else that cannot be limited under Belgian or EU law. If you
        are a consumer, your mandatory statutory rights are unaffected by
        anything on this page.
      </p>
      <p className="copy">
        Keep your own backups of anything you cannot afford to lose. The export
        button exists for exactly this.
      </p>

      <h2>10. Changes to these terms</h2>
      <p className="copy">
        We may update these terms. If a change materially affects you, we will
        notify you by email or in the app at least 30 days before it takes
        effect, and if you do not accept it you can close your account before
        then. Continuing to use the service after that date means you accept
        the new terms.
      </p>

      <h2>11. Law and jurisdiction</h2>
      <p className="copy">
        Belgian law applies, and the courts of the district where{" "}
        {entity.name} has its registered office have jurisdiction. If you are a
        consumer, this does not deprive you of the protection of the mandatory
        law of the country you live in, and you may also bring proceedings in
        your own country&rsquo;s courts.
      </p>

      <h2>12. Contact</h2>
      <p className="copy">
        Questions about these terms:{" "}
        <a href={`mailto:${entity.contactEmail}`}>{entity.contactEmail}</a>.
        Full company details are on the <a href="/legal/imprint">imprint</a>,
        and what we do with your data is in the{" "}
        <a href="/legal/privacy">Privacy Policy</a>, which forms part of this
        agreement.
      </p>
    </>
  );
}
