> **ChatGPT Custom MCP:** An optional authenticated, stateless Streamable HTTP service and local terminal-approved writes are documented in [docs/chatgpt-mcp.md](docs/chatgpt-mcp.md). The Codex CLI stdio service and Telegram bot also use the shared diagnosis tools and guidance.

# Codex CLI untuk MikroTik RouterOS 6 dan 7

MCP server lokal agar Codex CLI dapat membaca status dan, jika diaktifkan secara eksplisit, mengubah konfigurasi MikroTik. Koneksi memakai protokol RouterOS API native sehingga satu implementasi bekerja di RouterOS 6 dan 7.

Fitur utama:

- RouterOS API port 8728 dan API SSL port 8729
- login plaintext untuk ROS 6.43+ dan ROS 7
- fallback challenge-response untuk ROS sebelum 6.43
- tool siap pakai untuk resource router, interface, IP, route, ARP, DHCP lease, firewall, neighbor, DNS cache, dan log
- query `/print` atau `/getall` untuk menu RouterOS lain
- monitor rate link aktual, trafik RX/TX, dan ping terbatas tanpa mengubah konfigurasi
- panduan diagnosis routing, VLAN, firewall, DHCP/DNS, Hotspot/PPPoE, VPN, queue dan Wi-Fi melalui `mikrotik_guide`
- operasi tulis mati secara default dan dibatasi ke aksi yang diizinkan
- path yang lazim berisi password, private key, atau secret diblokir secara default

## Persyaratan

- Node.js 20 atau lebih baru
- Codex CLI
- akses jaringan dari komputer ini ke router
- service `api` atau `api-ssl` aktif di MikroTik

## 1. Siapkan akun MikroTik

Jalankan di terminal MikroTik sebagai administrator. Ganti subnet dengan alamat komputer atau subnet manajemen yang benar.

```routeros
/user group add name=codex-read policy=api,read
/user add name=codex group=codex-read password="PASSWORD_KUAT"
/ip service set api disabled=no port=8728 address=192.168.88.0/24
```

Tool ping memerlukan policy RouterOS `test` selain `api,read`. Administrator dapat menambahkannya bila probe dibutuhkan. Policy `test` juga mencakup kemampuan lain di RouterOS; MCP tetap membatasi tool probe ke ping 1 sampai 10 paket. Jika izin ditolak, agent harus melaporkan keterbatasan itu. Lihat [policy user MikroTik](https://help.mikrotik.com/docs/spaces/ROS/pages/8978504/User).

Untuk penggunaan baca-tulis, buat group terpisah. Aktifkan hanya saat dibutuhkan:

```routeros
/user group add name=codex-write policy=api,read,write
/user set codex group=codex-write
```

API port 8728 tidak mengenkripsi password maupun data. Gunakan hanya pada LAN manajemen/VPN tepercaya. Untuk jaringan lain, konfigurasi sertifikat RouterOS lalu gunakan `api-ssl` port 8729 dan `MIKROTIK_TLS=true`.

## 2. Instal dan build

```bash
git clone git@github.com:emmeril/codex-mikrotik.git
cd codex-mikrotik
npm ci
npm run build
cp .env.example .env
chmod 600 .env
```

Edit `.env`, minimal isi `MIKROTIK_HOST`, `MIKROTIK_USERNAME`, dan `MIKROTIK_PASSWORD`.

## 3. Daftarkan ke Codex CLI

Gunakan path absolut agar server tetap dapat dijalankan dari direktori mana pun:

```bash
PROJECT_DIR="$(pwd)"
codex mcp add mikrotik -- \
  node --env-file="$PROJECT_DIR/.env" \
  "$PROJECT_DIR/dist/server.js"
```

Pastikan MCP terdaftar:

```bash
codex mcp get mikrotik
codex mcp list
```

Mulai sesi Codex baru. Contoh permintaan:

```text
Cek koneksi MikroTik dan tampilkan versi RouterOS.
Tampilkan interface yang running=false.
Periksa default route dan DHCP lease aktif.
Tampilkan rule firewall filter yang disabled.
```

Tool yang tersedia:

| Tool | Fungsi | Default |
| --- | --- | --- |
| `mikrotik_inspect` | Membaca kelompok data umum | Aktif |
| `mikrotik_query` | Menjalankan `/print` atau `/getall` | Aktif |
| `mikrotik_ethernet_monitor` | Rate link dan duplex aktual, monitor sekali jalan | Aktif |
| `mikrotik_traffic` | Sampel RX/TX bits/s per interface | Aktif |
| `mikrotik_ping` | Probe ICMP 1 sampai 10 paket dari router | Aktif |
| `mikrotik_guide` | Runbook diagnosis dengan sumber resmi MikroTik | Aktif |
| `mikrotik_execute` | `add`, `set`, `remove`, `enable`, `disable`, `move`, `reset-counters` | Nonaktif |

Alur diagnosis, contoh input tool, batas kesimpulan dan aktivasi dijelaskan dalam [panduan network engineering](docs/network-engineering.md). Rate Ethernet aktual berasal dari monitor, sedangkan `speed` pada hasil konfigurasi tidak membuktikan hasil negosiasi link.

## Agent Telegram

Agent Telegram menjalankan Codex App Server lokal yang sudah login dengan akun ChatGPT. Tidak diperlukan `OPENAI_API_KEY`. Satu proses Codex dipertahankan selama bot aktif agar setiap pesan tidak perlu memulai CLI baru. Codex memakai MCP `mikrotik` untuk membaca router dan memahami permintaan pengguna. Mode long polling dipakai sehingga server tidak memerlukan domain publik, HTTPS, atau webhook.

Alur keamanannya:

- hanya Telegram user ID dalam allowlist yang dilayani
- direct message diwajibkan secara default
- credential ChatGPT diambil dari login Codex CLI lokal, tidak disalin ke `.env`
- environment Codex memakai allowlist minimal sehingga token Telegram dan credential RouterOS tidak diwariskan
- sesi berjalan di direktori sementara dengan permission profile filesystem minimal
- Codex hanya diberi MCP `mikrotik` dengan tool baca, monitor, ping terbatas dan panduan diagnosis
- pembacaan router berjalan langsung saat diperlukan
- perubahan konfigurasi dibuat sebagai preview command dan attribute
- perubahan baru dijalankan setelah pemilik menekan tombol `Jalankan`
- konfirmasi terikat ke user dan chat, hanya dapat dipakai sekali, dan kedaluwarsa otomatis
- operasi beruntun dihentikan pada error pertama dan jumlah operasi yang sudah selesai dilaporkan

### 1. Buat bot dan periksa login Codex

1. Chat `@BotFather` di Telegram, jalankan `/newbot`, lalu simpan token bot.
2. Pastikan Codex CLI sudah login dengan akun ChatGPT dan MCP MikroTik tersedia:

```bash
codex login status
codex mcp get mikrotik
```

3. Salin konfigurasi contoh jika `.env` belum ada:

```bash
cp .env.example .env
chmod 600 .env
```

Isi bagian berikut di `.env`:

```dotenv
TELEGRAM_BOT_TOKEN=TOKEN_DARI_BOTFATHER
TELEGRAM_ALLOWED_USER_IDS=0
TELEGRAM_PRIVATE_ONLY=true
CODEX_TIMEOUT_SECONDS=300
CODEX_TRANSPORT=app-server
```

Jalankan bot sementara, kirim `/whoami` melalui Telegram, lalu ganti nilai `TELEGRAM_ALLOWED_USER_IDS=0` dengan ID yang diberikan bot. Beberapa ID dapat dipisahkan dengan koma. Restart bot sesudah mengubah allowlist.

App Server memilih model default yang tersedia pada akun. Jika perlu, model dan reasoning effort dapat dipilih dengan `CODEX_MODEL` dan `CODEX_REASONING_EFFORT`. Set `CODEX_TRANSPORT=exec` untuk kembali ke proses CLI per pesan. `CODEX_SERVICE_TIER=fast` bersifat opsional dan memakai kuota lebih besar daripada mode standar.

### 2. Jalankan agent

```bash
npm ci
npm run build
node --env-file=.env dist/telegram.js
```

Untuk pengembangan tanpa build:

```bash
node --env-file=.env --import tsx src/telegram.ts
```

Untuk menjalankan terus-menerus melalui PM2:

```bash
npm run build
npm run pm2:start
pm2 save
```

Operasional berikutnya:

```bash
npm run pm2:restart
npm run pm2:logs
pm2 status mikrotik-telegram
```

Entry PM2 memakai nama `mikrotik-telegram`, menjalankan satu instance, melakukan auto-restart dengan jeda lima detik, dan membaca konfigurasi dari `.env`.

Contoh chat:

```text
Cek versi RouterOS, uptime, CPU, dan memory.
Interface mana yang tidak running?
Tampilkan DHCP lease aktif dan ringkas per subnet.
Periksa firewall filter yang disabled.
Tambahkan address 10.20.0.1/24 ke ether4 dengan comment LAN-CCTV.
```

Empat contoh pertama hanya membaca data. Contoh terakhir menghasilkan preview dan tombol konfirmasi.

### 3. Izinkan konfigurasi

Secara default agent hanya dapat membaca router. Untuk mengizinkan `add`, `set`, `remove`, `enable`, `disable`, `move`, dan `reset-counters`, ubah `.env`:

```dotenv
MIKROTIK_WRITE_ENABLED=true
```

Restart agent setelah perubahan. Aksi seperti reboot, shutdown, reset configuration, dan install package tetap tidak diizinkan. Untuk mengurangi dampak jika token bocor, gunakan akun RouterOS khusus, batasi alamat sumber API, gunakan API SSL atau VPN, dan jangan memberikan policy yang tidak dibutuhkan.

Perintah bot:

| Perintah | Fungsi |
| --- | --- |
| `/start` atau `/help` | Contoh penggunaan dan bantuan |
| `/whoami` | Telegram user ID dan chat ID |
| `/new` | Menghapus konteks percakapan aktif |

## Mengaktifkan perubahan konfigurasi

Ubah `.env` lalu mulai ulang sesi Codex:

```dotenv
MIKROTIK_WRITE_ENABLED=true
```

Tool tulis tetap mewajibkan `confirm=true` pada setiap panggilan dan menolak aksi di luar allowlist. Perintah seperti reboot, shutdown, reset configuration, dan install package tidak tersedia.

Contoh permintaan yang cukup spesifik:

```text
Tambahkan address 10.10.10.1/24 ke interface ether3. Tampilkan command dan attribute persisnya, lalu minta konfirmasi saya sebelum mengeksekusi.
```

Meski MCP menyediakan field konfirmasi, selalu minta Codex menunjukkan perubahan final sebelum eksekusi karena rule firewall, route, atau address yang salah dapat memutus akses ke router.

## Query lanjutan

`mikrotik_query` menerima sintaks query word RouterOS. Contoh input MCP:

```json
{
  "command": "/ip/firewall/nat/print",
  "queries": ["?disabled=false"],
  "proplist": [".id", "chain", "action", "comment"],
  "limit": 100
}
```

Pembacaan menu sensitif seperti `/ppp/secret/print`, `/user/print`, `/certificate/print`, dan `/system/script/print` ditolak. Jika benar-benar diperlukan, set `MIKROTIK_SENSITIVE_READ_ENABLED=true`; nilai ini terpisah dari izin tulis.

## API SSL dan sertifikat

Dengan CA internal:

```dotenv
MIKROTIK_TLS=true
MIKROTIK_PORT=8729
MIKROTIK_TLS_CA_FILE=/absolute/path/router-ca.pem
MIKROTIK_TLS_SERVER_NAME=router.example.net
MIKROTIK_TLS_REJECT_UNAUTHORIZED=true
```

Sertifikat self-signed dapat dipakai dengan `MIKROTIK_TLS_REJECT_UNAUTHORIZED=false`, tetapi koneksi menjadi rentan terhadap penyamaran router. Lebih baik percaya CA internal dan biarkan verifikasi aktif.

## Pengembangan

```bash
npm run typecheck
npm test
npm run build
```

Server memakai stdio untuk MCP. Jangan menulis log biasa ke stdout karena dapat merusak framing JSON-RPC; diagnostik server ditulis ke stderr.

## Pemecahan masalah

- `connection refused`: pastikan service `api`/`api-ssl` aktif dan port benar.
- `timed out`: periksa firewall router, routing, dan field `address` pada `/ip service`.
- `cannot verify certificate`: isi CA file dan server name dengan benar; jangan langsung mematikan verifikasi pada jaringan publik.
- `not enough permissions`: periksa policy group user MikroTik.
- MCP tidak muncul: jalankan `npm run build`, cek `codex mcp get mikrotik`, lalu buka sesi Codex baru.

## Batasan

- Transport stdio tidak membuka port lokal. Transport HTTP opsional membuka listener loopback sesuai konfigurasinya.
- API lama memakai MD5 challenge hanya untuk kompatibilitas. Keamanan transport tetap bergantung pada LAN/VPN atau API SSL.
- Kompatibilitas login diuji otomatis dengan server tiruan. Uji terhadap perangkat fisik tetap diperlukan karena konfigurasi service, policy, dan TLS berbeda per router.
