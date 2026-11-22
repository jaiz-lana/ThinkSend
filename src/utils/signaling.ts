import { schnorr } from '@noble/secp256k1';
import {
  base64UrlDecode,
  base64UrlEncode,
  bytesToHex,
  deriveAesKeyFromEcdh,
  deriveRoomSignalKey,
  exportPublicKeyJwk,
  generateEcdhKeyPair,
  importEcdhPublicKeyJwk,
  openAesGcm,
  randomId,
  sealAesGcm,
  sha256Bytes,
  sha256TextHex,
} from './crypto';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const DEFAULT_NOSTR_RELAYS = [
  'wss://relay.primal.net',
  'wss://relay.nostr.net',
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://nostr-pub.wellorder.net',
  'wss://relay.snort.social',
];

export type SignalingPeer = {
  id: string;
  alias: string;
  device: string;
  pubJwk: JsonWebKey;
  requirePin: boolean;
  lastSeen: number;
};

export type DirectSignalPayload =
  | { type: 'invite'; sessionId: string; fileCount: number; totalSize: number; fileSummary: string }
  | { type: 'accept'; sessionId: string }
  | { type: 'decline'; sessionId: string; reason?: string }
  | { type: 'offer'; sessionId: string; sdp: RTCSessionDescriptionInit }
  | { type: 'answer'; sessionId: string; sdp: RTCSessionDescriptionInit }
  | { type: 'ice'; sessionId: string; candidate: RTCIceCandidateInit };

export type RelayStatus = {
  connectedRelays: number;
  targetRelays: number;
  mode: 'nostr' | 'custom-ws';
  lastError?: string;
};

export type CustomWsValidation =
  | { valid: true; url: string }
  | { valid: false; reason: string };

export function validateCustomWsUrl(
  raw: string,
  pageProtocol = typeof window !== 'undefined' ? window.location.protocol : 'https:'
): CustomWsValidation {
  const trimmed = raw.trim();
  if (!trimmed) return { valid: true, url: '' };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      valid: false,
      reason: 'Format URL WebSocket tidak valid. Gunakan format wss://nama-server.contoh',
    };
  }

  if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') {
    return {
      valid: false,
      reason: `Protokol "${parsed.protocol}" tidak didukung WebSocket. Gunakan wss:// atau kosongkan untuk Relay Default.`,
    };
  }

  if (!parsed.hostname) {
    return {
      valid: false,
      reason: 'Alamat server WebSocket tidak boleh kosong.',
    };
  }

  const isLoopback =
    parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === '[::1]';
  if (pageProtocol === 'https:' && parsed.protocol === 'ws:' && !isLoopback) {
    return {
      valid: false,
      reason:
        'Halaman HTTPS hanya mengizinkan wss:// (aman). Kosongkan kolom ini untuk memakai Relay Default.',
    };
  }

  return { valid: true, url: trimmed };
}

const DEVICE_ADJ = [
  'Biru',
  'Perak',
  'Emas',
  'Hijau',
  'Cepat',
  'Kilat',
  'Cerah',
  'Bening',
  'Lincah',
  'Teduh',
];
const DEVICE_NOUN = [
  'Elang',
  'Kancil',
  'Merpati',
  'Rajawali',
  'Komodo',
  'Rusa',
  'Garuda',
  'Lumba-Lumba',
  'Penyu',
  'Kenari',
];

export function detectDeviceLabel(): string {
  const ua = navigator.userAgent;
  if (/android/i.test(ua)) return 'Android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iPhone/iPad';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'Mac';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'Browser';
}

export function getOrCreateAlias(): string {
  const key = 'thinksend_device_alias';
  try {
    const saved = localStorage.getItem(key);
    if (saved && saved.trim().length > 0) return saved.trim().slice(0, 28);
  } catch {
    // Abaikan jika storage dibatasi
  }
  const adj = DEVICE_ADJ[Math.floor(Math.random() * DEVICE_ADJ.length)];
  const noun = DEVICE_NOUN[Math.floor(Math.random() * DEVICE_NOUN.length)];
  const alias = `${noun} ${adj}`;
  try {
    localStorage.setItem(key, alias);
  } catch {
    // Abaikan
  }
  return alias;
}

export function saveAlias(alias: string): string {
  const clean = alias.trim().slice(0, 28) || getOrCreateAlias();
  try {
    localStorage.setItem('thinksend_device_alias', clean);
  } catch {
    // Abaikan
  }
  return clean;
}

export function generateRoomCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = '';
  while (out.length < 12) {
    const rand = new Uint8Array(1);
    crypto.getRandomValues(rand);
    if (rand[0] < 256 - (256 % alphabet.length)) {
      out += alphabet[rand[0] % alphabet.length];
    }
  }
  return out;
}

export function normalizeRoomCode(input: string): string {
  const normalized = input.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
  return normalized.length >= 4 && normalized.length <= 16 ? normalized : '';
}

function normalizeIpGroup(rawIp: string): string {
  const ip = rawIp.trim();
  if (ip.includes(':')) {
    // IPv6: gunakan 4 hextet pertama (/64 prefix) untuk grup Wi-Fi rumah/kantor
    return ip.split(':').slice(0, 4).join(':');
  }
  return ip;
}

function extractStunSrflxIp(): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    let bestV4: string | null = null;
    let bestV6: string | null = null;
    let pc: RTCPeerConnection | null = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        pc?.close();
      } catch {
        // Ignore
      }
      resolve(bestV4 ?? bestV6);
    };

    const timer = setTimeout(finish, 2400);

    try {
      pc = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun.cloudflare.com:3478' },
        ],
      });
      pc.createDataChannel('probe');
      pc.onicecandidate = (e) => {
        if (!e.candidate) {
          finish();
          return;
        }
        const cand = e.candidate.candidate;
        if (cand.includes(' typ srflx ')) {
          const parts = cand.split(' ');
          const ip = parts[4];
          if (ip) {
            if (ip.includes('.')) {
              bestV4 = ip;
              finish();
            } else if (!bestV6 && ip.includes(':')) {
              bestV6 = normalizeIpGroup(ip);
            }
          }
        }
      };
      void pc
        .createOffer()
        .then((offer) => pc?.setLocalDescription(offer))
        .catch(() => finish());
    } catch {
      finish();
    }
  });
}

async function fetchPublicIpv4(): Promise<string | null> {
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 2500);
    const res = await fetch('https://api4.ipify.org?format=json', {
      signal: controller.signal,
      cache: 'no-store',
    });
    clearTimeout(tid);
    if (!res.ok) return null;
    const data = (await res.json()) as { ip?: string };
    return typeof data.ip === 'string' && data.ip.includes('.') ? data.ip : null;
  } catch {
    return null;
  }
}

export async function detectRadarRoomSecret(): Promise<{
  secret: string;
  ipLabel: string;
} | null> {
  const [v4Http, stunIp] = await Promise.all([fetchPublicIpv4(), extractStunSrflxIp()]);
  const groupIp = v4Http ?? (stunIp ? normalizeIpGroup(stunIp) : null);
  if (!groupIp) return null;

  // IP mentah hanya di-hash lokal (SHA-256) sehingga relay tidak tahu IP pengguna
  const hash = await sha256TextHex(`thinksend-radar-v1:${groupIp}`);
  const masked = groupIp.includes('.')
    ? groupIp.split('.').slice(0, 2).join('.') + '.*.*'
    : 'IPv6 LAN';

  return {
    secret: `radar:${hash.slice(0, 32)}`,
    ipLabel: masked,
  };
}

function topicToEphemeralKind(topic: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < topic.length; i++) {
    h = Math.imul(h ^ topic.charCodeAt(i), 0x01000193);
  }
  return ((h >>> 0) % 9000) + 20500;
}

const DEVICE_UID_KEY = 'thinksend_device_uid';
const SESSION_FALLBACK_UID = randomId(10);
const RETIRED_SELF_IDS = new Set<string>();

export function getOrCreateDeviceUid(): string {
  try {
    const saved = localStorage.getItem(DEVICE_UID_KEY);
    if (saved && saved.trim().length >= 6) return saved.trim();
  } catch {
    // Abaikan jika storage dibatasi
  }
  const fresh = randomId(10);
  try {
    localStorage.setItem(DEVICE_UID_KEY, fresh);
  } catch {
    try {
      const sess = sessionStorage.getItem(DEVICE_UID_KEY);
      if (sess) return sess;
      sessionStorage.setItem(DEVICE_UID_KEY, SESSION_FALLBACK_UID);
    } catch {
      // Abaikan
    }
    return SESSION_FALLBACK_UID;
  }
  return fresh;
}

type OuterEnvelope =
  | {
      kind: 'presence';
      id: string;
      deviceUid?: string;
      alias: string;
      device: string;
      pubJwk: JsonWebKey;
      requirePin: boolean;
      bye?: boolean;
      ts: number;
    }
  | {
      kind: 'direct';
      from: string;
      fromDeviceUid?: string;
      to: string;
      fromPubJwk: JsonWebKey;
      enc: string;
      ts: number;
    };

export class ThinkSendSignalingRoom {
  readonly selfId: string;
  readonly selfDeviceUid: string;
  private alias: string;
  private readonly device: string;
  private requirePin: boolean;
  private readonly roomSecret: string;
  private readonly customWsUrl?: string;

  private ecdhPair: CryptoKeyPair | null = null;
  private selfPubJwk: JsonWebKey | null = null;
  private roomKey: CryptoKey | null = null;
  private topicHash = '';
  private nostrKind = 21000;
  private nostrKeypair = schnorr.keygen();

  private sockets = new Map<string, WebSocket>();
  private customWs: WebSocket | null = null;
  private customWsError?: string;
  private closed = false;
  private closing = false;
  private subId = `ts-${randomId(6)}`;
  private seenIds = new Set<string>();
  private peers = new Map<string, SignalingPeer>();
  private pairKeyCache = new Map<string, CryptoKey>();

  private heartbeatTimer: number | null = null;
  private pruneTimer: number | null = null;
  private reconnectTimers = new Map<string, number>();
  private onPageHideBound: () => void;

  private onPeersUpdate: (peers: SignalingPeer[]) => void;
  private onDirectSignal: (peer: SignalingPeer, signal: DirectSignalPayload) => void;
  private onStatus: (status: RelayStatus) => void;
  private onPeerBye?: (peerId: string) => void;

  constructor(opts: {
    alias: string;
    requirePin: boolean;
    roomSecret: string;
    customWsUrl?: string;
    onPeersUpdate: (peers: SignalingPeer[]) => void;
    onDirectSignal: (peer: SignalingPeer, signal: DirectSignalPayload) => void;
    onStatus: (status: RelayStatus) => void;
    onPeerBye?: (peerId: string) => void;
  }) {
    this.selfId = randomId(9);
    this.selfDeviceUid = getOrCreateDeviceUid();
    RETIRED_SELF_IDS.add(this.selfId);
    if (RETIRED_SELF_IDS.size > 64) {
      const oldest = RETIRED_SELF_IDS.values().next().value;
      if (oldest && oldest !== this.selfId) RETIRED_SELF_IDS.delete(oldest);
    }

    this.alias = opts.alias;
    this.device = detectDeviceLabel();
    this.requirePin = opts.requirePin;
    this.roomSecret = opts.roomSecret;
    this.customWsUrl = opts.customWsUrl?.trim() || undefined;
    this.onPeersUpdate = opts.onPeersUpdate;
    this.onDirectSignal = opts.onDirectSignal;
    this.onStatus = opts.onStatus;
    this.onPeerBye = opts.onPeerBye;

    this.onPageHideBound = () => {
      void this.broadcastPresence(true);
    };
  }

  async start(): Promise<void> {
    this.ecdhPair = await generateEcdhKeyPair();
    this.selfPubJwk = await exportPublicKeyJwk(this.ecdhPair.publicKey);
    this.roomKey = await deriveRoomSignalKey(this.roomSecret);
    this.topicHash = (await sha256TextHex(`thinksend-topic-v1:${this.roomSecret}`)).slice(0, 32);
    this.nostrKind = topicToEphemeralKind(this.topicHash);

    if (this.closed || this.closing) return;

    window.addEventListener('pagehide', this.onPageHideBound);

    if (this.customWsUrl) {
      this.connectCustomWs(this.customWsUrl);
    } else {
      const targetRelays = DEFAULT_NOSTR_RELAYS.slice(0, 4);
      targetRelays.forEach((url, idx) => {
        this.connectNostrRelay(url, idx);
      });
    }

    this.heartbeatTimer = window.setInterval(() => {
      void this.broadcastPresence(false);
    }, 10_000);

    this.pruneTimer = window.setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [id, peer] of this.peers) {
        if (now - peer.lastSeen > 30_000) {
          this.peers.delete(id);
          this.onPeerBye?.(id);
          changed = true;
        }
      }
      if (changed) this.emitPeers();
    }, 5_000);
  }

  updateSelfMeta(opts: { alias?: string; requirePin?: boolean }): void {
    if (opts.alias !== undefined) this.alias = opts.alias;
    if (opts.requirePin !== undefined) this.requirePin = opts.requirePin;
    void this.broadcastPresence(false);
  }

  getPeers(): SignalingPeer[] {
    return Array.from(this.peers.values());
  }

  async sendDirect(targetPeer: SignalingPeer, signal: DirectSignalPayload): Promise<void> {
    if (this.closed || this.closing || !this.ecdhPair || !this.selfPubJwk) return;
    const pairKey = await this.getPairKey(targetPeer.id, targetPeer.pubJwk);
    const aad = textEncoder.encode(`${this.topicHash}:${this.selfId}:${targetPeer.id}`);
    const sealedDirect = await sealAesGcm(
      pairKey,
      textEncoder.encode(JSON.stringify(signal)),
      aad
    );

    await this.publishEnvelope({
      kind: 'direct',
      from: this.selfId,
      fromDeviceUid: this.selfDeviceUid,
      to: targetPeer.id,
      fromPubJwk: this.selfPubJwk,
      enc: base64UrlEncode(sealedDirect),
      ts: Date.now(),
    });
  }

  async close(): Promise<void> {
    if (this.closed || this.closing) return;
    this.closing = true;
    window.removeEventListener('pagehide', this.onPageHideBound);

    const hasOpenSocket =
      (this.customWs && this.customWs.readyState === WebSocket.OPEN) ||
      Array.from(this.sockets.values()).some((ws) => ws.readyState === WebSocket.OPEN);

    try {
      await this.broadcastPresence(true);
      if (hasOpenSocket) {
        // Beri waktu singkat agar frame bye benar-benar terkirim sebelum socket ditutup
        await new Promise((r) => setTimeout(r, 85));
      }
    } catch {
      // Abaikan saat tutup
    }

    this.closed = true;
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
    if (this.pruneTimer !== null) clearInterval(this.pruneTimer);
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    this.reconnectTimers.clear();

    for (const ws of this.sockets.values()) {
      try {
        ws.close();
      } catch {
        // Ignore
      }
    }
    this.sockets.clear();
    if (this.customWs) {
      try {
        this.customWs.close();
      } catch {
        // Ignore
      }
      this.customWs = null;
    }
    this.peers.clear();
    this.pairKeyCache.clear();
  }

  private emitStatus(lastError?: string): void {
    if (this.closed || this.closing) return;
    if (this.customWsUrl) {
      this.onStatus({
        connectedRelays: this.customWs?.readyState === WebSocket.OPEN ? 1 : 0,
        targetRelays: 1,
        mode: 'custom-ws',
        lastError,
      });
      return;
    }
    let openCount = 0;
    for (const ws of this.sockets.values()) {
      if (ws.readyState === WebSocket.OPEN) openCount++;
    }
    this.onStatus({
      connectedRelays: openCount,
      targetRelays: 4,
      mode: 'nostr',
      lastError,
    });
  }

  private emitPeers(): void {
    if (this.closed || this.closing) return;
    const list = Array.from(this.peers.values()).sort((a, b) => a.alias.localeCompare(b.alias));
    this.onPeersUpdate(list);
  }

  private async getPairKey(peerId: string, pubJwk: JsonWebKey): Promise<CryptoKey> {
    const cached = this.pairKeyCache.get(peerId);
    if (cached) return cached;
    if (!this.ecdhPair) throw new Error('ECDH keypair belum siap');
    const peerPub = await importEcdhPublicKeyJwk(pubJwk);
    const pairSalt = await sha256Bytes(
      `${this.topicHash}:${[this.selfId, peerId].sort().join(':')}`
    );
    const derived = await deriveAesKeyFromEcdh(
      this.ecdhPair.privateKey,
      peerPub,
      pairSalt,
      'thinksend-sig-e2ee-v1'
    );
    this.pairKeyCache.set(peerId, derived);
    return derived;
  }

  private async broadcastPresence(bye: boolean): Promise<void> {
    if (this.closed || !this.selfPubJwk) return;
    if (this.closing && !bye) return;
    await this.publishEnvelope({
      kind: 'presence',
      id: this.selfId,
      deviceUid: this.selfDeviceUid,
      alias: this.alias,
      device: this.device,
      pubJwk: this.selfPubJwk,
      requirePin: this.requirePin,
      ...(bye ? { bye: true } : {}),
      ts: Date.now(),
    });
  }

  private async publishEnvelope(envelope: OuterEnvelope): Promise<void> {
    if (!this.roomKey) return;
    const aad = textEncoder.encode(this.topicHash);
    const sealed = await sealAesGcm(this.roomKey, textEncoder.encode(JSON.stringify(envelope)), aad);
    const content = base64UrlEncode(sealed);

    if (this.customWsUrl) {
      if (this.customWs?.readyState === WebSocket.OPEN) {
        this.customWs.send(
          JSON.stringify({
            type: 'pub',
            topic: this.topicHash,
            id: randomId(8),
            data: content,
          })
        );
      }
      return;
    }

    const createdAt = Math.floor(Date.now() / 1000);
    const pubkeyHex = bytesToHex(this.nostrKeypair.publicKey);
    const tags = [['x', this.topicHash]];
    const eventCore = JSON.stringify([0, pubkeyHex, createdAt, this.nostrKind, tags, content]);
    const idBytes = await sha256Bytes(eventCore);
    const idHex = bytesToHex(idBytes);
    const sigBytes = await schnorr.signAsync(idBytes, this.nostrKeypair.secretKey);
    const frame = JSON.stringify([
      'EVENT',
      {
        id: idHex,
        pubkey: pubkeyHex,
        created_at: createdAt,
        kind: this.nostrKind,
        tags,
        content,
        sig: bytesToHex(sigBytes),
      },
    ]);

    for (const ws of this.sockets.values()) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(frame);
      }
    }
  }

  private isOwnIdentity(id?: string, deviceUid?: string): boolean {
    if (id && (id === this.selfId || RETIRED_SELF_IDS.has(id))) return true;
    if (deviceUid && deviceUid === this.selfDeviceUid) return true;
    return false;
  }

  private async handleEncryptedPayload(msgId: string, content: string): Promise<void> {
    if (this.closed || this.closing || !this.roomKey) return;
    if (this.seenIds.has(msgId)) return;
    this.seenIds.add(msgId);
    if (this.seenIds.size > 1000) {
      const oldest = this.seenIds.values().next().value;
      if (oldest) this.seenIds.delete(oldest);
    }

    let envelope: OuterEnvelope;
    try {
      const aad = textEncoder.encode(this.topicHash);
      const plainBytes = await openAesGcm(this.roomKey, base64UrlDecode(content), aad);
      envelope = JSON.parse(textDecoder.decode(plainBytes)) as OuterEnvelope;
    } catch {
      return;
    }

    if (!envelope || typeof envelope !== 'object' || typeof envelope.ts !== 'number') return;

    // Abaikan pesan kedaluwarsa > 40 detik
    if (Math.abs(Date.now() - envelope.ts) > 40_000) return;

    if (envelope.kind === 'presence') {
      if (
        typeof envelope.id !== 'string' ||
        typeof envelope.alias !== 'string' ||
        !envelope.pubJwk ||
        typeof envelope.pubJwk !== 'object'
      ) {
        return;
      }
      if (this.isOwnIdentity(envelope.id, envelope.deviceUid)) {
        if (this.peers.delete(envelope.id)) this.emitPeers();
        return;
      }
      if (envelope.bye) {
        const deleted = this.peers.delete(envelope.id);
        this.onPeerBye?.(envelope.id);
        if (deleted) this.emitPeers();
        return;
      }
      const isNew = !this.peers.has(envelope.id);
      this.peers.set(envelope.id, {
        id: envelope.id,
        alias: envelope.alias.trim().slice(0, 32) || 'Perangkat Terdekat',
        device: (typeof envelope.device === 'string' ? envelope.device : 'Browser').slice(0, 24),
        pubJwk: envelope.pubJwk,
        requirePin: Boolean(envelope.requirePin),
        lastSeen: Date.now(),
      });
      this.emitPeers();
      if (isNew) {
        // Balas presence agar perangkat baru segera melihat kita
        void this.broadcastPresence(false);
      }
      return;
    }

    if (envelope.kind === 'direct' && envelope.to === this.selfId) {
      if (this.isOwnIdentity(envelope.from, envelope.fromDeviceUid)) return;
      try {
        const senderPeer = this.peers.get(envelope.from);
        const senderPubJwk = senderPeer?.pubJwk ?? envelope.fromPubJwk;
        const pairKey = await this.getPairKey(envelope.from, senderPubJwk);
        const aad = textEncoder.encode(`${this.topicHash}:${envelope.from}:${this.selfId}`);
        const decrypted = await openAesGcm(pairKey, base64UrlDecode(envelope.enc), aad);
        const signal = JSON.parse(textDecoder.decode(decrypted)) as DirectSignalPayload;
        const peerObj: SignalingPeer = senderPeer ?? {
          id: envelope.from,
          alias: 'Perangkat Terdekat',
          device: 'Browser',
          pubJwk: senderPubJwk,
          requirePin: false,
          lastSeen: Date.now(),
        };
        this.onDirectSignal(peerObj, signal);
      } catch {
        // Abaikan jika gagal dekripsi ECDH
      }
    }
  }

  private connectNostrRelay(url: string, slotIdx: number): void {
    if (this.closed || this.closing) return;
    try {
      const ws = new WebSocket(url);
      this.sockets.set(url, ws);

      ws.onopen = () => {
        if (this.closed || this.closing) {
          ws.close();
          return;
        }
        const since = Math.floor(Date.now() / 1000) - 18;
        ws.send(
          JSON.stringify([
            'REQ',
            this.subId,
            { kinds: [this.nostrKind], '#x': [this.topicHash], since },
          ])
        );
        this.emitStatus();
        void this.broadcastPresence(false);
      };

      ws.onmessage = (e) => {
        if (typeof e.data !== 'string') return;
        try {
          const parsed = JSON.parse(e.data) as unknown[];
          if (parsed[0] === 'EVENT' && parsed[2] && typeof parsed[2] === 'object') {
            const ev = parsed[2] as { id?: string; content?: string };
            if (typeof ev.id === 'string' && typeof ev.content === 'string') {
              void this.handleEncryptedPayload(ev.id, ev.content);
            }
          }
        } catch {
          // Ignore malformed relay frame
        }
      };

      const scheduleReconnect = () => {
        this.sockets.delete(url);
        this.emitStatus();
        if (this.closed || this.closing) return;
        const nextUrl =
          DEFAULT_NOSTR_RELAYS[(slotIdx + Math.floor(Math.random() * 2) + 1) % DEFAULT_NOSTR_RELAYS.length];
        const targetUrl = this.sockets.has(nextUrl) ? url : nextUrl;
        const tid = window.setTimeout(() => {
          this.reconnectTimers.delete(url);
          this.connectNostrRelay(targetUrl, (slotIdx + 1) % DEFAULT_NOSTR_RELAYS.length);
        }, 4500);
        this.reconnectTimers.set(url, tid);
      };

      ws.onerror = () => {
        // ditangani di onclose
      };
      ws.onclose = scheduleReconnect;
    } catch {
      this.emitStatus('Gagal membuka koneksi relay');
    }
  }

  private connectCustomWs(url: string): void {
    if (this.closed || this.closing) return;
    const validation = validateCustomWsUrl(url);
    if (!validation.valid) {
      this.customWsError = validation.reason;
      this.emitStatus(validation.reason);
      return;
    }

    try {
      const ws = new WebSocket(validation.url);
      this.customWs = ws;
      ws.onopen = () => {
        if (this.closed || this.closing) {
          ws.close();
          return;
        }
        this.customWsError = undefined;
        ws.send(JSON.stringify({ type: 'join', topic: this.topicHash }));
        this.emitStatus();
        void this.broadcastPresence(false);
      };
      ws.onmessage = (e) => {
        if (typeof e.data !== 'string') return;
        try {
          const msg = JSON.parse(e.data) as { topic?: string; id?: string; data?: string };
          if (msg.topic === this.topicHash && msg.id && msg.data) {
            void this.handleEncryptedPayload(msg.id, msg.data);
          }
        } catch {
          // Ignore
        }
      };
      ws.onerror = () => {
        if (this.closed || this.closing) return;
        this.customWsError = 'Gagal terhubung ke server WebSocket kustom';
        this.emitStatus(this.customWsError);
      };
      ws.onclose = () => {
        if (this.customWs === ws) this.customWs = null;
        if (this.closed || this.closing) return;
        this.emitStatus(
          this.customWsError ?? 'Koneksi ke server WebSocket kustom terputus, mencoba lagi...'
        );
        const tid = window.setTimeout(() => this.connectCustomWs(validation.url), 4000);
        this.reconnectTimers.set('custom', tid);
      };
    } catch (err) {
      if (err instanceof DOMException && err.name === 'SecurityError') {
        this.customWsError =
          'Koneksi ws:// diblokir browser pada halaman HTTPS. Gunakan wss:// atau Relay Default.';
      } else {
        this.customWsError = 'URL WebSocket kustom tidak valid (harus diawali wss://).';
      }
      this.emitStatus(this.customWsError);
    }
  }
}
