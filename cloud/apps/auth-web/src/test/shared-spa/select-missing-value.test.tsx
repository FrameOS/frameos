// <Select> (frontend/src/components/Select.tsx) with a value that is not
// among its options. A native <select> then shows the first option while the
// form still holds the stored value — a field pointing at a renamed scene or
// state key looked like it had picked the first entry and saved the stale
// one (2026-09 review). The component now renders the stored value as an
// extra first option so what is shown is what gets saved.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Select } from "../../../../../../frontend/src/components/Select";

const options = [
  { value: "one", label: "One" },
  { value: "two", label: "Two" },
];

function optionValues(html: string): string[] {
  return Array.from(html.matchAll(/<option[^>]*value="([^"]*)"/g)).map((m) => m[1] ?? "");
}

function selectedValue(html: string): string | null {
  const match = html.match(/<option[^>]*\bselected=""[^>]*value="([^"]*)"|<option[^>]*value="([^"]*)"[^>]*\bselected=""/);
  return match ? (match[1] ?? match[2] ?? null) : null;
}

describe("<Select> with a value outside its options", () => {
  it("renders nothing extra when the value is an option", () => {
    const html = renderToStaticMarkup(<Select value="two" options={options} onChange={() => {}} />);
    expect(optionValues(html)).toEqual(["one", "two"]);
    expect(selectedValue(html)).toBe("two");
  });

  it("renders the stored value as a marked first option and keeps it selected", () => {
    const html = renderToStaticMarkup(<Select value="gone" options={options} onChange={() => {}} />);
    expect(optionValues(html)).toEqual(["gone", "one", "two"]);
    expect(html).toContain(">gone (not an option)</option>");
    expect(selectedValue(html)).toBe("gone");
  });

  it("leaves the empty string to the browser (placeholder idiom)", () => {
    const html = renderToStaticMarkup(<Select value="" options={options} onChange={() => {}} />);
    expect(optionValues(html)).toEqual(["one", "two"]);
    expect(html).not.toContain("not an option");
    const nullHtml = renderToStaticMarkup(<Select value={null as unknown as string} options={options} />);
    expect(optionValues(nullHtml)).toEqual(["one", "two"]);
  });

  it("finds a value inside an optgroup", () => {
    const html = renderToStaticMarkup(
      <Select
        value="deep"
        options={[{ label: "Group", options: [{ value: "deep", label: "Deep" }] }, ...options]}
        onChange={() => {}}
      />,
    );
    expect(optionValues(html)).toEqual(["deep", "one", "two"]);
    expect(html).not.toContain("not an option");
    expect(selectedValue(html)).toBe("deep");
  });

  it("matches numeric option values against a string value", () => {
    const html = renderToStaticMarkup(
      <Select
        value="2"
        options={[
          { value: 1, label: "One" },
          { value: 2, label: "Two" },
        ]}
        onChange={() => {}}
      />,
    );
    expect(optionValues(html)).toEqual(["1", "2"]);
    expect(html).not.toContain("not an option");
  });

  it("does not throw on a non-string label", () => {
    const html = renderToStaticMarkup(
      <Select
        value="x"
        options={[{ value: "x", label: { nested: true } as unknown as string }, { value: "y", label: 3 as unknown as string }]}
      />,
    );
    expect(optionValues(html)).toEqual(["x", "y"]);
    expect(html).toContain(">3</option>");
  });
});
