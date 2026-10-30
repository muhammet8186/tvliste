# Render TV Kaynak Tarayıcı

## GitHub ve Render kurulumu
1. GitHub'da yeni bir repository oluşturun.
2. `server.js` ve `package.json` dosyalarını repository ana dizinine yükleyin.
3. Render'da **New + → Web Service** seçip GitHub repository'nizi bağlayın.
4. Runtime: **Node**; Build Command: `npm install`; Start Command: `npm start`.
5. Environment Variables bölümünde `ALLOWED_HOSTS` = `blog.canlitvizle.tv` ekleyin.
6. Deploy işlemini başlatın.

Deploy tamamlanınca Render size `https://....onrender.com` adresi verir. Bu adresi mevcut HTML programındaki Worker URL alanına yapıştırın.

## Sınırlar
Yalnızca herkese açık HTTPS sayfaları taranır. İzin listesinde olmayan alan adları engellenir. Giriş, abonelik veya DRM koruması aşılmaz. JavaScript ile sonradan oluşturulan listeler veya korumalı oynatıcı bağlantıları bulunamayabilir. Bulunan her bağlantının çalışacağı garanti edilmez.
