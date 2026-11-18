# ThinkSend

**ThinkSend** adalah aplikasi web **PWA (Progressive Web App)** untuk transfer file cepat lintas jalur secara langsung antar perangkat (*peer-to-peer* / optik) tanpa menyimpan file di server perantara, hadir dengan **tema terang khas Telegram** dan **latar belakang motif Batik Parang**.

🌐 **Demo Langsung (GitHub Pages):** https://jaiz-lana.github.io/ThinkSend/

---

## Fitur Utama

- **📷 QR Optik (100% Offline)**
  Transfer file melalui cahaya layar ke kamera menggunakan rangkaian kode QR beruntun (*animated QR stream*) lengkap dengan dukungan seret &amp; lepas (*drag & drop*) serta verifikasi integritas **SHA-256** (`qrcode`, `jsqr`, dan `BarcodeDetector`).
- **📶 WLAN (Wi-Fi Lokal P2P)**
  Disederhanakan dalam 3 pilihan langsung di menu **WLAN**:
  - **Wi-Fi Sekitar**: Deteksi otomatis perangkat lain di Wi-Fi yang sama (*IP* publik di-hash lokal `SHA-256`, dilengkapi filter identitas perangkat persisten untuk mencegah perangkat mendeteksi dirinya sendiri — Issue #1). Jika Wi-Fi sedang tanpa akses internet, tersedia pintasan langsung ke **Tanpa Internet**; serta validasi &amp; pemulihan otomatis ke Relay Default jika URL WebSocket kustom tersimpan tidak valid.
  - **Kode Ruang**: Buat kode ruang privat 6 karakter, salin kode/tautan, atau scan QR ruang (`#wlan-room=...`) agar aman di Wi-Fi publik, *CGNAT*, atau lintas jaringan.
  - **Tanpa Internet**: Transfer 100% tanpa internet sama sekali di router/hotspot lokal melalui scan QR Offer ↔ Answer terkompresi (*single-frame QR*) atau salin-tempel teks manual.
- **🌐 Provider (Internet P2P)**
  Transfer jarak jauh lewat internet/data seluler melalui terowongan **WebRTC P2P** terenkripsi *End-to-End*, kini dilengkapi tombol cepat **Salin Kode**, **Tempel**, serta berbagi &amp; memindai **QR Kode Sesi / Balasan**.
- **🛡️ Enkripsi End-to-End Berlapis**
  Setiap transfer WebRTC diamankan oleh **DTLS** WebRTC ditambah lapisan aplikasi **ECDH P-256 + HKDF-SHA256 + AES-256-GCM**, kode pencocokan **SAS 6 digit**, opsi **PIN Terima 4 digit** (*HMAC challenge-response* tanpa mengirim PIN *plaintext*), serta verifikasi **SHA-256 streaming** penuh sebelum file disimpan.
- **🎨 Desain Telegram Light + Batik Parang & Standar Web Modern**
  Palet biru Telegram dengan pola vektor *seamless* **Batik Parang**, dialog modal &amp; bilah progres HTML semantik (`<dialog>`, `<progress>`), tombol salin dengan umpan balik langsung yang aksesibel, serta dukungan navigasi keyboard &amp; zoom yang ramah pengguna.
- **📲 Dukungan PWA &amp; Offline**
  Dapat diinstal di desktop maupun ponsel dan berjalan offline melalui `Service Worker`.

---

## Cara Menggunakan

1. **QR Optik**: Pilih tab **QR Optik**, klik **Kirim File** pada pengirim lalu pilih atau seret file (`< 2 MB` disarankan), dan klik **Terima File** serta aktifkan kamera pada penerima sambil menghadapkan kedua layar.
2. **WLAN (Wi-Fi Sekitar / Kode Ruang)**: Buka tab **WLAN** di kedua perangkat:
   - Gunakan **Wi-Fi Sekitar** di Wi-Fi pribadi, atau pilih **Kode Ruang** jika berada di Wi-Fi publik/jaringan berbeda.
   - Opsional: aktifkan **PIN Terima** untuk perlindungan tambahan.
   - Klik **Kirim File** di samping nama perangkat tujuan, pilih satu atau banyak file, lalu penerima menekan **Terima File** dan mencocokkan kode 6 digit.
3. **WLAN (Tanpa Internet) &amp; Provider**: Untuk kondisi tanpa internet sama sekali di LAN (atau internet jarak jauh pada tab **Provider**), ikuti langkah **1. Saya Pengirim ↔ 2. Saya Penerima** menggunakan scan QR atau tombol **Salin Kode / Tempel**.

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

## Laporkan Bug &amp; Masukan

Menemukan kendala tampilan, kamera QR, atau koneksi P2P? Silakan laporkan melalui tombol **Laporkan Bug** di bagian bawah aplikasi atau langsung buka [GitHub Issues](https://github.com/jaiz-lana/ThinkSend/issues).

## Rilis

Setiap pembaruan versi dicatat di halaman [GitHub Releases](https://github.com/jaiz-lana/ThinkSend/releases).
