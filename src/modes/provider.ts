import { formatBytes } from '../utils/crypto';

export function renderProviderMode(container: HTMLElement): () => void {
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
            <circle cx="12" cy="12" r="9.5" />
            <path d="M2.5 12h19" />
            <path d="M12 2.5a14.5 14.5 0 0 1 0 19 14.5 14.5 0 0 1 0-19Z" />
          </svg>
        </span>
        Transfer Jaringan Provider (Internet P2P)
      </h2>
      <p class="desc">Kirim file jarak jauh menggunakan koneksi data seluler/provider melalui WebRTC P2P terenkripsi.</p>

      <div class="role-switch">
        <button id="prov-host-btn" class="btn btn-primary">1. Buat Sesi (Pengirim)</button>
        <button id="prov-join-btn" class="btn">2. Gabung Sesi (Penerima)</button>
      </div>

      <div id="prov-body"></div>
    </div>
  `;

  const body = document.getElementById('prov-body')!;
  const hostBtn = document.getElementById('prov-host-btn') as HTMLButtonElement;
  const joinBtn = document.getElementById('prov-join-btn') as HTMLButtonElement;
  const rtcConfig: RTCConfiguration = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  };

  const setActiveRole = (isHost: boolean) => {
    hostBtn.classList.toggle('btn-primary', isHost);
    joinBtn.classList.toggle('btn-primary', !isHost);
  };
  setActiveRole(true);

  hostBtn.onclick = async () => {
    setActiveRole(true);
    cleanup();
    pc = new RTCPeerConnection(rtcConfig);
    dc = pc.createDataChannel('thinksend-provider', { ordered: true });
    bindChannel(dc, true);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    pc.onicecandidate = () => {
      if (pc?.iceGatheringState === 'complete') {
        const box = document.getElementById('prov-offer-out') as HTMLTextAreaElement;
        if (box) box.value = btoa(JSON.stringify(pc.localDescription));
      }
    };

    body.innerHTML = `
      <div class="input-group">
        <label>Kirim Kode Sesi ini ke Penerima (via WhatsApp/Chat):</label>
        <textarea id="prov-offer-out" rows="3" readonly placeholder="Mengumpulkan rute jaringan..."></textarea>
      </div>
      <div class="input-group">
        <label>Tempel Kode Balasan dari Penerima:</label>
        <textarea id="prov-answer-in" rows="3" placeholder="Tempel kode balasan di sini..."></textarea>
      </div>
      <button id="prov-connect-btn" class="btn btn-primary" style="width:100%;">Hubungkan P2P</button>
      <div id="prov-transfer-area" style="margin-top:14px;"></div>
    `;

    document.getElementById('prov-connect-btn')!.onclick = async () => {
      const raw = (document.getElementById('prov-answer-in') as HTMLTextAreaElement).value.trim();
      if (!raw || !pc) return;
      await pc.setRemoteDescription(JSON.parse(atob(raw)));
    };
  };

  joinBtn.onclick = () => {
    setActiveRole(false);
    cleanup();
    pc = new RTCPeerConnection(rtcConfig);
    pc.ondatachannel = (e) => {
      dc = e.channel;
      bindChannel(dc, false);
    };

    body.innerHTML = `
      <div class="input-group">
        <label>Tempel Kode Sesi dari Pengirim:</label>
        <textarea id="prov-offer-in" rows="3" placeholder="Tempel kode sesi di sini..."></textarea>
      </div>
      <button id="prov-gen-answer" class="btn btn-primary" style="width:100%;margin-bottom:12px;">Buat Kode Balasan</button>
      <div class="input-group">
        <label>Kirim Kode Balasan ini kembali ke Pengirim:</label>
        <textarea id="prov-answer-out" rows="3" readonly placeholder="Kode balasan akan muncul di sini..."></textarea>
      </div>
      <div id="prov-transfer-area" style="margin-top:14px;"></div>
    `;

    document.getElementById('prov-gen-answer')!.onclick = async () => {
      const raw = (document.getElementById('prov-offer-in') as HTMLTextAreaElement).value.trim();
      if (!raw || !pc) return;
      await pc.setRemoteDescription(JSON.parse(atob(raw)));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      pc.onicecandidate = () => {
        if (pc?.iceGatheringState === 'complete') {
          const out = document.getElementById('prov-answer-out') as HTMLTextAreaElement;
          if (out) out.value = btoa(JSON.stringify(pc.localDescription));
        }
      };
    };
  };

  return cleanup;
}

function bindChannel(dc: RTCDataChannel, isSender: boolean) {
  dc.binaryType = 'arraybuffer';
  let incomingMeta: { name: string; size: number } | null = null;
  let chunks: ArrayBuffer[] = [];
  let receivedBytes = 0;

  dc.onopen = () => {
    const area = document.getElementById('prov-transfer-area');
    if (!area) return;
    if (isSender) {
      area.innerHTML = `
        <div class="alert alert-success">✅ Terhubung via Internet P2P!</div>
        <label class="file-drop">
          <input type="file" id="prov-file-input" />
          <span class="file-drop-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
          </span>
          <strong>Pilih File untuk Dikirim</strong>
        </label>
        <div id="prov-progress"></div>
      `;
      const input = document.getElementById('prov-file-input') as HTMLInputElement;
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        dc.send(JSON.stringify({ name: file.name, size: file.size }));
        const buf = await file.arrayBuffer();
        const chunkSize = 64 * 1024;
        for (let i = 0; i < buf.byteLength; i += chunkSize) {
          dc.send(buf.slice(i, i + chunkSize));
        }
        document.getElementById('prov-progress')!.innerHTML = `
          <div class="alert alert-success">✅ Terkirim: ${file.name} (${formatBytes(file.size)})</div>
        `;
      };
    } else {
      area.innerHTML = `<div class="alert alert-success">✅ Terhubung! Menunggu file dari pengirim...</div>`;
    }
  };

  dc.onmessage = (e) => {
    const area = document.getElementById('prov-transfer-area');
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
          <div class="alert alert-success">✅ File diterima!</div>
          <a href="${url}" download="${incomingMeta.name}" class="btn btn-success" style="width:100%;text-decoration:none;">
            💾 Simpan ${incomingMeta.name} (${formatBytes(incomingMeta.size)})
          </a>
        `;
      }
    }
  };
}
