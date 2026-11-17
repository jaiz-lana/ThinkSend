import {
  decodeCompactPayload,
  encodeCompactPayload,
  formatBytes,
} from '../utils/crypto';
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
  const createdUrls: string[] = [];
  let destroyed = false;

  function cleanup() {
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
        Transfer Jaringan Provider (Internet P2P)
      </h2>
      <p class="desc">Kirim file jarak jauh melalui koneksi seluler/internet dengan enkripsi penuh <strong>End-to-End</strong> (WebRTC DTLS + ECDH AES-256-GCM + SHA-256).</p>

      <div class="role-switch">
        <button id="prov-host-btn" class="btn btn-primary" type="button">1. Buat Sesi (Pengirim)</button>
        <button id="prov-join-btn" class="btn" type="button">2. Gabung Sesi (Penerima)</button>
      </div>

      <div id="prov-body"></div>
    </div>
  `;

  const body = document.getElementById('prov-body')!;
  const hostBtn = document.getElementById('prov-host-btn') as HTMLButtonElement;
  const joinBtn = document.getElementById('prov-join-btn') as HTMLButtonElement;

  const setActiveRole = (isHost: boolean) => {
    hostBtn.classList.toggle('btn-primary', isHost);
    joinBtn.classList.toggle('btn-primary', !isHost);
  };

  function mountTransferUi(
    area: HTMLElement,
    activePc: RTCPeerConnection,
    activeSession: E2eeDataSession,
    role: 'sender' | 'receiver',
    resetFn: () => void
  ) {
    area.innerHTML = `
      <div class="e2ee-session-box">
        <div class="alert alert-info" id="prov-hs-status">
          <span>⏳</span>
          <div>Menunggu koneksi P2P jarak jauh terbuka...</div>
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

    const renderProgress = (info: TransferProgressInfo, prefix: string) => {
      const pct =
        info.totalBytes > 0 ? Math.min(100, Math.round((info.doneBytes / info.totalBytes) * 100)) : 100;
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
            <strong>${escapeHtml(prefix)}: ${escapeHtml(info.fileName)}</strong>
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
        const { sasCode } = await activeSession.negotiate({
          onChannelOpen: () => {
            hsStatus.innerHTML = `<span>🔐</span><div>Jalur terbuka! Menjalankan jabat tangan kunci <strong>ECDH P-256 + AES-256-GCM</strong>...</div>`;
          },
        });
        if (destroyed) return;

        const pathLabel = await detectIcePathLabel(activePc);
        hsStatus.className = 'alert alert-success';
        hsStatus.innerHTML = `
          <span>🛡️</span>
          <div>
            <strong>E2EE Aktif (${escapeHtml(pathLabel)})</strong><br />
            <span class="sas-row">Kode Verifikasi: <code class="sas-badge">${escapeHtml(sasCode)}</code></span>
          </div>
        `;

        if (role === 'sender') {
          readyArea.innerHTML = `
            <label class="file-drop" style="margin-top:8px;">
              <input type="file" id="prov-file-input" multiple />
              <span class="file-drop-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
              </span>
              <strong>Pilih Satu atau Banyak File</strong>
              <span class="subtitle" style="color:var(--muted);">Terenkripsi AES-256-GCM + verifikasi SHA-256</span>
            </label>
          `;
          const input = readyArea.querySelector('#prov-file-input') as HTMLInputElement;
          input.onchange = async () => {
            const files = input.files ? Array.from(input.files) : [];
            input.value = '';
            if (files.length === 0) return;
            try {
              await activeSession.sendFiles(files, (info) => renderProgress(info, 'Mengirim'));
              progressArea.innerHTML = `
                <div class="alert alert-success">
                  <span>✅</span>
                  <div><strong>${files.length} file terkirim</strong> &amp; terverifikasi SHA-256!</div>
                </div>
              `;
            } catch (err) {
              progressArea.innerHTML = `<div class="alert alert-warning">Gagal mengirim: ${escapeHtml((err as Error).message)}</div>`;
            }
          };
        } else {
          readyArea.innerHTML = `
            <div class="alert alert-info" style="margin-top:8px;">
              <span>📥</span>
              <div>Siap menerima file terenkripsi dari pengirim...</div>
            </div>
          `;
          void activeSession.listenForFiles({
            onProgress: (info) => renderProgress(info, 'Menerima'),
            onFileComplete: (res: ReceivedFileResult) => {
              createdUrls.push(res.url);
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
              progressArea.innerHTML = `<div class="alert alert-warning">${escapeHtml(err.message)}</div>`;
            },
          });
        }
      } catch (err) {
        if (destroyed) return;
        hsStatus.className = 'alert alert-warning';
        hsStatus.innerHTML = `<span>⚠️</span><div>${escapeHtml((err as Error).message)}</div>`;
        readyArea.innerHTML = `<button id="prov-reset-btn" type="button" class="btn" style="width:100%;">Ulangi Sesi</button>`;
        (readyArea.querySelector('#prov-reset-btn') as HTMLButtonElement).onclick = resetFn;
      }
    })();
  }

  const mountHost = async () => {
    setActiveRole(true);
    cleanup();
    pc = createPeerConnectionForMode('provider');
    const dc = pc.createDataChannel('thinksend-provider-e2ee', { ordered: true });
    session = new E2eeDataSession(dc, true);

    body.innerHTML = `
      <div class="input-group">
        <label>Kirim Kode Sesi Ringkas ini ke Penerima (via WhatsApp/Chat):</label>
        <textarea id="prov-offer-out" rows="3" readonly placeholder="Mengumpulkan rute jaringan..."></textarea>
      </div>
      <div class="input-group">
        <label>Tempel Kode Balasan dari Penerima:</label>
        <textarea id="prov-answer-in" rows="3" placeholder="Tempel kode balasan di sini..."></textarea>
      </div>
      <button id="prov-connect-btn" class="btn btn-primary" type="button" style="width:100%;">Hubungkan P2P</button>
      <div id="prov-err-box" style="margin-top:10px;"></div>
      <div id="prov-transfer-area" style="margin-top:10px;"></div>
    `;

    const errBox = document.getElementById('prov-err-box')!;
    const transferArea = document.getElementById('prov-transfer-area')!;
    mountTransferUi(transferArea, pc, session, 'sender', () => void mountHost());

    document.getElementById('prov-connect-btn')!.onclick = async () => {
      errBox.innerHTML = '';
      const raw = (document.getElementById('prov-answer-in') as HTMLTextAreaElement).value.trim();
      if (!raw || !pc) return;
      try {
        const desc = JSON.parse(await decodeCompactPayload(raw)) as RTCSessionDescriptionInit;
        await pc.setRemoteDescription(desc);
      } catch (err) {
        errBox.innerHTML = `<div class="alert alert-warning">Kode balasan tidak valid: ${escapeHtml((err as Error).message)}</div>`;
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const gathered = await gatherIceDescription(pc, 2800);
    if (destroyed) return;
    const compact = await encodeCompactPayload(JSON.stringify(gathered));
    const box = document.getElementById('prov-offer-out') as HTMLTextAreaElement | null;
    if (box) box.value = compact;
  };

  const mountJoin = () => {
    setActiveRole(false);
    cleanup();
    pc = createPeerConnectionForMode('provider');

    body.innerHTML = `
      <div class="input-group">
        <label>Tempel Kode Sesi dari Pengirim:</label>
        <textarea id="prov-offer-in" rows="3" placeholder="Tempel kode sesi di sini..."></textarea>
      </div>
      <button id="prov-gen-answer" class="btn btn-primary" type="button" style="width:100%;margin-bottom:12px;">Buat Kode Balasan</button>
      <div class="input-group">
        <label>Kirim Kode Balasan ini kembali ke Pengirim:</label>
        <textarea id="prov-answer-out" rows="3" readonly placeholder="Kode balasan akan muncul di sini..."></textarea>
      </div>
      <div id="prov-err-box" style="margin-top:10px;"></div>
      <div id="prov-transfer-area" style="margin-top:10px;"></div>
    `;

    const errBox = document.getElementById('prov-err-box')!;
    const transferArea = document.getElementById('prov-transfer-area')!;
    pc.ondatachannel = (e) => {
      session = new E2eeDataSession(e.channel, false);
      mountTransferUi(transferArea, pc!, session, 'receiver', mountJoin);
    };

    document.getElementById('prov-gen-answer')!.onclick = async () => {
      errBox.innerHTML = '';
      const raw = (document.getElementById('prov-offer-in') as HTMLTextAreaElement).value.trim();
      if (!raw || !pc) return;
      try {
        const remote = JSON.parse(await decodeCompactPayload(raw)) as RTCSessionDescriptionInit;
        await pc.setRemoteDescription(remote);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        const gathered = await gatherIceDescription(pc, 2800);
        if (destroyed) return;
        const compact = await encodeCompactPayload(JSON.stringify(gathered));
        const out = document.getElementById('prov-answer-out') as HTMLTextAreaElement | null;
        if (out) out.value = compact;
      } catch (err) {
        errBox.innerHTML = `<div class="alert alert-warning">Kode sesi tidak valid: ${escapeHtml((err as Error).message)}</div>`;
      }
    };
  };

  hostBtn.onclick = () => void mountHost();
  joinBtn.onclick = () => mountJoin();
  void mountHost();

  return destroyAll;
}
