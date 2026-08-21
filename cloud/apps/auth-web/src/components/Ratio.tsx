// "1/10" — active over total. Reads "1 of 10" to a screen reader and carries
// the longer description as a tooltip; an empty pair is a quiet dash.
export function Ratio({
  active,
  title,
  total,
}: {
  active: number;
  title?: string;
  total: number;
}) {
  if (total === 0) {
    return (
      <span className="ratio ratio--empty" title={title}>
        —
      </span>
    );
  }
  return (
    <span
      aria-label={`${active} of ${total}`}
      className="ratio"
      title={title ?? `${active} active of ${total}`}
    >
      {active}
      <span className="ratio__total">/{total}</span>
    </span>
  );
}
