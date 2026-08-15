// The operator's legal identity, and the list of processors that see user
// data. Both are facts about the deployment, not about the code, so they come
// from the environment — a self-hoster running this AGPL codebase must not
// end up publishing FrameOS's company details as their own imprint.
//
// Anything unset renders as a visible "[TO BE COMPLETED]" marker rather than
// silently disappearing. A privacy policy with a quietly missing controller
// name is worse than one that says out loud it is incomplete: the missing
// name is exactly the part the law requires.

export const placeholder = "[TO BE COMPLETED]";

function entityValue(name: string) {
  return process.env[name]?.trim() || placeholder;
}

function optionalEntityValue(name: string) {
  return process.env[name]?.trim() || undefined;
}

export type LegalEntity = {
  /** Free-form postal address, one array entry per line. */
  address: string[];
  /** Belgian KBO/BCE enterprise number. */
  companyNumber: string;
  country: string;
  /** Where data-protection and legal notices should be sent. */
  contactEmail: string;
  /** Legal form + name, e.g. "Example Frames BV". */
  name: string;
  /** Natural person(s) representing the company. */
  representative: string;
  vatNumber: string;
};

export function getLegalEntity(): LegalEntity {
  const address = process.env.FRAMEOS_LEGAL_ENTITY_ADDRESS?.trim();
  return {
    // Newline or "|" separated so a single env var can hold a postal address.
    address: address
      ? address
          .split(/\r?\n|\|/)
          .map((line) => line.trim())
          .filter(Boolean)
      : [placeholder],
    companyNumber: entityValue("FRAMEOS_LEGAL_COMPANY_NUMBER"),
    contactEmail: entityValue("FRAMEOS_LEGAL_CONTACT_EMAIL"),
    country: process.env.FRAMEOS_LEGAL_ENTITY_COUNTRY?.trim() || "Belgium",
    name: entityValue("FRAMEOS_LEGAL_ENTITY_NAME"),
    representative: entityValue("FRAMEOS_LEGAL_REPRESENTATIVE"),
    vatNumber: entityValue("FRAMEOS_LEGAL_VAT_NUMBER"),
  };
}

export function isLegalEntityConfigured() {
  return Boolean(process.env.FRAMEOS_LEGAL_ENTITY_NAME?.trim());
}

// Where a data subject complains. Belgium by default, matching the default
// establishment; a deployment in another member state overrides it.
export function getSupervisoryAuthority() {
  return {
    name:
      optionalEntityValue("FRAMEOS_LEGAL_SUPERVISORY_AUTHORITY") ??
      "Belgian Data Protection Authority (Gegevensbeschermingsautoriteit / Autorité de protection des données)",
    url:
      optionalEntityValue("FRAMEOS_LEGAL_SUPERVISORY_AUTHORITY_URL") ??
      "https://www.dataprotectionauthority.be/",
  };
}

export type Processor = {
  /** What it does for us, in plain language. */
  purpose: string;
  data: string;
  location: string;
  name: string;
  /** True when the processor only runs if an optional feature is enabled. */
  optional?: boolean;
  privacyUrl: string;
};

// Every third party that can see personal data, audited against the code:
// grep for outbound hosts in apps/auth-web and apps/frame-hub. Keep this list
// in step with that — it is the promise the privacy policy makes, and a
// processor added in code but not here is a straightforward GDPR breach.
export const processors: Processor[] = [
  {
    data: "Everything you store: account, frames, scenes, uploaded files, backups.",
    location: "Germany (EU)",
    name: "Hetzner Online GmbH",
    privacyUrl: "https://www.hetzner.com/legal/privacy-policy/",
    purpose: "Hosting of the servers and the encrypted off-site backups.",
  },
  {
    data: "Pages visited, clicks, and error reports. Never page URLs that contain a token, and never element attributes.",
    location: "EU region (eu.i.posthog.com)",
    name: "PostHog",
    privacyUrl: "https://posthog.com/privacy",
    purpose:
      "Product analytics and error tracking — how the service is used and what breaks.",
  },
  {
    data: "Your email address and the message body.",
    location: "United States",
    name: "Postmark (ActiveCampaign)",
    privacyUrl: "https://postmarkapp.com/eu-privacy",
    purpose:
      "Sending account email: address verification and password resets.",
  },
  {
    data: "Your IP address and a challenge token. No account data.",
    location: "Global network",
    name: "Cloudflare",
    privacyUrl: "https://www.cloudflare.com/privacypolicy/",
    purpose:
      "Content delivery and the anti-abuse check on the signup and password-reset forms.",
  },
  {
    data: "The text and images you submit for publication, and your prompts.",
    location: "United States",
    name: "OpenAI",
    optional: true,
    privacyUrl: "https://openai.com/policies/privacy-policy",
    purpose:
      "Moderating and categorising scenes published to the Scene Store, and answering AI chat requests you start.",
  },
  {
    data: "Your Google account identifier and email address.",
    location: "United States",
    name: "Google",
    optional: true,
    privacyUrl: "https://policies.google.com/privacy",
    purpose:
      "Sign-in with Google — only if you choose that button instead of a password.",
  },
];
