import {
  getLegalEntity,
  getSupervisoryAuthority,
  placeholder,
  processors,
} from "../../../src/lib/legal";

export const metadata = { title: "Privacy Policy" };

// GDPR arts. 13-14: what is collected, why, on what legal basis, who else
// sees it, how long it is kept, and what the data subject can do about it.
// Written to be read by a person rather than by a lawyer, which the GDPR
// actually requires ("concise, transparent, intelligible... clear and plain
// language", art. 12(1)) — the dense version is not the compliant one.

const lastUpdated = "15 August 2026";

export default function PrivacyPage() {
  const entity = getLegalEntity();
  const authority = getSupervisoryAuthority();
  const incomplete = entity.name === placeholder;

  return (
    <>
      <h1>Privacy Policy</h1>
      <p className="copy">
        Last updated: {lastUpdated}. This explains what FrameOS Cloud does with
        your data, in plain language. The short version: we collect what the
        service needs to work, we sell nothing, and you can take your data and
        leave at any time.
      </p>

      {incomplete ? (
        <p className="notice-error" role="alert">
          The operator has not yet configured its legal identity, so the
          controller details below read {placeholder}. Set the{" "}
          <code>FRAMEOS_LEGAL_*</code> environment variables before opening
          signups to the public.
        </p>
      ) : null}

      <h2>Who is responsible</h2>
      <p className="copy">
        The controller is {entity.name}, {entity.address.join(", ")},{" "}
        {entity.country}. For anything in this policy — including the requests
        described under &ldquo;Your rights&rdquo; — write to{" "}
        <a href={`mailto:${entity.contactEmail}`}>{entity.contactEmail}</a>. We
        are small enough that a real person reads that address.
      </p>
      <p className="copy">
        We have not appointed a Data Protection Officer: we are not a public
        body, our core activity is not large-scale monitoring, and we do not
        process special categories of data at scale, so art. 37 GDPR does not
        require one.
      </p>

      <h2>What we collect, and why</h2>

      <h3>Your account</h3>
      <p className="copy">
        Your email address, an optional display name, and a hash of your
        password (or, if you sign in with Google, your Google account
        identifier instead). We need this to have an account at all, so the
        legal basis is <strong>performance of a contract</strong> (art. 6(1)(b)
        GDPR). Without it there is no service. We verify the email address
        because password resets and security notices have to reach the real
        owner of the account.
      </p>

      <h3>Your frames, scenes and files</h3>
      <p className="copy">
        Whatever you put into the service: the frames you link, the scenes you
        write or install, the images and files you upload, your device settings
        and schedules, backups of your FrameOS installations, and the logs and
        metrics your frames report. Also <strong>performance of a contract</strong> —
        this is the thing you signed up for. Private scenes are private; a
        scene becomes public only when you publish it.
      </p>

      <h3>Security and abuse prevention</h3>
      <p className="copy">
        We record an audit trail of security-relevant actions (sign-ins, device
        approvals, token rotations, scene publishing, deletions) with the IP
        address the request came from, and we rate-limit by IP address. The
        signup and password-reset forms run an anti-abuse check. The legal
        basis is our <strong>legitimate interest</strong> (art. 6(1)(f)) in
        keeping accounts from being taken over and the service from being
        flooded — an interest you share.
      </p>

      <h3>Analytics and error reports</h3>
      <p className="copy">
        If — and only if — you agree to it, we record which pages you visit and
        what you click, plus automatic reports when something goes wrong in
        your browser. The legal basis is your <strong>consent</strong> (art.
        6(1)(a)), which you can withdraw at any time from the cookie banner
        without giving a reason and without losing anything else. Decline and
        the analytics code never loads.
      </p>
      <p className="copy">
        Even with consent, we deliberately strip the parts that would be
        sensitive: URLs that carry a token (a password-reset link, a private
        scene&rsquo;s share link) are redacted before they leave your browser,
        element attributes are never captured, and pages that list other
        people&rsquo;s email addresses are excluded entirely.
      </p>
      <p className="copy">
        Errors that happen on <em>our servers</em> are logged and reported
        without your consent and without your identity attached, on the basis
        of our <strong>legitimate interest</strong> in the service working at
        all. Those reports contain the error and the operation that failed, not
        your content.
      </p>

      <h2>Cookies and similar storage</h2>
      <p className="copy">We use as few as we can get away with:</p>
      <ul className="copy">
        <li>
          <strong>Session cookie</strong> — proves you are signed in. Strictly
          necessary; no consent needed, and it disappears when you sign out.
        </li>
        <li>
          <strong>Theme and consent preferences</strong> — remembers dark mode
          and remembers what you answered on the cookie banner, so it does not
          ask again. Strictly necessary for a function you asked for.
        </li>
        <li>
          <strong>Analytics storage</strong> — set by PostHog only after you
          accept. Declining leaves it unset.
        </li>
      </ul>

      <h2>Who else sees your data</h2>
      <p className="copy">
        We do not sell your data and we do not share it for anyone
        else&rsquo;s advertising. We do use a small number of service providers
        who process data on our behalf, under contract (art. 28 GDPR), and only
        on our instructions:
      </p>
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Provider</th>
              <th>What it does</th>
              <th>What it sees</th>
              <th>Where</th>
            </tr>
          </thead>
          <tbody>
            {processors.map((processor) => (
              <tr key={processor.name}>
                <td>
                  <a
                    href={processor.privacyUrl}
                    rel="noreferrer noopener"
                    target="_blank"
                  >
                    {processor.name}
                  </a>
                  {processor.optional ? (
                    <>
                      <br />
                      <small>only for the feature described</small>
                    </>
                  ) : null}
                </td>
                <td className="copy">{processor.purpose}</td>
                <td className="copy">{processor.data}</td>
                <td>{processor.location}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="copy">
        Your account and everything in it is stored in the EU. Where a provider
        above is outside the EEA, the transfer is covered by the European
        Commission&rsquo;s Standard Contractual Clauses and, for US providers,
        by the EU-US Data Privacy Framework where they are certified.
      </p>
      <p className="copy">
        We will also disclose data if a law or a valid court order requires it.
        If that ever happens and we are allowed to tell you, we will.
      </p>

      <h2>Public by your choice</h2>
      <p className="copy">
        Scenes you publish to the Scene Store are public: their name,
        description, preview images, contents, and your display name as the
        publisher are visible to everyone and downloadable by anyone. Your
        email address is never shown. Unpublishing removes a scene from the
        store, but copies other people already downloaded are theirs.
      </p>

      <h2>How long we keep things</h2>
      <ul className="copy">
        <li>
          <strong>Account data</strong> — until you delete your account. Then
          it goes, along with your frames, scenes, files and backups.
        </li>
        <li>
          <strong>Sessions</strong> — until they expire or you sign out.
        </li>
        <li>
          <strong>Security audit trail</strong> — kept after account deletion
          with your account identifier removed, because a security log you can
          erase on request is not a security log. It no longer points at you.
        </li>
        <li>
          <strong>Backups</strong> — the off-site backups roll over on a
          30-day cycle, so deleted data survives in them for up to 30 days
          before being overwritten. We do not restore backups to recover
          deleted accounts.
        </li>
        <li>
          <strong>Analytics</strong> — retained by PostHog under their standard
          retention.
        </li>
      </ul>

      <h2>Your rights</h2>
      <p className="copy">
        Under the GDPR you have the right to access your data, correct it, have
        it erased, restrict or object to how we use it, receive it in a
        portable format, and withdraw any consent you have given. Two of those
        do not need to involve us at all:
      </p>
      <ul className="copy">
        <li>
          <strong>Export</strong> — download everything on your account as a
          JSON file from your{" "}
          <a href="/account/security">account security page</a>, any time.
        </li>
        <li>
          <strong>Deletion</strong> — delete your account from the same page.
          It is immediate and permanent; nothing waits on us.
        </li>
      </ul>
      <p className="copy">
        For anything else, email{" "}
        <a href={`mailto:${entity.contactEmail}`}>{entity.contactEmail}</a>. We
        answer within one month, as art. 12(3) requires. There is no charge.
      </p>
      <p className="copy">
        If you think we have got this wrong, you can complain to a supervisory
        authority — for us that is the{" "}
        <a href={authority.url} rel="noreferrer noopener" target="_blank">
          {authority.name}
        </a>
        , or the authority where you live. We would rather you told us first.
      </p>

      <h2>Automated decisions</h2>
      <p className="copy">
        We do not make decisions about you by automated means with legal or
        similarly significant effects. Scenes submitted to the Scene Store are
        screened automatically for illegal and abusive content, and a rejection
        there can be appealed by writing to us — a human will look.
      </p>

      <h2>Children</h2>
      <p className="copy">
        FrameOS Cloud is not directed at children and we do not knowingly
        create accounts for anyone under 16. If you believe a child has an
        account here, tell us and we will remove it.
      </p>

      <h2>Security</h2>
      <p className="copy">
        Passwords are stored hashed, never in plain text. Traffic is encrypted
        in transit. Credentials for your linked FrameOS installations are
        encrypted at rest. Backups are encrypted in transit and stored on
        access-controlled infrastructure in the EU. No system is perfect; if we
        ever suffer a breach that puts you at risk, we will notify you and the
        supervisory authority as arts. 33-34 require.
      </p>

      <h2>Changes</h2>
      <p className="copy">
        If we change this policy in a way that matters, we will tell you by
        email or in the app before the change takes effect. The date at the top
        always says when it last changed.
      </p>
    </>
  );
}
