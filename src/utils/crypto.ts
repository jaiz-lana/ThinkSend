const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  return bytesToHex(new Uint8Array(hashBuffer));
}

export async function sha256Bytes(data: Uint8Array | string): Promise<Uint8Array> {
  const raw = typeof data === 'string' ? textEncoder.encode(data) : data;
  const hashBuffer = await crypto.subtle.digest('SHA-256', toArrayBuffer(raw));
  return new Uint8Array(hashBuffer);
}

export async function sha256TextHex(text: string): Promise<string> {
  return bytesToHex(await sha256Bytes(text));
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.byteLength; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.byteLength));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

export function base64ToUint8(base64: string): Uint8Array {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  return uint8ToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  return base64ToUint8(padded);
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function randomId(byteLength = 8): string {
  return base64UrlEncode(randomBytes(byteLength));
}

// Streaming FIPS 180-4 SHA-256 untuk file besar tanpa membebani RAM
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

export class Sha256Stream {
  private readonly h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private readonly buf = new Uint8Array(64);
  private readonly w = new Uint32Array(64);
  private bufLen = 0;
  private totalBytes = 0;

  update(chunk: Uint8Array): void {
    this.totalBytes += chunk.byteLength;
    let offset = 0;

    if (this.bufLen > 0) {
      const needed = 64 - this.bufLen;
      if (chunk.byteLength < needed) {
        this.buf.set(chunk, this.bufLen);
        this.bufLen += chunk.byteLength;
        return;
      }
      this.buf.set(chunk.subarray(0, needed), this.bufLen);
      this.processBlock(this.buf, 0);
      this.bufLen = 0;
      offset = needed;
    }

    while (offset + 64 <= chunk.byteLength) {
      this.processBlock(chunk, offset);
      offset += 64;
    }

    if (offset < chunk.byteLength) {
      const rem = chunk.subarray(offset);
      this.buf.set(rem, 0);
      this.bufLen = rem.byteLength;
    }
  }

  digestHex(): string {
    const finalBuf = new Uint8Array(this.bufLen < 56 ? 64 : 128);
    finalBuf.set(this.buf.subarray(0, this.bufLen), 0);
    finalBuf[this.bufLen] = 0x80;

    const totalBitsHigh = Math.floor((this.totalBytes * 8) / 0x100000000);
    const totalBitsLow = (this.totalBytes * 8) >>> 0;
    const view = new DataView(finalBuf.buffer);
    view.setUint32(finalBuf.length - 8, totalBitsHigh, false);
    view.setUint32(finalBuf.length - 4, totalBitsLow, false);

    this.processBlock(finalBuf, 0);
    if (finalBuf.length === 128) {
      this.processBlock(finalBuf, 64);
    }

    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) {
      outView.setUint32(i * 4, this.h[i], false);
    }
    return bytesToHex(out);
  }

  private processBlock(block: Uint8Array, offset: number): void {
    const w = this.w;
    for (let i = 0; i < 16; i++) {
      const p = offset + i * 4;
      w[i] =
        ((block[p] << 24) | (block[p + 1] << 16) | (block[p + 2] << 8) | block[p + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = this.h[0];
    let b = this.h[1];
    let c = this.h[2];
    let d = this.h[3];
    let e = this.h[4];
    let f = this.h[5];
    let g = this.h[6];
    let hh = this.h[7];

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    this.h[0] = (this.h[0] + a) >>> 0;
    this.h[1] = (this.h[1] + b) >>> 0;
    this.h[2] = (this.h[2] + c) >>> 0;
    this.h[3] = (this.h[3] + d) >>> 0;
    this.h[4] = (this.h[4] + e) >>> 0;
    this.h[5] = (this.h[5] + f) >>> 0;
    this.h[6] = (this.h[6] + g) >>> 0;
    this.h[7] = (this.h[7] + hh) >>> 0;
  }
}

export async function computeFileSha256(
  file: Blob,
  onProgress?: (ratio: number) => void
): Promise<string> {
  if (file.size <= 16 * 1024 * 1024) {
    const hex = await sha256Hex(await file.arrayBuffer());
    onProgress?.(1);
    return hex;
  }

  const stream = new Sha256Stream();
  const sliceSize = 2 * 1024 * 1024;
  for (let offset = 0; offset < file.size; offset += sliceSize) {
    const buf = await file.slice(offset, Math.min(offset + sliceSize, file.size)).arrayBuffer();
    stream.update(new Uint8Array(buf));
    onProgress?.(Math.min(1, (offset + sliceSize) / file.size));
  }
  return stream.digestHex();
}

// --- End-to-End Encryption (ECDH P-256 + HKDF-SHA256 + AES-256-GCM + HMAC PIN) ---

export async function generateEcdhKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
}

export async function exportPublicKeyJwk(publicKey: CryptoKey): Promise<JsonWebKey> {
  return crypto.subtle.exportKey('jwk', publicKey);
}

export async function importEcdhPublicKeyJwk(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    []
  );
}

export async function deriveAesKeyFromEcdh(
  privateKey: CryptoKey,
  peerPublicKey: CryptoKey,
  salt: Uint8Array,
  info: string
): Promise<CryptoKey> {
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: peerPublicKey },
    privateKey,
    256
  );
  const baseKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: toArrayBuffer(salt),
      info: toArrayBuffer(textEncoder.encode(info)),
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function deriveSessionCrypto(
  privateKey: CryptoKey,
  peerPublicKey: CryptoKey,
  salt: Uint8Array
): Promise<{ sessionKey: CryptoKey; pinHmacKey: CryptoKey; sasCode: string }> {
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: peerPublicKey },
    privateKey,
    256
  );
  const hkdfKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, [
    'deriveKey',
    'deriveBits',
  ]);

  const [sessionKey, pinHmacKey, sasBits] = await Promise.all([
    crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: toArrayBuffer(salt),
        info: toArrayBuffer(textEncoder.encode('thinksend-e2ee-data-v1')),
      },
      hkdfKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    ),
    crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: toArrayBuffer(salt),
        info: toArrayBuffer(textEncoder.encode('thinksend-e2ee-pin-v1')),
      },
      hkdfKey,
      { name: 'HMAC', hash: 'SHA-256', length: 256 },
      false,
      ['sign', 'verify']
    ),
    crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: toArrayBuffer(salt),
        info: toArrayBuffer(textEncoder.encode('thinksend-e2ee-sas-v1')),
      },
      hkdfKey,
      32
    ),
  ]);

  const sasNum = new DataView(sasBits).getUint32(0, false) % 1_000_000;
  const sasStr = String(sasNum).padStart(6, '0');
  const sasCode = `${sasStr.slice(0, 3)}-${sasStr.slice(3)}`;

  return { sessionKey, pinHmacKey, sasCode };
}

export async function deriveRoomSignalKey(roomSecret: string): Promise<CryptoKey> {
  const keyMaterial = await sha256Bytes(`thinksend-room-aes-v1:${roomSecret}`);
  return crypto.subtle.importKey('raw', toArrayBuffer(keyMaterial), 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}

export async function sealAesGcm(
  key: CryptoKey,
  plaintext: Uint8Array,
  aad?: Uint8Array,
  explicitIv?: Uint8Array
): Promise<Uint8Array> {
  const iv = explicitIv ?? randomBytes(12);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: toArrayBuffer(iv),
        ...(aad ? { additionalData: toArrayBuffer(aad) } : {}),
      },
      key,
      toArrayBuffer(plaintext)
    )
  );
  const packed = new Uint8Array(12 + ciphertext.byteLength);
  packed.set(iv, 0);
  packed.set(ciphertext, 12);
  return packed;
}

export async function openAesGcm(
  key: CryptoKey,
  sealed: Uint8Array,
  aad?: Uint8Array
): Promise<Uint8Array> {
  if (sealed.byteLength < 12 + 16) {
    throw new Error('Paket terenkripsi tidak valid');
  }
  const iv = sealed.subarray(0, 12);
  const ciphertext = sealed.subarray(12);
  const plain = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: toArrayBuffer(iv),
      ...(aad ? { additionalData: toArrayBuffer(aad) } : {}),
    },
    key,
    toArrayBuffer(ciphertext)
  );
  return new Uint8Array(plain);
}

export async function hmacSha256Hex(key: CryptoKey, data: string): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', key, toArrayBuffer(textEncoder.encode(data)));
  return bytesToHex(new Uint8Array(sig));
}

export function buildDirectionalIv(prefix4: Uint8Array, seq: number): Uint8Array {
  const iv = new Uint8Array(12);
  iv.set(prefix4.subarray(0, 4), 0);
  const view = new DataView(iv.buffer);
  const high = Math.floor(seq / 0x100000000);
  const low = seq >>> 0;
  view.setUint32(4, high, false);
  view.setUint32(8, low, false);
  return iv;
}

// --- Compact SDP / QR Payload Codec (Shrinks Offer/Answer ~60% for fast QR scanning) ---

export async function encodeCompactPayload(text: string): Promise<string> {
  const raw = textEncoder.encode(text);
  if (typeof CompressionStream !== 'undefined') {
    try {
      const cs = new CompressionStream('deflate-raw');
      const readPromise = new Response(cs.readable).arrayBuffer();
      const writer = cs.writable.getWriter();
      await writer.write(toArrayBuffer(raw));
      await writer.close();
      const compressed = new Uint8Array(await readPromise);
      if (compressed.byteLength < raw.byteLength) {
        return `c:${base64UrlEncode(compressed)}`;
      }
    } catch {
      // Fallback ke payload tanpa kompresi
    }
  }
  return `u:${base64UrlEncode(raw)}`;
}

export async function decodeCompactPayload(encoded: string): Promise<string> {
  const trimmed = encoded.replace(/\s+/g, '');
  if (!trimmed) {
    throw new Error('Kode masih kosong. Tempel atau pindai kode terlebih dahulu.');
  }
  try {
    if (trimmed.startsWith('c:')) {
      if (typeof DecompressionStream === 'undefined') {
        throw new Error('Browser ini tidak mendukung DecompressionStream untuk membaca kode.');
      }
      const compressed = base64UrlDecode(trimmed.slice(2));
      const ds = new DecompressionStream('deflate-raw');
      const readPromise = new Response(ds.readable).arrayBuffer();
      const writer = ds.writable.getWriter();
      await writer.write(toArrayBuffer(compressed));
      await writer.close();
      const plain = await readPromise;
      return textDecoder.decode(plain);
    }
    if (trimmed.startsWith('u:')) {
      return textDecoder.decode(base64UrlDecode(trimmed.slice(2)));
    }
    // Kompatibilitas dengan kode Base64 JSON versi lama
    return textDecoder.decode(base64ToUint8(trimmed));
  } catch (err) {
    if (err instanceof Error && err.message.includes('DecompressionStream')) throw err;
    throw new Error('Format kode tidak valid atau terpotong saat disalin. Pastikan seluruh teks kode tersalin.');
  }
}

export async function parseCompactSdp(
  encoded: string,
  expectedType: 'offer' | 'answer'
): Promise<RTCSessionDescriptionInit> {
  const rawJson = await decodeCompactPayload(encoded);
  let desc: unknown;
  try {
    desc = JSON.parse(rawJson);
  } catch {
    throw new Error('Isi kode bukan data sesi P2P yang valid.');
  }
  if (!desc || typeof desc !== 'object') {
    throw new Error('Data kode P2P tidak dikenali.');
  }
  const typed = desc as { type?: unknown; sdp?: unknown };
  if (typeof typed.type !== 'string' || typeof typed.sdp !== 'string' || typed.sdp.length < 10) {
    throw new Error('Struktur kode P2P tidak lengkap.');
  }
  if (typed.type !== expectedType) {
    if (expectedType === 'answer' && typed.type === 'offer') {
      throw new Error(
        'Anda menempel Kode Sesi (Offer), padahal kolom ini khusus untuk Kode Balasan (Answer) dari penerima.'
      );
    }
    if (expectedType === 'offer' && typed.type === 'answer') {
      throw new Error(
        'Anda menempel Kode Balasan (Answer), padahal kolom ini khusus untuk Kode Sesi (Offer) dari pengirim.'
      );
    }
    throw new Error(`Jenis kode (${typed.type}) tidak sesuai dengan yang dibutuhkan (${expectedType}).`);
  }
  return { type: typed.type, sdp: typed.sdp };
}
