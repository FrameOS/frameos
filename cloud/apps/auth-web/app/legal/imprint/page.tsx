import {
  getLegalEntity,
  getSupervisoryAuthority,
  placeholder,
} from "../../../src/lib/legal";

export const metadata = { title: "Imprint" };

// Required by the e-Commerce Directive (art. 5) and, for a Belgian operator,
// book III of the Code of Economic Law: a visitor must be able to find out
// who is behind the service and how to reach them, without signing up first.

export default function ImprintPage() {
  const entity = getLegalEntity();
  const authority = getSupervisoryAuthority();
  const incomplete = entity.name === placeholder;

  return (
    <>
      <h1>Imprint</h1>
      <p className="copy">
        Information about the operator of FrameOS Cloud, as required by
        European and Belgian law.
      </p>

      {incomplete ? (
        <p className="notice-error" role="alert">
          This imprint is not yet complete. The operator has not configured its
          legal identity ({placeholder} below). Set the{" "}
          <code>FRAMEOS_LEGAL_*</code> environment variables before opening
          signups to the public.
        </p>
      ) : null}

      <h2>Operator</h2>
      <dl className="legal-facts">
        <dt>Company</dt>
        <dd>{entity.name}</dd>

        <dt>Address</dt>
        <dd>
          {entity.address.map((line) => (
            <span key={line}>
              {line}
              <br />
            </span>
          ))}
          {entity.country}
        </dd>

        <dt>Represented by</dt>
        <dd>{entity.representative}</dd>

        <dt>Enterprise number (KBO/BCE)</dt>
        <dd>{entity.companyNumber}</dd>

        <dt>VAT number</dt>
        <dd>{entity.vatNumber}</dd>

        <dt>Email</dt>
        <dd>
          <a href={`mailto:${entity.contactEmail}`}>{entity.contactEmail}</a>
        </dd>
      </dl>

      <h2>Services offered</h2>
      <p className="copy">
        FrameOS Cloud is a hosted service for managing FrameOS e-ink picture
        frames: linking devices, storing and deploying scenes, keeping backups,
        and publishing scenes to the Scene Store. FrameOS itself is free and
        open-source software; you can also run all of it yourself, without this
        service.
      </p>

      <h2>Data protection</h2>
      <p className="copy">
        The controller for personal data processed through this service is the
        company named above. What we collect and why is set out in the{" "}
        <a href="/legal/privacy">Privacy Policy</a>. Data-protection questions
        and requests go to{" "}
        <a href={`mailto:${entity.contactEmail}`}>{entity.contactEmail}</a>.
      </p>
      <p className="copy">
        Supervisory authority:{" "}
        <a href={authority.url} rel="noreferrer noopener" target="_blank">
          {authority.name}
        </a>
        .
      </p>

      <h2>Dispute resolution</h2>
      <p className="copy">
        We are not obliged to, and do not, participate in dispute resolution
        proceedings before a consumer arbitration board. If something has gone
        wrong, write to us first — we prefer to sort it out with you directly.
      </p>

      <h2>Responsibility for content and links</h2>
      <p className="copy">
        Scenes published to the Scene Store are created by their authors, not
        by us. We moderate what is published and remove content that breaks the{" "}
        <a href="/legal/terms">Terms of Service</a>, but we do not pre-approve
        every scene, and we are not responsible for the content of external
        sites a scene or a page here links to.
      </p>
    </>
  );
}
