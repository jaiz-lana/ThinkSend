# ThinkSend

Aplikasi web PWA untuk transfer file cepat lintas jalur:
- **QR Optik**: 100% offline via kamera & QR beruntun dengan verifikasi SHA-256.
- **WLAN**: Transfer P2P di jaringan Wi-Fi lokal melalui WebRTC DataChannel.
- **Provider**: Transfer P2P jarak jauh melalui koneksi internet.

## Pengembangan Lokal

```bash
npm install
npm run dev
```

## Build Produksi

```bash
npm run build
```

Hasil build berada di folder `dist/` dan otomatis di-deploy ke GitHub Pages melalui workflow `.github/workflows/deploy.yml` saat push ke branch `main`.
