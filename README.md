# TV Kaynak Tarayıcı – Render sürümü 2.0

Bu servis, izin verilen HTTPS alan adındaki herkese açık sayfaları tarar; kanal sayfalarını takip eder ve sayfa HTML'i / satır içi betiklerinde açıkça bulunan `.m3u` veya `.m3u8` adreslerini yakalamaya çalışır.

## Render ayarları
- Runtime: Node
- Build Command: `npm install`
- Start Command: `npm start`
- Environment variable `ALLOWED_HOSTS`: `blog.canlitvizle.tv` (yalnızca bu site taranacaksa)

`/health` kontrolü sürüm bilgisini döndürür. `/scan?url=https%3A%2F%2Fblog.canlitvizle.tv%2Fkategori%2Fyerel` taramayı başlatır.

## Önemli sınırlar
- Yalnızca izin listesinde bulunan HTTPS alan adları taranır. Harici iframe/video sağlayıcılarına otomatik istek gönderilmez.
- Tarama, herkese açık statik HTML ve sayfa içindeki metinleri inceler; JavaScript çalıştırmaz, oturum açmaz, DRM/abonelik/erişim korumasını aşmaz.
- Bazı siteler yayın adreslerini tarayıcıda JavaScript ile veya korumalı oynatıcı arkasında oluşturur. Bu durumda kanal sayfası bulunabilir ama doğrudan M3U8 adresi bulunamayabilir. Böyle bir sayfa URL'si M3U listesine doğrudan yayınmış gibi eklenmez.
- En fazla 25 sayfa taranır. Tarama sırasında sayfa başına 2 MB ve 12 saniye sınırı vardır.

## Güncelleme
Bu dosyaları Render servisine bağlı Git deposundaki mevcut `server.js` ve `README.md` ile değiştirip gönderin. Depo bağlantılı ve otomatik dağıtım açıksa Render yeni commit'i otomatik dağıtır; değilse Dashboard > Deploys > Manual Deploy üzerinden dağıtım başlatın.
