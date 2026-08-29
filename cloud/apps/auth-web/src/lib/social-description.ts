// The one-line blurb link previews (Discord, Slack, iMessage, X) show under a
// scene's name. Scene descriptions are markdown written for the store page;
// an embed card renders none of it, so `**bold**`, links and list markers
// would show up as raw punctuation. This flattens the markdown to a single
// plain-text paragraph and trims it to what a card actually displays.

// Discord truncates og:description at ~350 characters; other cards sooner.
// Cutting on a word boundary ourselves keeps the ellipsis tidy.
export const socialDescriptionMaxLength = 300;

// Escaped punctuation (`\*`) is literal text; park it in the private-use
// area so the emphasis/list passes below cannot mistake it for syntax.
const escapedChars = "\\`*_{}[]()#+-.!>~|";
const placeholderBase = 0xe000;

export function markdownToPlainText(markdown: string): string {
  return (
    markdown
      .replace(/\r\n?/g, "\n")
      .replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, (_match, char: string) =>
        String.fromCharCode(placeholderBase + escapedChars.indexOf(char)),
      )
      // Fenced code blocks contribute nothing readable to a card.
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/`([^`\n]*)`/g, "$1")
      // Images before links, so the `!` is not left behind.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/<[^>\n]+>/g, " ")
      // Headings, block quotes and list markers at the start of a line.
      .replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
      .replace(/^[ \t]*>[ \t]?/gm, "")
      .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, "")
      .replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, " ")
      // Emphasis. Underscores only when they wrap a word (snake_case stays).
      .replace(/(\*{1,3})(?=\S)([\s\S]*?\S)\1/g, "$2")
      .replace(/(?<![A-Za-z0-9])(_{1,3})(?=\S)([\s\S]*?\S)\1(?![A-Za-z0-9])/g, "$2")
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
      .replace(/\s+/g, " ")
      .replace(/[\ue000-\ue01f]/g, (char) =>
        escapedChars.charAt(char.charCodeAt(0) - placeholderBase),
      )
      .trim()
  );
}

export function truncateForCard(
  text: string,
  maxLength = socialDescriptionMaxLength,
): string {
  if (text.length <= maxLength) {
    return text;
  }
  const cut = text.slice(0, maxLength - 1);
  const lastSpace = cut.lastIndexOf(" ");
  const kept = lastSpace > maxLength / 2 ? cut.slice(0, lastSpace) : cut;
  return `${kept.replace(/[\s,;:.!?-]+$/, "")}…`;
}

export function socialDescription(
  markdown: string | null | undefined,
  fallback: string,
): string {
  const text = markdown ? markdownToPlainText(markdown) : "";
  return truncateForCard(text || fallback);
}

// What a scene with no description of its own says on a card. Naming the
// publisher makes the card read as a real thing someone made, not a generic
// site tile, and the second sentence tells a stranger what the link does.
export function defaultSceneDescription(publisher: string | null): string {
  return `A FrameOS scene by ${publisher ?? "a FrameOS user"}. Preview it in your browser, remix it, or install it on your e-ink or HDMI frame.`;
}
