# Halo lur! Sugeng rawuh nang Dataiki! 

Awakmu ngerti artine "Dataiki"? Bener banget, tegese "Data iki" alias "This Data" nang basa bule ne. Pas banget karo fungsine, aplikasi iki digawe khusus nggo mbantu kowe ngolah *data iki*, *data iku*, lan kabeh data-datamu sing pating semrawut ben dadi luwih rapi lan siap didadekne *Machine Learning*. 

Kowe ra usah mumet nulis kode *boilerplate* sing bola-bali padha. Seka narik data mentah, reresik data, nglatih model, sampe *deploy* dadi API—kabeh kari *drag-and-drop* nang kanvas sing penak banget didelok! 

---

## Ngopo Kowe Bakal Seneng Banget Karo Dataiki?

- **Narik Data Gede Tanpa Bikin Laptop Lemot (Anti-OOM):** 
  Arep narik data seka MSSQL, PostgreSQL, MySQL, Oracle, utawa REST API? Bisa! Duwe file CSV/Excel sing ukurane gajah? Tinggal cemplungne nang folder lokal. Dataiki nggawe ilmu *out-of-core* seka Polars lan DuckDB, dadi RAM laptopmu bakal tetep aman sentosa. Datamu otomatis diowahi dadi format `.parquet` ben prosese ngacir!

- **Beres-beres Data Kari Numpuk Kartu (Stackable Recipe):** 
  Lali wae ngetik skrip dawa sing marai ngelu. Nang kene, kowe kari numpuk "Kartu Resep" gawe mfilter, ngisi data sing bolong, utawa gawe fitur anyar. Mantep-e meneh, tumpukan resep iki bakal dadi "satpam" pas modelmu wis *live*. Nek ana request API sing ora sesuai karo aturan resepmu, otomatis langsung ditolak (HTTP 422) sedurunge model e kebingungan.

- **Golek Model Sing Paling Jos Tanpa Ribet (ML Studio):**
  - *Tahap Audisi (Screening):* Sistem bakal ngadu macem-macem algoritma nggawe sampel data, ben cepet ketemu sapa sing pantes masuk klasemen (Leaderboard).
  - *Tahap Final (Deep Tuning):* Pilih algoritma sing menang, terus jarno Optuna sing mikir keras nggoleki *setting*-an paling pas (hyperparameter) nang data utuhmu.

- **Akal-akalan Gawe Data Jomplang:** 
  Data klasifikasi-mu kurang seimbang? Nganggo wae SMOTE. Utawa regresi-ne kurangan baris? Tambahi Gaussian Jitter. Sing pinter seka Dataiki, proses iki *mung* mlaku pas lagi masa sinau (*training*) ae. Dadi data tes lan API *live* mu tetep murni ra kecampur data gawe-gawean!

- **Langsung Gasss nang Production! (MLOps Gateway):**
  Nek modelmu wis pinter, wektune di-pamerne nggawe 3 cara gampang iki:
  1. Bikin **REST API Dinamis** sing endpoint-e iso mbok atur sak karepmu.
  2. Ekspor dadi file **.zip Mandiri**. Wenehke nang tim IT, iso langsung mlaku nang server endi wae tanpa butuh nginstal Dataiki meneh (*Zero Vendor Lock-in*).
  3. Gawe **Jadwal Otomatis (Batch Job)** nggawe kalender sing gampang diwaca. Ora usah mumet ngapalke kode Cron!

- **Aman lan Bisa Dibalekne (Immutable & Rollback):** 
  Model sing wis *live* bakal dibekukan. Nek kowe arep nglatih maneh nganggo data sasi iki (*retrain*), Dataiki bakal ngunci parametere lan nyimpen versi anyar sebagai cadangan (*Staged*). Jebule model sing anyar asile luwih elek? Tenang, tinggal klik sepisan gawe mbalekne (*Rollback*), lan API-mu bakal tetep aman nggawe model sing lawas.

---

## Ayo Dijajal Saiki! (Carane Nginstal)

### 1. Siapke Mesine (Backend)
Clone disik repositori iki lan siapke *environment* Python-mu (pastikne nggawe Python 3.10 munggah ya lur!).

```bash
git clone [https://github.com/tonshans/dataiki.git](https://github.com/tonshans/dataiki.git)
cd dataiki
python -m venv venv
source venv/bin/activate  # Nek nggawe Windows ketike: venv\Scripts\activate.bat

# Install kebutuhane lan uripke servere!
pip install -r requirements.txt
uvicorn backend.main:app --host 127.0.0.1 --port 8000 --reload

```

Oracle: default thin mode. Set `DATAIKI_ORACLE_THICK=1` jika memakai Oracle Instant Client.

Freestyle Script Editor: aktif secara default (`DATAIKI_ALLOW_FREESTYLE=1`). Set
`DATAIKI_ALLOW_FREESTYLE=0` untuk menyembunyikan editor dari UI dan menolak endpoint
`/api/production/scripts/*`. Catatan: script berjalan dengan akses penuh ke proses server.

CORS: default hanya `http://localhost:5173` dan `http://127.0.0.1:5173`. Untuk origin lain
(mis. `npm run preview` di port 4173), set `DATAIKI_CORS_ORIGINS=http://localhost:4173`.
Jangan set `DATAIKI_CORS_ALLOW_CREDENTIALS=1` bersama `*`.

### 2. Uripke Tampilane (Frontend)

Buka terminal anyar, terus jalanne React/Vite-ne:

```bash
cd frontend
npm install
npm run dev
```

### 3. Mulai Dolanane!

- Konek Data: Buka UI Dataiki, mlebu nang menu Sidebar Palette, terus isi kredensialmu nang Connection Vault. File CSV raksasa? Copy-paste wae langsung nang folder storage/uploads/ nang komputermu.

- Eksplorasi: Tarik Node Ingestion nang kanvas. Klik gawe buka laci data, cek fill-rate tiap kolom, lan delok grafike. Tumpuk kartu resep gawe ngeresiki datamu.

- Latih AI-ne: Sambungne data sing wis resik nang Node ML Studio, pilih targete, lan mulai audisi algoritma!

- Publish: Pindah nang mode Production Gateway lan pamerne modelmu dadi API utawa Scheduler.

Sugeng bereksperimen karo datamu.
