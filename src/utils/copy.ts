// Reusable Copy Button (Async Clipboard + legacy fallback + role="status" live region),
// native <dialog> light-dismiss fallback, and Drag & Drop zone helper.

const copyTimers = new WeakMap<HTMLElement, number>();
let lastCopyMessage = '';
let globalInitialized = false;

function legacyCopy(text: string): boolean {
  const field = Object.assign(document.createElement('textarea'), { value: text });
  field.setAttribute('readonly', '');
  field.style.cssText = 'position:fixed;inset-block-start:0;opacity:0;pointer-events:none';
  document.body.append(field);
  field.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    field.remove();
  }
}

export function reportCopyFeedback(button: HTMLButtonElement, ok: boolean, customMsg?: string): void {
  const tip = button.nextElementSibling as HTMLElement | null;
  const existing = copyTimers.get(button);
  if (existing !== undefined) clearTimeout(existing);

  button.removeAttribute('data-copied');
  button.removeAttribute('data-failed');

  let message = customMsg ?? (ok ? 'Tersalin' : 'Gagal menyalin');
  if (message === lastCopyMessage) {
    message += '\u00A0';
  }
  lastCopyMessage = message;

  if (tip) tip.textContent = '';
  void button.offsetWidth;
  button.setAttribute(ok ? 'data-copied' : 'data-failed', '');
  requestAnimationFrame(() => {
    if (tip) tip.textContent = message;
  });

  const tid = window.setTimeout(() => {
    button.removeAttribute('data-copied');
    button.removeAttribute('data-failed');
    if (tip) tip.textContent = '';
  }, 2000);
  copyTimers.set(button, tid);
}

export async function copyTextFromSource(
  button: HTMLButtonElement,
  target: HTMLElement | null,
  directText?: string
): Promise<boolean> {
  const text =
    directText !== undefined
      ? directText
      : target
        ? target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
          ? target.value.trim()
          : (target.innerText || target.textContent || '').trim()
        : '';

  if (!text) {
    reportCopyFeedback(button, false, 'Belum ada kode');
    return false;
  }

  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
    } else if (!legacyCopy(text)) {
      throw new Error('Clipboard unavailable');
    }
    reportCopyFeedback(button, true);
    return true;
  } catch {
    if (legacyCopy(text)) {
      reportCopyFeedback(button, true);
      return true;
    }
    reportCopyFeedback(button, false);
    return false;
  }
}

export function renderCopyControlHtml(opts: {
  id?: string;
  targetId?: string;
  label: string;
  ariaLabel?: string;
  className?: string;
}): string {
  const safeIdAttr = opts.id ? ` id="${opts.id}"` : '';
  const cmdAttrs = opts.targetId ? ` command="--copy" commandfor="${opts.targetId}"` : '';
  const ariaAttr =
    opts.ariaLabel && opts.ariaLabel !== opts.label ? ` aria-label="${opts.ariaLabel}"` : '';
  return `
    <span class="copy-wrap">
      <button type="button"${safeIdAttr} class="btn copy-btn ${opts.className ?? ''}"${cmdAttrs}${ariaAttr}>
        <span class="copy-icon-slot" aria-hidden="true">
          <svg class="icon-copy" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
          <svg class="icon-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </span>
        <span class="copy-label">${opts.label}</span>
      </button>
      <span class="copy-tip" role="status"></span>
    </span>
  `.trim();
}

export function initGlobalCopyHandlers(): void {
  if (globalInitialized) return;
  globalInitialized = true;

  if ('CommandEvent' in window) {
    document.addEventListener(
      'command',
      (event: Event) => {
        const ce = event as Event & {
          command?: string;
          source?: Element | null;
        };
        if (ce.command === '--copy' && ce.source instanceof HTMLButtonElement) {
          const target = event.target instanceof HTMLElement ? event.target : null;
          void copyTextFromSource(ce.source, target);
        }
      },
      true
    );
  } else {
    document.addEventListener('click', (event) => {
      const btn = (event.target as Element | null)?.closest<HTMLButtonElement>(
        'button[command="--copy"]'
      );
      if (!btn) return;
      const targetId = btn.getAttribute('commandfor');
      const target = targetId ? document.getElementById(targetId) : null;
      void copyTextFromSource(btn, target);
    });
  }
}

export async function pasteFromClipboardToField(
  field: HTMLInputElement | HTMLTextAreaElement,
  errorBox?: HTMLElement | null
): Promise<boolean> {
  if (errorBox) errorBox.innerHTML = '';
  try {
    if (!navigator.clipboard || typeof navigator.clipboard.readText !== 'function') {
      throw new Error('Clipboard read unavailable');
    }
    const text = (await navigator.clipboard.readText()).trim();
    if (!text) {
      if (errorBox) {
        errorBox.innerHTML = `<div class="alert alert-warning">Clipboard kosong. Salin kode terlebih dahulu lalu coba lagi.</div>`;
      }
      return false;
    }
    field.value = text;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.focus();
    return true;
  } catch {
    field.focus();
    if (errorBox) {
      errorBox.innerHTML = `<div class="alert alert-info">Izin tempel otomatis dibatasi browser. Ketuk kotak input di atas lalu pilih <strong>Tempel / Paste</strong> (Ctrl+V).</div>`;
    }
    return false;
  }
}

export function attachLightDismissFallback(dialog: HTMLDialogElement): void {
  if ('closedBy' in HTMLDialogElement.prototype) return;
  const isOutside = (e: PointerEvent) => {
    const r = dialog.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  let pressedOutside = false;
  dialog.addEventListener('pointerdown', (e) => {
    pressedOutside = e.target === dialog && isOutside(e);
  });
  dialog.addEventListener('pointerup', (e) => {
    if (pressedOutside && e.target === dialog && isOutside(e)) {
      dialog.close();
    }
    pressedOutside = false;
  });
}

export function setupDropZone(
  dropEl: HTMLElement | null,
  onFiles: (files: File[]) => void
): () => void {
  if (!dropEl) return () => {};
  let dragDepth = 0;

  const onDragEnter = (e: DragEvent) => {
    e.preventDefault();
    dragDepth++;
    dropEl.classList.add('is-dragover');
  };
  const onDragOver = (e: DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  };
  const onDragLeave = (e: DragEvent) => {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropEl.classList.remove('is-dragover');
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    dragDepth = 0;
    dropEl.classList.remove('is-dragover');
    const files = e.dataTransfer?.files ? Array.from(e.dataTransfer.files) : [];
    if (files.length > 0) onFiles(files);
  };

  dropEl.addEventListener('dragenter', onDragEnter);
  dropEl.addEventListener('dragover', onDragOver);
  dropEl.addEventListener('dragleave', onDragLeave);
  dropEl.addEventListener('drop', onDrop);

  return () => {
    dropEl.removeEventListener('dragenter', onDragEnter);
    dropEl.removeEventListener('dragover', onDragOver);
    dropEl.removeEventListener('dragleave', onDragLeave);
    dropEl.removeEventListener('drop', onDrop);
  };
}
