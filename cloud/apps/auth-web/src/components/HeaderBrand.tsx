import Link from "next/link";

// The lead slot of the shared cloud header (cloud-chrome.css): the cloud
// logo — light and dark renditions, CSS picks one — plus either the wordmark
// or, when a page brings a `title`, that title in the wordmark's place. The
// /frames SPA renders the same markup in cloud-frontend AccountHeader.tsx.
export function HeaderBrand({
  href,
  title,
}: {
  href: string;
  title?: React.ReactNode;
}) {
  return (
    <div className="frameos-account-header__lead">
      <Link
        aria-label="FrameOS Cloud"
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
        {title ? null : (
          <span className="frameos-account-header__name">FrameOS Cloud</span>
        )}
      </Link>
      {title ? (
        <span className="frameos-account-header__title">{title}</span>
      ) : null}
    </div>
  );
}
