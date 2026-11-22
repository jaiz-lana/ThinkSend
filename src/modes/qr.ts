import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { sha256Hex, formatBytes, uint8ToBase64, base64ToUint8 } from '../utils/crypto';
import { setupDropZone } from '../utils/copy';
import { escapeHtml } from '../utils/webrtcTransfer';
import {
  OPTICAL_QR_MAX_BYTES,
  OPTICAL_QR_CHUNK_SIZE,
  validateOpticalQrMetadata,
} from '../utils/qrMetadata';

const CHUNK_SIZE = OPTICAL_QR_CHUNK_SIZE; // Optimal balance between QR density & fast camera decode
const FPS = 12;

export function renderQrMode(container: HTMLElement): () => void {
  let role: 'send' | 'receive' = 'send';
  let streamTimer: number | null = null;
  let videoStream: MediaStream | null = null;
  let scanRaf: number | null = null;
  let runGen = 0;
  let cleanupDrop: (() => void) | null = null;
  const createdUrls: string[] = [];

  function revokeUrls() {
    while (createdUrls.length > 0) {
      const u = createdUrls.pop();
      if (u) URL.revokeObjectURL(u);
    }
  }

  function stopMediaOnly() {
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

  function stopAll() {
    runGen++;
    cleanupDrop?.();
    cleanupDrop = null;
    stopMediaOnly();
  }

  function destroyAll() {
    stopAll();
    revokeUrls();
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
        <p class="desc">Kirim file lewat layar ke kamera tanpa Wi-Fi, Bluetooth, atau internet sama sekali.</p>

        <div class="role-switch" role="tablist" aria-label="Peran QR Optik">
          <button id="qr-role-send" type="button" role="tab" aria-selected="${role === 'send'}" class="btn ${role === 'send' ? 'btn-primary' : ''}">
            <svg class="inline-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M22 2 11 13" />
              <path d="M22 2 15 22 11 13 2 9 22 2z" />
            </svg>
            Kirim File
          </button>
          <button id="qr-role-recv" type="button" role="tab" aria-selected="${role === 'receive'}" class="btn ${role === 'receive' ? 'btn-primary' : ''}">
            <svg class="inline-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Terima File
          </button>
        </div>

        <div id="qr-body"></div>

        <details class="advanced-box">
          <summary>Tips Agar Pemindaian QR Cepat &amp; Lancar</summary>
          <p>
            Cocok untuk teks, dokumen kecil, kunci, atau foto ringan (&lt; 2 MB). Naikkan kecerahan layar pengirim, hindari pantulan lampu langsung, dan sejajarkan bingkai biru hingga kamera mengunci semua blok serta memverifikasi SHA-256. Untuk file besar di area tanpa internet, gunakan menu <strong>WLAN &rarr; Tanpa Internet</strong>.
          </p>
        </details>
      </div>
    `;

    document.getElementById('qr-role-send')!.onclick = () => {
      if (role === 'send') return;
      role = 'send';
      render();
    };
    document.getElementById('qr-role-recv')!.onclick = () => {
      if (role === 'receive') return;
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
      <label class="file-drop" id="qr-dropzone">
        <input type="file" id="qr-file-input" />
        <span class="file-drop-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
        </span>
        <strong style="font-size:0.95rem;">Pilih atau Seret File ke Sini</strong>
        <span style="font-size:0.78rem;color:var(--muted);margin-top:2px;">Disarankan &lt; 2 MB agar selesai dalam beberapa detik</span>
      </label>
      <div id="qr-send-status"></div>
    `;

    const dropzone = document.getElementById('qr-dropzone') as HTMLLabelElement;
    const input = document.getElementById('qr-file-input') as HTMLInputElement;
    const status = document.getElementById('qr-send-status')!;

    const startSendingFile = async (file: File) => {
      if (file.name.length > 255 || !Number.isSafeInteger(file.size) || file.size > OPTICAL_QR_MAX_BYTES) {
        status.innerHTML = '<div class="alert alert-warning"><span aria-hidden="true">⚠️</span><div>File tidak valid: nama maksimal 255 karakter dan ukuran maksimal 100 MB.</div></div>';
        return;
      }
      stopMediaOnly();
      const myGen = ++runGen;

      const sizeWarn =
        file.size > 3 * 1024 * 1024
          ? `<div class="alert alert-warning"><span aria-hidden="true">⚠️</span><div>File berukuran <strong>${escapeHtml(formatBytes(file.size))}</strong> (~${Math.ceil((file.size / CHUNK_SIZE) / FPS)} dtk/putaran). Jika terlalu lama lewat kamera, pertimbangkan memakai tab <strong>WLAN</strong>.</div></div>`
          : '';

      status.innerHTML = `${sizeWarn}<div class="alert alert-info">Menyiapkan blok QR &amp; sidik jari SHA-256...</div>`;
      const buffer = await file.arrayBuffer();
      if (myGen !== runGen) return;

      const hash = await sha256Hex(buffer);
      if (myGen !== runGen) return;

      const bytes = new Uint8Array(buffer);
      const totalChunks = Math.max(1, Math.ceil(bytes.length / CHUNK_SIZE));
      const streamId = hash.slice(0, 6);

      const chunks: string[] = [];
      for (let i = 0; i < totalChunks; i++) {
        const slice = bytes.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        chunks.push(`TS1|D|${i}|${uint8ToBase64(slice)}`);
      }
      const metaPayload = `TS1|M|${encodeURIComponent(file.name)}|${file.size}|${totalChunks}|${hash}|${streamId}`;

      dropzone.hidden = true;

      status.innerHTML = `
        ${sizeWarn}
        <div class="alert alert-info">
          <span aria-hidden="true">📱</span>
          <div><strong>Hadapkan Kamera Penerima ke QR Ini:</strong> Siaran berputar otomatis sampai semua blok diterima.</div>
        </div>
        <div class="qr-stage">
          <canvas id="qr-canvas"></canvas>
        </div>
        <div class="stats-row">
          <span id="qr-frame-info" class="truncate-line"><span>Menyiapkan...</span></span>
          <span id="qr-block-info">${totalChunks} blok (${escapeHtml(formatBytes(file.size))})</span>
        </div>
        <div class="action-row" style="margin-top:12px;">
          <button id="qr-change-file" type="button" class="btn">Pilih File Lain</button>
          <button id="qr-stop-btn" type="button" class="btn btn-danger">Hentikan</button>
        </div>
      `;

      const canvas = document.getElementById('qr-canvas') as HTMLCanvasElement;
      const frameInfo = document.getElementById('qr-frame-info')!;
      document.getElementById('qr-change-file')!.onclick = () => {
        stopMediaOnly();
        status.innerHTML = '';
        dropzone.hidden = false;
        input.value = '';
        input.click();
      };
      document.getElementById('qr-stop-btn')!.onclick = () => render();

      // Interleave metadata setiap beberapa frame agar penerima bisa bergabung kapan saja
      let tick = 0;
      const drawNext = () => {
        if (myGen !== runGen) return;
        const isMeta = tick % 9 === 0;
        const idx = Math.floor((tick - Math.floor(tick / 9)) % totalChunks);
        const payload = isMeta ? metaPayload : chunks[idx];

        void QRCode.toCanvas(canvas, payload, {
          width: 300,
          margin: 1,
          errorCorrectionLevel: 'L',
        });

        frameInfo.textContent = isMeta
          ? `Metadata (${file.name})`
          : `Blok ${idx + 1} / ${totalChunks}`;
        tick++;
      };

      drawNext();
      streamTimer = window.setInterval(drawNext, 1000 / FPS);
    };

    input.onchange = () => {
      const file = input.files?.[0];
      input.value = '';
      if (file) void startSendingFile(file);
    };

    cleanupDrop = setupDropZone(dropzone, (files) => {
      if (files[0]) void startSendingFile(files[0]);
    });
  }

  function renderReceiver(body: HTMLElement) {
    body.innerHTML = `
      <div class="alert alert-info">
        <span aria-hidden="true">📷</span>
        <div>Arahkan kamera ke layar pengirim. Transfer akan <strong>berjalan otomatis</strong> begitu QR terbaca.</div>
      </div>
      <div id="qr-camera-wrap" class="camera-box" hidden>
        <video id="qr-video" playsinline muted></video>
        <div class="camera-guide"></div>
      </div>
      <button id="qr-start-cam" type="button" class="btn btn-primary" style="width:100%;margin-bottom:12px;">
        📷 Aktifkan Kamera &amp; Pindai
      </button>
      <div id="qr-recv-status"></div>
    `;

    const camWrap = document.getElementById('qr-camera-wrap')!;
    const startBtn = document.getElementById('qr-start-cam') as HTMLButtonElement;
    const video = document.getElementById('qr-video') as HTMLVideoElement;
    const status = document.getElementById('qr-recv-status')!;

    startBtn.onclick = async () => {
      const myGen = ++runGen;
      startBtn.disabled = true;
      startBtn.textContent = 'Menyalakan kamera...';
      status.innerHTML = '';

      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error('Browser tidak mendukung akses kamera atau halaman belum memakai HTTPS.');
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        });
        if (myGen !== runGen) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        videoStream = stream;
        video.srcObject = stream;
        camWrap.hidden = false;
        await video.play();
        if (myGen !== runGen) {
          stopMediaOnly();
          return;
        }

        startBtn.hidden = true;
        startScanning(video, camWrap, startBtn, status, myGen);
      } catch (err) {
        if (myGen !== runGen) return;
        camWrap.hidden = true;
        startBtn.disabled = false;
        startBtn.textContent = '📷 Coba Nyalakan Kamera Lagi';
        status.innerHTML = `<div class="alert alert-warning"><span aria-hidden="true">⚠️</span><div>Gagal mengakses kamera: ${escapeHtml((err as Error).message)}</div></div>`;
      }
    };
  }

  function startScanning(
    video: HTMLVideoElement,
    camWrap: HTMLElement,
    startBtn: HTMLButtonElement,
    status: HTMLElement,
    myGen: number
  ) {
    const offscreen = document.createElement('canvas');
    const ctx = offscreen.getContext('2d', { willReadFrequently: true })!;

    let meta: { name: string; size: number; total: number; hash: string } | null = null;
    const received = new Map<number, Uint8Array>();
    let startTime = 0;
    let completed = false;

    const hasNative = 'BarcodeDetector' in window;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const detector = hasNative ? new (window as any).BarcodeDetector({ formats: ['qr_code'] }) : null;

    const updateUI = () => {
      if (myGen !== runGen || completed) return;
      if (!meta) {
        status.innerHTML = `
          <div class="transfer-progress-card">
            <div class="transfer-meta-row">
              <strong>Mencari sinyal QR pengirim...</strong>
              <span>Menunggu</span>
            </div>
            <progress class="ts-progress" aria-label="Mencari sinyal QR"></progress>
          </div>
        `;
        return;
      }
      const pct = Math.min(100, Math.round((received.size / meta.total) * 100));
      const elapsed = Math.max(0.1, (Date.now() - startTime) / 1000);
      const bytesGot = received.size * CHUNK_SIZE;
      const speed = (bytesGot / 1024 / elapsed).toFixed(1);

      status.innerHTML = `
        <div class="transfer-progress-card">
          <div class="transfer-meta-row">
            <strong>Menerima: ${escapeHtml(meta.name)} (${escapeHtml(formatBytes(meta.size))})</strong>
            <span>${pct}%</span>
          </div>
          <progress class="ts-progress" value="${pct}" max="100" aria-label="Progres transfer QR"></progress>
          <div class="stats-row">
            <span>${received.size} / ${meta.total} blok</span>
            <span>${speed} KB/dtk</span>
          </div>
        </div>
      `;
    };

    updateUI();

    const handlePayload = async (raw: string) => {
      if (myGen !== runGen || completed || !raw.startsWith('TS1|')) return;
      const parts = raw.split('|');

      if (parts[1] === 'M' && parts.length >= 6) {
        let decodedName = 'file';
        try {
          decodedName = decodeURIComponent(parts[2] || 'file');
        } catch {
          decodedName = parts[2] || 'file';
        }
        const size = Number(parts[3]);
        const total = Number(parts[4]);
        const hash = parts[5] || '';
        const validated = validateOpticalQrMetadata(decodedName, size, total, hash);
        if (!validated) return;
        if (!meta || meta.hash !== validated.hash) {
          meta = { name: validated.name, size: validated.size, total: validated.total, hash: validated.hash };
          received.clear();
          startTime = Date.now();
          updateUI();
        }
      } else if (parts[1] === 'D' && meta && parts.length >= 4) {
        const idx = Number(parts[2]);
        if (!Number.isInteger(idx) || idx < 0 || idx >= meta.total) return;

        if (!received.has(idx)) {
          let bytes: Uint8Array;
          try {
            bytes = base64ToUint8(parts[3]);
          } catch {
            return;
          }
          if (bytes.byteLength > CHUNK_SIZE) return;
          received.set(idx, bytes);
          updateUI();

          if (received.size === meta.total) {
            completed = true;
            stopMediaOnly();
            camWrap.hidden = true;

            let totalBytes = 0;
            const orderedChunks: Uint8Array[] = [];
            for (let i = 0; i < meta.total; i++) {
              const c = received.get(i) ?? new Uint8Array(0);
              orderedChunks.push(c);
              totalBytes += c.byteLength;
            }
            const full = new Uint8Array(totalBytes);
            let offset = 0;
            for (const c of orderedChunks) {
              full.set(c, offset);
              offset += c.byteLength;
            }

            if (totalBytes !== meta.size) {
              status.innerHTML = '<div class="alert alert-warning"><span aria-hidden="true">⚠️</span><div>Metadata tidak valid: ukuran hasil rakitan tidak sama dengan ukuran yang dinyatakan.</div></div>';
              return;
            }

            const actualHash = await sha256Hex(full.buffer);
            if (myGen !== runGen) return;

            const verified = actualHash === meta.hash;
            const blob = new Blob([full]);
            const url = URL.createObjectURL(blob);
            createdUrls.push(url);

            status.innerHTML = `
              <div class="alert ${verified ? 'alert-success' : 'alert-warning'}" role="status">
                <span aria-hidden="true">${verified ? '✅' : '⚠️'}</span>
                <div>${verified ? 'Transfer selesai &amp; keutuhan file SHA-256 cocok 100%!' : 'Transfer selesai, namun hash SHA-256 tidak cocok.'}</div>
              </div>
              <div class="received-file-item">
                <div class="received-file-meta">
                  <strong>${escapeHtml(meta.name)}</strong>
                  <span>${escapeHtml(formatBytes(full.byteLength))} • ${verified ? 'SHA-256 Terverifikasi' : 'Hash Tidak Cocok'}</span>
                </div>
                <a href="${url}" download="${escapeHtml(meta.name)}" class="btn btn-success" style="text-decoration:none;">
                  💾 Simpan File
                </a>
              </div>
              <button id="qr-recv-again" type="button" class="btn" style="width:100%;margin-top:10px;">
                📷 Pindai File Berikutnya
              </button>
            `;

            document.getElementById('qr-recv-again')!.onclick = () => {
              startBtn.hidden = false;
              startBtn.disabled = false;
              startBtn.textContent = '📷 Aktifkan Kamera & Pindai';
              status.innerHTML = '';
              startBtn.click();
            };
          }
        }
      }
    };

    const loop = async () => {
      if (myGen !== runGen || completed) return;
      if (video.readyState === video.HAVE_ENOUGH_DATA && video.videoWidth > 0) {
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
            // Abaikan error frame
          }
        } else {
          const img = ctx.getImageData(0, 0, offscreen.width, offscreen.height);
          const code = jsQR(img.data, img.width, img.height);
          if (code) {
            await handlePayload(code.data);
          }
        }
      }
      if (myGen === runGen && !completed) {
        scanRaf = requestAnimationFrame(() => void loop());
      }
    };

    scanRaf = requestAnimationFrame(() => void loop());
  }

  render();
  return destroyAll;
}
