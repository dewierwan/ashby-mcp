import { inflateSync } from "node:zlib";
import { logger } from "./logger.js";

/**
 * Extract text from a PDF buffer.
 * Handles FlateDecode compressed streams and CMap Unicode mappings.
 * Returns the extracted text, or empty string if no text found.
 */
export function extractPdfText(buffer: Buffer): string {
  const raw = buffer.toString("latin1");

  // Decode all streams (decompress FlateDecode where needed)
  const decodedStreams: string[] = [];
  const streamRegex = /stream\r?\n([\s\S]*?)endstream/g;
  let sMatch;
  while ((sMatch = streamRegex.exec(raw)) !== null) {
    const before = raw.substring(Math.max(0, sMatch.index - 300), sMatch.index);
    const isFlate = /\/Filter\s*\/FlateDecode/.test(before);
    if (isFlate) {
      try {
        decodedStreams.push(inflateSync(Buffer.from(sMatch[1], "latin1")).toString("latin1"));
      } catch (e) {
        logger.warn("pdf: FlateDecode decompression failed", {
          streamOffset: sMatch.index,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    } else {
      decodedStreams.push(sMatch[1]);
    }
  }

  // Build CMap: parse beginbfchar/beginbfrange sections to map glyph codes to Unicode
  const cmap = new Map<string, string>();
  for (const s of decodedStreams) {
    // bfchar: <src> <dst>
    const charBlock = /beginbfchar([\s\S]*?)endbfchar/g;
    let cb;
    while ((cb = charBlock.exec(s)) !== null) {
      const pairs = /\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
      let p;
      while ((p = pairs.exec(cb[1])) !== null) {
        const hex = p[2];
        let ch = "";
        for (let i = 0; i < hex.length; i += 4) {
          ch += String.fromCodePoint(parseInt(hex.substring(i, i + 4), 16));
        }
        cmap.set(p[1].toLowerCase(), ch);
      }
    }
    // bfrange: <srcLo> <srcHi> <dstStart>
    const rangeBlock = /beginbfrange([\s\S]*?)endbfrange/g;
    let rb;
    while ((rb = rangeBlock.exec(s)) !== null) {
      const ranges = /\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
      let r;
      while ((r = ranges.exec(rb[1])) !== null) {
        const lo = parseInt(r[1], 16);
        const hi = parseInt(r[2], 16);
        let dst = parseInt(r[3], 16);
        const padLen = r[1].length;
        for (let code = lo; code <= hi; code++) {
          cmap.set(code.toString(16).padStart(padLen, "0").toLowerCase(), String.fromCodePoint(dst++));
        }
      }
    }
  }

  // Decode a hex string using CMap, falling back to raw char codes
  function decodeHex(hex: string): string {
    const keyLen = cmap.size > 0 ? [...cmap.keys()][0].length : 2;
    let result = "";
    for (let i = 0; i < hex.length; i += keyLen) {
      const code = hex.substring(i, i + keyLen).toLowerCase();
      if (cmap.has(code)) {
        result += cmap.get(code);
      } else {
        const cp = parseInt(code, 16);
        if (cp >= 0x20 && cp < 0x7f) result += String.fromCharCode(cp);
      }
    }
    return result;
  }

  // Extract text from content streams
  const textChunks: string[] = [];
  for (const s of decodedStreams) {
    // Skip CMap and font streams
    if (/beginbfchar|beginbfrange|\/CIDInit/.test(s)) continue;

    // Hex string Tj: <hex> Tj
    const hexTj = /<([0-9A-Fa-f]+)>\s*Tj/g;
    let hm;
    while ((hm = hexTj.exec(s)) !== null) {
      textChunks.push(decodeHex(hm[1]));
    }
    // Parenthesized string Tj: (text) Tj
    const parenTj = /\(([^)]*)\)\s*Tj/g;
    let pm;
    while ((pm = parenTj.exec(s)) !== null) {
      textChunks.push(pm[1]);
    }
    // TJ arrays with hex: [<hex> num <hex> ...] TJ
    const tjArr = /\[((?:<[0-9A-Fa-f]+>|\([^)]*\)|[^\]])*)\]\s*TJ/g;
    let am;
    while ((am = tjArr.exec(s)) !== null) {
      const inner = am[1];
      const hexInner = /<([0-9A-Fa-f]+)>/g;
      let hi;
      while ((hi = hexInner.exec(inner)) !== null) {
        textChunks.push(decodeHex(hi[1]));
      }
      const parenInner = /\(([^)]*)\)/g;
      let pi;
      while ((pi = parenInner.exec(inner)) !== null) {
        textChunks.push(pi[1]);
      }
    }
  }

  // Join chunks: don't insert spaces between single-char chunks (glyph-per-Tj PDFs)
  let joined = "";
  for (let i = 0; i < textChunks.length; i++) {
    const chunk = textChunks[i];
    const prev = i > 0 ? textChunks[i - 1] : "";
    if (i > 0 && (prev.length > 1 || chunk.length > 1)) {
      joined += " ";
    }
    joined += chunk;
  }

  // Clean up PDF escape sequences (backslash-backslash first to avoid double-processing)
  return joined
    .replace(/\\\\/g, "\x00")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "")
    .replace(/\\t/g, " ")
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\x00/g, "\\")
    .replace(/  +/g, " ")
    .trim();
}
