import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { sha256Hex, formatBytes, uint8ToBase64, base64ToUint8 } from '../utils/crypto';

const CHUNK_SIZE = 550; // Optimal balance between QR density & fast camera decode
const FPS = 12;

export function renderQrMode(container: HTMLElement): () => void {
  let role: 'send' | 'receive' = 'send';
  let streamTimer: number | null = null;
  let videoStream: MediaStream | null = null;
  let scanRaf: number | null = null;

  function stopAll() {
    if (streamTimer !== null) {
      clearInterval(streamTimer);
      streamTimer = null;
    }
    if (scanRaf !== null) {
      cancelAnimationFrame(scanRaf);
      scanRaf = null;
    }
    if (videoStream) {
      videoStream.getTracks().forEach((t) => t.stop());
      videoStream = null;
    }
  }

  function render() {
    stopAll();
    container.innerHTML = `
      <div class="card">
        <h2>
          <span class="card-title-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="3" width="7" height="7" rx="1.5" />
              <rect x="14" y="3" width="7" height="7" rx="1.5" />
              <rect x="3" y="14" width="7" height="7" rx="1.5" />
              <path d="M14 14h3v3h-3zM20 14v3M14 20h7M17 17h3v3" />
            </svg>
          </span>
          Transfer QR Optik (100% Offline)
        </h2>
        <p class="desc">Kirim file melalui cahaya layar ke kamera tanpa Wi-Fi, Bluetooth, atau kuota internet.</p>
        <div class="role-switch">
          <button id="qr-role-send" class="btn ${role === 'send' ? 'btn-primary' : ''}">
            <svg class="inline-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M22 2 11 13" />
              <path d="M22 2 15 22 11 13 2 9 22 2z" />
            </svg>
            Kirim File
          </button>
          <button id="qr-role-recv" class="btn ${role === 'receive' ? 'btn-primary' : ''}">
            <svg class="inline-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Terima File
          </button>
        </div>
        <div id="qr-body"></div>
      </div>
    `;

    document.getElementById('qr-role-send')!.onclick = () => {
      role = 'send';
      render();
    };
    document.getElementById('qr-role-recv')!.onclick = () => {
      role = 'receive';
      render();
    };

    const body = document.getElementById('qr-body')!;
    if (role === 'send') {
      renderSender(body);
    } else {
      renderReceiver(body);
    }
  }

  function renderSender(body: HTMLElement) {
    body.innerHTML = `
      <label class="file-drop">
        <input type="file" id="qr-file-input" />
        <span class="file-drop-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
        </span>
        <strong style="font-size:0.95rem;">Pilih File untuk Dikirim</strong>
        <span style="font-size:0.78rem;color:var(--muted);margin-top:2px;">Disarankan &lt; 2 MB untuk transfer QR tercepat</span>
      </label>
      <div id="qr-send-status"></div>
    `;

    const input = document.getElementById('qr-file-input') as HTMLInputElement;
    const status = document.getElementById('qr-send-status')!;

    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;

      status.innerHTML = `<div class="alert alert-info">Menyiapkan blok data &amp; hash SHA-256...</div>`;
      const buffer = await file.arrayBuffer();
      const hash = await sha256Hex(buffer);
      const bytes = new Uint8Array(buffer);
      const totalChunks = Math.max(1, Math.ceil(bytes.length / CHUNK_SIZE));

      const chunks: string[] = [];
      for (let i = 0; i < totalChunks; i++) {
        const slice = bytes.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        chunks.push(`TS1|D|${i}|${uint8ToBase64(slice)}`);
      }
      const metaPayload = `TS1|M|${encodeURIComponent(file.name)}|${file.size}|${totalChunks}|${hash}`;

      status.innerHTML = `
        <div class="alert alert-warning">
          <span>⚠️</span>
          <div><strong>Hadapkan Perangkat A &amp; B!</strong><br/>Arahkan kamera penerima ke layar ini. Terus hadapkan kedua perangkat satu sama lain hingga transfer selesai.</div>
        </div>
        <div class="qr-stage">
          <canvas id="qr-canvas"></canvas>
        </div>
        <div class="stats-row">
          <span id="qr-frame-info">File: ${file.name} (${formatBytes(file.size)})</span>
          <span id="qr-block-info">${totalChunks} blok</span>
        </div>
        <div style="margin-top:12px;display:flex;gap:8px;">
          <button id="qr-stop-btn" class="btn btn-danger" style="width:100%;">Hentikan Transfer</button>
        </div>
      `;

      const canvas = document.getElementById('qr-canvas') as HTMLCanvasElement;
      const frameInfo = document.getElementById('qr-frame-info')!;
      document.getElementById('qr-stop-btn')!.onclick = () => render();

      // Interleave metadata every 8 frames so receiver can auto-start anytime
      let tick = 0;
      const drawNext = () => {
        const isMeta = tick % 9 === 0;
        const idx = Math.floor((tick - Math.floor(tick / 9)) % totalChunks);
        const payload = isMeta ? metaPayload : chunks[idx];

        QRCode.toCanvas(canvas, payload, {
          width: 300,
          margin: 1,
          errorCorrectionLevel: 'L',
        });

        frameInfo.textContent = isMeta
          ? `Kalibrasi / Metadata (${file.name})`
          : `Mengirim blok ${idx + 1} / ${totalChunks}`;
        tick++;
      };

      drawNext();
      streamTimer = window.setInterval(drawNext, 1000 / FPS);
    };
  }

  function renderReceiver(body: HTMLElement) {
    body.innerHTML = `
      <div class="alert alert-warning">
        <span>⚠️</span>
        <div><strong>Panduan Alignment:</strong> Hadapkan kamera ke layar pengirim. Jika sudah sejajar, transfer akan <strong>otomatis dimulai</strong>. Terus hadapkan kedua perangkat hingga selesai.</div>
      </div>
      <div class="camera-box">
        <video id="qr-video" playsinline muted></video>
        <div class="camera-guide"></div>
      </div>
      <button id="qr-start-cam" class="btn btn-primary" style="width:100%;margin-bottom:12px;">📷 Aktifkan Kamera &amp; Mulai</button>
      <div id="qr-recv-status"></div>
    `;

    const startBtn = document.getElementById('qr-start-cam') as HTMLButtonElement;
    const video = document.getElementById('qr-video') as HTMLVideoElement;
    const status = document.getElementById('qr-recv-status')!;

    startBtn.onclick = async () => {
      try {
        videoStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        });
        video.srcObject = videoStream;
        await video.play();
        startBtn.style.display = 'none';
        startScanning(video, status);
      } catch (err) {
        status.innerHTML = `<div class="alert alert-warning">Gagal mengakses kamera: ${(err as Error).message}</div>`;
      }
    };
  }

  async function startScanning(video: HTMLVideoElement, status: HTMLElement) {
    const offscreen = document.createElement('canvas');
    const ctx = offscreen.getContext('2d', { willReadFrequently: true })!;

    let meta: { name: string; size: number; total: number; hash: string } | null = null;
    const received = new Map<number, Uint8Array>();
    let startTime = 0;

    // Prefer native BarcodeDetector if available for maximum speed
    const hasNative = 'BarcodeDetector' in window;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const detector = hasNative ? new (window as any).BarcodeDetector({ formats: ['qr_code'] }) : null;

    const updateUI = () => {
      if (!meta) {
        status.innerHTML = `<div class="alert alert-info">Mencari sinyal QR pengirim... Pastikan kedua perangkat saling berhadapan.</div>`;
        return;
      }
      const pct = Math.round((received.size / meta.total) * 100);
      const elapsed = Math.max(0.1, (Date.now() - startTime) / 1000);
      const bytesGot = received.size * CHUNK_SIZE;
      const speed = (bytesGot / 1024 / elapsed).toFixed(1);

      status.innerHTML = `
        <div class="alert alert-info">Menerima: <strong>${meta.name}</strong> (${formatBytes(meta.size)})</div>
        <div class="progress-wrap"><div class="progress-bar" style="width:${pct}%"></div></div>
        <div class="stats-row">
          <span>${pct}% (${received.size}/${meta.total} blok)</span>
          <span>${speed} KB/s</span>
        </div>
      `;
    };

    updateUI();

    const handlePayload = async (raw: string) => {
      if (!raw.startsWith('TS1|')) return;
      const parts = raw.split('|');

      if (parts[1] === 'M' && !meta) {
        meta = {
          name: decodeURIComponent(parts[2]),
          size: Number(parts[3]),
          total: Number(parts[4]),
          hash: parts[5],
        };
        startTime = Date.now();
        updateUI();
      } else if (parts[1] === 'D' && meta) {
        const idx = Number(parts[2]);
        if (!received.has(idx)) {
          received.set(idx, base64ToUint8(parts[3]));
          updateUI();

          if (received.size === meta.total) {
            stopAll();
            const full = new Uint8Array(meta.size);
            let offset = 0;
            for (let i = 0; i < meta.total; i++) {
              const chunk = received.get(i)!;
              full.set(chunk, offset);
              offset += chunk.length;
            }
            const actualHash = await sha256Hex(full.buffer);
            const verified = actualHash === meta.hash;
            const blob = new Blob([full]);
            const url = URL.createObjectURL(blob);

            status.innerHTML = `
              <div class="alert ${verified ? 'alert-success' : 'alert-warning'}">
                ${verified ? '✅ Transfer Selesai &amp; SHA-256 Terverifikasi!' : '⚠️ Transfer selesai, namun hash tidak cocok.'}
              </div>
              <a href="${url}" download="${meta.name}" class="btn btn-success" style="width:100%;text-decoration:none;">
                💾 Simpan ${meta.name} (${formatBytes(meta.size)})
              </a>
            `;
          }
        }
      }
    };

    const loop = async () => {
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        offscreen.width = video.videoWidth;
        offscreen.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, offscreen.width, offscreen.height);

        if (detector) {
          try {
            const codes = await detector.detect(offscreen);
            for (const c of codes) {
              await handlePayload(c.rawValue);
            }
          } catch {
            // ignore frame error
          }
        } else {
          const img = ctx.getImageData(0, 0, offscreen.width, offscreen.height);
          const code = jsQR(img.data, img.width, img.height);
          if (code) {
            await handlePayload(code.data);
          }
        }
      }
      scanRaf = requestAnimationFrame(loop);
    };

    scanRaf = requestAnimationFrame(loop);
  }

  render();
  return stopAll;
}
