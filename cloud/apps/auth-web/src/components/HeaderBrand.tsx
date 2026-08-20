import Link from "next/link";

// The lead slot of the shared cloud header (cloud-chrome.css): the cloud
// logo — light and dark renditions, CSS picks one — and the wordmark, both
// inside one link. A page may add a `title` after the wordmark; it never
// replaces it, so the wordmark sits at the same offset on every surface
// (the store header and the workspace header used to differ by the gap
// between the brand link and a detached title). The /frames SPA renders
// the same markup in cloud-frontend AccountHeader.tsx.
export function HeaderBrand({
  href,
  name = "FrameOS Cloud",
  title,
}: {
  href: string;
  name?: string;
  title?: React.ReactNode;
}) {
  return (
    <div className="frameos-account-header__lead">
      <Link
        aria-label={name}
        className="frameos-account-header__brand"
        href={href}
      >
        <img
          alt=""
          className="frameos-account-header__logo frameos-account-header__logo--light"
          height={24}
          src="/logo-light.svg"
          width={36}
        />
        <img
          alt=""
          className="frameos-account-header__logo frameos-account-header__logo--dark"
          height={24}
          src="/logo-dark.svg"
          width={36}
        />
        <span className="frameos-account-header__name">{name}</span>
      </Link>
      {title ? (
        <span className="frameos-account-header__title">{title}</span>
      ) : null}
    </div>
  );
}
