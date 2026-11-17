# ThinkSend

**ThinkSend** adalah aplikasi web **PWA (Progressive Web App)** untuk transfer file cepat lintas jalur secara langsung antar perangkat (*peer-to-peer* / optik) tanpa menyimpan file di server perantara, kini hadir dengan **tema terang khas Telegram** dan **latar belakang motif Batik Parang**.

🌐 **Demo Langsung (GitHub Pages):** https://jaiz-lana.github.io/ThinkSend/

---

## Tentang Aplikasi

ThinkSend dirancang agar perangkat tetap dapat bertukar file dalam berbagai kondisi jaringan—mulai dari kondisi 100% offline tanpa sinyal sama sekali, jaringan Wi-Fi lokal (otomatis maupun tanpa internet), hingga koneksi internet jarak jauh dengan jaminan keamanan **End-to-End**:

- **📷 QR Optik (100% Offline)**
  Transfer file melalui cahaya layar ke kamera menggunakan rangkaian kode QR beruntun (*animated QR stream*) lengkap dengan verifikasi integritas **SHA-256** (`qrcode`, `jsqr`, dan `BarcodeDetector`).
- **📶 WLAN (Wi-Fi Lokal P2P — Penemuan Otomatis & Offline Murni)**
  - **Radar Wi-Fi Otomatis**: Mendeteksi perangkat lain di jaringan Wi-Fi yang sama secara otomatis (alamat IP publik hanya di-hash lokal `SHA-256`—relay tidak pernah mengetahui IP mentah pengguna).
  - **Kode Ruang & Scan QR Ruang**: Buat kode ruang privat 6 karakter atau tautan QR `#wlan-room=...` agar aman di Wi-Fi publik, *CGNAT*, atau lintas jaringan, tanpa perlu akun maupun server pribadi.
  - **Offline Murni (QR / Teks)**: Transfer tanpa akses internet sama sekali di router lokal dengan memindai QR Offer ↔ QR Answer terkompresi (*single-frame QR*).
  - **Relay Signaling E2EE Tanpa Server Pribadi**: Memakai relay Nostr ephemeral publik sebagai pipa buta (pesan dienkripsi kunci ruang + **ECDH** per pasangan perangkat) serta mendukung **Custom WebSocket URL** bagi pengguna yang ingin *self-host*.
- **🌐 Provider (Internet P2P)**
  Transfer jarak jauh menggunakan data seluler/internet melalui koneksi **WebRTC P2P** terenkripsi *End-to-End* dengan kode sesi ringkas terkompresi.
- **🛡️ Enkripsi End-to-End Berlapis**
  Setiap transfer WebRTC diamankan oleh **DTLS** WebRTC ditambah lapisan aplikasi **ECDH P-256 + HKDF-SHA256 + AES-256-GCM**, kode pencocokan **SAS 6 digit**, opsi **PIN Terima 4 digit** (*HMAC challenge-response* tanpa mengirim PIN *plaintext*), serta verifikasi **SHA-256 streaming** penuh sebelum file disimpan.
- **🎨 Desain Telegram Light + Batik Parang**
  Antarmuka terang dengan palet biru khas Telegram (`#2AABEE` / `#3390EC`), tab navigasi modern, kartu gelembung pesan yang bersih, serta pola vektor *seamless* **Batik Parang** (lengkap dengan *ukel*, *isen-isen*, dan *mlinjon*).
- **📲 Dukungan PWA & Offline**
  Dapat diinstal di desktop maupun ponsel serta berjalan offline melalui `Service Worker`.

---

## Cara Menggunakan

1. **QR Optik**: Pilih tab **QR Optik**, klik **Kirim File** pada perangkat pengirim lalu pilih file (`< 2 MB` disarankan), dan klik **Terima File** serta aktifkan kamera pada perangkat penerima sambil menghadapkan kedua layar.
2. **WLAN (Otomatis)**: Buka tab **WLAN** di kedua perangkat:
   - Gunakan **Radar Wi-Fi Otomatis** di Wi-Fi pribadi, atau pilih **Kode Ruang / Scan QR** jika berada di Wi-Fi publik/berbeda jaringan.
   - Opsional: aktifkan **PIN Terima** untuk perlindungan tambahan.
   - Klik **Kirim File** di samping nama perangkat tujuan, pilih satu atau banyak file, lalu penerima menekan **Terima (E2EE)** dan cocokkan kode 6 digit sebelum/saat transfer berjalan.
3. **WLAN (Offline Murni) & Provider**: Untuk kondisi tanpa internet sama sekali di LAN (atau internet jarak jauh pada tab **Provider**), gunakan **Scan QR Offer ↔ Answer** (atau salin-tempel kode sesi ringkas secara manual).

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
