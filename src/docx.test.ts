import { describe, it, expect } from "vitest";
import { deflateRawSync } from "node:zlib";
import { extractDocxText } from "./docx.js";

// Helper: build a minimal ZIP archive from a list of entries.
// CRCs are written as 0 (our extractor doesn't validate them).
function makeZip(entries: Array<{ name: string; data: Buffer; compress: boolean }>): Buffer {
  const localParts: Buffer[] = [];
  const cdParts: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const method = e.compress ? 8 : 0;
    const compData = e.compress ? deflateRawSync(e.data) : e.data;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(0, 14);
    lh.writeUInt32LE(compData.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    localParts.push(lh, nameBuf, compData);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(0, 16);
    cd.writeUInt32LE(compData.length, 20);
    cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    cdParts.push(cd, nameBuf);

    offset += lh.length + nameBuf.length + compData.length;
  }

  const localBlock = Buffer.concat(localParts);
  const cdBlock = Buffer.concat(cdParts);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBlock.length, 12);
  eocd.writeUInt32LE(localBlock.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localBlock, cdBlock, eocd]);
}

function docBody(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${inner}</w:body>
</w:document>`;
}

function para(text: string): string {
  return `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
}

describe("extractDocxText", () => {
  describe("stored (uncompressed) entries", () => {
    it("extracts text from a single paragraph", () => {
      const xml = docBody(para("hello world"));
      const zip = makeZip([
        { name: "word/document.xml", data: Buffer.from(xml, "utf8"), compress: false },
      ]);
      expect(extractDocxText(zip)).toBe("hello world");
    });
  });

  describe("deflate-compressed entries", () => {
    it("inflates and extracts text", () => {
      const xml = docBody(para("compressed content"));
      const zip = makeZip([
        { name: "word/document.xml", data: Buffer.from(xml, "utf8"), compress: true },
      ]);
      expect(extractDocxText(zip)).toBe("compressed content");
    });

    it("ignores other entries and finds word/document.xml", () => {
      const xml = docBody(para("target"));
      const zip = makeZip([
        { name: "[Content_Types].xml", data: Buffer.from("<ignored/>", "utf8"), compress: true },
        { name: "_rels/.rels", data: Buffer.from("<ignored/>", "utf8"), compress: true },
        { name: "word/document.xml", data: Buffer.from(xml, "utf8"), compress: true },
      ]);
      expect(extractDocxText(zip)).toBe("target");
    });
  });

  describe("formatting", () => {
    it("separates paragraphs with newlines", () => {
      const xml = docBody(para("first") + para("second"));
      const zip = makeZip([
        { name: "word/document.xml", data: Buffer.from(xml, "utf8"), compress: true },
      ]);
      expect(extractDocxText(zip)).toBe("first\nsecond");
    });

    it("converts <w:tab/> to tab and <w:br/> to newline", () => {
      const xml = docBody(
        `<w:p><w:r><w:t>a</w:t><w:tab/><w:t>b</w:t><w:br/><w:t>c</w:t></w:r></w:p>`
      );
      const zip = makeZip([
        { name: "word/document.xml", data: Buffer.from(xml, "utf8"), compress: true },
      ]);
      expect(extractDocxText(zip)).toBe("a\tb\nc");
    });

    it("decodes XML entities", () => {
      const xml = docBody(para("Tom &amp; Jerry &lt;friends&gt;"));
      const zip = makeZip([
        { name: "word/document.xml", data: Buffer.from(xml, "utf8"), compress: true },
      ]);
      expect(extractDocxText(zip)).toBe("Tom & Jerry <friends>");
    });

    it("strips unknown tags without losing inner text", () => {
      const xml = docBody(
        `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>bold</w:t></w:r><w:r><w:t> plain</w:t></w:r></w:p>`
      );
      const zip = makeZip([
        { name: "word/document.xml", data: Buffer.from(xml, "utf8"), compress: true },
      ]);
      expect(extractDocxText(zip)).toBe("bold plain");
    });
  });

  describe("edge cases", () => {
    it("returns empty string for empty buffer", () => {
      expect(extractDocxText(Buffer.from(""))).toBe("");
    });

    it("returns empty string for buffer without EOCD", () => {
      expect(extractDocxText(Buffer.from("not a zip file"))).toBe("");
    });

    it("returns empty string when word/document.xml is missing", () => {
      const zip = makeZip([
        { name: "other.xml", data: Buffer.from("<x/>", "utf8"), compress: false },
      ]);
      expect(extractDocxText(zip)).toBe("");
    });
  });
});
