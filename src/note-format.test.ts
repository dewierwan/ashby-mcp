import { describe, it, expect } from "vitest";
import {
  MAX_NOTE_LINE_LENGTH,
  buildNotePayload,
  checkNoteReadability,
  noteMarkdownToHtml,
} from "./note-format.js";

describe("noteMarkdownToHtml", () => {
  it("keeps a short plain note as one paragraph", () => {
    expect(noteMarkdownToHtml("Strong candidate")).toBe("<p>Strong candidate</p>");
  });

  it("keeps plain-text line breaks and blank lines", () => {
    expect(noteMarkdownToHtml("Line one\nLine two\n\nNew paragraph")).toBe(
      "<p>Line one<br>Line two</p><p>New paragraph</p>"
    );
  });

  it("renders bold, italic and code", () => {
    expect(noteMarkdownToHtml("**Bold** and *italic* and `code`")).toBe(
      "<p><b>Bold</b> and <i>italic</i> and <code>code</code></p>"
    );
  });

  it("leaves stray asterisks and snake_case alone", () => {
    expect(noteMarkdownToHtml("5 * 3 = 15, see field_name_here")).toBe(
      "<p>5 * 3 = 15, see field_name_here</p>"
    );
  });

  it("renders Markdown links and lets bold wrap them", () => {
    expect(noteMarkdownToHtml("**See [the doc](https://example.com/a?b=1&c=2)**")).toBe(
      '<p><b>See <a href="https://example.com/a?b=1&amp;c=2">the doc</a></b></p>'
    );
  });

  it("links bare URLs and keeps trailing punctuation outside the link", () => {
    expect(noteMarkdownToHtml("Profile: https://example.com/in/jane_doe.")).toBe(
      '<p>Profile: <a href="https://example.com/in/jane_doe">https://example.com/in/jane_doe</a>.</p>'
    );
  });

  it("does not treat underscores or asterisks inside a URL as emphasis", () => {
    expect(noteMarkdownToHtml("https://example.com/*a*/b and *real*")).toBe(
      '<p><a href="https://example.com/*a*/b">https://example.com/*a*/b</a> and <i>real</i></p>'
    );
  });

  it("escapes HTML in the note", () => {
    expect(noteMarkdownToHtml('<script>alert("x")</script> & more')).toBe(
      "<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; more</p>"
    );
  });

  it("refuses non-http link targets", () => {
    expect(noteMarkdownToHtml("[click](javascript:alert(1))")).not.toContain("<a");
  });

  it("renders bullets, nested bullets and numbered lists", () => {
    const html = noteMarkdownToHtml(
      ["- One", "- Two", "  - Nested", "- Three", "", "1. First", "2. Second"].join("\n")
    );
    expect(html).toBe(
      "<ul><li>One</li><li>Two<ul><li>Nested</li></ul></li><li>Three</li></ul>" +
        "<ol><li>First</li><li>Second</li></ol>"
    );
  });

  it("turns headings into bold lines, because Ashby flattens heading tags", () => {
    expect(noteMarkdownToHtml("## To check\n- Work authorization")).toBe(
      "<p><b>To check</b></p><ul><li>Work authorization</li></ul>"
    );
    expect(noteMarkdownToHtml("# **Already bold**")).toBe("<p><b>Already bold</b></p>");
  });

  it("does not treat a bold label as a bullet", () => {
    expect(noteMarkdownToHtml("**Background**\n- Fact")).toBe(
      "<p><b>Background</b></p><ul><li>Fact</li></ul>"
    );
  });

  it("does not treat a year at the start of a line as a numbered list", () => {
    expect(noteMarkdownToHtml("2026. A good year")).toBe("<p>2026. A good year</p>");
  });

  it("renders the recommended lead-note layout", () => {
    const note = [
      "**Sourced lead for Staff Engineer.** Added by Sam on 3 Mar 2026 from the [speaker list](https://example.com/speakers).",
      "",
      "**Background**",
      "- Staff engineer at Acme since 2022",
      "- Based in London",
      "",
      "**To check**",
      "- UK work authorization",
    ].join("\n");
    expect(noteMarkdownToHtml(note)).toBe(
      '<p><b>Sourced lead for Staff Engineer.</b> Added by Sam on 3 Mar 2026 from the <a href="https://example.com/speakers">speaker list</a>.</p>' +
        "<p><b>Background</b></p><ul><li>Staff engineer at Acme since 2022</li><li>Based in London</li></ul>" +
        "<p><b>To check</b></p><ul><li>UK work authorization</li></ul>"
    );
  });
});

describe("buildNotePayload", () => {
  it("sends the note as HTML", () => {
    expect(buildNotePayload("Hi")).toEqual({ type: "text/html", value: "<p>Hi</p>" });
  });
});

describe("checkNoteReadability", () => {
  it("accepts short notes and structured long notes", () => {
    expect(checkNoteReadability("Strong candidate")).toBeNull();
    const structured = Array.from({ length: 40 }, (_, i) => `- Fact number ${i}`).join("\n");
    expect(structured.length).toBeGreaterThan(MAX_NOTE_LINE_LENGTH);
    expect(checkNoteReadability(structured)).toBeNull();
  });

  it("rejects a long note written as one paragraph", () => {
    const wall = "Sentence about the candidate. ".repeat(30);
    const problem = checkNoteReadability(wall);
    expect(problem).toContain("Note not saved");
    expect(problem).toContain("Nothing was created");
  });

  it("rejects a wall of text that follows a short summary line", () => {
    const note = `Summary line.\n\n${"More detail here. ".repeat(40)}`;
    expect(checkNoteReadability(note)).not.toBeNull();
  });

  it("does not count URLs towards line length", () => {
    const line = `Source: https://example.com/${"a".repeat(MAX_NOTE_LINE_LENGTH)}`;
    expect(checkNoteReadability(line)).toBeNull();
  });
});
