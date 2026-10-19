// ---------------------------------------------------------------------------
// NS Glucose -- ext4.js
// Verify and decrypt one sealed 16-byte packet from the bridge (protocol
// v2). Must match BridgeSecurity.swift (PacketSealer) and PROTOCOL.md.
//
//   Byte 0-3   : nonce uint32 LE = unix seconds, strictly increasing
//   Byte 4-11  : 8-byte reading, XOR-encrypted with E(nonce, 0)
//   Byte 12-15 : tag = first word of E(E(nonce, 0xFFFFFFFF) ^ reading)
//
// E is XTEA with the 128-bit key from the "Bridge key" setting (32 hex
// digits, spaces ignored). Loaded via loadExt(4) per packet, then freed.
//
// Returns [glucose, trend, ageMin, rate, nonce, iob x100 (-32768 unknown),
// loop age min (255 unknown)] or an error code:
//   -1 no/invalid key   -2 wrong key or tampered   -3 replayed / clock off
// ---------------------------------------------------------------------------
function(data, keyHex, now, lastNonce) {
  var i, c, n = 0, nib = [], k = [];
  keyHex = '' + keyHex;
  for (i = 0; i < keyHex.length; i++) {
    c = keyHex.charCodeAt(i);
    if (c >= 48 && c <= 57) { nib[n++] = c - 48; }
    else if (c >= 97 && c <= 102) { nib[n++] = c - 87; }
    else if (c >= 65 && c <= 70) { nib[n++] = c - 55; }
  }
  if (n != 32) return -1;
  for (i = 0; i < 4; i++) {
    k[i] = ((nib[8*i] << 4 | nib[8*i+1]) | (nib[8*i+2] << 4 | nib[8*i+3]) << 8 |
            (nib[8*i+4] << 4 | nib[8*i+5]) << 16 | (nib[8*i+6] << 4 | nib[8*i+7]) << 24) >>> 0;
  }

  var enc = function(v0, v1) {
    var s = 0, r;
    for (r = 0; r < 32; r++) {
      v0 = (v0 + ((((v1 << 4) ^ (v1 >>> 5)) + v1) ^ (s + k[s & 3]))) >>> 0;
      s = (s + 0x9E3779B9) >>> 0;
      v1 = (v1 + ((((v0 << 4) ^ (v0 >>> 5)) + v0) ^ (s + k[(s >>> 11) & 3]))) >>> 0;
    }
    return [v0, v1];
  };
  var u32 = function(b, o) {
    return (b[o] | (b[o+1] << 8) | (b[o+2] << 16) | (b[o+3] << 24)) >>> 0;
  };

  if (data.length != 16) return -2;
  var nonce = u32(data, 0);
  var ks = enc(nonce, 0), p = [];
  for (i = 0; i < 8; i++) {
    p[i] = data[4+i] ^ ((ks[i >> 2] >>> ((i & 3) * 8)) & 255);
  }
  var x = enc(nonce, 0xFFFFFFFF);
  var tag = enc((x[0] ^ u32(p, 0)) >>> 0, (x[1] ^ u32(p, 4)) >>> 0)[0];
  if (tag !== u32(data, 12)) return -2;
  if (!(now > 0) || nonce <= lastNonce || nonce > now + 600 || nonce < now - 600) return -3;

  return [(p[0] | (p[1] << 8)) / 100,
          p[2] <= 7 ? p[2] : 0,
          p[3],
          p[4] > 127 ? p[4] - 256 : p[4],
          nonce,
          (p[5] | (p[6] << 8)) > 32767 ? (p[5] | (p[6] << 8)) - 65536 : (p[5] | (p[6] << 8)),
          p[7]];
}
