import { inflateRawSync } from "node:zlib";
import { logger } from "./logger.js";

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const TARGET = "word/document.xml";

/**
 * Extract text from a DOCX buffer.
 * DOCX is a ZIP containing word/document.xml; we locate that entry via the ZIP
 * central directory, inflate it (deflate or stored), then strip XML.
 * Returns the extracted text, or empty string if anything fails.
 */
export function extractDocxText(buffer: Buffer): string {
  // Scan back from end of file for End of Central Directory signature.
  // ZIP spec allows up to 64KB of trailing comment, so scan that far.
  let eocdOffset = -1;
  const scanFrom = Math.max(0, buffer.length - 65557);
  for (let i = buffer.length - 22; i >= scanFrom; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    logger.warn("docx: end-of-central-directory not found");
    return "";
  }

  const cdOffset = buffer.readUInt32LE(eocdOffset + 16);
  const cdSize = buffer.readUInt32LE(eocdOffset + 12);
  const cdEnd = cdOffset + cdSize;

  let method = -1;
  let compSize = 0;
  let localOffset = -1;
  let entryOffset = cdOffset;
  while (entryOffset + 46 <= cdEnd) {
    if (buffer.readUInt32LE(entryOffset) !== CD_SIG) break;
    const nameLen = buffer.readUInt16LE(entryOffset + 28);
    const extraLen = buffer.readUInt16LE(entryOffset + 30);
    const commentLen = buffer.readUInt16LE(entryOffset + 32);
    const name = buffer.toString("utf8", entryOffset + 46, entryOffset + 46 + nameLen);
    if (name === TARGET) {
      method = buffer.readUInt16LE(entryOffset + 10);
      compSize = buffer.readUInt32LE(entryOffset + 20);
      localOffset = buffer.readUInt32LE(entryOffset + 42);
      break;
    }
    entryOffset += 46 + nameLen + extraLen + commentLen;
  }
  if (localOffset < 0) {
    logger.warn("docx: word/document.xml not found in archive");
    return "";
  }

  if (buffer.readUInt32LE(localOffset) !== LOCAL_SIG) {
    logger.warn("docx: local file header signature mismatch", { localOffset });
    return "";
  }
  const lhNameLen = buffer.readUInt16LE(localOffset + 26);
  const lhExtraLen = buffer.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + lhNameLen + lhExtraLen;
  const compData = buffer.subarray(dataStart, dataStart + compSize);

  let xml: string;
  if (method === 0) {
    xml = compData.toString("utf8");
  } else if (method === 8) {
    try {
      xml = inflateRawSync(compData).toString("utf8");
    } catch (e) {
      logger.warn("docx: deflate inflateRaw failed", {
        error: e instanceof Error ? e.message : String(e),
      });
      return "";
    }
  } else {
    logger.warn("docx: unsupported compression method", { method });
    return "";
  }

  // Strip XML: tabs, line breaks, paragraph ends → whitespace; drop remaining tags.
  // Decode &amp; last so existing &lt;/&gt; etc. are not double-decoded.
  return xml
    .replace(/<w:tab\b[^>]*\/?>/g, "\t")
    .replace(/<w:br\b[^>]*\/?>/g, "\n")
    .replace(/<\/w:p\s*>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
