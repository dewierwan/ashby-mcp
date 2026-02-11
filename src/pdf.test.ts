import { describe, it, expect } from "vitest";
import { deflateSync } from "node:zlib";
import { extractPdfText } from "./pdf.js";

// Helper: build a minimal PDF-like buffer with the given stream content.
// Wraps content in a stream/endstream pair with an optional /FlateDecode filter.
function makePdf(...streams: Array<{ content: string; flate?: boolean }>): Buffer {
  let pdf = "%PDF-1.4\n";
  for (const { content, flate } of streams) {
    const filter = flate ? "/Filter /FlateDecode " : "";
    const data = flate
      ? deflateSync(Buffer.from(content, "latin1")).toString("latin1")
      : content;
    pdf += `<< ${filter}/Length ${data.length} >>\nstream\n${data}\nendstream\n`;
  }
  pdf += "%%EOF";
  return Buffer.from(pdf, "latin1");
}

describe("extractPdfText", () => {
  describe("uncompressed streams", () => {
    it("extracts text from parenthesized Tj operators", () => {
      const pdf = makePdf({ content: "BT (Hello World) Tj ET" });
      expect(extractPdfText(pdf)).toBe("Hello World");
    });

    it("extracts text from multiple Tj operators", () => {
      const pdf = makePdf({ content: "BT (Hello) Tj ( World) Tj ET" });
      expect(extractPdfText(pdf)).toBe("Hello World");
    });

    it("extracts text from TJ arrays with parenthesized strings", () => {
      const pdf = makePdf({ content: "BT [(Hello) -50 ( World)] TJ ET" });
      expect(extractPdfText(pdf)).toBe("Hello World");
    });
  });

  describe("FlateDecode decompression", () => {
    it("decompresses and extracts text from FlateDecode streams", () => {
      const pdf = makePdf({ content: "BT (Compressed text) Tj ET", flate: true });
      expect(extractPdfText(pdf)).toBe("Compressed text");
    });

    it("skips streams that fail to decompress", () => {
      // Create a PDF with a FlateDecode marker but invalid compressed data
      let pdf = "%PDF-1.4\n";
      pdf += "<< /Filter /FlateDecode /Length 10 >>\nstream\nNOTZLIBDAT\nendstream\n";
      pdf += "%%EOF";
      const result = extractPdfText(Buffer.from(pdf, "latin1"));
      expect(result).toBe("");
    });

    it("handles mix of compressed and uncompressed streams", () => {
      const pdf = makePdf(
        { content: "BT (Part one) Tj ET" },
        { content: "BT (Part two) Tj ET", flate: true }
      );
      expect(extractPdfText(pdf)).toContain("Part one");
      expect(extractPdfText(pdf)).toContain("Part two");
    });
  });

  describe("CMap and hex decoding", () => {
    it("decodes hex Tj using beginbfchar CMap", () => {
      const cmapStream = [
        "/CIDInit /ProcSet findresource begin",
        "beginbfchar",
        "<01> <0048>",
        "<02> <0069>",
        "endbfchar",
        "end",
      ].join("\n");
      const textStream = "BT <0102> Tj ET";
      const pdf = makePdf({ content: cmapStream }, { content: textStream });
      expect(extractPdfText(pdf)).toBe("Hi");
    });

    it("decodes hex Tj using beginbfrange CMap", () => {
      const cmapStream = [
        "beginbfrange",
        "<01> <03> <0041>",
        "endbfrange",
      ].join("\n");
      const textStream = "BT <010203> Tj ET";
      const pdf = makePdf({ content: cmapStream }, { content: textStream });
      expect(extractPdfText(pdf)).toBe("ABC");
    });

    it("falls back to raw char codes when CMap has no entry", () => {
      // No CMap provided, hex 48=H, 69=i
      const pdf = makePdf({ content: "BT <4869> Tj ET" });
      expect(extractPdfText(pdf)).toBe("Hi");
    });

    it("handles hex strings in TJ arrays", () => {
      const cmapStream = "beginbfchar\n<01> <0048>\n<02> <0065>\n<03> <006C>\nendbfchar";
      const textStream = "BT [<0102> -100 <030301>] TJ ET";
      const pdf = makePdf({ content: cmapStream }, { content: textStream });
      expect(extractPdfText(pdf)).toContain("He");
      expect(extractPdfText(pdf)).toContain("llH");
    });
  });

  describe("chunk joining", () => {
    it("does not insert spaces between single-char chunks", () => {
      const cmapStream = "beginbfchar\n<01> <0048>\n<02> <0069>\nendbfchar";
      const textStream = "BT <01> Tj <02> Tj ET";
      const pdf = makePdf({ content: cmapStream }, { content: textStream });
      expect(extractPdfText(pdf)).toBe("Hi");
    });

    it("inserts spaces between multi-char chunks", () => {
      const pdf = makePdf({ content: "BT (Hello) Tj (World) Tj ET" });
      expect(extractPdfText(pdf)).toBe("Hello World");
    });
  });

  describe("escape sequences", () => {
    it("cleans up backslash-n", () => {
      const pdf = makePdf({ content: "BT (Line1\\nLine2) Tj ET" });
      expect(extractPdfText(pdf)).toContain("Line1");
      expect(extractPdfText(pdf)).toContain("Line2");
    });

    it("cleans up backslash-escaped backslashes", () => {
      const pdf = makePdf({ content: "BT (path\\\\to\\\\file) Tj ET" });
      expect(extractPdfText(pdf)).toBe("path\\to\\file");
    });
  });

  describe("edge cases", () => {
    it("returns empty string for empty buffer", () => {
      expect(extractPdfText(Buffer.from(""))).toBe("");
    });

    it("returns empty string for PDF with no text streams", () => {
      const pdf = makePdf({ content: "q 0 0 100 100 re f Q" });
      expect(extractPdfText(pdf)).toBe("");
    });

    it("returns empty string for buffer with no stream objects", () => {
      expect(extractPdfText(Buffer.from("%PDF-1.4\n%%EOF"))).toBe("");
    });

    it("skips CMap-only streams (no text extraction from them)", () => {
      const cmapOnly = "/CIDInit /ProcSet findresource begin\nbeginbfchar\n<01> <0041>\nendbfchar\nend";
      const pdf = makePdf({ content: cmapOnly });
      expect(extractPdfText(pdf)).toBe("");
    });
  });
});
