import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { attachLightDismissFallback } from './copy';

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
    let resultValue: string | null = null;

    const headingId = `qr-scan-title-${Math.random().toString(36).slice(2, 8)}`;
    const dialog = document.createElement('dialog');
    dialog.className = 'ts-dialog';
    dialog.setAttribute('closedby', 'any');
    dialog.setAttribute('aria-labelledby', headingId);
    dialog.innerHTML = `
      <div class="modal-card">
        <div class="modal-header">
          <div>
            <h2 id="${headingId}" style="font-size:1.05rem;font-weight:700;color:var(--text-strong);"></h2>
            <span class="modal-version">Arahkan kamera ke QR Code</span>
          </div>
          <form method="dialog">
            <button type="submit" class="modal-close" value="cancel" aria-label="Tutup pemindai QR">&times;</button>
          </form>
        </div>
        <div class="camera-box" style="margin-bottom:10px;">
          <video playsinline muted></video>
          <div class="camera-guide"></div>
        </div>
        <div class="qr-scan-msg alert alert-info" style="margin-bottom:12px;">
          <span aria-hidden="true">📷</span>
          <div class="qr-scan-hint"></div>
        </div>
        <form method="dialog">
          <button type="submit" class="btn qr-cancel-btn" value="cancel" style="width:100%;" autofocus>Batal</button>
        </form>
      </div>
    `;

    const titleEl = dialog.querySelector('h2')!;
    const hintEl = dialog.querySelector('.qr-scan-hint')!;
    const msgBox = dialog.querySelector('.qr-scan-msg') as HTMLElement;
    const video = dialog.querySelector('video')!;

    titleEl.textContent = opts.title;
    hintEl.textContent = opts.hint ?? 'Menyalakan kamera...';

    const stopMedia = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
        stream = null;
      }
    };

    const cleanupAndResolve = (val: string | null) => {
      if (settled) return;
      settled = true;
      stopMedia();
      dialog.returnValue = '';
      if (dialog.isConnected) dialog.remove();
      resolve(val);
    };

    dialog.addEventListener('close', () => {
      cleanupAndResolve(resultValue);
    });

    attachLightDismissFallback(dialog);
    document.body.appendChild(dialog);
    dialog.showModal();

    const startCamera = async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error('Browser tidak mengizinkan akses kamera (pastikan HTTPS).');
        }
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        });
        if (settled) {
          stopMedia();
          return;
        }
        video.srcObject = stream;
        await video.play();
        if (settled) {
          stopMedia();
          return;
        }

        const offscreen = document.createElement('canvas');
        const ctx = offscreen.getContext('2d', { willReadFrequently: true })!;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const DetectorCtor = (window as any).BarcodeDetector;
        const detector = DetectorCtor ? new DetectorCtor({ formats: ['qr_code'] }) : null;

        const tick = async () => {
          if (settled) return;
          if (video.readyState === video.HAVE_ENOUGH_DATA && video.videoWidth > 0) {
            offscreen.width = video.videoWidth;
            offscreen.height = video.videoHeight;
            ctx.drawImage(video, 0, 0, offscreen.width, offscreen.height);

            if (detector) {
              try {
                const codes = await detector.detect(offscreen);
                if (codes?.[0]?.rawValue) {
                  resultValue = codes[0].rawValue;
                  dialog.close('scanned');
                  return;
                }
              } catch {
                // Fallback ke jsQR di bawah bila gagal
              }
            }
            const img = ctx.getImageData(0, 0, offscreen.width, offscreen.height);
            const code = jsQR(img.data, img.width, img.height);
            if (code?.data) {
              resultValue = code.data;
              dialog.close('scanned');
              return;
            }
          }
          rafId = requestAnimationFrame(() => void tick());
        };

        rafId = requestAnimationFrame(() => void tick());
      } catch (err) {
        msgBox.className = 'qr-scan-msg alert alert-warning';
        hintEl.textContent = `Kamera tidak dapat diakses (${(err as Error).message}). Tutup pemindai ini lalu tempel teks kode di kolom manual.`;
      }
    };

    void startCamera();
  });
}

export function showQrCodeModal(opts: {
  title: string;
  subtitle?: string;
  payload: string;
}): Promise<void> {
  return new Promise((resolve) => {
    const headingId = `qr-show-title-${Math.random().toString(36).slice(2, 8)}`;
    const dialog = document.createElement('dialog');
    dialog.className = 'ts-dialog';
    dialog.setAttribute('closedby', 'any');
    dialog.setAttribute('aria-labelledby', headingId);
    dialog.innerHTML = `
      <div class="modal-card">
        <div class="modal-header">
          <div>
            <h2 id="${headingId}" style="font-size:1.05rem;font-weight:700;color:var(--text-strong);"></h2>
            <span class="modal-version"></span>
          </div>
          <form method="dialog">
            <button type="submit" class="modal-close" value="close" aria-label="Tutup QR">&times;</button>
          </form>
        </div>
        <div class="qr-stage" style="margin-bottom:12px;">
          <canvas></canvas>
        </div>
        <form method="dialog">
          <button type="submit" class="btn btn-primary" value="close" style="width:100%;" autofocus>Tutup</button>
        </form>
      </div>
    `;

    dialog.querySelector('h2')!.textContent = opts.title;
    dialog.querySelector('.modal-version')!.textContent =
      opts.subtitle ?? 'Pindai QR ini dari perangkat lawan';

    attachLightDismissFallback(dialog);
    dialog.addEventListener('close', () => {
      dialog.returnValue = '';
      if (dialog.isConnected) dialog.remove();
      resolve();
    });

    document.body.appendChild(dialog);
    dialog.showModal();
    const canvas = dialog.querySelector('canvas')!;
    void drawQrCanvas(canvas, opts.payload, 240);
  });
}
