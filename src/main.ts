import './style.css';
import { renderQrMode } from './modes/qr';
import { renderWlanMode } from './modes/wlan';
import { renderProviderMode } from './modes/provider';

type TransferMode = 'qr' | 'wlan' | 'provider';

const container = document.getElementById('mode-container')!;
const tabs = document.querySelectorAll<HTMLButtonElement>('.mode-tab');

let cleanupCurrentMode: (() => void) | null = null;

function switchMode(mode: TransferMode) {
  if (cleanupCurrentMode) {
    cleanupCurrentMode();
    cleanupCurrentMode = null;
  }

  tabs.forEach((t) => t.classList.toggle('active', t.dataset.mode === mode));
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
    switchMode(mode);
  });
});

// Register Service Worker for PWA
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {
    const status = document.getElementById('pwa-status');
    if (status) status.textContent = 'Web Mode';
  });
}

switchMode('qr');
