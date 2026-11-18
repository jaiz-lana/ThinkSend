import {
  encodeCompactPayload,
  formatBytes,
  parseCompactSdp,
} from '../utils/crypto';
import {
  pasteFromClipboardToField,
  renderCopyControlHtml,
  setupDropZone,
} from '../utils/copy';
import { scanQrWithCamera, showQrCodeModal } from '../utils/qrModal';
import {
  createPeerConnectionForMode,
  detectIcePathLabel,
  E2eeDataSession,
  escapeHtml,
  gatherIceDescription,
  type ReceivedFileResult,
  type TransferProgressInfo,
} from '../utils/webrtcTransfer';

export function renderProviderMode(container: HTMLElement): () => void {
  let pc: RTCPeerConnection | null = null;
  let session: E2eeDataSession | null = null;
  let roleMode: 'host' | 'join' = 'host';
  let sessionGen = 0;
  let connectWatchdogTimer: number | null = null;
  let cleanupDrop: (() => void) | null = null;
  const createdUrls: string[] = [];
  let destroyed = false;

  function clearWatchdog() {
    if (connectWatchdogTimer !== null) {
      clearTimeout(connectWatchdogTimer);
      connectWatchdogTimer = null;
    }
  }

  function cleanup() {
    sessionGen++;
    clearWatchdog();
    cleanupDrop?.();
    cleanupDrop = null;
    session?.close();
    pc?.close();
    session = null;
    pc = null;
  }

  function destroyAll() {
    destroyed = true;
    cleanup();
    while (createdUrls.length > 0) {
      const u = createdUrls.pop();
      if (u) URL.revokeObjectURL(u);
    }
  }

  container.innerHTML = `
    <div class="card">
      <h2>
        <span class="card-title-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="9.5" />
            <path d="M2.5 12h19" />
            <path d="M12 2.5a14.5 14.5 0 0 1 0 19 14.5 14.5 0 0 1 0-19Z" />
          </svg>
        </span>
        Transfer Internet (Provider P2P)
      </h2>
      <p class="desc">Kirim file langsung antar perangkat lewat internet atau data seluler tanpa unggah ke server mana pun.</p>

      <div class="role-switch" role="tablist" aria-label="Peran Transfer Internet">
        <button id="prov-host-btn" class="btn btn-primary" type="button" role="tab" aria-selected="true">
          1. Saya Pengirim
        </button>
        <button id="prov-join-btn" class="btn" type="button" role="tab" aria-selected="false">
          2. Saya Penerima
        </button>
      </div>

      <div id="prov-body"></div>

      <details class="advanced-box">
        <summary>Cara Kerja &amp; Keamanan End-to-End</summary>
        <p>
          <strong>Langkah singkat:</strong> Pengirim menyalin <strong>Kode Sesi</strong> lalu mengirimkannya via WhatsApp/chat ke Penerima &rarr; Penerima menempelkannya untuk membuat <strong>Kode Balasan</strong> &rarr; Pengirim menempel Kode Balasan untuk membuka terowongan langsung. Data terenkripsi penuh WebRTC DTLS + ECDH P-256 AES-256-GCM + verifikasi SHA-256.
        </p>
      </details>
    </div>
  `;

  const body = document.getElementById('prov-body')!;
  const hostBtn = document.getElementById('prov-host-btn') as HTMLButtonElement;
  const joinBtn = document.getElementById('prov-join-btn') as HTMLButtonElement;

  const setActiveRole = (isHost: boolean) => {
    roleMode = isHost ? 'host' : 'join';
    hostBtn.classList.toggle('btn-primary', isHost);
    hostBtn.setAttribute('aria-selected', String(isHost));
    joinBtn.classList.toggle('btn-primary', !isHost);
    joinBtn.setAttribute('aria-selected', String(!isHost));
  };

  function mountTransferUi(
    area: HTMLElement,
    setupStepsEl: HTMLElement | null,
    activePc: RTCPeerConnection,
    activeSession: E2eeDataSession,
    role: 'sender' | 'receiver',
    myGen: number,
    resetFn: () => void
  ) {
    area.innerHTML = `
      <div class="e2ee-session-box">
        <div class="alert alert-info" id="prov-hs-status">
          <span aria-hidden="true">⏳</span>
          <div>Menghubungkan perangkat langsung...</div>
        </div>
        <div id="prov-session-ready"></div>
        <div id="prov-progress-list"></div>
        <div id="prov-received-list"></div>
      </div>
    `;

    const hsStatus = area.querySelector('#prov-hs-status') as HTMLElement;
    const readyArea = area.querySelector('#prov-session-ready') as HTMLElement;
    const progressArea = area.querySelector('#prov-progress-list') as HTMLElement;
    const receivedArea = area.querySelector('#prov-received-list') as HTMLElement;
    let receivedCount = 0;

    readyArea.innerHTML = `
      <button id="prov-cancel-conn-btn" type="button" class="btn" style="width:100%;">Batalkan / Buat Sesi Baru</button>
    `;
    (readyArea.querySelector('#prov-cancel-conn-btn') as HTMLButtonElement).onclick = () => {
      cleanup();
      resetFn();
    };

    const renderProgress = (info: TransferProgressInfo, prefix: string) => {
      const pct =
        info.totalBytes > 0 ? Math.min(100, Math.round((info.doneBytes / info.totalBytes) * 100)) : 100;
      const phaseText =
        info.phase === 'hashing'
          ? 'Menyiapkan verifikasi SHA-256...'
          : info.phase === 'verifying'
            ? 'Memverifikasi integritas SHA-256...'
            : `${formatBytes(info.doneBytes)} / ${formatBytes(info.totalBytes)}`;
      const speedText =
        info.phase === 'transferring' && info.speedBps > 0 ? `${formatBytes(info.speedBps)}/dtk` : '';

      progressArea.innerHTML = `
        <div class="transfer-progress-card">
          <div class="transfer-meta-row">
            <strong>${escapeHtml(prefix)}: ${escapeHtml(info.fileName)}</strong>
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

    clearWatchdog();
    connectWatchdogTimer = window.setTimeout(() => {
      if (destroyed || myGen !== sessionGen) return;
      if (activePc.connectionState !== 'connected') {
        hsStatus.className = 'alert alert-warning';
        hsStatus.innerHTML = `
          <span aria-hidden="true">⚠️</span>
          <div>
            Koneksi P2P belum tersambung (&gt;15 detik). Kemungkinan jaringan memakai firewall/NAT ketat (CGNAT). Anda dapat menunggu atau membuat sesi baru.
          </div>
        `;
      }
    }, 15_000);

    void (async () => {
      try {
        const { sasCode } = await activeSession.negotiate({
          onChannelOpen: () => {
            if (destroyed || myGen !== sessionGen) return;
            clearWatchdog();
            hsStatus.innerHTML = `<span aria-hidden="true">🔐</span><div>Saluran terbuka! Mengamankan koneksi End-to-End...</div>`;
          },
        });
        if (destroyed || myGen !== sessionGen) return;
        clearWatchdog();

        if (setupStepsEl) setupStepsEl.hidden = true;

        const pathLabel = await detectIcePathLabel(activePc);
        if (destroyed || myGen !== sessionGen) return;

        hsStatus.className = 'alert alert-success';
        hsStatus.innerHTML = `
          <span aria-hidden="true">🛡️</span>
          <div>
            <strong>Terhubung Aman (${escapeHtml(pathLabel)})</strong><br />
            <span class="sas-row">Kode Cocok: <code class="sas-badge">${escapeHtml(sasCode)}</code></span>
          </div>
        `;

        if (role === 'sender') {
          const handleFiles = async (files: File[]) => {
            if (files.length === 0) return;
            try {
              await activeSession.sendFiles(files, (info) => renderProgress(info, 'Mengirim'));
              if (destroyed || myGen !== sessionGen) return;
              progressArea.innerHTML = `
                <div class="alert alert-success" role="status">
                  <span aria-hidden="true">✅</span>
                  <div><strong>${files.length} file terkirim</strong> &amp; terverifikasi SHA-256!</div>
                </div>
              `;
            } catch (err) {
              if (destroyed || myGen !== sessionGen) return;
              progressArea.innerHTML = `<div class="alert alert-warning">Gagal mengirim: ${escapeHtml((err as Error).message)}</div>`;
            }
          };

          readyArea.innerHTML = `
            <label class="file-drop" id="prov-dropzone" style="margin-top:4px;">
              <input type="file" id="prov-file-input" multiple />
              <span class="file-drop-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
              </span>
              <strong>Pilih atau Seret File ke Sini</strong>
              <span class="subtitle" style="color:var(--muted);">Terenkripsi End-to-End sebelum dikirim</span>
            </label>
            <button id="prov-close-btn" type="button" class="btn" style="width:100%;margin-top:6px;">Putuskan &amp; Sesi Baru</button>
          `;

          const input = readyArea.querySelector('#prov-file-input') as HTMLInputElement;
          const dropEl = readyArea.querySelector('#prov-dropzone') as HTMLElement;
          input.onchange = () => {
            const files = input.files ? Array.from(input.files) : [];
            input.value = '';
            void handleFiles(files);
          };
          cleanupDrop = setupDropZone(dropEl, (files) => void handleFiles(files));
          (readyArea.querySelector('#prov-close-btn') as HTMLButtonElement).onclick = () => {
            cleanup();
            resetFn();
          };
        } else {
          readyArea.innerHTML = `
            <div class="alert alert-info" style="margin-top:4px;">
              <span aria-hidden="true">📥</span>
              <div>Siap menerima file dari pengirim...</div>
            </div>
            <button id="prov-close-btn" type="button" class="btn" style="width:100%;margin-top:6px;">Putuskan &amp; Sesi Baru</button>
          `;
          (readyArea.querySelector('#prov-close-btn') as HTMLButtonElement).onclick = () => {
            cleanup();
            resetFn();
          };

          void activeSession.listenForFiles({
            onProgress: (info) => renderProgress(info, 'Menerima'),
            onFileComplete: (res: ReceivedFileResult) => {
              createdUrls.push(res.url);
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
                  <span>${escapeHtml(formatBytes(res.size))} • ${res.verified ? 'Terverifikasi' : 'Hash Tidak Cocok'}</span>
                </div>
                <a class="btn btn-success" href="${res.url}" download="${escapeHtml(res.name)}" style="text-decoration:none;">
                  💾 Simpan
                </a>
              `;
              receivedArea.prepend(item);
            },
            onRemoteClose: () => {
              if (destroyed || myGen !== sessionGen) return;
              hsStatus.className = 'alert alert-info';
              hsStatus.innerHTML = `<span aria-hidden="true">ℹ️</span><div>${
                receivedCount > 0
                  ? 'Sesi ditutup pengirim. File di bawah tetap bisa disimpan.'
                  : 'Sesi ditutup oleh pengirim.'
              }</div>`;
            },
            onError: (err) => {
              if (destroyed || myGen !== sessionGen) return;
              progressArea.innerHTML = `<div class="alert alert-warning">${escapeHtml(err.message)}</div>`;
            },
          });
        }
      } catch (err) {
        if (destroyed || myGen !== sessionGen) return;
        clearWatchdog();
        hsStatus.className = 'alert alert-warning';
        hsStatus.innerHTML = `<span aria-hidden="true">⚠️</span><div>${escapeHtml((err as Error).message)}</div>`;
        readyArea.innerHTML = `<button id="prov-reset-btn" type="button" class="btn" style="width:100%;">Buat Sesi Baru</button>`;
        (readyArea.querySelector('#prov-reset-btn') as HTMLButtonElement).onclick = () => {
          cleanup();
          resetFn();
        };
      }
    })();
  }

  const mountHost = async () => {
    setActiveRole(true);
    cleanup();
    const myGen = sessionGen;
    const localPc = createPeerConnectionForMode('provider');
    pc = localPc;
    const dc = localPc.createDataChannel('thinksend-provider-e2ee', { ordered: true });
    const localSession = new E2eeDataSession(dc, true);
    session = localSession;

    let answerApplied = false;

    body.innerHTML = `
      <div id="prov-setup-steps">
        <div class="input-group">
          <div class="field-head">
            <label for="prov-offer-out">Langkah 1 &bull; Kirim Kode Sesi ini ke Penerima:</label>
            <div class="field-actions">
              ${renderCopyControlHtml({
                id: 'prov-copy-offer',
                targetId: 'prov-offer-out',
                label: 'Salin Kode',
                className: 'mini-btn',
              })}
              <button id="prov-qr-offer" type="button" class="mini-link-btn" disabled>QR</button>
            </div>
          </div>
          <textarea id="prov-offer-out" rows="3" readonly placeholder="Menyiapkan kode sesi jaringan..."></textarea>
        </div>

        <div class="input-group">
          <div class="field-head">
            <label for="prov-answer-in">Langkah 2 &bull; Tempel Kode Balasan dari Penerima:</label>
            <div class="field-actions">
              <button id="prov-paste-answer" type="button" class="mini-link-btn">Tempel</button>
              <button id="prov-scan-answer" type="button" class="mini-link-btn">📷 Scan QR</button>
            </div>
          </div>
          <textarea id="prov-answer-in" rows="3" placeholder="Tempel kode balasan di sini..."></textarea>
        </div>

        <button id="prov-connect-btn" class="btn btn-primary" type="button" style="width:100%;">Hubungkan Perangkat</button>
      </div>
      <div id="prov-err-box" style="margin-top:10px;"></div>
      <div id="prov-transfer-area" style="margin-top:10px;"></div>
    `;

    const setupStepsEl = document.getElementById('prov-setup-steps')!;
    const errBox = document.getElementById('prov-err-box')!;
    const transferArea = document.getElementById('prov-transfer-area')!;
    const answerIn = document.getElementById('prov-answer-in') as HTMLTextAreaElement;
    const qrOfferBtn = document.getElementById('prov-qr-offer') as HTMLButtonElement;
    const connectBtn = document.getElementById('prov-connect-btn') as HTMLButtonElement;

    const connectWithAnswer = async (raw: string) => {
      errBox.innerHTML = '';
      if (answerApplied) {
        errBox.innerHTML = `<div class="alert alert-info">Koneksi sedang berjalan. Gunakan <strong>Batalkan / Buat Sesi Baru</strong> jika ingin mengulang.</div>`;
        return;
      }
      const desc = await parseCompactSdp(raw, 'answer');
      if (destroyed || myGen !== sessionGen) return;
      answerApplied = true;
      connectBtn.disabled = true;
      mountTransferUi(transferArea, setupStepsEl, localPc, localSession, 'sender', myGen, () => {
        void mountHost();
      });
      await localPc.setRemoteDescription(desc);
    };

    document.getElementById('prov-paste-answer')!.onclick = () => {
      void pasteFromClipboardToField(answerIn, errBox);
    };

    document.getElementById('prov-scan-answer')!.onclick = async () => {
      const scanned = await scanQrWithCamera({
        title: 'Scan QR Kode Balasan',
        hint: 'Arahkan kamera ke QR Balasan di layar penerima.',
      });
      if (!scanned || destroyed || myGen !== sessionGen) return;
      answerIn.value = scanned;
      try {
        await connectWithAnswer(scanned);
      } catch (err) {
        answerApplied = false;
        connectBtn.disabled = false;
        errBox.innerHTML = `<div class="alert alert-warning"><span aria-hidden="true">⚠️</span><div>${escapeHtml((err as Error).message)}</div></div>`;
      }
    };

    connectBtn.onclick = async () => {
      try {
        await connectWithAnswer(answerIn.value);
      } catch (err) {
        answerApplied = false;
        connectBtn.disabled = false;
        errBox.innerHTML = `<div class="alert alert-warning"><span aria-hidden="true">⚠️</span><div>${escapeHtml((err as Error).message)}</div></div>`;
      }
    };

    try {
      const offer = await localPc.createOffer();
      await localPc.setLocalDescription(offer);
      const gathered = await gatherIceDescription(localPc, 2800);
      if (destroyed || myGen !== sessionGen || roleMode !== 'host') return;
      const compact = await encodeCompactPayload(JSON.stringify(gathered));
      const box = document.getElementById('prov-offer-out') as HTMLTextAreaElement | null;
      if (box) box.value = compact;
      qrOfferBtn.disabled = false;
      qrOfferBtn.onclick = () => {
        void showQrCodeModal({
          title: 'QR Kode Sesi (Offer)',
          subtitle: 'Minta penerima memindai QR ini dari menu Provider → Saya Penerima',
          payload: compact,
        });
      };
    } catch (err) {
      if (destroyed || myGen !== sessionGen) return;
      errBox.innerHTML = `<div class="alert alert-warning">Gagal menyiapkan sesi jaringan: ${escapeHtml((err as Error).message)}</div>`;
    }
  };

  const mountJoin = () => {
    setActiveRole(false);
    cleanup();
    const myGen = sessionGen;
    const localPc = createPeerConnectionForMode('provider');
    pc = localPc;

    body.innerHTML = `
      <div id="prov-setup-steps">
        <div class="input-group">
          <div class="field-head">
            <label for="prov-offer-in">Langkah 1 &bull; Tempel Kode Sesi dari Pengirim:</label>
            <div class="field-actions">
              <button id="prov-paste-offer" type="button" class="mini-link-btn">Tempel</button>
              <button id="prov-scan-offer" type="button" class="mini-link-btn">📷 Scan QR</button>
            </div>
          </div>
          <textarea id="prov-offer-in" rows="3" placeholder="Tempel kode sesi di sini..."></textarea>
        </div>

        <button id="prov-gen-answer" class="btn btn-primary" type="button" style="width:100%;margin-bottom:12px;">Buat Kode Balasan</button>

        <div id="prov-answer-step" class="input-group" hidden>
          <div class="field-head">
            <label for="prov-answer-out">Langkah 2 &bull; Kirim Kode Balasan ini ke Pengirim:</label>
            <div class="field-actions">
              ${renderCopyControlHtml({
                id: 'prov-copy-answer',
                targetId: 'prov-answer-out',
                label: 'Salin Balasan',
                className: 'mini-btn',
              })}
              <button id="prov-qr-answer" type="button" class="mini-link-btn">QR</button>
            </div>
          </div>
          <textarea id="prov-answer-out" rows="3" readonly></textarea>
        </div>
      </div>

      <div id="prov-err-box" style="margin-top:10px;"></div>
      <div id="prov-transfer-area" style="margin-top:10px;"></div>
    `;

    const setupStepsEl = document.getElementById('prov-setup-steps')!;
    const errBox = document.getElementById('prov-err-box')!;
    const transferArea = document.getElementById('prov-transfer-area')!;
    const offerIn = document.getElementById('prov-offer-in') as HTMLTextAreaElement;
    const answerStep = document.getElementById('prov-answer-step')!;
    const genBtn = document.getElementById('prov-gen-answer') as HTMLButtonElement;

    localPc.ondatachannel = (e) => {
      if (destroyed || myGen !== sessionGen) return;
      const localSession = new E2eeDataSession(e.channel, false);
      session = localSession;
      mountTransferUi(transferArea, setupStepsEl, localPc, localSession, 'receiver', myGen, mountJoin);
    };

    const generateFromOffer = async (raw: string) => {
      errBox.innerHTML = '';
      genBtn.disabled = true;
      genBtn.textContent = 'Menyiapkan balasan...';
      try {
        const remote = await parseCompactSdp(raw, 'offer');
        await localPc.setRemoteDescription(remote);
        const answer = await localPc.createAnswer();
        await localPc.setLocalDescription(answer);
        const gathered = await gatherIceDescription(localPc, 2800);
        if (destroyed || myGen !== sessionGen || roleMode !== 'join') return;
        const compact = await encodeCompactPayload(JSON.stringify(gathered));
        const out = document.getElementById('prov-answer-out') as HTMLTextAreaElement;
        out.value = compact;
        answerStep.hidden = false;
        genBtn.textContent = 'Kode Balasan Siap!';
        document.getElementById('prov-qr-answer')!.onclick = () => {
          void showQrCodeModal({
            title: 'QR Kode Balasan (Answer)',
            subtitle: 'Minta pengirim memindai QR ini untuk menyambungkan transfer',
            payload: compact,
          });
        };
      } catch (err) {
        genBtn.disabled = false;
        genBtn.textContent = 'Buat Kode Balasan';
        errBox.innerHTML = `<div class="alert alert-warning"><span aria-hidden="true">⚠️</span><div>${escapeHtml((err as Error).message)}</div></div>`;
      }
    };

    document.getElementById('prov-paste-offer')!.onclick = () => {
      void pasteFromClipboardToField(offerIn, errBox);
    };

    document.getElementById('prov-scan-offer')!.onclick = async () => {
      const scanned = await scanQrWithCamera({
        title: 'Scan QR Kode Sesi',
        hint: 'Arahkan kamera ke QR Kode Sesi di layar pengirim.',
      });
      if (!scanned || destroyed || myGen !== sessionGen) return;
      offerIn.value = scanned;
      await generateFromOffer(scanned);
    };

    genBtn.onclick = () => void generateFromOffer(offerIn.value);
  };

  hostBtn.onclick = () => {
    if (roleMode === 'host') return;
    void mountHost();
  };
  joinBtn.onclick = () => {
    if (roleMode === 'join') return;
    mountJoin();
  };
  void mountHost();

  return destroyAll;
}
