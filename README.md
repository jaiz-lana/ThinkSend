# ThinkSend

**ThinkSend** adalah aplikasi web **PWA (Progressive Web App)** untuk transfer file cepat lintas jalur secara langsung antar perangkat (*peer-to-peer* / optik) tanpa menyimpan file di server perantara, kini hadir dengan **tema terang khas Telegram** dan **latar belakang motif Batik Parang**.

🌐 **Demo Langsung (GitHub Pages):** https://jaiz-lana.github.io/ThinkSend/

---

## Tentang Aplikasi

ThinkSend dirancang agar perangkat tetap dapat bertukar file dalam berbagai kondisi jaringan—mulai dari kondisi 100% offline tanpa sinyal sama sekali, jaringan Wi-Fi lokal tanpa kuota, hingga koneksi internet jarak jauh:

- **📷 QR Optik (100% Offline)**
  Transfer file melalui cahaya layar ke kamera menggunakan rangkaian kode QR beruntun (*animated QR stream*) lengkap dengan verifikasi integritas **SHA-256** (menggunakan `qrcode`, `jsqr`, dan Web Crypto API `BarcodeDetector` bila tersedia).
- **📶 WLAN (Wi-Fi Lokal P2P)**
  Transfer berkecepatan tinggi antar perangkat di jaringan Wi-Fi yang sama melalui **WebRTC DataChannel** tanpa memakai kuota internet.
- **🌐 Provider (Internet P2P)**
  Transfer jarak jauh menggunakan data seluler/internet melalui koneksi **WebRTC P2P terenkripsi** dengan pertukaran kode sesi (*Offer/Answer*).
- **🎨 Desain Telegram Light + Batik Parang**
  Antarmuka terang dengan palet biru khas Telegram (`#2AABEE` / `#3390EC`), tab navigasi modern, kartu gelembung pesan yang bersih, serta pola vektor *seamless* **Batik Parang** (lengkap dengan *ukel*, *isen-isen*, dan *mlinjon*).
- **📲 Dukungan PWA & Offline**
  Dapat diinstal di desktop maupun ponsel serta berjalan offline melalui `Service Worker`.

---

## Cara Menggunakan

1. **QR Optik**: Pilih tab **QR Optik**, klik **Kirim File** pada perangkat pengirim lalu pilih file (`< 2 MB` disarankan), dan klik **Terima File** serta aktifkan kamera pada perangkat penerima sambil menghadapkan kedua layar.
2. **WLAN / Provider**: Pilih **Buat Koneksi / Sesi (Pengirim)** untuk menghasilkan kode *Offer*, tempelkan di perangkat penerima (**Gabung Koneksi / Sesi**) untuk membuat kode *Answer*, lalu tempelkan kembali *Answer* ke pengirim untuk mulai mengirim file.

---

## Pengembangan Lokal

Pastikan **Node.js 20+** sudah terpasang, lalu jalankan:

```bash
npm install
npm run dev
```

## Build Produksi

```bash
npm run build
```

Hasil build akan dibuat di folder `dist/`. Workflow GitHub Actions ([`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)) secara otomatis membangun bundel produksi dan men-deploy ke **GitHub Pages** setiap ada push ke branch `main`.

## Laporkan Bug & Masukan

Menemukan kendala tampilan, kamera QR, atau koneksi P2P? Silakan laporkan melalui tombol **Laporkan Bug** di bagian bawah aplikasi atau langsung buka [GitHub Issues](https://github.com/jaiz-lana/ThinkSend/issues).

## Rilis

Setiap pembaruan versi dicatat di halaman [GitHub Releases](https://github.com/jaiz-lana/ThinkSend/releases).
