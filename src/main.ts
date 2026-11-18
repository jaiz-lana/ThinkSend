import './style.css';
import { attachLightDismissFallback, initGlobalCopyHandlers } from './utils/copy';
import { renderQrMode } from './modes/qr';
import { renderWlanMode } from './modes/wlan';
import { renderProviderMode } from './modes/provider';

type TransferMode = 'qr' | 'wlan' | 'provider';

const container = document.getElementById('mode-container')!;
const tabs = document.querySelectorAll<HTMLButtonElement>('.mode-tab');

let cleanupCurrentMode: (() => void) | null = null;
let currentMode: TransferMode | null = null;

initGlobalCopyHandlers();

function parseModeFromHash(hash: string): TransferMode {
  const raw = hash.replace(/^#/, '');
  if (raw === 'wlan' || raw.startsWith('wlan-')) return 'wlan';
  if (raw === 'provider') return 'provider';
  return 'qr';
}

function switchMode(mode: TransferMode, options?: { syncHash?: boolean }) {
  if (cleanupCurrentMode) {
    cleanupCurrentMode();
    cleanupCurrentMode = null;
  }
  currentMode = mode;

  const hasNativeFocusgroup = Object.hasOwn(HTMLElement.prototype, 'focusGroup');
  let activeTabId = 'mode-tab-qr';
  tabs.forEach((t) => {
    const isActive = t.dataset.mode === mode;
    t.classList.toggle('active', isActive);
    t.setAttribute('aria-selected', String(isActive));
    t.toggleAttribute('focusgroupstart', isActive);
    if (!hasNativeFocusgroup) {
      t.tabIndex = isActive ? 0 : -1;
    } else {
      t.removeAttribute('tabindex');
    }
    if (isActive) {
      activeTabId = t.id;
      try {
        t.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      } catch {
        // Ignore on unsupported engines
      }
    }
  });
  container.setAttribute('aria-labelledby', activeTabId);

  if (options?.syncHash && !window.location.hash.startsWith('#wlan-room=')) {
    try {
      window.history.replaceState(null, '', `#${mode}`);
    } catch {
      // Ignore history restrictions
    }
  }

  container.innerHTML = '';

  if (mode === 'qr') {
    cleanupCurrentMode = renderQrMode(container);
  } else if (mode === 'wlan') {
    cleanupCurrentMode = renderWlanMode(container);
  } else {
    cleanupCurrentMode = renderProviderMode(container);
  }
}

tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    const mode = tab.dataset.mode as TransferMode;
    switchMode(mode, { syncHash: true });
  });
});

// Delegated keyboard arrow/Home/End navigation for all ARIA tablists (when native focusgroup is absent)
document.addEventListener('keydown', (e) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  const target = e.target as HTMLElement | null;
  const currentTab = target?.closest<HTMLButtonElement>('[role="tab"]');
  const tablist = currentTab?.closest<HTMLElement>('[role="tablist"]');
  if (!currentTab || !tablist) return;

  const hasNativeFocusgroup =
    tablist.hasAttribute('focusgroup') && Object.hasOwn(HTMLElement.prototype, 'focusGroup');
  if (hasNativeFocusgroup) return;

  const list = Array.from(tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)'));
  const idx = list.indexOf(currentTab);
  if (idx < 0 || list.length <= 1) return;

  e.preventDefault();
  let nextIdx = idx;
  if (e.key === 'ArrowRight') nextIdx = (idx + 1) % list.length;
  else if (e.key === 'ArrowLeft') nextIdx = (idx - 1 + list.length) % list.length;
  else if (e.key === 'Home') nextIdx = 0;
  else if (e.key === 'End') nextIdx = list.length - 1;

  const nextTab = list[nextIdx];
  list.forEach((btn) => {
    btn.tabIndex = btn === nextTab ? 0 : -1;
  });
  nextTab.focus();
});

window.addEventListener('hashchange', () => {
  const nextMode = parseModeFromHash(window.location.hash);
  if (window.location.hash.startsWith('#wlan-room=') || nextMode !== currentMode) {
    switchMode(nextMode);
  }
});

// Register Service Worker for PWA
if ('serviceWorker' in navigator) {
  navigator.serviceWorker
    .register(`${import.meta.env.BASE_URL}sw.js`, { updateViaCache: 'none' })
    .then((reg) => {
      reg.update().catch(() => {});
    })
    .catch(() => {
      const status = document.getElementById('pwa-status');
      if (status) status.textContent = 'Mode Web';
    });
}

switchMode(parseModeFromHash(window.location.hash));
requestAnimationFrame(() => document.body.classList.add('tabs-ready'));

// About Modal (Native <dialog> + closedby="any" + light-dismiss fallback)
const aboutModal = document.getElementById('about-modal') as HTMLDialogElement | null;
if (aboutModal) {
  attachLightDismissFallback(aboutModal);
  aboutModal.addEventListener('close', () => {
    aboutModal.returnValue = '';
  });

  const openAboutFallback = () => {
    if (!aboutModal.open) aboutModal.showModal();
  };

  if (!('commandForElement' in HTMLButtonElement.prototype)) {
    document.getElementById('about-open-btn')?.addEventListener('click', openAboutFallback);
    document.getElementById('about-footer-btn')?.addEventListener('click', openAboutFallback);
  }
}
