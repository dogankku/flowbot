# FlowBot — Kripto Para Akışı Tarayıcı ve Alım-Satım Botu

FlowBot borsadaki en likit coinleri sürekli tarar, **büyük para girişini** (hacim patlaması, balina
alımları, agresif alıcı baskısı, emir defteri dengesizliği, gizli birikim) tespit eder, bunları
0–100 arası bir skora çevirir ve:

- `scan` modunda sadece **uyarı** verir (Telegram),
- `paper` modunda **sanal parayla** otomatik al-sat yapar,
- `live` modunda **gerçek parayla** işlem yapar.

Hepsi aynı kodu kullanır: paper'da test ettiğin strateji canlıda birebir aynı çalışır.

## 🌐 Canlı web paneli: https://dogankku.github.io/flowbot/

Kurulum gerektirmez, tarayıcıda açılır:
- Binance'ten **anlık fiyatlar** (WebSocket), en likit 60 USDT paritesi
- Her dakika **para akışı taraması** (Python botuyla aynı 6 dedektör ve skor; `assets/flow.js`)
- **Canlı balina akışı**: büyük tekil piyasa emirleri ve son 15 dakikanın net balina akışı
- Canlı mum grafiği, 5 dakikalık agresif alıcı oranı
- **Paper bot**: "Botu Başlat" ile sanal parayla otomatik al-sat. Durum tarayıcında saklanır, sayfa açıkken çalışır.

GitHub Pages sadece statik dosya sunduğu için web paneli **gerçek parayla işlem yapmaz** (API anahtarını
herkese açık bir sayfaya koymak güvenli değil). 7/24 gerçek işlem için aşağıdaki Python botunu bir sunucuda çalıştır.

---

## 1. Kurulum

```bash
python -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env              # sadece Telegram/canlı mod için doldurman gerekir
python -m pytest -q tests         # 9 test geçmeli
```

## 2. Kullanım

| Komut | Ne yapar |
|---|---|
| `python main.py once` | Tek tarama yapar, en güçlü sinyalleri yazdırır |
| `python main.py scan` | Her dakika tarar, güçlü sinyalde Telegram'a yazar (işlem yok) |
| `python main.py paper` | Sanal 1000 USDT ile otomatik işlem (komisyon + slipaj dahil) |
| `python main.py backtest --symbols BTC/USDT SOL/USDT --days 90` | Geçmiş veride test |
| `python main.py live --i-understand-the-risk` | **Gerçek para** |

Örnek çıktı:

```
PUMP/USDT  skor=80/100  fiyat=106.855
  ▲ volume_spike  1.00  hacim z=6.4 (yeşil mum, 7.3x ort.)
  ▲ money_flow    0.85  birikim=+0.41 MFI=90 OBV akışı=+0.94
  ▲ breakout      1.00  48 bar zirvesi kırıldı (7.3x hacim)
  ▲ whale_trades  0.33  9 balina işlemi: alış $192,339 / satış $96,170
  ▲ taker_flow    0.58  agresif alıcı oranı %67
  ▲ orderbook     1.00  defter dengesizliği +0.66, spread %0.100
```

Tüm sinyaller ve işlemler `data/flowbot.db` (SQLite) dosyasına, loglar `data/flowbot.log` dosyasına yazılır.

## 3. Para akışını nasıl tespit ediyor?

İki aşamalı tarama yapar (borsanın API limitlerine takılmamak için):

**Aşama 1: tüm coinler (sadece mum verisi)**
- **Hacim patlaması**: son mumun hacmi, son 24 saatin medyanından kaç *robust sigma* yukarıda (medyan/MAD; tekil uç değerlerden etkilenmez).
- **Para akışı / birikim**: hacmin mumun üst kısmında mı alt kısmında mı kapandığı (CLV), MFI, OBV.
  OBV yükselirken fiyat yatay kalıyorsa → **gizli birikim** bonusu.
- **Kırılım**: 48 barlık zirvenin hacimle kırılması.

**Aşama 2: en iyi 8 aday (ek API çağrısıyla)**
- **Balina işlemleri**: son 1000 işlem içinde en büyük %1'lik dilim (en az $20k). Balinalar alıyor mu, satıyor mu?
- **Taker akışı (CVD)**: piyasa emriyle agresif alanların oranı ve ivmesi.
- **Emir defteri**: fiyatın ±%1 aralığında alış ve satış derinliği, büyük duvarlar.

Skor long-only'dir: alış yönlü bileşenler skoru artırır, satış yönlü bileşenler düşürür.

**Güvenlik filtreleri**: RSI > 82, fiyat 24s VWAP'tan 5 ATR'den uzak (geç kalmış, kovalama), spread > %0.15 → işlem açılmaz.

## 4. Risk yönetimi (en önemli kısım)

- **Sabit risk**: her işlemde stop olursa kaybedilecek tutar sermayenin **%1'i**. Pozisyon büyüklüğü buna göre hesaplanır.
- Stop = giriş − 2×ATR. 1R kârda stop **başabaşa** çekilir.
- 2R'de pozisyonun **yarısı satılır**; kalanı 2.5×ATR **iz süren stop** ile taşınır.
- En fazla 4 açık pozisyon, tek pozisyon en fazla sermayenin %20'si.
- Gün içinde %4 kayıp olursa o gün **yeni pozisyon açılmaz**.
- Aynı coinde çıkıştan sonra 2 saat bekleme; pozisyon en fazla 24 saat tutulur.

Bütün değerler `config.yaml` içinden değiştirilebilir.

## 5. Önerilen yol haritası

1. **Backtest**: `python main.py backtest --days 120` ile ilk 10 coinde dene. `min_score`, `z_threshold`, `stop_atr_mult` değerleriyle oyna.
   Profit factor > 1.3 ve makul düşüş görmeden ilerleme.
   (Not: geçmiş balina/defter verisi ücretsiz alınamadığı için backtest sadece Aşama 1 dedektörlerini kullanır.)
2. **Paper trading**: en az **2–4 hafta** `paper` modda çalıştır. `data/flowbot.db` içindeki işlemleri incele.
3. **Küçük canlı**: kaybetmeyi göze alabileceğin küçük bir tutarla `live`.
4. Sonuçlara göre ayarları iyileştir.

## 6. Canlı moda geçmeden önce

- Borsada API anahtarı oluştur: **sadece okuma + spot işlem**. **Çekim (withdraw) iznini ASLA açma.** Mümkünse IP kısıtlaması koy.
- `.env` dosyasına anahtarları yaz. Bu dosyayı kimseyle paylaşma.
- Önce `sandbox: true` ile borsanın test ağında dene (Binance Spot Testnet ayrı anahtar ister).
- **Stop'lar bot içinde yönetilir.** Bot kapalıysa stop çalışmaz. Botu 7/24 açık bir VPS'te çalıştır
  (ör. `tmux`, `systemd` veya `nohup python main.py live --i-understand-the-risk &`).
- Bot yeniden başlatılınca açık pozisyonlar `data/state_live.json` dosyasından geri yüklenir.

## 7. Telegram bildirimi

1. Telegram'da @BotFather → `/newbot` → token'ı al.
2. Bota bir mesaj at, `https://api.telegram.org/bot<TOKEN>/getUpdates` adresinden `chat.id`'yi bul.
3. `.env` → `TELEGRAM_TOKEN`, `TELEGRAM_CHAT_ID`; `config.yaml` → `telegram.enabled: true`.

## 8. Dosya yapısı

```
main.py                 komut satırı
config.yaml             tüm ayarlar
flowbot/exchange.py     ccxt borsa bağlantısı (Binance, Bybit, OKX, KuCoin...)
flowbot/indicators.py   göstergeler + özellik üretimi
flowbot/detectors.py    6 para akışı dedektörü
flowbot/scorer.py       skor birleştirme + filtreler
flowbot/positions.py    stop / kâr al / iz süren stop kuralları
flowbot/risk.py         pozisyon büyüklüğü, günlük limit
flowbot/broker.py       PaperBroker / LiveBroker
flowbot/engine.py       ana döngü
flowbot/backtest.py     geçmiş test
tests/                  ağ gerektirmeyen testler
```

## ⚠️ Uyarı

Bu yazılım yatırım tavsiyesi değildir ve kâr garantisi vermez. Kripto piyasaları çok volatildir;
hacim patlamaları sahte (wash trading), emir defteri duvarları ise yanıltıcı (spoofing) olabilir.
Pump'ların önemli bir kısmı hızla geri döner. Kaybetmeyi göze alamayacağın parayla işlem yapma.
