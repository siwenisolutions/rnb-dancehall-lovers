'use strict';
// Small stand-in for iconv-lite, used only in the Cloudflare bundle
// (wrangler.jsonc "alias"). The real package's streaming part doesn't load
// on Workers, and Express only needs text decoding, which TextDecoder does.
function decoder(encoding) {
  return new TextDecoder(String(encoding || 'utf-8').toLowerCase(), { fatal: false });
}
module.exports = {
  encodingExists(encoding) {
    try { decoder(encoding); return true; } catch { return false; }
  },
  getDecoder(encoding) {
    const td = decoder(encoding);
    return { write: (buf) => td.decode(buf, { stream: true }), end: () => td.decode() };
  },
  decode(buf, encoding) {
    return decoder(encoding).decode(buf);
  },
  encode(str, encoding) {
    return Buffer.from(String(str), /^(latin1|binary|iso-8859-1)$/i.test(encoding) ? 'latin1' : 'utf8');
  },
};
