import { formatBytes } from '../utils/crypto';

export function renderWlanMode(container: HTMLElement): () => void {
  let pc: RTCPeerConnection | null = null;
  let dc: RTCDataChannel | null = null;

  function cleanup() {
    dc?.close();
    pc?.close();
    dc = null;
    pc = null;
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
      <p class="desc">Transfer super cepat antar perangkat di jaringan Wi-Fi yang sama menggunakan WebRTC DataChannel (tanpa kuota internet).</p>

      <div class="alert alert-info">
        <span>💡</span>
        <div><strong>Cara Kerja:</strong> Pengirim membuat <em>Offer</em>, Penerima menempelkan <em>Offer</em> untuk membuat <em>Answer</em>, lalu Pengirim menempelkan <em>Answer</em>. Setelah terhubung, kirim file secepat kecepatan Wi-Fi!</div>
      </div>

      <div class="role-switch">
        <button id="wlan-host-btn" class="btn btn-primary">1. Buat Koneksi (Pengirim)</button>
        <button id="wlan-join-btn" class="btn">2. Gabung Koneksi (Penerima)</button>
      </div>

      <div id="wlan-body"></div>
    </div>
  `;

  const body = document.getElementById('wlan-body')!;
  const hostBtn = document.getElementById('wlan-host-btn') as HTMLButtonElement;
  const joinBtn = document.getElementById('wlan-join-btn') as HTMLButtonElement;

  const setActiveRole = (isHost: boolean) => {
    hostBtn.classList.toggle('btn-primary', isHost);
    joinBtn.classList.toggle('btn-primary', !isHost);
  };
  setActiveRole(true);

  hostBtn.onclick = async () => {
    setActiveRole(true);
    cleanup();
    pc = new RTCPeerConnection({ iceServers: [] }); // Local WLAN only
    dc = pc.createDataChannel('thinksend-wlan', { ordered: true });
    setupDataChannel(dc, body, true);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    pc.onicecandidate = () => {
      if (pc?.iceGatheringState === 'complete') {
        const offerBox = document.getElementById('wlan-offer-out') as HTMLTextAreaElement;
        if (offerBox) offerBox.value = btoa(JSON.stringify(pc.localDescription));
      }
    };

    body.innerHTML = `
      <div class="input-group">
        <label>Salin Kode Offer ini ke Perangkat Penerima:</label>
        <textarea id="wlan-offer-out" rows="3" readonly placeholder="Menyiapkan kode lokal..."></textarea>
      </div>
      <div class="input-group">
        <label>Tempel Kode Answer dari Penerima:</label>
        <textarea id="wlan-answer-in" rows="3" placeholder="Tempel kode Answer di sini..."></textarea>
      </div>
      <button id="wlan-connect-btn" class="btn btn-primary" style="width:100%;">Hubungkan WLAN</button>
      <div id="wlan-transfer-area" style="margin-top:14px;"></div>
    `;

    document.getElementById('wlan-connect-btn')!.onclick = async () => {
      const raw = (document.getElementById('wlan-answer-in') as HTMLTextAreaElement).value.trim();
      if (!raw || !pc) return;
      await pc.setRemoteDescription(JSON.parse(atob(raw)));
    };
  };

  joinBtn.onclick = () => {
    setActiveRole(false);
    cleanup();
    pc = new RTCPeerConnection({ iceServers: [] });
    pc.ondatachannel = (e) => {
      dc = e.channel;
      setupDataChannel(dc, body, false);
    };

    body.innerHTML = `
      <div class="input-group">
        <label>Tempel Kode Offer dari Pengirim:</label>
        <textarea id="wlan-offer-in" rows="3" placeholder="Tempel kode Offer di sini..."></textarea>
      </div>
      <button id="wlan-gen-answer" class="btn btn-primary" style="width:100%;margin-bottom:12px;">Buat Kode Answer</button>
      <div class="input-group">
        <label>Salin Kode Answer ini kembali ke Pengirim:</label>
        <textarea id="wlan-answer-out" rows="3" readonly placeholder="Kode Answer akan muncul di sini..."></textarea>
      </div>
      <div id="wlan-transfer-area" style="margin-top:14px;"></div>
    `;

    document.getElementById('wlan-gen-answer')!.onclick = async () => {
      const raw = (document.getElementById('wlan-offer-in') as HTMLTextAreaElement).value.trim();
      if (!raw || !pc) return;
      await pc.setRemoteDescription(JSON.parse(atob(raw)));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      pc.onicecandidate = () => {
        if (pc?.iceGatheringState === 'complete') {
          const out = document.getElementById('wlan-answer-out') as HTMLTextAreaElement;
          if (out) out.value = btoa(JSON.stringify(pc.localDescription));
        }
      };
    };
  };

  return cleanup;
}

function setupDataChannel(dc: RTCDataChannel, _container: HTMLElement, isSender: boolean) {
  dc.binaryType = 'arraybuffer';
  let incomingMeta: { name: string; size: number } | null = null;
  let chunks: ArrayBuffer[] = [];
  let receivedBytes = 0;

  dc.onopen = () => {
    const area = document.getElementById('wlan-transfer-area');
    if (!area) return;
    if (isSender) {
      area.innerHTML = `
        <div class="alert alert-success">✅ Terhubung via WLAN! Siap mengirim file.</div>
        <label class="file-drop">
          <input type="file" id="wlan-file-input" />
          <span class="file-drop-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
          </span>
          <strong>Pilih File untuk Dikirim via WLAN</strong>
        </label>
        <div id="wlan-progress"></div>
      `;
      const input = document.getElementById('wlan-file-input') as HTMLInputElement;
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        dc.send(JSON.stringify({ name: file.name, size: file.size }));
        const buf = await file.arrayBuffer();
        const chunkSize = 64 * 1024;
        for (let i = 0; i < buf.byteLength; i += chunkSize) {
          dc.send(buf.slice(i, i + chunkSize));
        }
        document.getElementById('wlan-progress')!.innerHTML = `
          <div class="alert alert-success">✅ Terkirim: ${file.name} (${formatBytes(file.size)})</div>
        `;
      };
    } else {
      area.innerHTML = `<div class="alert alert-success">✅ Terhubung via WLAN! Menunggu file dari pengirim...</div>`;
    }
  };

  dc.onmessage = (e) => {
    const area = document.getElementById('wlan-transfer-area');
    if (!area) return;

    if (typeof e.data === 'string') {
      incomingMeta = JSON.parse(e.data);
      chunks = [];
      receivedBytes = 0;
      area.innerHTML = `<div class="alert alert-info">Menerima ${incomingMeta!.name} (${formatBytes(incomingMeta!.size)})...</div>`;
    } else if (incomingMeta) {
      chunks.push(e.data);
      receivedBytes += (e.data as ArrayBuffer).byteLength;
      if (receivedBytes >= incomingMeta.size) {
        const blob = new Blob(chunks);
        const url = URL.createObjectURL(blob);
        area.innerHTML = `
          <div class="alert alert-success">✅ File diterima via WLAN!</div>
          <a href="${url}" download="${incomingMeta.name}" class="btn btn-success" style="width:100%;text-decoration:none;">
            💾 Simpan ${incomingMeta.name} (${formatBytes(incomingMeta.size)})
          </a>
        `;
      }
    }
  };
}
