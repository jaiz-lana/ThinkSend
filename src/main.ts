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

  tabs.forEach((t) => {
    const isActive = t.dataset.mode === mode;
    t.classList.toggle('active', isActive);
    t.setAttribute('aria-selected', String(isActive));
  });
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
  navigator.serviceWorker
    .register(`${import.meta.env.BASE_URL}sw.js`, { updateViaCache: 'none' })
    .then((reg) => {
      reg.update().catch(() => {});
    })
    .catch(() => {
      const status = document.getElementById('pwa-status');
      if (status) status.textContent = 'Web Mode';
    });
}

const initialHash = window.location.hash.replace('#', '') as TransferMode;
const initialMode: TransferMode = initialHash === 'wlan' || initialHash === 'provider' ? initialHash : 'qr';
switchMode(initialMode);
requestAnimationFrame(() => document.body.classList.add('tabs-ready'));

// About Modal
const aboutModal = document.getElementById('about-modal');
const openAbout = () => {
  if (aboutModal) aboutModal.hidden = false;
};
const closeAbout = () => {
  if (aboutModal) aboutModal.hidden = true;
};

document.getElementById('about-open-btn')?.addEventListener('click', openAbout);
document.getElementById('about-footer-btn')?.addEventListener('click', openAbout);
document.getElementById('about-close-btn')?.addEventListener('click', closeAbout);
document.getElementById('about-ok-btn')?.addEventListener('click', closeAbout);
aboutModal?.addEventListener('click', (e) => {
  if (e.target === aboutModal) closeAbout();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && aboutModal && !aboutModal.hidden) closeAbout();
});
