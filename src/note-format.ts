/**
 * Candidate notes: writing guide, wall-of-text guard, and Markdown → HTML.
 *
 * Ashby's `candidate.createNote` takes plain text or `{ type: "text/html" }`.
 * Plain text keeps line breaks but shows Markdown literally. HTML sent through
 * the API renders only a small tag set (checked against the Ashby feed, Nov 2026):
 *
 *   rendered:  <p> <br> <b>/<strong> <i>/<em> <u> <code> <pre> <a> <ul> <ol> <li>
 *   flattened: <h1>-<h6>, <blockquote>, <table> become plain paragraphs
 *
 * So agents write Markdown and this module emits only the tags Ashby renders.
 * Headings become bold lines because Ashby flattens real heading tags.
 */

/** Longest line of visible text a note may contain before it is rejected. */
export const MAX_NOTE_LINE_LENGTH = 600;

/** Shared writing guide, appended to the description of every tool that writes a note. */
export const NOTE_WRITING_GUIDE = `How to write the note (it is read by busy people skimming a candidate's feed):
- Write Markdown. It is converted to the rich text Ashby renders: **bold**, *italic*, \`code\`, [label](https://url), "- " bullets (indent two spaces to nest), "1. " numbered lists, and a blank line between paragraphs. A "#" heading becomes a bold line. Tables are not supported.
- Line 1 is one sentence a reader can stop after: what this note is, who or what it came from, and the date.
- Put everything else under short bold labels, each followed by bullets with one fact per bullet. Use only the labels that have content, for example **Background**, **Why them**, **Status**, **To check**, **Next step**.
- Keep quotes from other people in their own paragraph, in quotation marks, with who said it.
- Link sources as [label](url) instead of pasting bare URLs into sentences.
- A note of one or two sentences needs no structure. Never write a long note as one paragraph: any single line over ${MAX_NOTE_LINE_LENGTH} characters is rejected.

Example:
**Sourced lead for Staff Engineer.** Added by Sam on 3 Mar 2026 from the [conference speaker list](https://example.com/speakers).

**Background**
- Staff engineer at Acme since 2022; led the payments rewrite
- Based in London

**To check**
- Whether she is open to moving
- UK work authorization`;

const URL_PATTERN = /https?:\/\/[^\s<>"]+/g;

/**
 * Returns an instruction for the calling agent when the note is a wall of text,
 * or null when the note is fine. URLs do not count towards line length.
 */
export function checkNoteReadability(note: string): string | null {
  const lines = note.replace(/\r\n?/g, "\n").split("\n");
  const longest = Math.max(
    ...lines.map((line) => line.replace(URL_PATTERN, "").trim().length)
  );
  if (longest <= MAX_NOTE_LINE_LENGTH) return null;

  return `Note not saved: it contains a ${longest}-character block of text with no line break, which is hard to read in Ashby's feed. Nothing was created. Rewrite it and call the tool again:
- Keep line 1 to one sentence: what this note is, where it came from, and the date.
- Move the rest under short bold labels (for example **Background**, **Status**, **To check**) with one fact per bullet.
- Split a long quote into paragraphs at its natural breaks.
Keep every fact; change only the layout.`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Bold and italic on text that contains no code spans or links. */
function renderEmphasis(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, "<b>$1</b>")
    .replace(/(?<![*\w])\*(?=[^\s*])([^*]+?)(?<=[^\s*])\*(?![*\w])/g, "<i>$1</i>");
}

/** Splits trailing punctuation off a bare URL so "see https://x.com." links cleanly. */
function splitTrailingPunctuation(url: string): [string, string] {
  let end = url.length;
  while (end > 0) {
    const ch = url[end - 1];
    if (".,;:!?'*".includes(ch)) {
      end--;
    } else if (ch === ")") {
      const body = url.slice(0, end);
      const opens = (body.match(/\(/g) ?? []).length;
      const closes = (body.match(/\)/g) ?? []).length;
      if (closes > opens) end--;
      else break;
    } else {
      break;
    }
  }
  return [url.slice(0, end), url.slice(end)];
}

// Code spans, Markdown links and bare URLs are pulled out first so emphasis
// markers and HTML escaping never run inside a URL or a code span.
const INLINE_TOKEN =
  /`([^`\n]+)`|\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)|(https?:\/\/[^\s<>"]+)/g;

function renderInline(text: string): string {
  // Tokens are swapped for placeholders, emphasis runs over the whole line (so
  // bold can wrap a link), then the placeholders are swapped back.
  const tokens: string[] = [];
  const hold = (html: string): string => {
    tokens.push(html);
    return `\u0000${tokens.length - 1}\u0000`;
  };

  const withPlaceholders = text
    .replace(/\u0000/g, "")
    .replace(INLINE_TOKEN, (match, code, label, linkUrl, bareUrl) => {
      if (code !== undefined) return hold(`<code>${escapeHtml(code)}</code>`);
      if (label !== undefined) {
        return hold(`<a href="${escapeHtml(linkUrl)}">${renderEmphasis(label)}</a>`);
      }
      if (bareUrl !== undefined) {
        const [url, trailing] = splitTrailingPunctuation(bareUrl);
        if (!url) return match;
        return hold(`<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`) + trailing;
      }
      return match;
    });

  return renderEmphasis(withPlaceholders).replace(
    /\u0000(\d+)\u0000/g,
    (_, index) => tokens[Number(index)]
  );
}

type ListKind = "ul" | "ol";
interface ListItem {
  kind: ListKind;
  indent: number;
  lines: string[];
}

function renderList(items: ListItem[]): string {
  let html = "";
  let i = 0;
  const baseIndent = items[0].indent;

  while (i < items.length) {
    const kind = items[i].kind;
    html += `<${kind}>`;
    while (i < items.length && items[i].kind === kind && items[i].indent <= baseIndent) {
      const item = items[i];
      i++;
      const childStart = i;
      while (i < items.length && items[i].indent > baseIndent) i++;
      const children = items.slice(childStart, i);
      html += `<li>${item.lines.map(renderInline).join("<br>")}`;
      if (children.length > 0) html += renderList(children);
      html += "</li>";
    }
    html += `</${kind}>`;
  }
  return html;
}

const HEADING = /^#{1,6}\s+(.+?)\s*#*$/;
const BULLET = /^(\s*)[-*•]\s+(.+)$/;
const NUMBERED = /^(\s*)\d{1,3}[.)]\s+(.+)$/;

/**
 * Converts the Markdown subset described in NOTE_WRITING_GUIDE into the HTML
 * Ashby renders. Plain text passes through with its line breaks intact.
 */
export function noteMarkdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").replace(/\t/g, "  ").split("\n");
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let list: ListItem[] = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push(`<p>${paragraph.map(renderInline).join("<br>")}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list.length > 0) {
      blocks.push(renderList(list));
      list = [];
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    if (line.trim() === "") {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const text = heading[1].replace(/^\*\*(.+)\*\*$/, "$1");
      blocks.push(`<p><b>${renderInline(text)}</b></p>`);
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    const listMatch = bullet ?? numbered;
    if (listMatch) {
      flushParagraph();
      list.push({
        kind: bullet ? "ul" : "ol",
        indent: listMatch[1].length,
        lines: [listMatch[2]],
      });
      continue;
    }

    // An indented line directly under a list item continues that item.
    if (list.length > 0 && /^\s+/.test(line)) {
      list[list.length - 1].lines.push(line.trim());
      continue;
    }

    flushList();
    paragraph.push(line.trim());
  }

  flushParagraph();
  flushList();
  return blocks.join("");
}

/** The `note` value to send to `candidate.createNote`. */
export function buildNotePayload(note: string): { type: "text/html"; value: string } {
  return { type: "text/html", value: noteMarkdownToHtml(note) };
}
