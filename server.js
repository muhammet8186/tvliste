import express from "express";
import * as cheerio from "cheerio";
import { chromium as playwright } from "playwright-core";
import chromium from "@sparticuz/chromium";
import dns from "node:dns/promises";
import net from "node:net";

const app = express();
const PORT = Number(process.env.PORT || 10000);
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || "blog.canlitvizle.tv,canlitv.you")
  .split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
const MAX_PAGES = Math.min(80, Math.max(1, Number(process.env.MAX_PAGES || 35)));
const PAGE_WAIT_MS = Math.min(30000, Math.max(3000, Number(process.env.PAGE_WAIT_MS || 12000)));
const MAX_STREAMS = 300;
const MAX_QUEUE = MAX_PAGES * 3;
const dnsCache = new Map();

function allowedHost(host) {
  host = host.toLowerCase().replace(/\.$/, "");
  return ALLOWED_HOSTS.some(h => host === h || host.endsWith("." + h));
}
function validatePage(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error("Geçerli bir URL girilmedi."); }
  if (u.protocol !== "https:" || !allowedHost(u.hostname) || u.username || u.password || u.port) {
    throw new Error("Bu HTTPS alan adı tarama izin listesinde değil: " + u.hostname);
  }
  u.hash = "";
  return u;
}
function clean(s) { return String(s || "").replace(/\s+/g, " ").trim().slice(0, 140); }
function isPlaylist(url, contentType = "") {
  return /\.m3u8?(?:$|[?#])/i.test(url) || /mpegurl|vnd\.apple\.mpegurl/i.test(contentType);
}
function isTemporary(url) {
  try {
    const keys = [...new URL(url).searchParams.keys()].map(x => x.toLowerCase());
    return keys.some(k => ["tkn", "token", "utkn", "ip", "tm", "expires", "auth", "signature", "sig", "key"].includes(k));
  } catch { return false; }
}
function channelLabel(url, fallback = "") {
  try {
    const u = new URL(url);
    const ch = u.searchParams.get("ch");
    if (ch) return clean(ch.replace(/[-_]/g, " "));
    const name = u.pathname.split("/").filter(Boolean).pop()?.replace(/\.m3u8?$/i, "").replace(/[-_]/g, " ");
    return clean(fallback || name || "Bulunan yayın");
  } catch { return clean(fallback || "Bulunan yayın"); }
}
function scoreLink(label, href) {
  const s = (label + " " + href).toLocaleLowerCase("tr");
  if (/iletişim|iletisim|hakkımızda|hakkimizda|gizlilik|privacy|çerez|cookie|reklam|login|giriş|register|kayıt/.test(s)) return -1;
  if (/trt|atv|show|fox|now|tv8|kanal|haber|spor|çocuk|cocuk|dini|yerel|star|beyaz|ntv|cnn|360|teve|ulusal|canlı|canli/.test(s)) return 5;
  if (/kategori|category|kanallar|channels|\/tv|\/canli/.test(s)) return 3;
  return 1;
}
function isPrivateIPv4(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a,b] = p;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}
function isPublicIP(ip) {
  const version = net.isIP(ip);
  if (version === 4) return !isPrivateIPv4(ip);
  if (version === 6) {
    const x = ip.toLowerCase();
    if (x === "::" || x === "::1" || x.startsWith("fc") || x.startsWith("fd") || x.startsWith("fe8") || x.startsWith("fe9") || x.startsWith("fea") || x.startsWith("feb")) return false;
    if (x.startsWith("::ffff:")) return isPublicIP(x.slice(7));
    return true;
  }
  return false;
}
async function safePublicRequest(raw) {
  try {
    const u = new URL(raw);
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password) return false;
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
    if (net.isIP(host)) return isPublicIP(host);
    const now = Date.now();
    const cached = dnsCache.get(host);
    let addresses;
    if (cached && cached.expires > now) addresses = cached.addresses;
    else {
      const rows = await dns.lookup(host, { all: true, verbatim: true });
      addresses = rows.map(x => x.address);
      dnsCache.set(host, { addresses, expires: now + 60000 });
    }
    return addresses.length > 0 && addresses.every(isPublicIP);
  } catch { return false; }
}

app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/", (_req, res) => res.type("text").send("TV Kaynak Tarayıcı v4 - Playwright ağ isteği yakalama. /health veya /scan?url=..."));
app.get("/health", (_req, res) => res.json({
  ok: true, version: "4.0", engine: "playwright", allowedHosts: ALLOWED_HOSTS,
  maxPages: MAX_PAGES, pageWaitMs: PAGE_WAIT_MS
}));

app.get("/scan", async (req, res) => {
  if (typeof req.query.url !== "string" || req.query.url.length > 2048) {
    return res.status(400).json({ ok: false, error: "url parametresi gerekli (en fazla 2048 karakter)." });
  }
  let browser;
  try {
    const start = validatePage(req.query.url);
    browser = await playwright.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true
    });
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      viewport: { width: 1365, height: 900 },
      ignoreHTTPSErrors: false,
      serviceWorkers: "block"
    });

    // Her yönlendirme ve alt kaynak isteği public-IP kontrolünden geçirilir.
    await context.route("**/*", async route => {
      const ok = await safePublicRequest(route.request().url());
      if (!ok) return route.abort("blockedbyclient");
      return route.continue();
    });

    const queue = [{ url: start.toString(), label: "", score: 100 }];
    const queued = new Set([start.toString()]);
    const visited = new Set();
    const streams = new Map();
    const pagesFound = [];
    const errors = [];

    while (queue.length && visited.size < MAX_PAGES && streams.size < MAX_STREAMS) {
      queue.sort((a, b) => b.score - a.score);
      const item = queue.shift();
      if (visited.has(item.url)) continue;
      visited.add(item.url);
      let page;
      try {
        page = await context.newPage();
        let currentLabel = item.label || "";
        const addStream = (url, contentType = "") => {
          if (!isPlaylist(url, contentType) || streams.size >= MAX_STREAMS) return;
          try {
            const u = new URL(url);
            if (!["http:", "https:"].includes(u.protocol)) return;
            const key = u.href;
            if (!streams.has(key)) {
              const label = currentLabel || item.label || channelLabel(key);
              streams.set(key, {
                url: key, title: label, channelName: label, type: "stream",
                source: item.url, temporary: isTemporary(key)
              });
            }
          } catch { /* malformed network URL */ }
        };
        page.on("request", request => addStream(request.url()));
        page.on("response", response => {
          const headers = response.headers();
          addStream(response.url(), headers["content-type"] || "");
        });

        await page.goto(item.url, { waitUntil: "domcontentloaded", timeout: 35000 });
        await page.waitForTimeout(1800);
        const titleBits = await page.locator("h1, title").allTextContents().catch(() => []);
        currentLabel = item.label || clean(titleBits.find(Boolean)) || channelLabel(item.url, "Kanal");

        // Kullanıcı etkileşimi gerektiren standart, görünür oynat düğmelerini dener.
        const playSelectors = [
          "button[aria-label*='play' i]", "button[title*='play' i]",
          ".vjs-big-play-button", ".plyr__control--overlaid",
          "button[aria-label*='oynat' i]", "[title*='Oynat']",
          "[class*='play-button']", "[class*='play_btn']"
        ];
        for (const selector of playSelectors) {
          try {
            const locator = page.locator(selector).first();
            if (await locator.isVisible({ timeout: 350 }).catch(() => false)) {
              await locator.click({ timeout: 1500 }).catch(() => {});
              await page.waitForTimeout(1800);
              break;
            }
          } catch { /* selector may not exist */ }
        }
        await page.waitForTimeout(PAGE_WAIT_MS);

        const pageUrl = page.url();
        const content = await page.content();
        const $ = cheerio.load(content);
        const links = [];
        $("a[href]").each((_, el) => {
          const href = $(el).attr("href");
          if (!href) return;
          try {
            const u = new URL(href, pageUrl);
            if (u.protocol !== "https:" || u.hostname !== start.hostname) return;
            if (/\.(m3u8?|pdf|jpg|jpeg|png|webp|zip)(?:$|[?#])/i.test(u.href)) return;
            const label = clean($(el).text() || $(el).attr("title") || $(el).attr("aria-label") || u.pathname);
            const score = scoreLink(label, u.href);
            if (score >= 1) links.push({ url: u.href, label: label || "Kanal sayfası", score });
          } catch { /* ignore malformed link */ }
        });
        links.sort((a, b) => b.score - a.score);
        for (const link of links) {
          if (queue.length + visited.size >= MAX_QUEUE) break;
          if (!queued.has(link.url) && !visited.has(link.url)) {
            queued.add(link.url);
            queue.push(link);
          }
        }
        pagesFound.push({ url: item.url, title: currentLabel || clean($("title").text()) || "Kaynak sayfası" });
      } catch (error) {
        errors.push({ url: item.url, error: String(error?.message || error).slice(0, 180) });
      } finally {
        if (page) await page.close().catch(() => {});
      }
    }

    const channelPages = pagesFound.map(page => ({
      url: page.url, title: page.title, type: "channel", source: start.toString()
    }));
    const streamList = [...streams.values()];
    res.json({
      ok: true, version: "4.0", engine: "playwright",
      scannedPages: visited.size, count: channelPages.length + streamList.length,
      streamCount: streamList.length, pages: channelPages, streams: streamList,
      items: [...channelPages, ...streamList], diagnostics: pagesFound, errors,
      message: streamList.length
        ? "Sayfalar tarandı; tarayıcı ağ isteklerinde M3U/M3U8 kaynakları yakalandı."
        : "Sayfalar açıldı ancak bu taramada M3U/M3U8 isteği yakalanmadı. Oynatıcı etkileşim, harici servis veya erişim izni gerektiriyor olabilir."
    });
  } catch (error) {
    res.status(400).json({ ok: false, error: error?.message || "Tarama başarısız." });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

app.listen(PORT, "0.0.0.0", () => console.log(`TV scanner v4 listening on ${PORT}; allowlist=${ALLOWED_HOSTS.join(",")}`));
