import Link from "next/link";

// The topbar passes showName={false} when a page title takes the text slot;
// the auth cards keep the full wordmark.
export function BrandMark({
  href = "/",
  showName = true,
}: {
  href?: string;
  showName?: boolean;
}) {
  return (
    <Link aria-label="FrameOS Cloud" className="brand" href={href}>
      <span aria-hidden className="brand-mark">
        <img
          alt=""
          className="brand-logo brand-logo--light"
          height={22}
          src="/logo-light.svg"
          width={32}
        />
        <img
          alt=""
          className="brand-logo brand-logo--dark"
          height={22}
          src="/logo-dark.svg"
          width={32}
        />
      </span>
      {showName ? <p className="brand__name">FrameOS Cloud</p> : null}
    </Link>
  );
}
