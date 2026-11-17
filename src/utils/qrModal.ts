import QRCode from 'qrcode';
import jsQR from 'jsqr';

export async function drawQrCanvas(
  canvas: HTMLCanvasElement,
  text: string,
  width = 240
): Promise<void> {
  await QRCode.toCanvas(canvas, text, {
    width,
    margin: 2,
    errorCorrectionLevel: 'M',
    color: {
      dark: '#0f172a',
      light: '#ffffff',
    },
  });
}

export function scanQrWithCamera(opts: {
  title: string;
  hint?: string;
}): Promise<string | null> {
  return new Promise((resolve) => {
    let stream: MediaStream | null = null;
    let rafId: number | null = null;
    let settled = false;

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');
    backdrop.innerHTML = `
      <div class="modal-card">
        <div class="modal-header">
          <div>
            <h2 style="font-size:1.05rem;font-weight:700;color:var(--text-strong);"></h2>
            <span class="modal-version">Arahkan kamera ke QR Code</span>
          </div>
          <button type="button" class="modal-close" aria-label="Tutup">&times;</button>
        </div>
        <div class="camera-box" style="margin-bottom:10px;">
          <video playsinline muted></video>
          <div class="camera-guide"></div>
        </div>
        <div class="qr-scan-msg alert alert-info" style="margin-bottom:12px;">
          <span>📷</span>
          <div class="qr-scan-hint"></div>
        </div>
        <button type="button" class="btn qr-cancel-btn" style="width:100%;">Batal</button>
      </div>
    `;

    const titleEl = backdrop.querySelector('h2')!;
    const hintEl = backdrop.querySelector('.qr-scan-hint')!;
    const msgBox = backdrop.querySelector('.qr-scan-msg') as HTMLElement;
    const video = backdrop.querySelector('video')!;
    const closeBtn = backdrop.querySelector('.modal-close') as HTMLButtonElement;
    const cancelBtn = backdrop.querySelector('.qr-cancel-btn') as HTMLButtonElement;

    titleEl.textContent = opts.title;
    hintEl.textContent = opts.hint ?? 'Menyalakan kamera...';

    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
        stream = null;
      }
      window.removeEventListener('keydown', onKey);
      backdrop.remove();
      resolve(value);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish(null);
    };

    closeBtn.onclick = () => finish(null);
    cancelBtn.onclick = () => finish(null);
    backdrop.onclick = (e) => {
      if (e.target === backdrop) finish(null);
    };
    window.addEventListener('keydown', onKey);
    document.body.appendChild(backdrop);

    const startCamera = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        });
        if (settled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        video.srcObject = stream;
        await video.play();

        const offscreen = document.createElement('canvas');
        const ctx = offscreen.getContext('2d', { willReadFrequently: true })!;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const DetectorCtor = (window as any).BarcodeDetector;
        const detector = DetectorCtor ? new DetectorCtor({ formats: ['qr_code'] }) : null;

        const tick = async () => {
          if (settled) return;
          if (video.readyState === video.HAVE_ENOUGH_DATA) {
            offscreen.width = video.videoWidth;
            offscreen.height = video.videoHeight;
            ctx.drawImage(video, 0, 0, offscreen.width, offscreen.height);

            if (detector) {
              try {
                const codes = await detector.detect(offscreen);
                if (codes?.[0]?.rawValue) {
                  finish(codes[0].rawValue);
                  return;
                }
              } catch {
                // Fallback ke jsQR di bawah bila gagal
              }
            }
            const img = ctx.getImageData(0, 0, offscreen.width, offscreen.height);
            const code = jsQR(img.data, img.width, img.height);
            if (code?.data) {
              finish(code.data);
              return;
            }
          }
          rafId = requestAnimationFrame(() => void tick());
        };

        rafId = requestAnimationFrame(() => void tick());
      } catch (err) {
        msgBox.className = 'qr-scan-msg alert alert-warning';
        hintEl.textContent = `Kamera tidak dapat diakses (${(err as Error).message}). Gunakan input teks manual.`;
      }
    };

    void startCamera();
  });
}
