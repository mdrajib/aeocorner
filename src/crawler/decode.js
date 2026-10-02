/**
 * Turn the bytes of a page into text using the character set the page declares. Most of the web is UTF-8, but
 * plenty of real sites still send ISO-8859-1 or Windows-1252 (accents become garbage if read as UTF-8) and some
 * Japanese or Russian sites use legacy encodings. Order of authority, as in the HTML standard: the HTTP header,
 * then a byte-order mark, then a `<meta charset>` in the first kilobyte, then UTF-8.
 */

const LABEL = /charset\s*=\s*["']?\s*([A-Za-z0-9_.:-]+)/i;

function labelFromHeader(contentType) {
  return LABEL.exec(String(contentType ?? ''))?.[1] ?? null;
}

/** The charset named by a <meta> tag near the top, found by reading the start of the file as plain bytes. */
function labelFromMeta(bytes) {
  const head = Buffer.from(bytes.subarray(0, 2048)).toString('latin1');
  return /<meta[^>]{0,200}?charset\s*=\s*["']?\s*([A-Za-z0-9_.:-]+)/i.exec(head)?.[1] ?? null;
}

function decoderFor(label) {
  if (!label) return null;
  try {
    return new TextDecoder(label.trim(), { fatal: false });
  } catch {
    return null; // a name the platform doesn't know
  }
}

/** @returns {{ text: string, charset: string }} */
export function decodeBody(bytes, contentType = '') {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { text: buffer.toString('utf8').replace(/^\uFEFF/, ''), charset: 'utf-8' };
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(buffer.subarray(2)), charset: 'utf-16le' };
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(buffer.subarray(2)), charset: 'utf-16be' };
  }
  const decoder = decoderFor(labelFromHeader(contentType)) ?? decoderFor(labelFromMeta(buffer));
  if (decoder) return { text: decoder.decode(buffer), charset: decoder.encoding };
  return { text: new TextDecoder('utf-8', { fatal: false }).decode(buffer), charset: 'utf-8' };
}
