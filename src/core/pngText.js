// Text chunks for a PNG, so a downloaded map carries what it is and under which
// licence in the file as well as in its pixels. The credits drawn on the frame
// are the ones that count -- they survive a screenshot of the file, metadata
// does not -- but a file that is cropped has nothing else left to say where it
// came from.
//
// iTXt rather than tEXt: tEXt is Latin-1, and dataset names and citations are
// not.

const PNG_SIGNATURE_LENGTH = 8;
const IHDR_CHUNK_LENGTH = 4 + 4 + 13 + 4;

let crcTable = null;

function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function itxtChunk(keyword, text) {
  const encoder = new TextEncoder();
  // keyword \0, not compressed \0, method \0, no language tag \0, no
  // translated keyword \0, then the UTF-8 text.
  const data = new Uint8Array([...encoder.encode(keyword), 0, 0, 0, 0, 0, ...encoder.encode(text)]);
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(encoder.encode("iTXt"), 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
}

// `fields` is { keyword: text }, with the PNG spec's registered keywords
// (Title, Author, Description, Copyright, Source, Software, Creation Time)
// where one fits. The chunks go straight after IHDR, which every reader looks
// at first.
export async function withPngText(blob, fields) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const insertAt = PNG_SIGNATURE_LENGTH + IHDR_CHUNK_LENGTH;
  const chunks = Object.entries(fields)
    .filter(([, text]) => typeof text === "string" && text.length > 0)
    .map(([keyword, text]) => itxtChunk(keyword, text));
  return new Blob([bytes.subarray(0, insertAt), ...chunks, bytes.subarray(insertAt)], { type: "image/png" });
}
