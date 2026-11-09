# Diagnosis jaringan MikroTik

Repo ini menyediakan alat pembacaan dan panduan diagnosis untuk agent. Panduan membantu memilih bukti yang perlu diperiksa; panduan tidak menggantikan pengukuran, pengetahuan topologi, atau penilaian administrator.

Instruksi bersama berada di `src/network-engineer.ts`. MCP mengirim instruksi itu saat initialize dan menyediakan resource `mikrotik://knowledge/network-engineering`. Bot Telegram menyertakannya pada instruksi agent untuk transport App Server maupun CLI. Klien yang hanya mendukung tool dapat membaca runbook melalui `mikrotik_guide`.

## Pilih alat berdasarkan pertanyaan

| Pertanyaan | Alat dan bukti | Batas kesimpulan |
| --- | --- | --- |
| Rate port ISP berapa? | `mikrotik_ethernet_monitor`, `negotiated_rate` | Rate link fisik, bukan paket internet |
| Pemakaian bandwidth sekarang? | `mikrotik_traffic`, RX/TX bits/s | Sampel sesaat dari sudut router |
| Interface aktif? | `mikrotik_inspect` target `interfaces` | `running` tidak memastikan internet bekerja |
| Router bisa menjangkau tujuan? | `mikrotik_ping` dengan konteks routing | ICMP dari router, bukan tes layanan klien |
| Mengapa klien gagal? | Guide sesuai topik, query konfigurasi/status, probe relevan | Perlu memeriksa jalur klien dan jalur balik |

`configured_speed=100Mbps` dan `negotiated_rate=1Gbps` dapat muncul bersamaan ketika auto-negotiation aktif. Gunakan `negotiated_rate` untuk menjawab rate aktual. Jika monitor tidak memberikan rate, field itu `null`. Jangan mengisinya dari konfigurasi atau laporan sebelumnya. [Dokumentasi Ethernet MikroTik](https://help.mikrotik.com/docs/spaces/ROS/pages/8323191/Ethernet) menjelaskan perbedaan pengaturan speed dan hasil monitor.

Contoh input tool:

```json
{"interfaces":["ISP-1","ISP-2"]}
```

Input ini berlaku untuk `mikrotik_ethernet_monitor` dan `mikrotik_traffic`. Temukan nama interface terlebih dahulu. Setiap permintaan menerima 1 sampai 16 nama berbeda dan menjalankan monitor `once` per interface secara berurutan. Waktu pengamatan tercatat per interface; sampel kedua port tidak persis bersamaan. Selector `all` dan nama berisi koma ditolak.

Contoh probe yang alamat dan tabelnya harus disesuaikan setelah pemeriksaan routing:

```json
{"address":"192.0.2.1","count":3,"src_address":"192.0.2.2","routing_table":"wan1"}
```

Alamat di atas adalah contoh dokumentasi, bukan gateway atau tabel yang diketahui ada di router pengguna. Ping dibatasi 1 sampai 10 paket dengan interval 200 ms. Tool mengirim konteks probe yang diminta dan balasan RouterOS; tool tidak menghapus parameter yang ditolak versi router. Gunakan routing table atau kebijakan yang sudah diverifikasi sebelum menyatakan sebuah probe menguji ISP tertentu. [Parameter ping RouterOS](https://help.mikrotik.com/docs/spaces/ROS/pages/8323183/Ping) dan [policy routing](https://help.mikrotik.com/docs/spaces/ROS/pages/59965508/Policy+Routing) menjadi acuan.

Tool diagnosis tidak mengubah konfigurasi. Ping menghasilkan trafik ICMP kecil. Monitor bukan bandwidth test; tidak ada torch, sniffer, traffic generator, reboot atau putus link dalam tool diagnosis ini. `mikrotik_query` tetap terbatas pada `/print` dan `/getall`, dengan `file`, `follow`, `follow-only` dan `interval` ditolak agar tidak menulis file atau mengikuti stream terus-menerus.

Akun API memerlukan policy `test` untuk menjalankan ping. Jangan mengubah policy otomatis jika probe ditolak; laporkan kebutuhan izin kepada administrator. Policy tersebut lebih luas daripada ping, sedangkan tool MCP ini hanya menyediakan probe yang dibatasi. Acuan: [user policies RouterOS](https://help.mikrotik.com/docs/spaces/ROS/pages/8978504/User).

## Runbook yang tersedia

Panggil `mikrotik_guide` dengan `topic` berikut. Setiap hasil menyertakan langkah pemeriksaan dan sumber resmi MikroTik.

| Topic | Pemeriksaan |
| --- | --- |
| `interfaces` | Negosiasi link, duplex, error/FCS, link flap, trafik |
| `connectivity` | WAN/LAN, gateway, probe IP, DNS, jalur klien |
| `routing` | ROS 6/7, policy routing, PCC, ECMP, recursive route, failover |
| `dynamic_routing` | OSPF adjacency, BGP session/prefix, BFD, VRF |
| `ipv6` | Address, default route, ND/RA, DHCPv6-PD, firewall IPv6 |
| `firewall` | Packet path, input/forward/output, NAT, conntrack, FastTrack, IPv6 |
| `vlan` | Bridge ports, VLAN table, PVID, CPU port, hardware offload |
| `dhcp_dns` | Pool, subnet, lease, DHCP client, resolver, IPv6 |
| `hotspot_pppoe` | Sesi, autentikasi, queue dinamis, MTU/MRU, batas akses secret |
| `vpn` | Jenis tunnel, handshake, route kedua arah, NAT, MTU |
| `queues` | Simple queue/tree, marks, arah trafik, FastTrack, resource |
| `wireless` | Versi/package, registration table, PHY rate, radio dan backhaul |

Gunakan query terarah dengan `proplist` dan `limit`. Banyak menu berbeda antarversi dan package. Data yang tepat mencapai batas `limit` mungkin terpotong. Jangan menyebut `count` baris yang dikembalikan sebagai total seluruh sesi/perangkat tanpa pemeriksaan tambahan.

Menu yang dapat mengandung credential tetap mengikuti pembatasan sensitive read. Runbook VPN atau Hotspot tidak membuka akses ke private key, PPP secret atau RADIUS secret. Jangan menonaktifkan pembatasan demi melengkapi laporan.

## Standar jawaban dan perubahan

Jawaban menyampaikan hasil yang terukur lebih dahulu. Jika perlu, lanjutkan dengan sumber/waktu, dugaan penyebab yang belum terbukti dan langkah berikutnya. Koreksi laporan yang keliru dengan membaca sumber yang sesuai; jangan sekadar mengulang angka yang diberikan pengguna sebagai hasil pengukuran sendiri.

Untuk perubahan, periksa kondisi awal dan target, jelaskan dampaknya pada akses manajemen, susun preview command yang tepat, verifikasi sesudah penerapan dan siapkan rollback berdasarkan kondisi awal. Gunakan persetujuan yang sudah diterapkan pada stdio, Telegram atau HTTP. Tidak ada transaksi atomik lintas command dan tidak ada jaminan rollback otomatis.

## Verifikasi

Jalankan pada Node 20 atau lebih baru:

```bash
npm run typecheck
npm test
npm run build
```

Pengujian memakai server RouterOS tiruan untuk kasus konfigurasi 100 Mbps dengan rate aktual 1 Gbps, rate tidak tersedia, link turun, izin monitor ditolak, interface salah, trafik, konteks ping dan parameter tidak didukung. Pengujian MCP memeriksa discovery, instruksi, guide/resource dan validasi input. Pengujian ini memverifikasi perilaku alat dan integrasi, bukan akurasi seluruh jawaban model atau semua versi/perangkat RouterOS.

Sebelum aktivasi, periksa rate Ethernet pada perangkat yang diizinkan dan bandingkan dengan tab Status WinBox. Catat versi serta hasilnya tanpa menyimpan credential. Restart proses MCP/bot hanya saat aktivasi diminta. Klien/plugin mungkin memerlukan reconnect atau refresh tool agar definisi tool baru muncul.
