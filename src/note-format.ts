/**
 * Candidate notes: writing guide, readability check, and Markdown → HTML.
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

/**
 * Rules for any text written into Ashby, whatever the task. Kept free of
 * workflow-specific wording so they fit a lead note, an assessment, a call
 * summary or a one-line update equally.
 */
export const PLAIN_ENGLISH_RULES = `Plain English:
- Use short sentences and common words, one idea per sentence. Write "used", not "leveraged"; "about", not "regarding".
- No jargon, internal shorthand or tool-speak. Leave out tool names, field names, IDs and descriptions of your own process ("scorer estimate", "per the pipeline run"). Spell out an abbreviation the first time unless the whole hiring team uses it.
- Say who did what and when, with names and dates: "Sam emailed her on 3 Mar 2026", not "outreach was conducted".
- Include only what helps someone decide or act. No filler, no repeated facts, no stacked hedges.
- Keep facts apart from your opinion. Say where a fact came from, and mark anything you could not verify.`;

/** Full guide, appended to the description of every tool that writes a note. */
export const NOTE_WRITING_GUIDE = `How to write the note. People on the hiring team read it later, skimming a candidate's feed, without your conversation in front of them. These rules apply to every kind of note: a sourced lead, an assessment, a call or reference summary, a status update, a data correction.

${PLAIN_ENGLISH_RULES}

Layout:
- Write Markdown. It is converted to the rich text Ashby renders: **bold**, *italic*, \`code\`, [label](https://url), "- " bullets (indent two spaces to nest), "1. " numbered lists, and a blank line between paragraphs. A "#" heading becomes a bold line. Tables are not supported.
- Line 1 is one sentence a reader can stop after: the main point (what happened, what you found, or what you recommend), with who and when.
- If there is more, group it under short bold labels with one fact per bullet. Choose labels that fit this note, for example **Background**, **Evidence**, **Concerns**, **Status**, **To check**, **Next step**. Skip a label that has nothing under it.
- Put a quote from someone else in its own paragraph, in quotation marks, with who said it.
- Link sources as [label](url) instead of pasting bare URLs into sentences.
- A note of one or two sentences needs no labels or bullets. Never write a long note as one paragraph: any single line over ${MAX_NOTE_LINE_LENGTH} characters is rejected. Raw IDs and raw field names are rejected too.

Example of a short note:
Sam emailed her on 3 Mar 2026 to ask about start dates. No reply yet.

Example of a longer note:
**Recommend moving her to the final interview.** Based on her work test and resume, reviewed on 3 Mar 2026.

**Evidence**
- Work test: she found the pricing bug and explained the fix clearly
- Led a team of 6 at Acme for two years

**Concerns**
- No experience managing a budget

**Next step**
- Sam to book the final interview`;

/** Sent to the client when it connects, so the rules cover every tool, including ashby_call_api. */
export const SERVER_INSTRUCTIONS = `Anything you write into Ashby (a note, a lead's sourcing note, feedback, or any text sent through ashby_call_api) is read later by people on the hiring team, skimming, without your conversation in front of them. Write it in plain English: short sentences, common words, no jargon, and no tool names, field names or IDs. Put the main point in the first sentence, then group the rest under short bold labels with one fact per bullet. The full rules are in the ashby_add_candidate_note description and in ashby_get_api_docs. Notes are written in Markdown and converted to Ashby rich text.`;

const URL_PATTERN = /https?:\/\/[^\s<>"]+/g;
const CODE_SPAN_PATTERN = /`[^`\n]+`/g;
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
// A raw field name used as a label, such as "personal_website:" or "other_urls:".
const FIELD_LABEL_PATTERN = /(?<![\w@.])[a-z][a-z0-9]*(?:_[a-z0-9]+)+(?=:)/g;

/**
 * Checks the parts of the writing guide a program can judge: layout, raw IDs
 * and raw field names. Returns instructions for the calling agent when the
 * note fails, or null when it passes. URLs and \`code\` spans are not checked.
 * Word choice and tone are left to the guide in the tool description.
 */
export function checkNoteReadability(note: string): string | null {
  const lines = note.replace(/\r\n?/g, "\n").split("\n");
  const problems: string[] = [];

  const longest = Math.max(
    ...lines.map((line) => line.replace(URL_PATTERN, "").trim().length)
  );
  if (longest > MAX_NOTE_LINE_LENGTH) {
    problems.push(
      `It contains a ${longest}-character block of text with no line break. Keep line 1 to one sentence with the main point, move the rest under short bold labels (for example **Background**, **Evidence**, **To check**) with one fact per bullet, and split a long quote into paragraphs at its natural breaks.`
    );
  }

  const prose = note.replace(URL_PATTERN, "").replace(CODE_SPAN_PATTERN, "");
  if (UUID_PATTERN.test(prose)) {
    problems.push(
      "It contains a raw ID. A reader cannot use an ID: name the person, job or record in plain words, or link to it as [label](url)."
    );
  }
  UUID_PATTERN.lastIndex = 0;

  const fieldLabels = [...new Set(prose.match(FIELD_LABEL_PATTERN) ?? [])];
  if (fieldLabels.length > 0) {
    problems.push(
      `It uses raw field names as labels (${fieldLabels.slice(0, 5).join(", ")}). Write them in plain words, for example "Personal website" instead of "personal_website".`
    );
  }

  if (problems.length === 0) return null;

  return `Note not saved: it would be hard to read in Ashby's feed. Nothing was created. Fix this and call the tool again:
${problems.map((problem) => `- ${problem}`).join("\n")}
Keep every fact; change only the wording and layout. If the reader really needs a literal value, put it in \`backticks\`.`;
}

/** Turns an HTML note into text lines so a hand-built HTML note gets the same checks. */
export function htmlNoteToText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>|<\/\s*(?:p|li|div|ul|ol|pre|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "");
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
