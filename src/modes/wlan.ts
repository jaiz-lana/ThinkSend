import {
  encodeCompactPayload,
  formatBytes,
  parseCompactSdp,
  randomId,
} from '../utils/crypto';
import {
  copyTextFromSource,
  pasteFromClipboardToField,
  renderCopyControlHtml,
  setupDropZone,
} from '../utils/copy';
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

type WlanViewTab = 'radar' | 'room' | 'offline';

const CUSTOM_WS_STORAGE_KEY = 'thinksend_custom_ws_url';

function generateDefaultPin(): string {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return String(arr[0] % 10000).padStart(4, '0');
}

export function renderWlanMode(container: HTMLElement): () => void {
  let activeView: WlanViewTab = 'radar';
  let alias = getOrCreateAlias();
  let requirePin = false;
  let receiverPin = generateDefaultPin();
  let customWsUrl = '';
  try {
    customWsUrl = localStorage.getItem(CUSTOM_WS_STORAGE_KEY) ?? '';
  } catch {
    // Ignore storage restriction
  }

  let signalingRoom: ThinkSendSignalingRoom | null = null;
  let discoveryGen = 0;
  let currentRoomCode = '';
  let radarFailed = false;
  let peers: SignalingPeer[] = [];
  let relayStatus: RelayStatus = { connectedRelays: 0, targetRelays: 4, mode: 'nostr' };

  // Active WebRTC session state
  let activePc: RTCPeerConnection | null = null;
  let activeSession: E2eeDataSession | null = null;
  let activeSessionId = '';
  let activePeer: SignalingPeer | null = null;
  let activeRole: 'sender' | 'receiver' | null = null;
  let sessionGen = 0;
  let connectWatchdogTimer: number | null = null;
  let cleanupActiveDrop: (() => void) | null = null;
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

  // Cek apakah dibuka via QR Link #wlan-room=XXXXXX atau #wlan-offline
  const initialHash = window.location.hash;
  if (initialHash.startsWith('#wlan-room=')) {
    const codeFromHash = normalizeRoomCode(initialHash.slice('#wlan-room='.length));
    if (codeFromHash.length >= 4) {
      activeView = 'room';
      currentRoomCode = codeFromHash;
    }
  } else if (initialHash === '#wlan-offline') {
    activeView = 'offline';
  }

  function clearWatchdog() {
    if (connectWatchdogTimer !== null) {
      clearTimeout(connectWatchdogTimer);
      connectWatchdogTimer = null;
    }
  }

  function revokeAllObjectUrls() {
    while (createdObjectUrls.length > 0) {
      const u = createdObjectUrls.pop();
      if (u) URL.revokeObjectURL(u);
    }
  }

  function cleanupWebRtcSession() {
    sessionGen++;
    clearWatchdog();
    cleanupActiveDrop?.();
    cleanupActiveDrop = null;
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
    peers = [];
    if (signalingRoom) {
      const room = signalingRoom;
      signalingRoom = null;
      await room.close();
    }
  }

  function cleanupAll() {
    destroyed = true;
    discoveryGen++;
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
        Transfer WLAN (Wi-Fi Lokal)
      </h2>
      <p class="desc">Kirim file cepat antar perangkat di Wi-Fi yang sama secara langsung &amp; terenkripsi End-to-End.</p>

      <div class="wlan-nav" role="tablist" focusgroup="tablist nomemory wrap" aria-label="Pilih Cara Koneksi WLAN">
        <button id="wlan-sub-radar" type="button" role="tab" aria-selected="${activeView === 'radar'}" ${activeView === 'radar' ? 'focusgroupstart' : ''} class="wlan-nav-btn ${activeView === 'radar' ? 'active' : ''}">
          📡 Wi-Fi Sekitar
        </button>
        <button id="wlan-sub-room" type="button" role="tab" aria-selected="${activeView === 'room'}" ${activeView === 'room' ? 'focusgroupstart' : ''} class="wlan-nav-btn ${activeView === 'room' ? 'active' : ''}">
          🔑 Kode Ruang
        </button>
        <button id="wlan-tab-offline" type="button" role="tab" aria-selected="${activeView === 'offline'}" ${activeView === 'offline' ? 'focusgroupstart' : ''} class="wlan-nav-btn ${activeView === 'offline' ? 'active' : ''}">
          📵 Tanpa Internet
        </button>
      </div>

      <div id="wlan-main-body"></div>
    </div>
  `;

  const mainBody = document.getElementById('wlan-main-body')!;
  const tabRadarBtn = document.getElementById('wlan-sub-radar') as HTMLButtonElement;
  const tabRoomBtn = document.getElementById('wlan-sub-room') as HTMLButtonElement;
  const tabOfflineBtn = document.getElementById('wlan-tab-offline') as HTMLButtonElement;

  function syncNavButtons() {
    const hasNativeFocusgroup = Object.hasOwn(HTMLElement.prototype, 'focusGroup');
    const map: Array<[HTMLButtonElement, WlanViewTab]> = [
      [tabRadarBtn, 'radar'],
      [tabRoomBtn, 'room'],
      [tabOfflineBtn, 'offline'],
    ];
    for (const [btn, view] of map) {
      const selected = activeView === view;
      btn.classList.toggle('active', selected);
      btn.setAttribute('aria-selected', String(selected));
      btn.toggleAttribute('focusgroupstart', selected);
      if (!hasNativeFocusgroup) {
        btn.tabIndex = selected ? 0 : -1;
      } else {
        btn.removeAttribute('tabindex');
      }
      if (selected) {
        try {
          btn.scrollIntoView({
            block: 'nearest',
            inline: 'nearest',
            container: 'nearest',
          } as ScrollIntoViewOptions);
        } catch {
          try {
            btn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          } catch {
            // Ignore on unsupported engines
          }
        }
      }
    }
  }

  // ==================== SHARED E2EE TRANSFER UI ====================

  function bindSessionUi(
    sessionArea: HTMLElement,
    pc: RTCPeerConnection,
    session: E2eeDataSession,
    role: 'sender' | 'receiver',
    initialFiles: File[],
    mySessionGen: number,
    onReset: () => void,
    options?: { setupStepsEl?: HTMLElement | null; hideOfflineSwitch?: boolean }
  ) {
    sessionArea.innerHTML = `
      <div class="e2ee-session-box">
        <div class="alert alert-info wlan-hs-status">
          <span aria-hidden="true">⏳</span>
          <div style="flex:1;">Menunggu koneksi WebRTC P2P terbuka...</div>
          <button type="button" class="mini-link-btn wlan-hs-cancel">Batalkan</button>
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
    let receivedCount = 0;

    const hsCancelBtn = hsStatus.querySelector('.wlan-hs-cancel') as HTMLButtonElement | null;
    if (hsCancelBtn) {
      hsCancelBtn.onclick = () => {
        if (activePeer && activeSessionId && signalingRoom) {
          void signalingRoom.sendDirect(activePeer, {
            type: 'decline',
            sessionId: activeSessionId,
            reason: 'Koneksi dibatalkan.',
          });
        }
        cleanupWebRtcSession();
        onReset();
      };
    }

    clearWatchdog();
    connectWatchdogTimer = window.setTimeout(() => {
      if (destroyed || mySessionGen !== sessionGen) return;
      if (pc.connectionState !== 'connected') {
        hsStatus.className = 'alert alert-warning wlan-hs-status';
        hsStatus.innerHTML = `
          <span aria-hidden="true">⚠️</span>
          <div style="flex:1;">
            Koneksi P2P belum tersambung (&gt;15 dtk). Kemungkinan terhalang isolasi Wi-Fi publik atau firewall.
            ${
              options?.hideOfflineSwitch
                ? ''
                : '<br /><small>Tips: Coba tab <strong>Tanpa Internet</strong> atau pakai hotspot pribadi.</small>'
            }
          </div>
          <button type="button" class="mini-link-btn wlan-hs-cancel">Batalkan</button>
        `;
        const retryCancel = hsStatus.querySelector('.wlan-hs-cancel') as HTMLButtonElement | null;
        if (retryCancel) {
          retryCancel.onclick = () => {
            cleanupWebRtcSession();
            onReset();
          };
        }
      }
    }, 15_000);

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
              Kode Cocok Sesi: <strong>${escapeHtml(sasCode)}</strong> &bull;
              ${attempt > 1 ? `<span style="color:var(--danger);">PIN salah! Sisa percobaan: ${remaining}</span>` : 'Masukkan PIN 4 digit yang tampil di layar penerima.'}
            </p>
            <div class="pin-input-row">
              <label for="wlan-remote-pin-field" class="visually-hidden">PIN 4 digit penerima</label>
              <input id="wlan-remote-pin-field" class="wlan-remote-pin-in" type="text" inputmode="numeric" maxlength="8" placeholder="PIN 4 digit..." />
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
          ? 'Menyiapkan verifikasi SHA-256...'
          : info.phase === 'verifying'
            ? 'Memverifikasi keutuhan file SHA-256...'
            : `${formatBytes(info.doneBytes)} / ${formatBytes(info.totalBytes)}`;
      const speedText =
        info.phase === 'transferring' && info.speedBps > 0 ? `${formatBytes(info.speedBps)}/dtk` : '';

      progressArea.innerHTML = `
        <div class="transfer-progress-card">
          <div class="transfer-meta-row">
            <strong>${escapeHtml(labelPrefix)}: ${escapeHtml(info.fileName)}</strong>
            <span>${pct}%</span>
          </div>
          ${
            info.phase === 'hashing' || info.phase === 'verifying'
              ? '<progress class="ts-progress" aria-label="Memproses integritas file"></progress>'
              : `<progress class="ts-progress" value="${pct}" max="100" aria-label="Progres transfer"></progress>`
          }
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
            if (destroyed || mySessionGen !== sessionGen) return;
            clearWatchdog();
            hsStatus.className = 'alert alert-info wlan-hs-status';
            hsStatus.innerHTML = `
              <span aria-hidden="true">🔐</span>
              <div>Jalur terbuka! Mengamankan sesi End-to-End...</div>
            `;
          },
          onRequestRemotePin: role === 'sender' ? requestRemotePinUi : undefined,
        });
        if (destroyed || mySessionGen !== sessionGen) return;
        clearWatchdog();

        if (options?.setupStepsEl) options.setupStepsEl.hidden = true;

        const pathLabel = await detectIcePathLabel(pc);
        if (destroyed || mySessionGen !== sessionGen) return;

        hsStatus.className = 'alert alert-success wlan-hs-status';
        hsStatus.innerHTML = `
          <span aria-hidden="true">🛡️</span>
          <div>
            <strong>Terhubung Aman (${escapeHtml(pathLabel)})</strong><br />
            <span class="sas-row">Kode Cocok: <code class="sas-badge">${escapeHtml(sasCode)}</code> <small>(Cocokkan dengan layar sebelah)</small></span>
          </div>
        `;

        if (role === 'sender') {
          const sendQueue = async (files: File[]) => {
            if (files.length === 0) return;
            try {
              await session.sendFiles(files, (info) => renderProgress(info, 'Mengirim'));
              if (destroyed || mySessionGen !== sessionGen) return;
              progressArea.innerHTML = `
                <div class="alert alert-success" role="status">
                  <span aria-hidden="true">✅</span>
                  <div><strong>${files.length} file terkirim</strong> &amp; terverifikasi SHA-256 di penerima!</div>
                </div>
              `;
            } catch (err) {
              if (destroyed || mySessionGen !== sessionGen) return;
              progressArea.innerHTML = `
                <div class="alert alert-warning">
                  <span aria-hidden="true">⚠️</span>
                  <div>Gagal mengirim: ${escapeHtml((err as Error).message)}</div>
                </div>
              `;
            }
          };

          readyArea.innerHTML = `
            <label class="file-drop" id="wlan-e2ee-dropzone" style="margin-top:6px;">
              <input type="file" id="wlan-e2ee-file-input" multiple />
              <span class="file-drop-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
              </span>
              <strong>${initialFiles.length > 0 ? 'Kirim File Tambahan (Pilih / Seret)' : 'Pilih atau Seret File ke Sini'}</strong>
              <span class="subtitle" style="color:var(--muted);">Terenkripsi End-to-End langsung ke penerima</span>
            </label>
            <button id="wlan-close-session" type="button" class="btn" style="width:100%;margin-top:6px;">Putuskan Koneksi</button>
          `;

          const fileInput = readyArea.querySelector('#wlan-e2ee-file-input') as HTMLInputElement;
          const dropZoneEl = readyArea.querySelector('#wlan-e2ee-dropzone') as HTMLElement;
          fileInput.onchange = () => {
            const list = fileInput.files ? Array.from(fileInput.files) : [];
            fileInput.value = '';
            void sendQueue(list);
          };
          cleanupActiveDrop = setupDropZone(dropZoneEl, (files) => void sendQueue(files));
          (readyArea.querySelector('#wlan-close-session') as HTMLButtonElement).onclick = () => {
            cleanupWebRtcSession();
            onReset();
          };

          if (initialFiles.length > 0) {
            await sendQueue(initialFiles);
          }
        } else {
          readyArea.innerHTML = `
            <div class="alert alert-info" style="margin-top:6px;">
              <span aria-hidden="true">📥</span>
              <div>Siap menerima file dari pengirim...</div>
            </div>
            <button id="wlan-close-session" type="button" class="btn" style="width:100%;margin-top:6px;">Putuskan Koneksi</button>
          `;
          (readyArea.querySelector('#wlan-close-session') as HTMLButtonElement).onclick = () => {
            cleanupWebRtcSession();
            onReset();
          };

          void session.listenForFiles({
            onProgress: (info) => renderProgress(info, 'Menerima'),
            onFileComplete: (res: ReceivedFileResult) => {
              createdObjectUrls.push(res.url);
              receivedCount++;
              progressArea.innerHTML = `
                <div class="alert ${res.verified ? 'alert-success' : 'alert-warning'}" role="status">
                  <span aria-hidden="true">${res.verified ? '✅' : '⚠️'}</span>
                  <div>${res.verified ? 'File diterima &amp; keutuhan SHA-256 cocok 100%!' : 'Peringatan: Hash SHA-256 file tidak cocok!'}</div>
                </div>
              `;
              const item = document.createElement('div');
              item.className = 'received-file-item';
              item.innerHTML = `
                <div class="received-file-meta">
                  <strong>${escapeHtml(res.name)}</strong>
                  <span>${escapeHtml(formatBytes(res.size))} &bull; ${res.verified ? 'Terverifikasi' : 'Hash Tidak Cocok'}</span>
                </div>
                <a class="btn btn-success" href="${res.url}" download="${escapeHtml(res.name)}" style="text-decoration:none;">
                  💾 Simpan
                </a>
              `;
              receivedArea.prepend(item);
            },
            onRemoteClose: () => {
              if (destroyed || mySessionGen !== sessionGen) return;
              hsStatus.className = 'alert alert-info wlan-hs-status';
              hsStatus.innerHTML = `<span aria-hidden="true">ℹ️</span><div>${
                receivedCount > 0
                  ? 'Sesi ditutup oleh pengirim. File di bawah tetap dapat disimpan.'
                  : 'Pengirim menutup koneksi.'
              }</div>`;
            },
            onError: (err) => {
              if (destroyed || mySessionGen !== sessionGen) return;
              progressArea.innerHTML = `
                <div class="alert alert-warning">
                  <span aria-hidden="true">⚠️</span>
                  <div>${escapeHtml(err.message)}</div>
                </div>
              `;
            },
          });
        }
      } catch (err) {
        if (destroyed || mySessionGen !== sessionGen) return;
        clearWatchdog();
        hsStatus.className = 'alert alert-warning wlan-hs-status';
        hsStatus.innerHTML = `<span aria-hidden="true">⚠️</span><div>${escapeHtml((err as Error).message)}</div>`;
        readyArea.innerHTML = `<button type="button" class="btn wlan-retry-btn" style="width:100%;">Kembali</button>`;
        (readyArea.querySelector('.wlan-retry-btn') as HTMLButtonElement).onclick = () => {
          cleanupWebRtcSession();
          onReset();
        };
      }
    })();
  }

  // ==================== JALUR 1: WI-FI SEKITAR & KODE RUANG ====================

  function handleIncomingDirectSignal(peer: SignalingPeer, signal: DirectSignalPayload) {
    if (destroyed || activeView === 'offline') return;

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
            <div class="alert alert-warning" style="align-items:center;">
              <span aria-hidden="true">❌</span>
              <div style="flex:1;">${escapeHtml(signal.reason ?? 'Permintaan ditolak oleh penerima.')}</div>
              <button id="wlan-dismiss-notice" type="button" class="mini-link-btn">Tutup</button>
            </div>
          `;
          document.getElementById('wlan-dismiss-notice')?.addEventListener('click', () => {
            transferBox.innerHTML = '';
          });
        }
      }
      return;
    }

    if (signal.type === 'accept' && signal.sessionId === activeSessionId && activeRole === 'sender') {
      void startSenderWebRtcAfterAccept();
      return;
    }

    if (signal.type === 'offer' && signal.sessionId === activeSessionId && activeRole === 'receiver' && activePc) {
      const targetPc = activePc;
      const targetPeer = activePeer;
      const targetSessionId = activeSessionId;
      void (async () => {
        try {
          await targetPc.setRemoteDescription(signal.sdp);
          while (pendingIceQueue.length > 0 && targetPc === activePc) {
            await targetPc.addIceCandidate(pendingIceQueue.shift()!);
          }
          const answer = await targetPc.createAnswer();
          await targetPc.setLocalDescription(answer);
          if (targetPeer && targetPc === activePc) {
            await signalingRoom?.sendDirect(targetPeer, {
              type: 'answer',
              sessionId: targetSessionId,
              sdp: targetPc.localDescription!.toJSON(),
            });
          }
        } catch (err) {
          if (targetPc !== activePc) return;
          const box = document.getElementById('wlan-auto-session');
          if (box) {
            box.innerHTML = `<div class="alert alert-warning">Gagal memproses koneksi: ${escapeHtml((err as Error).message)}</div>`;
          }
        }
      })();
      return;
    }

    if (signal.type === 'answer' && signal.sessionId === activeSessionId && activeRole === 'sender' && activePc) {
      const targetPc = activePc;
      void (async () => {
        try {
          await targetPc.setRemoteDescription(signal.sdp);
          while (pendingIceQueue.length > 0 && targetPc === activePc) {
            await targetPc.addIceCandidate(pendingIceQueue.shift()!);
          }
        } catch (err) {
          if (targetPc !== activePc) return;
          const box = document.getElementById('wlan-auto-session');
          if (box) {
            box.innerHTML = `<div class="alert alert-warning">Gagal memproses balasan koneksi: ${escapeHtml((err as Error).message)}</div>`;
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

    const mySessionGen = sessionGen;
    const pc = createPeerConnectionForMode('wlan-auto');
    activePc = pc;
    pendingIceQueue = [];

    const dc = pc.createDataChannel('thinksend-wlan-e2ee', { ordered: true });
    const session = new E2eeDataSession(dc, true);
    activeSession = session;

    pc.onicecandidate = (e) => {
      if (e.candidate && activePeer && signalingRoom && pc === activePc) {
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
            <span aria-hidden="true">⚠️</span>
            <div style="flex:1;">Gagal tersambung langsung (kemungkinan diblokir isolasi Wi-Fi). Coba menu <strong>Tanpa Internet</strong> atau hotspot pribadi.</div>
            <button type="button" class="mini-link-btn" id="wlan-fail-close">Tutup</button>
          </div>
        `;
        document.getElementById('wlan-fail-close')?.addEventListener('click', () => {
          sessionBox.innerHTML = '';
        });
      }
    };

    bindSessionUi(sessionBox, pc, session, 'sender', pendingFilesToSend, mySessionGen, () => {
      sessionBox.innerHTML = '';
      renderAutoPeerList();
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (pc !== activePc || !activePeer || !signalingRoom) return;
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
      <div class="invite-card" role="region" aria-label="Permintaan transfer masuk">
        <div class="invite-header">
          <strong>📩 Permintaan Kirim File</strong>
          <span>dari <strong>${escapeHtml(inv.peer.alias)}</strong> (${escapeHtml(inv.peer.device)})</span>
        </div>
        <p class="invite-summary">
          ${inv.fileCount} file (${escapeHtml(formatBytes(inv.totalSize))}): ${escapeHtml(inv.fileSummary)}
        </p>
        ${
          requirePin
            ? `<div class="invite-pin-note">🔒 PIN Penerima aktif: <strong>${escapeHtml(receiverPin)}</strong> (sebutkan ke pengirim)</div>`
            : ''
        }
        <div class="invite-actions">
          <button id="wlan-inv-accept" type="button" class="btn btn-success">Terima File</button>
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
      const mySessionGen = sessionGen;
      activePeer = inv.peer;
      activeSessionId = inv.sessionId;
      activeRole = 'receiver';
      pendingIceQueue = [];
      incomingInvite = null;
      renderInviteBanner();

      const pc = createPeerConnectionForMode('wlan-auto');
      activePc = pc;

      pc.onicecandidate = (e) => {
        if (e.candidate && activePeer && signalingRoom && pc === activePc) {
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
          <div class="alert alert-info" style="align-items:center;">
            <span aria-hidden="true">⏳</span>
            <div style="flex:1;">Menyambungkan dengan <strong>${escapeHtml(inv.peer.alias)}</strong>...</div>
            <button id="wlan-recv-wait-cancel" type="button" class="mini-link-btn">Batalkan</button>
          </div>
        `;
        document.getElementById('wlan-recv-wait-cancel')?.addEventListener('click', () => {
          cleanupWebRtcSession();
          sessionBox.innerHTML = '';
        });
      }

      clearWatchdog();
      connectWatchdogTimer = window.setTimeout(() => {
        if (destroyed || mySessionGen !== sessionGen) return;
        if (!activeSession && sessionBox) {
          sessionBox.innerHTML = `
            <div class="alert alert-warning" style="align-items:center;">
              <span aria-hidden="true">⚠️</span>
              <div style="flex:1;">Pengirim belum tersambung (&gt;15 dtk). Kemungkinan terhalang firewall Wi-Fi.</div>
              <button id="wlan-recv-wait-cancel" type="button" class="mini-link-btn">Batalkan</button>
            </div>
          `;
          document.getElementById('wlan-recv-wait-cancel')?.addEventListener('click', () => {
            cleanupWebRtcSession();
            sessionBox.innerHTML = '';
          });
        }
      }, 15_000);

      let channelAttached = false;
      pc.onconnectionstatechange = () => {
        if (pc === activePc && pc.connectionState === 'failed' && !channelAttached) {
          cleanupWebRtcSession();
          if (sessionBox) {
            sessionBox.innerHTML = `
              <div class="alert alert-warning">
                <span aria-hidden="true">⚠️</span>
                <div>Koneksi WebRTC langsung gagal (isolasi jaringan). Gunakan menu <strong>Tanpa Internet</strong> atau hotspot yang sama.</div>
              </div>
            `;
          }
        }
      };

      pc.ondatachannel = (e) => {
        if (destroyed || pc !== activePc) return;
        channelAttached = true;
        clearWatchdog();
        const session = new E2eeDataSession(e.channel, false);
        activeSession = session;
        if (sessionBox) {
          bindSessionUi(sessionBox, pc, session, 'receiver', [], mySessionGen, () => {
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
    if (radarFailed && activeView === 'radar') {
      el.className = 'relay-pill relay-wait';
      el.textContent = 'Radar butuh internet • Gunakan Tanpa Internet jika offline';
      return;
    }
    if (relayStatus.connectedRelays > 0) {
      el.className = 'relay-pill relay-ok';
      el.textContent =
        relayStatus.mode === 'custom-ws'
          ? 'Siap • Terhubung ke Relay Kustom (E2EE)'
          : `Siap Menerima & Mengirim (${relayStatus.connectedRelays}/${relayStatus.targetRelays} jalur E2EE)`;
    } else {
      el.className = 'relay-pill relay-wait';
      el.textContent =
        relayStatus.lastError ?? 'Menghubungkan pencari perangkat...';
    }
  }

  function renderAutoPeerList() {
    const listEl = document.getElementById('wlan-peer-list');
    if (!listEl) return;

    if (radarFailed && activeView === 'radar') {
      listEl.innerHTML = `
        <div class="peer-empty peer-empty-offline">
          <div>
            <strong>Tidak dapat menjangkau jaringan pencarian otomatis</strong>
            <p>Jika Wi-Fi ini sedang tanpa internet, gunakan mode <strong>Tanpa Internet (QR)</strong> untuk transfer lokal 100% offline lewat router/hotspot yang sama.</p>
            <button id="wlan-jump-offline" type="button" class="btn btn-primary" style="margin-top:10px;">
              📵 Buka Mode Tanpa Internet
            </button>
          </div>
        </div>
      `;
      document.getElementById('wlan-jump-offline')!.onclick = () => {
        activeView = 'offline';
        renderCurrentView();
      };
      return;
    }

    if (peers.length === 0) {
      listEl.innerHTML = `
        <div class="peer-empty">
          <div class="radar-pulse" aria-hidden="true"></div>
          <div>
            <strong>Mencari perangkat lain...</strong>
            <p>Buka tab <strong>WLAN</strong> di perangkat kedua (${
              activeView === 'radar'
                ? 'di Wi-Fi yang sama'
                : `lalu masukkan kode <strong>${escapeHtml(currentRoomCode || '—')}</strong>`
            }). Perangkat ini otomatis siap menerima.</p>
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
              <span class="peer-device">${escapeHtml(p.device)} &bull; Siap menerima</span>
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
          if (files.length === 0 || destroyed) return;

          const currentRoom = signalingRoom;
          const stillOnline = peers.find((p) => p.id === target.id);
          if (!currentRoom || !stillOnline) {
            const sessionBox = document.getElementById('wlan-auto-session');
            if (sessionBox) {
              sessionBox.innerHTML = `<div class="alert alert-warning">Perangkat <strong>${escapeHtml(target.alias)}</strong> sudah tidak tersedia saat memilih file.</div>`;
            }
            return;
          }

          cleanupWebRtcSession();
          activePeer = stillOnline;
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
                <span aria-hidden="true">⏳</span>
                <div style="flex:1;">
                  Menunggu <strong>${escapeHtml(stillOnline.alias)}</strong> menerima
                  <strong>${files.length} file (${escapeHtml(formatBytes(totalSize))})</strong>...
                </div>
                <button id="wlan-cancel-invite" type="button" class="mini-link-btn">Batalkan</button>
              </div>
            `;
            const cancelInviteBtn = document.getElementById('wlan-cancel-invite');
            if (cancelInviteBtn) {
              cancelInviteBtn.onclick = () => {
                void signalingRoom?.sendDirect(stillOnline, {
                  type: 'decline',
                  sessionId: sentSessionId,
                  reason: 'Pengiriman dibatalkan oleh pengirim.',
                });
                cleanupWebRtcSession();
                sessionBox.innerHTML = '';
              };
            }
          }

          await currentRoom.sendDirect(stillOnline, {
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

  async function startDiscoveryRoom(secret: string, myGen: number) {
    peers = [];
    renderAutoPeerList();
    await cleanupSignaling();
    cleanupWebRtcSession();
    if (destroyed || myGen !== discoveryGen || activeView === 'offline') return;

    const room = new ThinkSendSignalingRoom({
      alias,
      requirePin,
      roomSecret: secret,
      customWsUrl: customWsUrl || undefined,
      onPeersUpdate: (nextPeers) => {
        if (destroyed || myGen !== discoveryGen) return;
        peers = nextPeers;
        renderAutoPeerList();
      },
      onDirectSignal: (peer, signal) => {
        if (destroyed || myGen !== discoveryGen) return;
        handleIncomingDirectSignal(peer, signal);
      },
      onStatus: (status) => {
        if (destroyed || myGen !== discoveryGen) return;
        relayStatus = status;
        renderRelayStatusBadge();
      },
      onPeerBye: (peerId) => {
        if (destroyed || myGen !== discoveryGen) return;
        if (incomingInvite && incomingInvite.peer.id === peerId) {
          incomingInvite = null;
          renderInviteBanner();
        }
        if (activePeer?.id === peerId && activeRole === 'sender' && !activeSession) {
          const leftAlias = activePeer.alias;
          cleanupWebRtcSession();
          const box = document.getElementById('wlan-auto-session');
          if (box) {
            box.innerHTML = `<div class="alert alert-warning">Perangkat <strong>${escapeHtml(leftAlias)}</strong> keluar sebelum menyetujui pengiriman.</div>`;
          }
        }
      },
    });
    signalingRoom = room;
    await room.start();
    if (destroyed || myGen !== discoveryGen) {
      if (signalingRoom === room) signalingRoom = null;
      await room.close();
    }
  }

  async function activateRadar() {
    const myGen = ++discoveryGen;
    radarFailed = false;
    peers = [];
    relayStatus = {
      connectedRelays: 0,
      targetRelays: customWsUrl ? 1 : 4,
      mode: customWsUrl ? 'custom-ws' : 'nostr',
    };
    renderRelayStatusBadge();
    renderAutoPeerList();

    const infoEl = document.getElementById('wlan-discovery-info');
    if (infoEl) infoEl.textContent = 'Mendeteksi jaringan Wi-Fi sekitar...';
    const refreshBtn = document.getElementById('wlan-radar-refresh') as HTMLButtonElement | null;
    if (refreshBtn) refreshBtn.disabled = true;

    const detected = await detectRadarRoomSecret();
    if (refreshBtn) refreshBtn.disabled = false;
    if (destroyed || myGen !== discoveryGen || activeView !== 'radar') return;

    if (!detected) {
      radarFailed = true;
      if (infoEl) infoEl.textContent = 'Tidak ada koneksi internet untuk Radar otomatis.';
      renderRelayStatusBadge();
      renderAutoPeerList();
      return;
    }

    if (infoEl) {
      infoEl.textContent = `Radar aktif (${detected.ipLabel}) • Otomatis menemukan perangkat di Wi-Fi sama`;
    }
    await startDiscoveryRoom(detected.secret, myGen);
  }

  async function activatePrivateRoom(code: string) {
    const myGen = ++discoveryGen;
    radarFailed = false;
    const clean = normalizeRoomCode(code) || generateRoomCode();
    currentRoomCode = clean;

    const codeDisplay = document.getElementById('wlan-room-code-display');
    const qrWrap = document.getElementById('wlan-room-qr-wrap');
    const qrCanvas = document.getElementById('wlan-room-qr-canvas') as HTMLCanvasElement | null;
    if (codeDisplay) codeDisplay.textContent = clean;
    if (qrWrap && qrCanvas) {
      qrWrap.hidden = false;
      const base = `${window.location.origin}${window.location.pathname}`;
      await drawQrCanvas(qrCanvas, `${base}#wlan-room=${clean}`, 168);
    }
    if (destroyed || myGen !== discoveryGen || activeView !== 'room') return;

    await startDiscoveryRoom(`room:${clean}`, myGen);
  }

  function renderAutoView(sub: 'radar' | 'room') {
    cleanupWebRtcSession();
    void cleanupSignaling();

    mainBody.innerHTML = `
      <div class="identity-bar">
        <div class="identity-left">
          <span class="identity-label">Perangkat Anda:</span>
          <strong id="wlan-alias-text">${escapeHtml(alias)}</strong>
          <button id="wlan-edit-alias" type="button" class="mini-link-btn">Ubah Nama</button>
        </div>
        <label class="pin-toggle">
          <input id="wlan-pin-check" type="checkbox" ${requirePin ? 'checked' : ''} />
          <span>🔒 PIN Terima</span>
        </label>
      </div>

      <div id="wlan-alias-editor" class="pin-config-bar" hidden>
        <label for="wlan-alias-input">Nama Baru:</label>
        <input id="wlan-alias-input" type="text" maxlength="28" value="${escapeHtml(alias)}" placeholder="Contoh: HP Budi" />
        <button id="wlan-alias-save" type="button" class="mini-link-btn">Simpan</button>
        <button id="wlan-alias-cancel" type="button" class="mini-link-btn">Batal</button>
      </div>

      <div id="wlan-pin-config" class="pin-config-bar" ${requirePin ? '' : 'hidden'}>
        <label for="wlan-pin-value">PIN Keamanan Penerima:</label>
        <input id="wlan-pin-value" type="text" inputmode="numeric" maxlength="8" value="${escapeHtml(receiverPin)}" />
        <button id="wlan-pin-regen" type="button" class="mini-link-btn">Acak</button>
      </div>

      <div id="wlan-invite-banner"></div>
      <div id="wlan-auto-session"></div>
      <div id="wlan-discovery-panel"></div>

      <div class="status-strip">
        <span id="wlan-relay-status" class="relay-pill relay-wait">Menghubungkan pencari perangkat...</span>
      </div>

      <div id="wlan-peer-list" class="peer-list"></div>

      <details class="advanced-box">
        <summary>Pengaturan Lanjutan &amp; Keamanan Enkripsi</summary>
        <p>
          Alamat IP publik untuk Radar hanya di-hash lokal (SHA-256), pesan sinyal memakai relay ephemeral terenkripsi tanpa penyimpanan file, dan data dikirim langsung peramban-ke-peramban dengan WebRTC DTLS + ECDH AES-256-GCM.
        </p>
        <div class="input-group" style="margin-bottom:0;margin-top:8px;">
          <label for="wlan-custom-ws">Custom WebSocket Signaling URL (Opsional):</label>
          <div style="display:flex;gap:8px;">
            <input id="wlan-custom-ws" type="text" value="${escapeHtml(customWsUrl)}" placeholder="Kosongkan untuk default relay gratis" />
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

    document.getElementById('wlan-save-ws')!.onclick = () => {
      customWsUrl = (document.getElementById('wlan-custom-ws') as HTMLInputElement).value.trim();
      try {
        if (customWsUrl) localStorage.setItem(CUSTOM_WS_STORAGE_KEY, customWsUrl);
        else localStorage.removeItem(CUSTOM_WS_STORAGE_KEY);
      } catch {
        // Ignore
      }
      renderAutoView(sub);
    };

    const panel = document.getElementById('wlan-discovery-panel')!;
    if (sub === 'radar') {
      panel.innerHTML = `
        <div class="alert alert-info" style="margin-bottom:10px;align-items:center;">
          <span aria-hidden="true">📡</span>
          <div style="flex:1;" id="wlan-discovery-info">Mendeteksi jaringan Wi-Fi sekitar...</div>
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
            <label for="wlan-room-in" class="visually-hidden">Kode Ruang WLAN</label>
            <input id="wlan-room-in" type="text" maxlength="16" value="${escapeHtml(currentRoomCode)}" placeholder="Masukkan Kode Ruang..." />
            <button id="wlan-room-join-btn" type="button" class="btn btn-primary">Gabung</button>
            <button id="wlan-room-new-btn" type="button" class="btn" title="Buat Kode Baru">Acak</button>
            <button id="wlan-room-scan-btn" type="button" class="btn" title="Scan QR Ruang">📷 Scan</button>
          </div>
          <div id="wlan-room-err" style="margin-top:8px;"></div>
          <div id="wlan-room-qr-wrap" class="room-qr-share" hidden>
            <canvas id="wlan-room-qr-canvas"></canvas>
            <div class="room-qr-meta">
              <span>Kode Ruang Aktif:</span>
              <strong id="wlan-room-code-display" class="room-code-big">${escapeHtml(currentRoomCode)}</strong>
              <small>Scan QR atau masukkan kode yang sama di perangkat kedua.</small>
              <div class="field-actions" style="margin-top:2px;">
                ${renderCopyControlHtml({
                  id: 'wlan-copy-room-code',
                  targetId: 'wlan-room-code-display',
                  label: 'Salin Kode',
                  className: 'mini-btn',
                })}
                <span class="copy-wrap">
                  <button id="wlan-copy-room-link" type="button" class="btn copy-btn mini-btn">
                    <span class="copy-icon-slot" aria-hidden="true">
                      <svg class="icon-copy" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <rect x="9" y="9" width="13" height="13" rx="2" />
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                      </svg>
                      <svg class="icon-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    </span>
                    <span class="copy-label">Salin Tautan</span>
                  </button>
                  <span class="copy-tip" role="status"></span>
                </span>
              </div>
            </div>
          </div>
        </div>
      `;

      const roomIn = document.getElementById('wlan-room-in') as HTMLInputElement;
      const roomErr = document.getElementById('wlan-room-err')!;
      document.getElementById('wlan-room-join-btn')!.onclick = () => {
        roomErr.innerHTML = '';
        const code = normalizeRoomCode(roomIn.value);
        if (code.length < 4) {
          roomErr.innerHTML = `<div class="alert alert-warning" style="margin-bottom:0;">Masukkan kode ruang minimal 4 huruf/angka.</div>`;
          roomIn.focus();
          return;
        }
        roomIn.value = code;
        void activatePrivateRoom(code);
      };
      document.getElementById('wlan-room-new-btn')!.onclick = () => {
        roomErr.innerHTML = '';
        const next = generateRoomCode();
        roomIn.value = next;
        void activatePrivateRoom(next);
      };
      document.getElementById('wlan-room-scan-btn')!.onclick = async () => {
        const scanned = await scanQrWithCamera({
          title: 'Scan QR Ruang WLAN',
          hint: 'Arahkan kamera ke QR Kode Ruang pada perangkat pengirim.',
        });
        if (!scanned) return;
        const match = scanned.match(/#wlan-room=([A-Za-z0-9-]+)/);
        const extracted = normalizeRoomCode(match ? match[1] : scanned);
        if (extracted.length >= 4) {
          roomErr.innerHTML = '';
          roomIn.value = extracted;
          void activatePrivateRoom(extracted);
        } else {
          roomErr.innerHTML = `<div class="alert alert-warning" style="margin-bottom:0;">QR yang dipindai bukan kode ruang yang valid.</div>`;
        }
      };
      const copyLinkBtn = document.getElementById('wlan-copy-room-link') as HTMLButtonElement;
      copyLinkBtn.onclick = () => {
        const base = `${window.location.origin}${window.location.pathname}`;
        void copyTextFromSource(copyLinkBtn, null, `${base}#wlan-room=${currentRoomCode}`);
      };

      void activatePrivateRoom(currentRoomCode);
    }
  }

  // ==================== JALUR 2: TANPA INTERNET (OFFLINE MURNI QR / TEKS) ====================

  function renderOfflineView() {
    discoveryGen++;
    cleanupWebRtcSession();
    void cleanupSignaling();

    let offlineRole: 'host' | 'join' = 'host';

    mainBody.innerHTML = `
      <div class="alert alert-info">
        <span aria-hidden="true">📵</span>
        <div><strong>100% Tanpa Internet:</strong> Hubungkan perangkat di router/hotspot lokal yang sama lewat scan QR berbalas.</div>
      </div>

      <div class="role-switch" role="tablist" aria-label="Peran Mode Tanpa Internet" style="margin-bottom:12px;">
        <button id="off-host-btn" type="button" role="tab" aria-selected="true" class="btn btn-primary">1. Saya Pengirim</button>
        <button id="off-join-btn" type="button" role="tab" aria-selected="false" class="btn">2. Saya Penerima</button>
      </div>

      <div id="off-body"></div>
    `;

    const offBody = document.getElementById('off-body')!;
    const hostBtn = document.getElementById('off-host-btn') as HTMLButtonElement;
    const joinBtn = document.getElementById('off-join-btn') as HTMLButtonElement;

    const mountHost = async () => {
      offlineRole = 'host';
      hostBtn.classList.add('btn-primary');
      hostBtn.setAttribute('aria-selected', 'true');
      joinBtn.classList.remove('btn-primary');
      joinBtn.setAttribute('aria-selected', 'false');

      cleanupWebRtcSession();
      const mySessionGen = sessionGen;

      const pc = createPeerConnectionForMode('wlan-offline');
      activePc = pc;
      const dc = pc.createDataChannel('thinksend-wlan-offline-e2ee', { ordered: true });
      const session = new E2eeDataSession(dc, true);
      activeSession = session;

      offBody.innerHTML = `
        <div id="off-host-steps" class="offline-qr-panel">
          <div class="qr-stage" style="padding:14px;">
            <div style="font-size:0.84rem;font-weight:700;color:var(--text-strong);margin-bottom:4px;">Langkah 1 &bull; Minta Penerima Scan QR Ini</div>
            <canvas id="off-offer-qr" style="max-width:220px;border-radius:10px;"></canvas>
            <div id="off-offer-status" style="font-size:0.75rem;color:var(--muted);">Menyiapkan kode jaringan lokal...</div>
          </div>

          <button id="off-scan-answer-btn" type="button" class="btn btn-primary" style="width:100%;margin-top:10px;" disabled>
            📷 Langkah 2 &bull; Scan QR Balasan dari Penerima
          </button>

          <details class="advanced-box" style="margin-top:10px;">
            <summary>Atau Salin &amp; Tempel Teks Manual</summary>
            <div class="input-group" style="margin-top:8px;">
              <div class="field-head">
                <label for="off-offer-txt">Kode Offer Anda:</label>
                ${renderCopyControlHtml({
                  id: 'off-copy-offer',
                  targetId: 'off-offer-txt',
                  label: 'Salin',
                  className: 'mini-btn',
                })}
              </div>
              <textarea id="off-offer-txt" rows="2" readonly placeholder="Menyiapkan..."></textarea>
            </div>
            <div class="input-group">
              <div class="field-head">
                <label for="off-answer-in">Tempel Kode Balasan dari Penerima:</label>
                <button id="off-paste-answer" type="button" class="mini-link-btn">Tempel</button>
              </div>
              <textarea id="off-answer-in" rows="2" placeholder="Tempel kode balasan di sini..."></textarea>
            </div>
            <button id="off-manual-connect" type="button" class="btn" style="width:100%;">Hubungkan</button>
          </details>
        </div>

        <div id="off-err-box" style="margin-top:10px;"></div>
        <div id="off-transfer-area" style="margin-top:10px;"></div>
      `;

      const stepsEl = document.getElementById('off-host-steps')!;
      const errBox = document.getElementById('off-err-box')!;
      const transferArea = document.getElementById('off-transfer-area')!;
      const answerIn = document.getElementById('off-answer-in') as HTMLTextAreaElement;
      const scanAnswerBtn = document.getElementById('off-scan-answer-btn') as HTMLButtonElement;

      let answerApplied = false;

      const applyAnswer = async (encoded: string) => {
        errBox.innerHTML = '';
        if (answerApplied) return;
        const desc = await parseCompactSdp(encoded, 'answer');
        if (destroyed || pc !== activePc) return;
        answerApplied = true;
        bindSessionUi(
          transferArea,
          pc,
          session,
          'sender',
          [],
          mySessionGen,
          () => void mountHost(),
          { setupStepsEl: stepsEl, hideOfflineSwitch: true }
        );
        await pc.setRemoteDescription(desc);
      };

      pc.onconnectionstatechange = () => {
        if (pc === activePc && pc.connectionState === 'failed' && dc.readyState !== 'open') {
          errBox.innerHTML = `
            <div class="alert alert-warning">
              <span aria-hidden="true">⚠️</span>
              <div>Koneksi lokal gagal. Pastikan kedua perangkat di Wi-Fi / hotspot yang sama dan coba buat Offer baru.</div>
            </div>
          `;
        }
      };

      document.getElementById('off-paste-answer')!.onclick = () => {
        void pasteFromClipboardToField(answerIn, errBox);
      };

      scanAnswerBtn.onclick = async () => {
        const scanned = await scanQrWithCamera({
          title: 'Scan QR Balasan Penerima',
          hint: 'Arahkan kamera ke QR Balasan di layar penerima.',
        });
        if (!scanned) return;
        try {
          await applyAnswer(scanned);
        } catch (err) {
          answerApplied = false;
          errBox.innerHTML = `<div class="alert alert-warning"><span aria-hidden="true">⚠️</span><div>${escapeHtml((err as Error).message)}</div></div>`;
        }
      };

      document.getElementById('off-manual-connect')!.onclick = async () => {
        try {
          await applyAnswer(answerIn.value);
        } catch (err) {
          answerApplied = false;
          errBox.innerHTML = `<div class="alert alert-warning"><span aria-hidden="true">⚠️</span><div>${escapeHtml((err as Error).message)}</div></div>`;
        }
      };

      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        const localDesc = await gatherIceDescription(pc, 2000);
        if (destroyed || activeView !== 'offline' || offlineRole !== 'host' || pc !== activePc) return;
        const compact = await encodeCompactPayload(JSON.stringify(localDesc));

        const qrCanvas = document.getElementById('off-offer-qr') as HTMLCanvasElement | null;
        const statusEl = document.getElementById('off-offer-status');
        const txtEl = document.getElementById('off-offer-txt') as HTMLTextAreaElement | null;
        if (qrCanvas) await drawQrCanvas(qrCanvas, compact, 210);
        if (txtEl) txtEl.value = compact;
        if (statusEl) statusEl.textContent = `QR Offer siap (${compact.length} karakter ringkas)`;
        scanAnswerBtn.disabled = false;
      } catch (err) {
        const statusEl = document.getElementById('off-offer-status');
        if (statusEl) statusEl.textContent = `Gagal membuat Offer: ${(err as Error).message}`;
      }
    };

    const mountJoin = () => {
      offlineRole = 'join';
      joinBtn.classList.add('btn-primary');
      joinBtn.setAttribute('aria-selected', 'true');
      hostBtn.classList.remove('btn-primary');
      hostBtn.setAttribute('aria-selected', 'false');

      cleanupWebRtcSession();
      const mySessionGen = sessionGen;

      const pc = createPeerConnectionForMode('wlan-offline');
      activePc = pc;

      offBody.innerHTML = `
        <div id="off-join-steps" class="offline-qr-panel">
          <div class="pin-config-bar" style="margin-bottom:10px;">
            <label class="pin-toggle" style="color:var(--text);">
              <input id="off-pin-check" type="checkbox" ${requirePin ? 'checked' : ''} />
              <span>🔒 Wajibkan PIN 4 Digit</span>
            </label>
            <label for="off-pin-val" class="visually-hidden">PIN Keamanan</label>
            <input id="off-pin-val" type="text" inputmode="numeric" maxlength="8" value="${escapeHtml(receiverPin)}" ${requirePin ? '' : 'hidden'} />
          </div>

          <button id="off-scan-offer-btn" type="button" class="btn btn-primary" style="width:100%;">
            📷 Langkah 1 &bull; Scan QR dari Pengirim
          </button>

          <div id="off-answer-qr-stage" class="qr-stage" style="padding:14px;margin-top:10px;" hidden>
            <div style="font-size:0.84rem;font-weight:700;color:var(--text-strong);margin-bottom:4px;">Langkah 2 &bull; Tunjukkan QR Balasan Ini ke Pengirim</div>
            <canvas id="off-answer-qr" style="max-width:220px;border-radius:10px;"></canvas>
            <div style="font-size:0.75rem;color:var(--muted);">Tunggu pengirim selesai memindai QR ini...</div>
          </div>

          <details class="advanced-box" style="margin-top:10px;">
            <summary>Atau Salin &amp; Tempel Teks Manual</summary>
            <div class="input-group" style="margin-top:8px;">
              <div class="field-head">
                <label for="off-offer-in">Tempel Kode Offer dari Pengirim:</label>
                <button id="off-paste-offer" type="button" class="mini-link-btn">Tempel</button>
              </div>
              <textarea id="off-offer-in" rows="2" placeholder="Tempel kode Offer di sini..."></textarea>
            </div>
            <button id="off-manual-gen-answer" type="button" class="btn" style="width:100%;margin-bottom:8px;">Buat Kode Balasan</button>
            <div class="input-group" style="margin-bottom:0;">
              <div class="field-head">
                <label for="off-answer-out">Salin Kode Balasan ini ke Pengirim:</label>
                ${renderCopyControlHtml({
                  id: 'off-copy-answer',
                  targetId: 'off-answer-out',
                  label: 'Salin',
                  className: 'mini-btn',
                })}
              </div>
              <textarea id="off-answer-out" rows="2" readonly placeholder="Kode Balasan akan muncul di sini..."></textarea>
            </div>
          </details>
        </div>

        <div id="off-err-box" style="margin-top:10px;"></div>
        <div id="off-transfer-area" style="margin-top:10px;"></div>
      `;

      const stepsEl = document.getElementById('off-join-steps')!;
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
      const offerIn = document.getElementById('off-offer-in') as HTMLTextAreaElement;
      let channelAttached = false;

      pc.onconnectionstatechange = () => {
        if (pc === activePc && pc.connectionState === 'failed' && !channelAttached) {
          errBox.innerHTML = `
            <div class="alert alert-warning">
              <span aria-hidden="true">⚠️</span>
              <div>Koneksi lokal gagal. Pastikan kedua perangkat berada di jaringan Wi-Fi / hotspot yang sama.</div>
            </div>
          `;
        }
      };

      pc.ondatachannel = (e) => {
        if (destroyed || pc !== activePc) return;
        channelAttached = true;
        const stage = document.getElementById('off-answer-qr-stage');
        if (stage) stage.hidden = true;
        const session = new E2eeDataSession(e.channel, false);
        activeSession = session;
        bindSessionUi(
          transferArea,
          pc,
          session,
          'receiver',
          [],
          mySessionGen,
          () => mountJoin(),
          { setupStepsEl: stepsEl, hideOfflineSwitch: true }
        );
      };

      const processOffer = async (encoded: string) => {
        errBox.innerHTML = '';
        const offerDesc = await parseCompactSdp(encoded, 'offer');
        await pc.setRemoteDescription(offerDesc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        const localDesc = await gatherIceDescription(pc, 2000);
        if (destroyed || activeView !== 'offline' || offlineRole !== 'join' || pc !== activePc) return;

        const compactAnswer = await encodeCompactPayload(JSON.stringify(localDesc));
        const stage = document.getElementById('off-answer-qr-stage')!;
        const qrCanvas = document.getElementById('off-answer-qr') as HTMLCanvasElement;
        const txtOut = document.getElementById('off-answer-out') as HTMLTextAreaElement;
        stage.hidden = false;
        await drawQrCanvas(qrCanvas, compactAnswer, 210);
        txtOut.value = compactAnswer;
      };

      document.getElementById('off-paste-offer')!.onclick = () => {
        void pasteFromClipboardToField(offerIn, errBox);
      };

      document.getElementById('off-scan-offer-btn')!.onclick = async () => {
        const scanned = await scanQrWithCamera({
          title: 'Scan QR dari Pengirim',
          hint: 'Arahkan kamera ke QR Offer di perangkat pengirim.',
        });
        if (!scanned) return;
        offerIn.value = scanned;
        try {
          await processOffer(scanned);
        } catch (err) {
          errBox.innerHTML = `<div class="alert alert-warning"><span aria-hidden="true">⚠️</span><div>${escapeHtml((err as Error).message)}</div></div>`;
        }
      };

      document.getElementById('off-manual-gen-answer')!.onclick = async () => {
        try {
          await processOffer(offerIn.value);
        } catch (err) {
          errBox.innerHTML = `<div class="alert alert-warning"><span aria-hidden="true">⚠️</span><div>${escapeHtml((err as Error).message)}</div></div>`;
        }
      };
    };

    hostBtn.onclick = () => {
      if (offlineRole === 'host') return;
      void mountHost();
    };
    joinBtn.onclick = () => {
      if (offlineRole === 'join') return;
      mountJoin();
    };
    void mountHost();
  }

  function renderCurrentView() {
    syncNavButtons();
    if (activeView === 'offline') {
      renderOfflineView();
    } else {
      renderAutoView(activeView);
    }
  }

  tabRadarBtn.onclick = () => {
    if (activeView === 'radar') return;
    activeView = 'radar';
    renderCurrentView();
  };

  tabRoomBtn.onclick = () => {
    if (activeView === 'room') return;
    activeView = 'room';
    renderCurrentView();
  };

  tabOfflineBtn.onclick = () => {
    if (activeView === 'offline') return;
    activeView = 'offline';
    renderCurrentView();
  };

  renderCurrentView();
  return cleanupAll;
}
