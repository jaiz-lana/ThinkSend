import { formatBytes, randomId, encodeCompactPayload, decodeCompactPayload } from '../utils/crypto';
import { drawQrCanvas, scanQrWithCamera } from '../utils/qrModal';
import {
  detectRadarRoomSecret,
  generateRoomCode,
  getOrCreateAlias,
  normalizeRoomCode,
  saveAlias,
  ThinkSendSignalingRoom,
  type DirectSignalPayload,
  type RelayStatus,
  type SignalingPeer,
} from '../utils/signaling';
import {
  createPeerConnectionForMode,
  detectIcePathLabel,
  E2eeDataSession,
  escapeHtml,
  gatherIceDescription,
  type ReceivedFileResult,
  type TransferProgressInfo,
} from '../utils/webrtcTransfer';

type WlanMainTab = 'auto' | 'offline';
type AutoDiscoveryMode = 'radar' | 'room';

const CUSTOM_WS_STORAGE_KEY = 'thinksend_custom_ws_url';

function generateDefaultPin(): string {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return String(arr[0] % 10000).padStart(4, '0');
}

export function renderWlanMode(container: HTMLElement): () => void {
  let activeMainTab: WlanMainTab = 'auto';
  let activeDiscovery: AutoDiscoveryMode = 'radar';
  let alias = getOrCreateAlias();
  let requirePin = false;
  let receiverPin = generateDefaultPin();
  let customWsUrl = '';
  try {
    customWsUrl = localStorage.getItem(CUSTOM_WS_STORAGE_KEY) ?? '';
  } catch {
    // Ignore storage access restriction
  }

  let signalingRoom: ThinkSendSignalingRoom | null = null;
  let currentRoomCode = '';
  let radarLabel = '';
  let peers: SignalingPeer[] = [];
  let relayStatus: RelayStatus = { connectedRelays: 0, targetRelays: 4, mode: 'nostr' };

  // Active WebRTC session state
  let activePc: RTCPeerConnection | null = null;
  let activeSession: E2eeDataSession | null = null;
  let activeSessionId = '';
  let activePeer: SignalingPeer | null = null;
  let activeRole: 'sender' | 'receiver' | null = null;
  let pendingFilesToSend: File[] = [];
  let pendingIceQueue: RTCIceCandidateInit[] = [];
  let incomingInvite: {
    peer: SignalingPeer;
    sessionId: string;
    fileCount: number;
    totalSize: number;
    fileSummary: string;
  } | null = null;

  const createdObjectUrls: string[] = [];
  let destroyed = false;

  // Cek apakah dibuka via QR Link #wlan-room=XXXXXX
  const initialHash = window.location.hash;
  if (initialHash.startsWith('#wlan-room=')) {
    const codeFromHash = normalizeRoomCode(initialHash.slice('#wlan-room='.length));
    if (codeFromHash.length >= 4) {
      activeMainTab = 'auto';
      activeDiscovery = 'room';
      currentRoomCode = codeFromHash;
    }
  }

  function revokeAllObjectUrls() {
    while (createdObjectUrls.length > 0) {
      const u = createdObjectUrls.pop();
      if (u) URL.revokeObjectURL(u);
    }
  }

  function cleanupWebRtcSession() {
    activeSession?.close();
    activePc?.close();
    activeSession = null;
    activePc = null;
    activeSessionId = '';
    activePeer = null;
    activeRole = null;
    pendingFilesToSend = [];
    pendingIceQueue = [];
    incomingInvite = null;
  }

  async function cleanupSignaling() {
    if (signalingRoom) {
      const room = signalingRoom;
      signalingRoom = null;
      await room.close();
    }
    peers = [];
  }

  function cleanupAll() {
    destroyed = true;
    cleanupWebRtcSession();
    void cleanupSignaling();
    revokeAllObjectUrls();
  }

  container.innerHTML = `
    <div class="card">
      <h2>
        <span class="card-title-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M5 12.55a11 11 0 0 1 14.08 0" />
            <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
            <path d="M1.42 9a16 16 0 0 1 21.16 0" />
            <circle cx="12" cy="19.5" r="1.2" fill="currentColor" stroke="none" />
          </svg>
        </span>
        Transfer WLAN (Wi-Fi Lokal P2P)
      </h2>
      <p class="desc">Kirim file cepat antar perangkat di Wi-Fi yang sama dengan enkripsi berlapis <strong>End-to-End</strong> (WebRTC DTLS + ECDH AES-256-GCM).</p>

      <div class="role-switch">
        <button id="wlan-tab-auto" class="btn btn-primary" type="button">📡 Otomatis (Radar &amp; Ruang)</button>
        <button id="wlan-tab-offline" class="btn" type="button">📷 Offline Murni (QR / Teks)</button>
      </div>

      <div id="wlan-main-body"></div>
    </div>
  `;

  const mainBody = document.getElementById('wlan-main-body')!;
  const tabAutoBtn = document.getElementById('wlan-tab-auto') as HTMLButtonElement;
  const tabOfflineBtn = document.getElementById('wlan-tab-offline') as HTMLButtonElement;

  function setMainTabButtons() {
    tabAutoBtn.classList.toggle('btn-primary', activeMainTab === 'auto');
    tabOfflineBtn.classList.toggle('btn-primary', activeMainTab === 'offline');
  }

  // ==================== SHARED E2EE TRANSFER UI ====================

  function bindSessionUi(
    sessionArea: HTMLElement,
    pc: RTCPeerConnection,
    session: E2eeDataSession,
    role: 'sender' | 'receiver',
    initialFiles: File[],
    onReset: () => void
  ) {
    sessionArea.innerHTML = `
      <div class="e2ee-session-box">
        <div class="alert alert-info wlan-hs-status">
          <span>⏳</span>
          <div>Menunggu koneksi WebRTC P2P terbuka...</div>
        </div>
        <div class="wlan-pin-prompt"></div>
        <div class="wlan-session-ready"></div>
        <div class="wlan-progress-list"></div>
        <div class="wlan-received-list"></div>
      </div>
    `;

    const hsStatus = sessionArea.querySelector('.wlan-hs-status') as HTMLElement;
    const pinPromptArea = sessionArea.querySelector('.wlan-pin-prompt') as HTMLElement;
    const readyArea = sessionArea.querySelector('.wlan-session-ready') as HTMLElement;
    const progressArea = sessionArea.querySelector('.wlan-progress-list') as HTMLElement;
    const receivedArea = sessionArea.querySelector('.wlan-received-list') as HTMLElement;

    const requestRemotePinUi = (
      sasCode: string,
      attempt: number,
      remaining: number
    ): Promise<string | null> => {
      return new Promise((resolve) => {
        pinPromptArea.innerHTML = `
          <div class="pin-card">
            <div class="pin-card-title">🔒 Perangkat Penerima Meminta PIN Keamanan</div>
            <p class="pin-card-sub">
              Kode Cocok Sesi: <strong>${escapeHtml(sasCode)}</strong> •
              ${attempt > 1 ? `<span style="color:var(--danger);">PIN salah! Sisa percobaan: ${remaining}</span>` : 'Masukkan 4 digit PIN yang tampil di layar penerima.'}
            </p>
            <div class="pin-input-row">
              <input class="wlan-remote-pin-in" type="text" inputmode="numeric" maxlength="8" placeholder="PIN 4 digit..." />
              <button type="button" class="btn btn-primary wlan-remote-pin-ok">Verifikasi</button>
              <button type="button" class="btn wlan-remote-pin-cancel">Batal</button>
            </div>
          </div>
        `;
        const input = pinPromptArea.querySelector('.wlan-remote-pin-in') as HTMLInputElement;
        const okBtn = pinPromptArea.querySelector('.wlan-remote-pin-ok') as HTMLButtonElement;
        const cancelBtn = pinPromptArea.querySelector('.wlan-remote-pin-cancel') as HTMLButtonElement;
        input.focus();
        const submit = () => {
          const val = input.value.trim();
          if (!val) return;
          pinPromptArea.innerHTML = '';
          resolve(val);
        };
        okBtn.onclick = submit;
        input.onkeydown = (e) => {
          if (e.key === 'Enter') submit();
        };
        cancelBtn.onclick = () => {
          pinPromptArea.innerHTML = '';
          resolve(null);
        };
      });
    };

    const renderProgress = (info: TransferProgressInfo, labelPrefix: string) => {
      const pct = info.totalBytes > 0 ? Math.min(100, Math.round((info.doneBytes / info.totalBytes) * 100)) : 100;
      const phaseText =
        info.phase === 'hashing'
          ? 'Menghitung SHA-256...'
          : info.phase === 'verifying'
            ? 'Memverifikasi integritas SHA-256...'
            : `${formatBytes(info.doneBytes)} / ${formatBytes(info.totalBytes)}`;
      const speedText =
        info.phase === 'transferring' && info.speedBps > 0 ? `${formatBytes(info.speedBps)}/dtk` : '';

      progressArea.innerHTML = `
        <div class="transfer-progress-card">
          <div class="transfer-meta-row">
            <strong>${escapeHtml(labelPrefix)}: ${escapeHtml(info.fileName)}</strong>
            <span>${pct}%</span>
          </div>
          <div class="progress-wrap"><div class="progress-bar" style="width:${pct}%"></div></div>
          <div class="stats-row">
            <span>${escapeHtml(phaseText)}</span>
            <span>${escapeHtml(speedText)}</span>
          </div>
        </div>
      `;
    };

    void (async () => {
      try {
        const { sasCode } = await session.negotiate({
          localPin: role === 'receiver' && requirePin ? receiverPin : undefined,
          onChannelOpen: () => {
            if (destroyed) return;
            hsStatus.className = 'alert alert-info wlan-hs-status';
            hsStatus.innerHTML = `
              <span>🔐</span>
              <div>Jalur terbuka! Menjalankan jabat tangan kunci <strong>ECDH P-256 + AES-256-GCM</strong>...</div>
            `;
          },
          onRequestRemotePin: role === 'sender' ? requestRemotePinUi : undefined,
        });
        if (destroyed) return;

        const pathLabel = await detectIcePathLabel(pc);
        hsStatus.className = 'alert alert-success wlan-hs-status';
        hsStatus.innerHTML = `
          <span>🛡️</span>
          <div>
            <strong>E2EE Aktif (${escapeHtml(pathLabel)})</strong><br />
            <span class="sas-row">Kode Verifikasi Pasangan: <code class="sas-badge">${escapeHtml(sasCode)}</code> <small>(Pastikan sama di kedua layar)</small></span>
          </div>
        `;

        if (role === 'sender') {
          const sendQueue = async (files: File[]) => {
            if (files.length === 0) return;
            try {
              await session.sendFiles(files, (info) => renderProgress(info, 'Mengirim'));
              progressArea.innerHTML = `
                <div class="alert alert-success">
                  <span>✅</span>
                  <div><strong>${files.length} file terkirim</strong> &amp; terverifikasi SHA-256 di perangkat penerima!</div>
                </div>
              `;
            } catch (err) {
              progressArea.innerHTML = `
                <div class="alert alert-warning">
                  <span>⚠️</span>
                  <div>Gagal mengirim: ${escapeHtml((err as Error).message)}</div>
                </div>
              `;
            }
          };

          readyArea.innerHTML = `
            <label class="file-drop" style="margin-top:8px;">
              <input type="file" id="wlan-e2ee-file-input" multiple />
              <span class="file-drop-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
              </span>
              <strong>${initialFiles.length > 0 ? 'Kirim File Tambahan via WLAN E2EE' : 'Pilih Satu atau Banyak File'}</strong>
              <span class="subtitle" style="color:var(--muted);">Terenkripsi AES-256-GCM sebelum dikirim</span>
            </label>
            <button id="wlan-close-session" type="button" class="btn" style="width:100%;margin-top:6px;">Putuskan Sesi</button>
          `;

          const fileInput = readyArea.querySelector('#wlan-e2ee-file-input') as HTMLInputElement;
          fileInput.onchange = () => {
            const list = fileInput.files ? Array.from(fileInput.files) : [];
            fileInput.value = '';
            void sendQueue(list);
          };
          (readyArea.querySelector('#wlan-close-session') as HTMLButtonElement).onclick = () => {
            cleanupWebRtcSession();
            onReset();
          };

          if (initialFiles.length > 0) {
            await sendQueue(initialFiles);
          }
        } else {
          readyArea.innerHTML = `
            <div class="alert alert-info" style="margin-top:8px;">
              <span>📥</span>
              <div>Siap menerima file terenkripsi dari pengirim...</div>
            </div>
            <button id="wlan-close-session" type="button" class="btn" style="width:100%;margin-top:6px;">Putuskan Sesi</button>
          `;
          (readyArea.querySelector('#wlan-close-session') as HTMLButtonElement).onclick = () => {
            cleanupWebRtcSession();
            onReset();
          };

          void session.listenForFiles({
            onProgress: (info) => renderProgress(info, 'Menerima'),
            onFileComplete: (res: ReceivedFileResult) => {
              createdObjectUrls.push(res.url);
              progressArea.innerHTML = `
                <div class="alert ${res.verified ? 'alert-success' : 'alert-warning'}">
                  <span>${res.verified ? '✅' : '⚠️'}</span>
                  <div>${res.verified ? 'File didekripsi &amp; SHA-256 cocok 100%!' : 'Peringatan: Hash SHA-256 file tidak cocok!'}</div>
                </div>
              `;
              const item = document.createElement('div');
              item.className = 'received-file-item';
              item.innerHTML = `
                <div class="received-file-meta">
                  <strong>${escapeHtml(res.name)}</strong>
                  <span>${escapeHtml(formatBytes(res.size))} • ${res.verified ? 'SHA-256 Terverifikasi' : 'Hash Tidak Cocok'}</span>
                </div>
                <a class="btn btn-success" href="${res.url}" download="${escapeHtml(res.name)}" style="text-decoration:none;">
                  💾 Simpan
                </a>
              `;
              receivedArea.prepend(item);
            },
            onError: (err) => {
              progressArea.innerHTML = `
                <div class="alert alert-warning">
                  <span>⚠️</span>
                  <div>${escapeHtml(err.message)}</div>
                </div>
              `;
            },
          });
        }
      } catch (err) {
        if (destroyed) return;
        hsStatus.className = 'alert alert-warning wlan-hs-status';
        hsStatus.innerHTML = `<span>⚠️</span><div>${escapeHtml((err as Error).message)}</div>`;
        readyArea.innerHTML = `<button type="button" class="btn wlan-retry-btn" style="width:100%;">Kembali</button>`;
        (readyArea.querySelector('.wlan-retry-btn') as HTMLButtonElement).onclick = () => {
          cleanupWebRtcSession();
          onReset();
        };
      }
    })();
  }

  // ==================== JALUR 1: OTOMATIS (RADAR & KODE RUANG) ====================

  function handleIncomingDirectSignal(peer: SignalingPeer, signal: DirectSignalPayload) {
    if (destroyed || activeMainTab !== 'auto') return;

    if (signal.type === 'invite') {
      if (activeSession || activePc) {
        void signalingRoom?.sendDirect(peer, {
          type: 'decline',
          sessionId: signal.sessionId,
          reason: 'Perangkat sedang sibuk dalam sesi transfer lain.',
        });
        return;
      }
      incomingInvite = {
        peer,
        sessionId: signal.sessionId,
        fileCount: signal.fileCount,
        totalSize: signal.totalSize,
        fileSummary: signal.fileSummary,
      };
      renderInviteBanner();
      return;
    }

    if (signal.type === 'decline') {
      if (incomingInvite && signal.sessionId === incomingInvite.sessionId) {
        incomingInvite = null;
        renderInviteBanner();
        return;
      }
      if (signal.sessionId === activeSessionId) {
        cleanupWebRtcSession();
        const transferBox = document.getElementById('wlan-auto-session');
        if (transferBox) {
          transferBox.innerHTML = `
            <div class="alert alert-warning">
              <span>❌</span>
              <div>${escapeHtml(signal.reason ?? 'Permintaan ditolak oleh penerima.')}</div>
            </div>
          `;
        }
      }
      return;
    }

    if (signal.type === 'accept' && signal.sessionId === activeSessionId && activeRole === 'sender') {
      void startSenderWebRtcAfterAccept();
      return;
    }

    if (signal.type === 'offer' && signal.sessionId === activeSessionId && activeRole === 'receiver' && activePc) {
      void (async () => {
        try {
          await activePc!.setRemoteDescription(signal.sdp);
          while (pendingIceQueue.length > 0) {
            await activePc!.addIceCandidate(pendingIceQueue.shift()!);
          }
          const answer = await activePc!.createAnswer();
          await activePc!.setLocalDescription(answer);
          if (activePeer) {
            await signalingRoom?.sendDirect(activePeer, {
              type: 'answer',
              sessionId: activeSessionId,
              sdp: activePc!.localDescription!.toJSON(),
            });
          }
        } catch (err) {
          const box = document.getElementById('wlan-auto-session');
          if (box) {
            box.innerHTML = `<div class="alert alert-warning">Gagal memproses Offer: ${escapeHtml((err as Error).message)}</div>`;
          }
        }
      })();
      return;
    }

    if (signal.type === 'answer' && signal.sessionId === activeSessionId && activeRole === 'sender' && activePc) {
      void (async () => {
        try {
          await activePc!.setRemoteDescription(signal.sdp);
          while (pendingIceQueue.length > 0) {
            await activePc!.addIceCandidate(pendingIceQueue.shift()!);
          }
        } catch (err) {
          const box = document.getElementById('wlan-auto-session');
          if (box) {
            box.innerHTML = `<div class="alert alert-warning">Gagal memproses Answer: ${escapeHtml((err as Error).message)}</div>`;
          }
        }
      })();
      return;
    }

    if (signal.type === 'ice' && signal.sessionId === activeSessionId && activePc) {
      if (activePc.remoteDescription) {
        void activePc.addIceCandidate(signal.candidate).catch(() => {});
      } else {
        pendingIceQueue.push(signal.candidate);
      }
    }
  }

  async function startSenderWebRtcAfterAccept() {
    if (!activePeer || !signalingRoom) return;
    const sessionBox = document.getElementById('wlan-auto-session');
    if (!sessionBox) return;

    const pc = createPeerConnectionForMode('wlan-auto');
    activePc = pc;
    pendingIceQueue = [];

    const dc = pc.createDataChannel('thinksend-wlan-e2ee', { ordered: true });
    const session = new E2eeDataSession(dc, true);
    activeSession = session;

    pc.onicecandidate = (e) => {
      if (e.candidate && activePeer && signalingRoom) {
        void signalingRoom.sendDirect(activePeer, {
          type: 'ice',
          sessionId: activeSessionId,
          candidate: e.candidate.toJSON(),
        });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc === activePc && pc.connectionState === 'failed' && dc.readyState !== 'open') {
        cleanupWebRtcSession();
        sessionBox.innerHTML = `
          <div class="alert alert-warning">
            <span>⚠️</span>
            <div>Gagal menyambungkan WebRTC langsung (kemungkinan diblokir isolasi Wi-Fi/NAT). Coba gunakan tab <strong>Offline Murni</strong> atau hotspot pribadi.</div>
          </div>
        `;
      }
    };

    bindSessionUi(sessionBox, pc, session, 'sender', pendingFilesToSend, () => {
      sessionBox.innerHTML = '';
      renderAutoPeerList();
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await signalingRoom.sendDirect(activePeer, {
      type: 'offer',
      sessionId: activeSessionId,
      sdp: pc.localDescription!.toJSON(),
    });
  }

  function renderInviteBanner() {
    const banner = document.getElementById('wlan-invite-banner');
    if (!banner) return;
    if (!incomingInvite) {
      banner.innerHTML = '';
      return;
    }
    const inv = incomingInvite;
    banner.innerHTML = `
      <div class="invite-card">
        <div class="invite-header">
          <strong>📩 Permintaan Kirim File</strong>
          <span>dari <strong>${escapeHtml(inv.peer.alias)}</strong> (${escapeHtml(inv.peer.device)})</span>
        </div>
        <p class="invite-summary">
          ${inv.fileCount} file (${escapeHtml(formatBytes(inv.totalSize))}): ${escapeHtml(inv.fileSummary)}
        </p>
        ${
          requirePin
            ? `<div class="invite-pin-note">🔒 PIN Penerima aktif: <strong>${escapeHtml(receiverPin)}</strong> (berikan ke pengirim)</div>`
            : ''
        }
        <div class="invite-actions">
          <button id="wlan-inv-accept" type="button" class="btn btn-success">Terima (E2EE)</button>
          <button id="wlan-inv-decline" type="button" class="btn btn-danger">Tolak</button>
        </div>
      </div>
    `;

    (banner.querySelector('#wlan-inv-decline') as HTMLButtonElement).onclick = () => {
      void signalingRoom?.sendDirect(inv.peer, { type: 'decline', sessionId: inv.sessionId });
      incomingInvite = null;
      renderInviteBanner();
    };

    (banner.querySelector('#wlan-inv-accept') as HTMLButtonElement).onclick = () => {
      cleanupWebRtcSession();
      activePeer = inv.peer;
      activeSessionId = inv.sessionId;
      activeRole = 'receiver';
      pendingIceQueue = [];
      incomingInvite = null;
      renderInviteBanner();

      const pc = createPeerConnectionForMode('wlan-auto');
      activePc = pc;

      pc.onicecandidate = (e) => {
        if (e.candidate && activePeer && signalingRoom) {
          void signalingRoom.sendDirect(activePeer, {
            type: 'ice',
            sessionId: activeSessionId,
            candidate: e.candidate.toJSON(),
          });
        }
      };

      const sessionBox = document.getElementById('wlan-auto-session');
      if (sessionBox) {
        sessionBox.innerHTML = `
          <div class="alert alert-info">
            <span>⏳</span>
            <div>Menyambungkan WebRTC dengan <strong>${escapeHtml(inv.peer.alias)}</strong>...</div>
          </div>
        `;
      }

      let channelAttached = false;
      pc.onconnectionstatechange = () => {
        if (pc === activePc && pc.connectionState === 'failed' && !channelAttached) {
          cleanupWebRtcSession();
          if (sessionBox) {
            sessionBox.innerHTML = `
              <div class="alert alert-warning">
                <span>⚠️</span>
                <div>Koneksi WebRTC langsung gagal (isolasi jaringan/NAT). Coba gunakan <strong>Offline Murni</strong> atau jaringan hotspot yang sama.</div>
              </div>
            `;
          }
        }
      };

      pc.ondatachannel = (e) => {
        channelAttached = true;
        const session = new E2eeDataSession(e.channel, false);
        activeSession = session;
        if (sessionBox) {
          bindSessionUi(sessionBox, pc, session, 'receiver', [], () => {
            sessionBox.innerHTML = '';
            renderAutoPeerList();
          });
        }
      };

      void signalingRoom?.sendDirect(inv.peer, {
        type: 'accept',
        sessionId: activeSessionId,
      });
    };
  }

  function renderRelayStatusBadge() {
    const el = document.getElementById('wlan-relay-status');
    if (!el) return;
    if (relayStatus.connectedRelays > 0) {
      el.className = 'relay-pill relay-ok';
      const label =
        relayStatus.mode === 'custom-ws'
          ? 'Terhubung ke Relay Kustom • Signaling E2EE'
          : `Terhubung ${relayStatus.connectedRelays}/${relayStatus.targetRelays} Relay • E2EE Aktif`;
      el.textContent = label;
    } else {
      el.className = 'relay-pill relay-wait';
      el.textContent =
        relayStatus.lastError ??
        'Menghubungkan relay signaling terenkripsi... (atau pakai Offline Murni jika tanpa internet)';
    }
  }

  function renderAutoPeerList() {
    const listEl = document.getElementById('wlan-peer-list');
    if (!listEl) return;

    if (peers.length === 0) {
      listEl.innerHTML = `
        <div class="peer-empty">
          <div class="radar-pulse" aria-hidden="true"></div>
          <div>
            <strong>Belum ada perangkat lain terdeteksi</strong>
            <p>Buka ThinkSend tab <strong>WLAN</strong> di perangkat kedua (${
              activeDiscovery === 'radar'
                ? 'di jaringan Wi-Fi yang sama'
                : `lalu masukkan kode ruang <strong>${escapeHtml(currentRoomCode || '—')}</strong>`
            }).</p>
          </div>
        </div>
      `;
      return;
    }

    listEl.innerHTML = peers
      .map((p) => {
        const initial = escapeHtml((p.alias.trim()[0] ?? 'T').toUpperCase());
        return `
          <div class="peer-row" data-peer-id="${escapeHtml(p.id)}">
            <div class="peer-avatar">${initial}</div>
            <div class="peer-info">
              <div class="peer-name-row">
                <strong>${escapeHtml(p.alias)}</strong>
                ${p.requirePin ? '<span class="peer-pin-tag">🔒 PIN</span>' : ''}
              </div>
              <span class="peer-device">${escapeHtml(p.device)} • Siap menerima P2P</span>
            </div>
            <button type="button" class="btn btn-primary peer-send-btn" data-peer-id="${escapeHtml(p.id)}">
              Kirim File
            </button>
          </div>
        `;
      })
      .join('');

    listEl.querySelectorAll<HTMLButtonElement>('.peer-send-btn').forEach((btn) => {
      btn.onclick = () => {
        const targetId = btn.dataset.peerId;
        const target = peers.find((p) => p.id === targetId);
        if (!target || !signalingRoom) return;

        const picker = document.createElement('input');
        picker.type = 'file';
        picker.multiple = true;
        picker.style.display = 'none';
        document.body.appendChild(picker);
        const cleanupPicker = () => picker.remove();
        picker.addEventListener('cancel', cleanupPicker, { once: true });
        picker.onchange = async () => {
          const files = picker.files ? Array.from(picker.files) : [];
          cleanupPicker();
          if (files.length === 0) return;

          cleanupWebRtcSession();
          activePeer = target;
          activeRole = 'sender';
          activeSessionId = randomId(8);
          pendingFilesToSend = files;
          pendingIceQueue = [];

          const totalSize = files.reduce((acc, f) => acc + f.size, 0);
          const namesPreview =
            files
              .slice(0, 2)
              .map((f) => f.name)
              .join(', ') + (files.length > 2 ? ` (+${files.length - 2} lainnya)` : '');

          const sentSessionId = activeSessionId;
          const sessionBox = document.getElementById('wlan-auto-session');
          if (sessionBox) {
            sessionBox.innerHTML = `
              <div class="alert alert-info" style="align-items:center;">
                <span>⏳</span>
                <div style="flex:1;">
                  Menunggu <strong>${escapeHtml(target.alias)}</strong> menerima pengiriman
                  <strong>${files.length} file (${escapeHtml(formatBytes(totalSize))})</strong>...
                </div>
                <button id="wlan-cancel-invite" type="button" class="mini-link-btn">Batalkan</button>
              </div>
            `;
            const cancelInviteBtn = document.getElementById('wlan-cancel-invite');
            if (cancelInviteBtn) {
              cancelInviteBtn.onclick = () => {
                void signalingRoom?.sendDirect(target, {
                  type: 'decline',
                  sessionId: sentSessionId,
                  reason: 'Pengiriman dibatalkan oleh pengirim.',
                });
                cleanupWebRtcSession();
                sessionBox.innerHTML = '';
              };
            }
          }

          await signalingRoom!.sendDirect(target, {
            type: 'invite',
            sessionId: sentSessionId,
            fileCount: files.length,
            totalSize,
            fileSummary: namesPreview,
          });
        };
        picker.click();
      };
    });
  }

  async function startDiscoveryRoom(secret: string) {
    await cleanupSignaling();
    cleanupWebRtcSession();
    if (destroyed || activeMainTab !== 'auto') return;

    const room = new ThinkSendSignalingRoom({
      alias,
      requirePin,
      roomSecret: secret,
      customWsUrl: customWsUrl || undefined,
      onPeersUpdate: (nextPeers) => {
        peers = nextPeers;
        renderAutoPeerList();
      },
      onDirectSignal: (peer, signal) => {
        handleIncomingDirectSignal(peer, signal);
      },
      onStatus: (status) => {
        relayStatus = status;
        renderRelayStatusBadge();
      },
    });
    signalingRoom = room;
    await room.start();
  }

  async function activateRadar() {
    radarLabel = 'Mendeteksi jaringan Wi-Fi...';
    const infoEl = document.getElementById('wlan-discovery-info');
    if (infoEl) infoEl.textContent = radarLabel;

    const detected = await detectRadarRoomSecret();
    if (destroyed || activeMainTab !== 'auto' || activeDiscovery !== 'radar') return;

    if (!detected) {
      radarLabel = 'Gagal mendeteksi grup IP (mungkin offline). Gunakan Kode Ruang atau Offline Murni.';
      if (infoEl) infoEl.textContent = radarLabel;
      return;
    }

    radarLabel = `Radar Wi-Fi Aktif (${detected.ipLabel} • IP di-hash lokal SHA-256)`;
    if (infoEl) infoEl.textContent = radarLabel;
    await startDiscoveryRoom(detected.secret);
  }

  async function activatePrivateRoom(code: string) {
    const clean = normalizeRoomCode(code) || generateRoomCode();
    currentRoomCode = clean;

    const codeDisplay = document.getElementById('wlan-room-code-display');
    const qrWrap = document.getElementById('wlan-room-qr-wrap');
    const qrCanvas = document.getElementById('wlan-room-qr-canvas') as HTMLCanvasElement | null;
    if (codeDisplay) codeDisplay.textContent = clean;
    if (qrWrap && qrCanvas) {
      qrWrap.hidden = false;
      const base = `${window.location.origin}${window.location.pathname}`;
      await drawQrCanvas(qrCanvas, `${base}#wlan-room=${clean}`, 176);
    }

    await startDiscoveryRoom(`room:${clean}`);
  }

  function renderAutoView() {
    cleanupWebRtcSession();
    void cleanupSignaling();

    mainBody.innerHTML = `
      <div class="identity-bar">
        <div class="identity-left">
          <span class="identity-label">Perangkat Ini:</span>
          <strong id="wlan-alias-text">${escapeHtml(alias)}</strong>
          <button id="wlan-edit-alias" type="button" class="mini-link-btn">Ubah Nama</button>
        </div>
        <label class="pin-toggle">
          <input id="wlan-pin-check" type="checkbox" ${requirePin ? 'checked' : ''} />
          <span>🔒 PIN Terima</span>
        </label>
      </div>

      <div id="wlan-alias-editor" class="pin-config-bar" hidden>
        <span>Nama Baru:</span>
        <input id="wlan-alias-input" type="text" maxlength="28" value="${escapeHtml(alias)}" placeholder="Contoh: HP Budi" />
        <button id="wlan-alias-save" type="button" class="mini-link-btn">Simpan</button>
        <button id="wlan-alias-cancel" type="button" class="mini-link-btn">Batal</button>
      </div>

      <div id="wlan-pin-config" class="pin-config-bar" ${requirePin ? '' : 'hidden'}>
        <span>PIN Keamanan Penerima:</span>
        <input id="wlan-pin-value" type="text" inputmode="numeric" maxlength="8" value="${escapeHtml(receiverPin)}" />
        <button id="wlan-pin-regen" type="button" class="mini-link-btn">Acak</button>
      </div>

      <div class="sub-tabs" role="tablist">
        <button id="wlan-sub-radar" type="button" class="sub-tab ${activeDiscovery === 'radar' ? 'active' : ''}">
          📡 Radar Wi-Fi Otomatis
        </button>
        <button id="wlan-sub-room" type="button" class="sub-tab ${activeDiscovery === 'room' ? 'active' : ''}">
          🔑 Kode Ruang / Scan QR
        </button>
      </div>

      <div id="wlan-invite-banner"></div>
      <div id="wlan-auto-session"></div>
      <div id="wlan-discovery-panel"></div>

      <div class="status-strip">
        <span id="wlan-relay-status" class="relay-pill relay-wait">Menghubungkan signaling E2EE...</span>
      </div>

      <div id="wlan-peer-list" class="peer-list"></div>

      <details class="advanced-box">
        <summary>Pengaturan Relay &amp; Jaminan End-to-End</summary>
        <p>
          Signaling memakai relay Nostr ephemeral publik tanpa menyimpan data di server. IP publik untuk Radar hanya di-hash lokal (SHA-256), sedangkan SDP &amp; isi file dienkripsi penuh dari browser ke browser (ECDH P-256 + AES-256-GCM + DTLS).
        </p>
        <div class="input-group" style="margin-bottom:0;margin-top:8px;">
          <label>Custom WebSocket Signaling URL (Opsional / Self-Host):</label>
          <div style="display:flex;gap:8px;">
            <input id="wlan-custom-ws" type="text" value="${escapeHtml(customWsUrl)}" placeholder="Kosongkan untuk default Nostr relay gratis" />
            <button id="wlan-save-ws" type="button" class="btn">Simpan</button>
          </div>
        </div>
      </details>
    `;

    // Identity & PIN handlers
    const aliasTextEl = document.getElementById('wlan-alias-text')!;
    const aliasEditor = document.getElementById('wlan-alias-editor')!;
    const aliasInput = document.getElementById('wlan-alias-input') as HTMLInputElement;

    document.getElementById('wlan-edit-alias')!.onclick = () => {
      aliasInput.value = alias;
      aliasEditor.hidden = !aliasEditor.hidden;
      if (!aliasEditor.hidden) {
        aliasInput.focus();
        aliasInput.select();
      }
    };

    const commitAlias = () => {
      const next = aliasInput.value.trim();
      if (next) {
        alias = saveAlias(next);
        aliasTextEl.textContent = alias;
        signalingRoom?.updateSelfMeta({ alias });
      }
      aliasEditor.hidden = true;
    };

    document.getElementById('wlan-alias-save')!.onclick = commitAlias;
    document.getElementById('wlan-alias-cancel')!.onclick = () => {
      aliasEditor.hidden = true;
    };
    aliasInput.onkeydown = (e) => {
      if (e.key === 'Enter') commitAlias();
      if (e.key === 'Escape') aliasEditor.hidden = true;
    };

    const pinCheck = document.getElementById('wlan-pin-check') as HTMLInputElement;
    const pinConfig = document.getElementById('wlan-pin-config') as HTMLElement;
    const pinInput = document.getElementById('wlan-pin-value') as HTMLInputElement;
    pinCheck.onchange = () => {
      requirePin = pinCheck.checked;
      pinConfig.hidden = !requirePin;
      signalingRoom?.updateSelfMeta({ requirePin });
    };
    pinInput.oninput = () => {
      receiverPin = pinInput.value.trim() || '0000';
    };
    document.getElementById('wlan-pin-regen')!.onclick = () => {
      receiverPin = generateDefaultPin();
      pinInput.value = receiverPin;
    };

    // Custom WS save
    document.getElementById('wlan-save-ws')!.onclick = () => {
      customWsUrl = (document.getElementById('wlan-custom-ws') as HTMLInputElement).value.trim();
      try {
        if (customWsUrl) localStorage.setItem(CUSTOM_WS_STORAGE_KEY, customWsUrl);
        else localStorage.removeItem(CUSTOM_WS_STORAGE_KEY);
      } catch {
        // Ignore
      }
      renderAutoView();
    };

    // Sub-mode switcher
    const subRadar = document.getElementById('wlan-sub-radar')!;
    const subRoom = document.getElementById('wlan-sub-room')!;
    const panel = document.getElementById('wlan-discovery-panel')!;

    const mountSubMode = () => {
      subRadar.classList.toggle('active', activeDiscovery === 'radar');
      subRoom.classList.toggle('active', activeDiscovery === 'room');

      if (activeDiscovery === 'radar') {
        panel.innerHTML = `
          <div class="alert alert-info" style="margin-bottom:10px;">
            <span>📡</span>
            <div style="flex:1;">
              <div id="wlan-discovery-info">Mendeteksi jaringan Wi-Fi...</div>
              <small style="opacity:0.85;">Di Wi-Fi publik / CGNAT, aktifkan <strong>PIN Terima</strong> atau beralih ke <strong>Kode Ruang</strong>.</small>
            </div>
            <button id="wlan-radar-refresh" type="button" class="mini-link-btn">Pindai Ulang</button>
          </div>
        `;
        document.getElementById('wlan-radar-refresh')!.onclick = () => void activateRadar();
        void activateRadar();
      } else {
        if (!currentRoomCode) currentRoomCode = generateRoomCode();
        panel.innerHTML = `
          <div class="room-box">
            <div class="room-join-row">
              <input id="wlan-room-in" type="text" maxlength="16" value="${escapeHtml(currentRoomCode)}" placeholder="Masukkan Kode Ruang..." />
              <button id="wlan-room-join-btn" type="button" class="btn btn-primary">Gabung</button>
              <button id="wlan-room-new-btn" type="button" class="btn" title="Buat Kode Baru">Acak</button>
              <button id="wlan-room-scan-btn" type="button" class="btn" title="Scan QR Ruang">📷 Scan QR</button>
            </div>
            <div id="wlan-room-qr-wrap" class="room-qr-share" hidden>
              <canvas id="wlan-room-qr-canvas"></canvas>
              <div class="room-qr-meta">
                <span>Kode Ruang Privat:</span>
                <strong id="wlan-room-code-display" class="room-code-big">${escapeHtml(currentRoomCode)}</strong>
                <small>Scan QR atau masukkan kode di perangkat kedua. Cocok untuk Wi-Fi publik atau beda jaringan.</small>
                <button id="wlan-copy-room-link" type="button" class="mini-link-btn" style="align-self:flex-start;">Salin Tautan Ruang</button>
              </div>
            </div>
          </div>
        `;

        const roomIn = document.getElementById('wlan-room-in') as HTMLInputElement;
        document.getElementById('wlan-room-join-btn')!.onclick = () => {
          const code = normalizeRoomCode(roomIn.value);
          if (code) {
            roomIn.value = code;
            void activatePrivateRoom(code);
          }
        };
        document.getElementById('wlan-room-new-btn')!.onclick = () => {
          const next = generateRoomCode();
          roomIn.value = next;
          void activatePrivateRoom(next);
        };
        document.getElementById('wlan-room-scan-btn')!.onclick = async () => {
          const scanned = await scanQrWithCamera({
            title: 'Scan QR Ruang WLAN',
            hint: 'Arahkan kamera ke QR Kode Ruang pada layar pengirim.',
          });
          if (!scanned) return;
          const match = scanned.match(/#wlan-room=([A-Za-z0-9-]+)/);
          const extracted = normalizeRoomCode(match ? match[1] : scanned);
          if (extracted) {
            roomIn.value = extracted;
            void activatePrivateRoom(extracted);
          }
        };
        document.getElementById('wlan-copy-room-link')!.onclick = async (e) => {
          const base = `${window.location.origin}${window.location.pathname}`;
          await navigator.clipboard.writeText(`${base}#wlan-room=${currentRoomCode}`).catch(() => {});
          (e.target as HTMLButtonElement).textContent = 'Tautan Tersalin!';
          setTimeout(() => {
            (e.target as HTMLButtonElement).textContent = 'Salin Tautan Ruang';
          }, 1500);
        };

        void activatePrivateRoom(currentRoomCode);
      }
      renderAutoPeerList();
    };

    subRadar.onclick = () => {
      if (activeDiscovery === 'radar') return;
      activeDiscovery = 'radar';
      mountSubMode();
    };
    subRoom.onclick = () => {
      if (activeDiscovery === 'room') return;
      activeDiscovery = 'room';
      mountSubMode();
    };

    mountSubMode();
  }

  // ==================== JALUR 2: OFFLINE MURNI (QR / TEKS TANPA INTERNET) ====================

  function renderOfflineView() {
    cleanupWebRtcSession();
    void cleanupSignaling();

    let offlineRole: 'host' | 'join' = 'host';

    mainBody.innerHTML = `
      <div class="alert alert-info">
        <span>🔌</span>
        <div><strong>100% Tanpa Internet &amp; Tanpa Server:</strong> Hubungkan perangkat di router Wi-Fi lokal melalui <strong>Scan QR Offer/Answer</strong> (atau salin-tempel teks manual).</div>
      </div>

      <div class="role-switch" style="margin-bottom:12px;">
        <button id="off-host-btn" type="button" class="btn btn-primary">1. Buat Koneksi (Pengirim)</button>
        <button id="off-join-btn" type="button" class="btn">2. Gabung Koneksi (Penerima)</button>
      </div>

      <div id="off-body"></div>
    `;

    const offBody = document.getElementById('off-body')!;
    const hostBtn = document.getElementById('off-host-btn') as HTMLButtonElement;
    const joinBtn = document.getElementById('off-join-btn') as HTMLButtonElement;

    const mountHost = async () => {
      offlineRole = 'host';
      hostBtn.classList.add('btn-primary');
      joinBtn.classList.remove('btn-primary');
      cleanupWebRtcSession();

      const pc = createPeerConnectionForMode('wlan-offline');
      activePc = pc;
      const dc = pc.createDataChannel('thinksend-wlan-offline-e2ee', { ordered: true });
      const session = new E2eeDataSession(dc, true);
      activeSession = session;

      offBody.innerHTML = `
        <div class="offline-qr-panel">
          <div class="qr-stage" style="padding:14px;">
            <div style="font-size:0.84rem;font-weight:700;color:var(--text-strong);margin-bottom:4px;">Langkah 1: Minta Penerima Scan QR Offer Ini</div>
            <canvas id="off-offer-qr" style="max-width:220px;border-radius:10px;"></canvas>
            <div id="off-offer-status" style="font-size:0.75rem;color:var(--muted);">Mengumpulkan alamat jaringan lokal...</div>
          </div>

          <button id="off-scan-answer-btn" type="button" class="btn btn-primary" style="width:100%;margin-top:10px;" disabled>
            📷 Langkah 2: Scan QR Answer dari Penerima
          </button>

          <details class="advanced-box" style="margin-top:10px;">
            <summary>Atau gunakan Salin &amp; Tempel Teks Manual</summary>
            <div class="input-group" style="margin-top:8px;">
              <label>Kode Offer (Ringkas):</label>
              <textarea id="off-offer-txt" rows="2" readonly placeholder="Menyiapkan..."></textarea>
            </div>
            <div class="input-group">
              <label>Tempel Kode Answer dari Penerima:</label>
              <textarea id="off-answer-in" rows="2" placeholder="Tempel kode Answer di sini..."></textarea>
            </div>
            <button id="off-manual-connect" type="button" class="btn" style="width:100%;">Hubungkan Manual</button>
          </details>

          <div id="off-err-box" style="margin-top:10px;"></div>
          <div id="off-transfer-area" style="margin-top:10px;"></div>
        </div>
      `;

      const errBox = document.getElementById('off-err-box')!;
      const transferArea = document.getElementById('off-transfer-area')!;
      bindSessionUi(transferArea, pc, session, 'sender', [], () => {
        void mountHost();
      });

      pc.onconnectionstatechange = () => {
        if (pc === activePc && pc.connectionState === 'failed' && dc.readyState !== 'open') {
          errBox.innerHTML = `
            <div class="alert alert-warning">
              <span>⚠️</span>
              <div>Koneksi WebRTC lokal gagal. Pastikan kedua perangkat berada di jaringan Wi-Fi / hotspot yang sama dan coba buat Offer baru.</div>
            </div>
          `;
        }
      };

      const applyAnswer = async (encoded: string) => {
        errBox.innerHTML = '';
        const rawJson = await decodeCompactPayload(encoded);
        const desc = JSON.parse(rawJson) as RTCSessionDescriptionInit;
        await pc.setRemoteDescription(desc);
      };

      const scanAnswerBtn = document.getElementById('off-scan-answer-btn') as HTMLButtonElement;
      scanAnswerBtn.onclick = async () => {
        const scanned = await scanQrWithCamera({
          title: 'Scan QR Answer Penerima',
          hint: 'Arahkan kamera ke QR Answer yang tampil di layar penerima.',
        });
        if (!scanned) return;
        try {
          await applyAnswer(scanned);
        } catch (err) {
          errBox.innerHTML = `<div class="alert alert-warning">QR Answer tidak valid: ${escapeHtml((err as Error).message)}</div>`;
        }
      };

      document.getElementById('off-manual-connect')!.onclick = async () => {
        const raw = (document.getElementById('off-answer-in') as HTMLTextAreaElement).value.trim();
        if (!raw) return;
        try {
          await applyAnswer(raw);
        } catch (err) {
          errBox.innerHTML = `<div class="alert alert-warning">Kode Answer tidak valid: ${escapeHtml((err as Error).message)}</div>`;
        }
      };

      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        const localDesc = await gatherIceDescription(pc, 2000);
        if (destroyed || activeMainTab !== 'offline' || offlineRole !== 'host') return;
        const compact = await encodeCompactPayload(JSON.stringify(localDesc));

        const qrCanvas = document.getElementById('off-offer-qr') as HTMLCanvasElement | null;
        const statusEl = document.getElementById('off-offer-status');
        const txtEl = document.getElementById('off-offer-txt') as HTMLTextAreaElement | null;
        if (qrCanvas) await drawQrCanvas(qrCanvas, compact, 210);
        if (txtEl) txtEl.value = compact;
        if (statusEl) statusEl.textContent = `QR Offer siap (${compact.length} karakter terkompresi)`;
        scanAnswerBtn.disabled = false;
      } catch (err) {
        const statusEl = document.getElementById('off-offer-status');
        if (statusEl) statusEl.textContent = `Gagal membuat Offer: ${(err as Error).message}`;
      }
    };

    const mountJoin = () => {
      offlineRole = 'join';
      joinBtn.classList.add('btn-primary');
      hostBtn.classList.remove('btn-primary');
      cleanupWebRtcSession();

      const pc = createPeerConnectionForMode('wlan-offline');
      activePc = pc;

      offBody.innerHTML = `
        <div class="offline-qr-panel">
          <div class="pin-config-bar" style="margin-bottom:10px;">
            <label class="pin-toggle" style="color:var(--text);">
              <input id="off-pin-check" type="checkbox" ${requirePin ? 'checked' : ''} />
              <span>🔒 Wajibkan PIN 4 Digit</span>
            </label>
            <input id="off-pin-val" type="text" inputmode="numeric" maxlength="8" value="${escapeHtml(receiverPin)}" ${requirePin ? '' : 'hidden'} />
          </div>

          <button id="off-scan-offer-btn" type="button" class="btn btn-primary" style="width:100%;">
            📷 Langkah 1: Scan QR Offer dari Pengirim
          </button>

          <div id="off-answer-qr-stage" class="qr-stage" style="padding:14px;margin-top:10px;" hidden>
            <div style="font-size:0.84rem;font-weight:700;color:var(--text-strong);margin-bottom:4px;">Langkah 2: Tunjukkan QR Answer Ini ke Pengirim</div>
            <canvas id="off-answer-qr" style="max-width:220px;border-radius:10px;"></canvas>
            <div style="font-size:0.75rem;color:var(--muted);">Tunggu pengirim selesai memindai QR ini...</div>
          </div>

          <details class="advanced-box" style="margin-top:10px;">
            <summary>Atau gunakan Salin &amp; Tempel Teks Manual</summary>
            <div class="input-group" style="margin-top:8px;">
              <label>Tempel Kode Offer dari Pengirim:</label>
              <textarea id="off-offer-in" rows="2" placeholder="Tempel kode Offer di sini..."></textarea>
            </div>
            <button id="off-manual-gen-answer" type="button" class="btn" style="width:100%;margin-bottom:8px;">Buat Answer Manual</button>
            <div class="input-group" style="margin-bottom:0;">
              <label>Salin Kode Answer ini kembali ke Pengirim:</label>
              <textarea id="off-answer-out" rows="2" readonly placeholder="Kode Answer akan muncul di sini..."></textarea>
            </div>
          </details>

          <div id="off-err-box" style="margin-top:10px;"></div>
          <div id="off-transfer-area" style="margin-top:10px;"></div>
        </div>
      `;

      const offPinCheck = document.getElementById('off-pin-check') as HTMLInputElement;
      const offPinVal = document.getElementById('off-pin-val') as HTMLInputElement;
      offPinCheck.onchange = () => {
        requirePin = offPinCheck.checked;
        offPinVal.hidden = !requirePin;
      };
      offPinVal.oninput = () => {
        receiverPin = offPinVal.value.trim() || '0000';
      };

      const errBox = document.getElementById('off-err-box')!;
      const transferArea = document.getElementById('off-transfer-area')!;
      let channelAttached = false;
      pc.onconnectionstatechange = () => {
        if (pc === activePc && pc.connectionState === 'failed' && !channelAttached) {
          errBox.innerHTML = `
            <div class="alert alert-warning">
              <span>⚠️</span>
              <div>Koneksi WebRTC lokal gagal. Pastikan kedua perangkat di Wi-Fi / hotspot yang sama dan coba scan ulang.</div>
            </div>
          `;
        }
      };

      pc.ondatachannel = (e) => {
        channelAttached = true;
        const stage = document.getElementById('off-answer-qr-stage');
        if (stage) stage.hidden = true;
        const session = new E2eeDataSession(e.channel, false);
        activeSession = session;
        bindSessionUi(transferArea, pc, session, 'receiver', [], () => {
          mountJoin();
        });
      };

      const processOffer = async (encoded: string) => {
        errBox.innerHTML = '';
        const rawJson = await decodeCompactPayload(encoded);
        const offerDesc = JSON.parse(rawJson) as RTCSessionDescriptionInit;
        await pc.setRemoteDescription(offerDesc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        const localDesc = await gatherIceDescription(pc, 2000);
        if (destroyed || activeMainTab !== 'offline' || offlineRole !== 'join') return;

        const compactAnswer = await encodeCompactPayload(JSON.stringify(localDesc));
        const stage = document.getElementById('off-answer-qr-stage')!;
        const qrCanvas = document.getElementById('off-answer-qr') as HTMLCanvasElement;
        const txtOut = document.getElementById('off-answer-out') as HTMLTextAreaElement;
        stage.hidden = false;
        await drawQrCanvas(qrCanvas, compactAnswer, 210);
        txtOut.value = compactAnswer;
      };

      document.getElementById('off-scan-offer-btn')!.onclick = async () => {
        const scanned = await scanQrWithCamera({
          title: 'Scan QR Offer Pengirim',
          hint: 'Arahkan kamera ke QR Offer di perangkat pengirim.',
        });
        if (!scanned) return;
        try {
          await processOffer(scanned);
        } catch (err) {
          errBox.innerHTML = `<div class="alert alert-warning">QR Offer tidak valid: ${escapeHtml((err as Error).message)}</div>`;
        }
      };

      document.getElementById('off-manual-gen-answer')!.onclick = async () => {
        const raw = (document.getElementById('off-offer-in') as HTMLTextAreaElement).value.trim();
        if (!raw) return;
        try {
          await processOffer(raw);
        } catch (err) {
          errBox.innerHTML = `<div class="alert alert-warning">Kode Offer tidak valid: ${escapeHtml((err as Error).message)}</div>`;
        }
      };
    };

    hostBtn.onclick = () => void mountHost();
    joinBtn.onclick = () => mountJoin();
    void mountHost();
  }

  function renderCurrentMainTab() {
    setMainTabButtons();
    if (activeMainTab === 'auto') {
      renderAutoView();
    } else {
      renderOfflineView();
    }
  }

  tabAutoBtn.onclick = () => {
    if (activeMainTab === 'auto') return;
    activeMainTab = 'auto';
    renderCurrentMainTab();
  };

  tabOfflineBtn.onclick = () => {
    if (activeMainTab === 'offline') return;
    activeMainTab = 'offline';
    renderCurrentMainTab();
  };

  renderCurrentMainTab();
  return cleanupAll;
}
