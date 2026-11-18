import {
  base64UrlDecode,
  base64UrlEncode,
  buildDirectionalIv,
  computeFileSha256,
  deriveSessionCrypto,
  exportPublicKeyJwk,
  generateEcdhKeyPair,
  hmacSha256Hex,
  importEcdhPublicKeyJwk,
  openAesGcm,
  randomBytes,
  sealAesGcm,
  sha256Bytes,
} from './crypto';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const CHUNK_SIZE = 32 * 1024; // 32 KB per frame WebRTC aman lintas browser
const MAX_BUFFERED_AMOUNT = 1024 * 1024; // 1 MB backpressure cap

export type WebRtcNetworkMode = 'wlan-offline' | 'wlan-auto' | 'provider';

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function createPeerConnectionForMode(mode: WebRtcNetworkMode): RTCPeerConnection {
  if (mode === 'wlan-offline') {
    return new RTCPeerConnection({ iceServers: [] });
  }
  return new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
    ],
  });
}

export async function gatherIceDescription(
  pc: RTCPeerConnection,
  timeoutMs = 2500
): Promise<RTCSessionDescriptionInit> {
  if (pc.iceGatheringState === 'complete' && pc.localDescription) {
    return pc.localDescription.toJSON();
  }
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', onState);
      pc.removeEventListener('icecandidate', onCand);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    const onState = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };
    const onCand = (e: RTCPeerConnectionIceEvent) => {
      if (!e.candidate) finish();
    };
    pc.addEventListener('icegatheringstatechange', onState);
    pc.addEventListener('icecandidate', onCand);
  });
  if (!pc.localDescription) {
    throw new Error('Deskripsi lokal WebRTC tidak tersedia');
  }
  return pc.localDescription.toJSON();
}

export async function detectIcePathLabel(pc: RTCPeerConnection): Promise<string> {
  try {
    const stats = await pc.getStats();
    let activeLocalId: string | null = null;
    stats.forEach((report) => {
      if (report.type === 'candidate-pair') {
        const pair = report as RTCIceCandidatePairStats & { nominated?: boolean };
        if (pair.nominated || pair.state === 'succeeded') {
          activeLocalId = pair.localCandidateId;
        }
      }
    });
    if (activeLocalId) {
      const local = stats.get(activeLocalId) as { candidateType?: string } | undefined;
      if (local?.candidateType === 'host') return 'LAN Wi-Fi Langsung (0 Kuota)';
      if (local?.candidateType === 'srflx' || local?.candidateType === 'prflx') {
        return 'P2P Langsung';
      }
      if (local?.candidateType === 'relay') return 'P2P Relay';
    }
  } catch {
    // Abaikan jika browser membatasi getStats
  }
  return 'WebRTC DTLS P2P';
}

type HandshakeHello = {
  t: 'e2ee_hello';
  pub: JsonWebKey;
  nonce: string;
  requirePin: boolean;
};

type PinControlMsg =
  | { t: 'pin_auth'; proof: string }
  | { t: 'pin_ok' }
  | { t: 'pin_retry'; remaining: number }
  | { t: 'pin_fail' };

type EncryptedControlMsg =
  | { t: 'file_start'; id: string; name: string; size: number; mime: string; sha256: string }
  | { t: 'file_end'; id: string }
  | { t: 'file_verified'; id: string; ok: boolean };

export type TransferProgressInfo = {
  fileIndex: number;
  totalFiles: number;
  fileName: string;
  doneBytes: number;
  totalBytes: number;
  speedBps: number;
  phase: 'hashing' | 'transferring' | 'verifying';
};

export type ReceivedFileResult = {
  id: string;
  name: string;
  size: number;
  mime: string;
  sha256: string;
  verified: boolean;
  blob: Blob;
  url: string;
};

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

const FRAME_CONTROL = 0x01;
const FRAME_CHUNK = 0x02;

export class E2eeDataSession {
  private readonly dc: RTCDataChannel;
  private readonly isInitiator: boolean;
  private queue: Array<string | ArrayBuffer | Blob> = [];
  private waiters: Array<{
    resolve: (val: string | ArrayBuffer | Blob) => void;
    reject: (err: Error) => void;
  }> = [];
  private closed = false;

  private sessionKey: CryptoKey | null = null;
  private pinHmacKey: CryptoKey | null = null;
  private sendPrefix: Uint8Array | null = null;
  private recvPrefix: Uint8Array | null = null;
  private sendSeq = 0;
  private recvSeq = 0;
  sasCode = '';

  constructor(dc: RTCDataChannel, isInitiator: boolean) {
    this.dc = dc;
    this.isInitiator = isInitiator;
    this.dc.binaryType = 'arraybuffer';
    this.dc.bufferedAmountLowThreshold = 256 * 1024;

    this.dc.onmessage = (event) => {
      const data = event.data as string | ArrayBuffer | Blob;
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter.resolve(data);
      } else {
        this.queue.push(data);
      }
    };

    this.dc.onclose = () => {
      this.failAllWaiters(new Error('Koneksi DataChannel ditutup.'));
    };

    this.dc.onerror = () => {
      this.failAllWaiters(new Error('Terjadi gangguan pada DataChannel WebRTC.'));
    };
  }

  private failAllWaiters(err: Error): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()!.reject(err);
    }
  }

  private nextRawMessage(): Promise<string | ArrayBuffer | Blob> {
    if (this.queue.length > 0) {
      return Promise.resolve(this.queue.shift()!);
    }
    if (this.closed || this.dc.readyState === 'closed' || this.dc.readyState === 'closing') {
      return Promise.reject(new Error('Koneksi sudah terputus.'));
    }
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  private async nextJsonMessage<T>(): Promise<T> {
    const raw = await this.nextRawMessage();
    if (typeof raw !== 'string') {
      throw new Error('Pesan kontrol handshake tidak valid.');
    }
    return JSON.parse(raw) as T;
  }

  private async waitOpen(): Promise<void> {
    if (this.dc.readyState === 'open') return;
    if (this.dc.readyState === 'closed' || this.dc.readyState === 'closing') {
      throw new Error('DataChannel gagal dibuka.');
    }
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onErr = () => {
        cleanup();
        reject(new Error('DataChannel gagal dibuka.'));
      };
      const cleanup = () => {
        this.dc.removeEventListener('open', onOpen);
        this.dc.removeEventListener('close', onErr);
        this.dc.removeEventListener('error', onErr);
      };
      this.dc.addEventListener('open', onOpen);
      this.dc.addEventListener('close', onErr);
      this.dc.addEventListener('error', onErr);
    });
  }

  private async waitBufferedLow(): Promise<void> {
    if (this.dc.bufferedAmount <= MAX_BUFFERED_AMOUNT) return;
    await new Promise<void>((resolve, reject) => {
      let pollId: number | null = null;
      const onLow = () => {
        if (this.dc.bufferedAmount <= MAX_BUFFERED_AMOUNT) {
          cleanup();
          resolve();
        }
      };
      const onClose = () => {
        cleanup();
        reject(new Error('Koneksi terputus saat mengirim data.'));
      };
      const cleanup = () => {
        if (pollId !== null) clearInterval(pollId);
        this.dc.removeEventListener('bufferedamountlow', onLow);
        this.dc.removeEventListener('close', onClose);
        this.dc.removeEventListener('error', onClose);
      };
      this.dc.addEventListener('bufferedamountlow', onLow);
      this.dc.addEventListener('close', onClose);
      this.dc.addEventListener('error', onClose);
      pollId = window.setInterval(() => {
        if (this.closed || this.dc.readyState === 'closed' || this.dc.readyState === 'closing') {
          onClose();
        } else if (this.dc.bufferedAmount <= MAX_BUFFERED_AMOUNT) {
          cleanup();
          resolve();
        }
      }, 120);
    });
  }

  async negotiate(opts: {
    localPin?: string;
    onChannelOpen?: () => void;
    onRequestRemotePin?: (sasCode: string, attempt: number, remaining: number) => Promise<string | null>;
  }): Promise<{ sasCode: string }> {
    if (this.closed) throw new Error('Sesi sudah ditutup.');
    await this.waitOpen();
    opts.onChannelOpen?.();

    const ecdhPair = await generateEcdhKeyPair();
    const myNonce = randomBytes(16);
    const myPubJwk = await exportPublicKeyJwk(ecdhPair.publicKey);
    const requirePin = Boolean(opts.localPin && opts.localPin.trim().length > 0);

    const helloMsg: HandshakeHello = {
      t: 'e2ee_hello',
      pub: myPubJwk,
      nonce: base64UrlEncode(myNonce),
      requirePin,
    };
    this.dc.send(JSON.stringify(helloMsg));

    const peerHello = await this.nextJsonMessage<HandshakeHello>();
    if (peerHello.t !== 'e2ee_hello' || !peerHello.pub || !peerHello.nonce) {
      throw new Error('Handshake E2EE tidak valid.');
    }

    const peerNonce = base64UrlDecode(peerHello.nonce);
    const peerPubKey = await importEcdhPublicKeyJwk(peerHello.pub);

    // Urutkan nonce secara deterministik agar kedua sisi menghasilkan salt identik
    const myB64 = helloMsg.nonce;
    const peerB64 = peerHello.nonce;
    const orderedSalt = new Uint8Array(myNonce.byteLength + peerNonce.byteLength);
    if (myB64 <= peerB64) {
      orderedSalt.set(myNonce, 0);
      orderedSalt.set(peerNonce, myNonce.byteLength);
    } else {
      orderedSalt.set(peerNonce, 0);
      orderedSalt.set(myNonce, peerNonce.byteLength);
    }

    const { sessionKey, pinHmacKey, sasCode } = await deriveSessionCrypto(
      ecdhPair.privateKey,
      peerPubKey,
      orderedSalt
    );
    this.sessionKey = sessionKey;
    this.pinHmacKey = pinHmacKey;
    this.sasCode = sasCode;

    // Prefix IV terarah diturunkan dari salt agar tidak mungkin bertabrakan
    const initPrefix = (await sha256Bytes(new Uint8Array([...orderedSalt, 0x49]))).subarray(0, 4);
    const respPrefix = (await sha256Bytes(new Uint8Array([...orderedSalt, 0x52]))).subarray(0, 4);
    this.sendPrefix = this.isInitiator ? initPrefix : respPrefix;
    this.recvPrefix = this.isInitiator ? respPrefix : initPrefix;

    // Challenge-Response PIN tanpa mengirim PIN plaintext
    if (peerHello.requirePin) {
      if (!opts.onRequestRemotePin) {
        throw new Error('Perangkat tujuan meminta PIN.');
      }
      let remaining = 3;
      let attempt = 1;
      while (true) {
        const pinInput = await opts.onRequestRemotePin(sasCode, attempt, remaining);
        if (!pinInput) {
          this.dc.close();
          throw new Error('Verifikasi PIN dibatalkan.');
        }
        const proof = await hmacSha256Hex(this.pinHmacKey, `pin-auth:${pinInput.trim()}`);
        this.dc.send(JSON.stringify({ t: 'pin_auth', proof } as PinControlMsg));
        const resp = await this.nextJsonMessage<PinControlMsg>();
        if (resp.t === 'pin_ok') break;
        if (resp.t === 'pin_retry') {
          remaining = resp.remaining;
          attempt++;
          continue;
        }
        this.dc.close();
        throw new Error('PIN salah terlalu banyak. Koneksi diputus.');
      }
    }

    if (requirePin && opts.localPin) {
      const expected = await hmacSha256Hex(this.pinHmacKey, `pin-auth:${opts.localPin.trim()}`);
      let remaining = 3;
      while (true) {
        const msg = await this.nextJsonMessage<PinControlMsg>();
        if (msg.t !== 'pin_auth') {
          throw new Error('Autentikasi PIN diperlukan.');
        }
        if (constantTimeEqualHex(msg.proof, expected)) {
          this.dc.send(JSON.stringify({ t: 'pin_ok' } as PinControlMsg));
          break;
        }
        remaining--;
        if (remaining <= 0) {
          this.dc.send(JSON.stringify({ t: 'pin_fail' } as PinControlMsg));
          this.dc.close();
          throw new Error('Pengirim gagal verifikasi PIN.');
        }
        this.dc.send(JSON.stringify({ t: 'pin_retry', remaining } as PinControlMsg));
      }
    }

    return { sasCode };
  }

  private async sendEncryptedFrame(kind: number, payload: Uint8Array): Promise<void> {
    if (!this.sessionKey || !this.sendPrefix) {
      throw new Error('Sesi E2EE belum diinisialisasi.');
    }
    const seq = this.sendSeq++;
    const iv = buildDirectionalIv(this.sendPrefix, seq);
    const aad = new Uint8Array(9);
    aad[0] = kind;
    aad.set(iv.subarray(4, 12), 1);

    const sealed = await sealAesGcm(this.sessionKey, payload, aad, iv);
    const packet = new Uint8Array(1 + sealed.byteLength);
    packet[0] = kind;
    packet.set(sealed, 1);

    if (this.dc.bufferedAmount > MAX_BUFFERED_AMOUNT) {
      await this.waitBufferedLow();
    }
    this.dc.send(packet.buffer);
  }

  private async readDecryptedFrame(): Promise<{ kind: number; data: Uint8Array }> {
    if (!this.sessionKey || !this.recvPrefix) {
      throw new Error('Sesi E2EE belum diinisialisasi.');
    }
    const raw = await this.nextRawMessage();
    const buf =
      raw instanceof ArrayBuffer ? raw : raw instanceof Blob ? await raw.arrayBuffer() : null;
    if (!buf || buf.byteLength < 1 + 12 + 16) {
      throw new Error('Frame E2EE rusak atau tidak lengkap.');
    }
    const bytes = new Uint8Array(buf);
    const kind = bytes[0];
    const seq = this.recvSeq++;
    const expectedIv = buildDirectionalIv(this.recvPrefix, seq);
    for (let i = 0; i < 12; i++) {
      if (bytes[1 + i] !== expectedIv[i]) {
        throw new Error('Urutan atau nonce frame E2EE tidak cocok.');
      }
    }
    const aad = new Uint8Array(9);
    aad[0] = kind;
    aad.set(expectedIv.subarray(4, 12), 1);
    const plain = await openAesGcm(this.sessionKey, bytes.subarray(1), aad);
    return { kind, data: plain };
  }

  async sendFiles(
    files: File[],
    onProgress: (info: TransferProgressInfo) => void
  ): Promise<void> {
    for (let idx = 0; idx < files.length; idx++) {
      const file = files[idx];
      onProgress({
        fileIndex: idx,
        totalFiles: files.length,
        fileName: file.name,
        doneBytes: 0,
        totalBytes: file.size,
        speedBps: 0,
        phase: 'hashing',
      });

      const sha256 = await computeFileSha256(file, (ratio) => {
        onProgress({
          fileIndex: idx,
          totalFiles: files.length,
          fileName: file.name,
          doneBytes: Math.floor(file.size * ratio),
          totalBytes: file.size,
          speedBps: 0,
          phase: 'hashing',
        });
      });

      const id = `${idx}-${Date.now()}`;
      const startMsg: EncryptedControlMsg = {
        t: 'file_start',
        id,
        name: file.name,
        size: file.size,
        mime: file.type || 'application/octet-stream',
        sha256,
      };
      await this.sendEncryptedFrame(FRAME_CONTROL, textEncoder.encode(JSON.stringify(startMsg)));

      const t0 = performance.now();
      let lastReport = 0;
      for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
        const end = Math.min(offset + CHUNK_SIZE, file.size);
        const chunkBuf = await file.slice(offset, end).arrayBuffer();
        await this.sendEncryptedFrame(FRAME_CHUNK, new Uint8Array(chunkBuf));

        const now = performance.now();
        if (now - lastReport > 90 || end === file.size) {
          lastReport = now;
          const elapsedSec = Math.max(0.001, (now - t0) / 1000);
          onProgress({
            fileIndex: idx,
            totalFiles: files.length,
            fileName: file.name,
            doneBytes: end,
            totalBytes: file.size,
            speedBps: end / elapsedSec,
            phase: 'transferring',
          });
        }
      }

      onProgress({
        fileIndex: idx,
        totalFiles: files.length,
        fileName: file.name,
        doneBytes: file.size,
        totalBytes: file.size,
        speedBps: 0,
        phase: 'verifying',
      });
      await this.sendEncryptedFrame(
        FRAME_CONTROL,
        textEncoder.encode(JSON.stringify({ t: 'file_end', id } as EncryptedControlMsg))
      );

      const ackFrame = await this.readDecryptedFrame();
      if (ackFrame.kind !== FRAME_CONTROL) {
        throw new Error('Respons konfirmasi penerima tidak valid.');
      }
      const ack = JSON.parse(textDecoder.decode(ackFrame.data)) as EncryptedControlMsg;
      if (ack.t !== 'file_verified' || !ack.ok) {
        throw new Error(`Verifikasi SHA-256 di penerima gagal untuk ${file.name}.`);
      }
    }
  }

  async listenForFiles(callbacks: {
    onProgress: (info: TransferProgressInfo) => void;
    onFileComplete: (result: ReceivedFileResult) => void;
    onError: (err: Error) => void;
    onRemoteClose?: () => void;
  }): Promise<void> {
    let currentMeta: Extract<EncryptedControlMsg, { t: 'file_start' }> | null = null;
    let chunks: ArrayBuffer[] = [];
    let receivedBytes = 0;
    let fileCount = 0;
    let startTime = 0;
    let lastReport = 0;

    try {
      while (!this.closed) {
        const frame = await this.readDecryptedFrame();
        if (frame.kind === FRAME_CONTROL) {
          const msg = JSON.parse(textDecoder.decode(frame.data)) as EncryptedControlMsg;
          if (msg.t === 'file_start') {
            currentMeta = msg;
            chunks = [];
            receivedBytes = 0;
            startTime = performance.now();
            lastReport = 0;
            callbacks.onProgress({
              fileIndex: fileCount,
              totalFiles: fileCount + 1,
              fileName: msg.name,
              doneBytes: 0,
              totalBytes: msg.size,
              speedBps: 0,
              phase: 'transferring',
            });
          } else if (msg.t === 'file_end' && currentMeta) {
            callbacks.onProgress({
              fileIndex: fileCount,
              totalFiles: fileCount + 1,
              fileName: currentMeta.name,
              doneBytes: currentMeta.size,
              totalBytes: currentMeta.size,
              speedBps: 0,
              phase: 'verifying',
            });
            const blob = new Blob(chunks, { type: currentMeta.mime });
            chunks = [];
            const actualSha = await computeFileSha256(blob);
            const verified = actualSha === currentMeta.sha256;
            await this.sendEncryptedFrame(
              FRAME_CONTROL,
              textEncoder.encode(
                JSON.stringify({
                  t: 'file_verified',
                  id: currentMeta.id,
                  ok: verified,
                } as EncryptedControlMsg)
              )
            );
            const url = URL.createObjectURL(blob);
            callbacks.onFileComplete({
              id: currentMeta.id,
              name: currentMeta.name,
              size: currentMeta.size,
              mime: currentMeta.mime,
              sha256: actualSha,
              verified,
              blob,
              url,
            });
            currentMeta = null;
            fileCount++;
          }
        } else if (frame.kind === FRAME_CHUNK && currentMeta) {
          const buf = frame.data.buffer.slice(
            frame.data.byteOffset,
            frame.data.byteOffset + frame.data.byteLength
          ) as ArrayBuffer;
          chunks.push(buf);
          receivedBytes += buf.byteLength;
          const now = performance.now();
          if (now - lastReport > 90 || receivedBytes >= currentMeta.size) {
            lastReport = now;
            const elapsedSec = Math.max(0.001, (now - startTime) / 1000);
            callbacks.onProgress({
              fileIndex: fileCount,
              totalFiles: fileCount + 1,
              fileName: currentMeta.name,
              doneBytes: receivedBytes,
              totalBytes: currentMeta.size,
              speedBps: receivedBytes / elapsedSec,
              phase: 'transferring',
            });
          }
        }
      }
    } catch (err) {
      if (!this.closed) {
        if (currentMeta === null && (this.dc.readyState === 'closed' || this.dc.readyState === 'closing')) {
          callbacks.onRemoteClose?.();
          return;
        }
        callbacks.onError(err instanceof Error ? err : new Error('Gagal menerima data terenkripsi.'));
      }
    }
  }

  close(): void {
    this.closed = true;
    try {
      this.dc.close();
    } catch {
      // Ignore
    }
  }
}
