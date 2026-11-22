# Security Review

## Ringkasan

Rilis 0.4.3 menerapkan validasi metadata transfer QR, pembatasan ukuran transfer, kode ruang acak yang lebih kuat, CSP untuk PWA statis, dan audit dependensi produksi.

## Temuan yang sudah ditangani

- Metadata QR Optik sekarang menolak nama file lebih dari 255 karakter, SHA-256 yang bukan 64 karakter heksadesimal, ukuran lebih dari 100 MB, dan jumlah blok yang tidak sesuai dengan ukuran yang dinyatakan.
- Hasil rakitan juga harus memiliki ukuran byte tepat yang dinyatakan dan mencocokkan SHA-256 sebelum ditampilkan sebagai transfer berhasil.
- Kode ruang baru menggunakan `crypto.getRandomValues()` dan minimal 12 karakter. Pemformatan tetap menerima kode ruang lama 4–16 karakter.
- PWA statis dipasang CSP yang membatasi skrip dan worker ke sumber lokal, gaya ke sumber lokal/inline yang dibutuhkan aplikasi, serta koneksi ke sumber HTTPS/WSS, `blob`, dan `data` yang diperlukan.
- CI build GitHub Pages menjalankan audit dependensi produksi.

## Risiko residu

- Protokol QR hanya menawarkan verifikasi integritas; kamera dan pengguna tetap harus memverifikasi bahwa layar dan perangkat pengirim merupakan pihak yang benar.
- WebRTC, relay, dan koneksi HTTPS/WSS bergantung pada konfigurasi dan keamanan jaringan peramban.
- Aplikasi statis tidak dapat menolak seluruh malware atau isi berbahaya; pengguna tetap harus memeriksa file sebelum membukanya.
- Browser lama atau mode berkas tanpa API Web Crypto atau kamera dapat membatasi fitur PWA.
