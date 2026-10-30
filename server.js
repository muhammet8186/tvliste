import express from "express";
import * as cheerio from "cheerio";
import { chromium as playwright } from "playwright-core";
import chromium from "@sparticuz/chromium";

const app = express();
const PORT = process.env.PORT || 10000;
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || "blog.canlitvizle.tv").split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
const MAX_PAGES = Number(process.env.MAX_PAGES || 30);
const PAGE_WAIT_MS = Number(process.env.PAGE_WAIT_MS || 9000);
const MAX_STREAMS = 300;

function allowedHost(host) {
  host = host.toLowerCase();
  return ALLOWED_HOSTS.some(h => host === h || host.endsWith("." + h));
}
function validatePage(raw) {
  const u = new URL(raw);
  if (u.protocol !== "https:" || !allowedHost(u.hostname) || u.username || u.password || u.port) {
    throw new Error("Bu HTTPS alan adı tarama izin listesinde değil: " + u.hostname);
  }
  return u;
}
function clean(s) { return String(s || "").replace(/\s+/g, " ").trim().slice(0, 140); }
function isPlaylist(url, contentType = "") {
  return /\.m3u8?(?:$|[?#])/i.test(url) || /mpegurl|vnd\.apple\.mpegurl/i.test(contentType);
}
function isTemporary(url) {
  try {
    const keys = [...new URL(url).searchParams.keys()].map(x => x.toLowerCase());
    return keys.some(k => ["tkn","token","utkn","ip","tm","expires","auth","signature","sig","key"].includes(k));
  } catch { return false; }
}
function channelLabel(url, fallback = "") {
  try {
    const u = new URL(url);
    const ch = u.searchParams.get("ch");
    if (ch) return clean(ch.replace(/[-_]/g, " "));
    const name = u.pathname.split("/").filter(Boolean).pop()?.replace(/\.m3u8?$/i,"").replace(/[-_]/g," ");
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
function safePublicRequest(raw) {
  try {
    const u = new URL(raw);
    if (!["http:", "https:"].includes(u.protocol)) return false;
    const h = u.hostname.toLowerCase();
    if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") ||
        h === "127.0.0.1" || h === "::1" || h.startsWith("10.") ||
        h.startsWith("192.168.") || /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
        h === "0.0.0.0" || h.startsWith("169.254.")) return false;
    return true;
  } catch { return false; }
}

app.use((req,res,next) => {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/", (_q,s) => s.type("text").send("TV Kaynak Tarayıcı v3 - Playwright ağ isteği yakalama. /health veya /scan?url=..."));
app.get("/health", (_q,s) => s.json({ok:true,version:"3.0",engine:"playwright"}));

app.get("/scan", async (req,res) => {
  if (typeof req.query.url !== "string") return res.status(400).json({ok:false,error:"url parametresi gerekli."});
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
      viewport: {width: 1365, height: 900},
      ignoreHTTPSErrors: false
    });
    // Block local/private literal destinations and non-web protocols in browser requests.
    await context.route("**/*", async route => {
      const u = route.request().url();
      if (!safePublicRequest(u)) return route.abort();
      return route.continue();
    });

    const queue = [{url:start.toString(), label:"", score:100}];
    const queued = new Set([start.toString()]);
    const visited = new Set();
    const streams = new Map();
    const pagesFound = [];
    const errors = [];

    while (queue.length && visited.size < MAX_PAGES && streams.size < MAX_STREAMS) {
      queue.sort((a,b) => b.score-a.score);
      const item = queue.shift();
      if (visited.has(item.url)) continue;
      visited.add(item.url);
      let page;
      try {
        page = await context.newPage();
        const addStream = (url, contentType = "") => {
          if (!isPlaylist(url, contentType) || streams.size >= MAX_STREAMS) return;
          try {
            const u = new URL(url);
            if (!["http:","https:"].includes(u.protocol)) return;
            const key = u.href;
            if (!streams.has(key)) streams.set(key, {
              url:key,
              title:item.label || channelLabel(key),
              channelName:item.label || channelLabel(key),
              type:"stream",
              source:item.url,
              temporary:isTemporary(key)
            });
          } catch {}
        };
        page.on("request", r => addStream(r.url()));
        page.on("response", r => {
          const h = r.headers();
          addStream(r.url(), h["content-type"] || "");
        });

        await page.goto(item.url, {waitUntil:"domcontentloaded", timeout:30000});
        await page.waitForTimeout(PAGE_WAIT_MS);

        // A normal, visible play control may be clicked to start a public player.
        const playSelectors = [
          "button[aria-label*='play' i]", "button[title*='play' i]",
          ".vjs-big-play-button", ".plyr__control--overlaid",
          "button[aria-label*='oynat' i]", "[title*='Oynat']"
        ];
        for (const sel of playSelectors) {
          try {
            const loc = page.locator(sel).first();
            if (await loc.isVisible({timeout:300}).catch(()=>false)) {
              await loc.click({timeout:1200}).catch(()=>{});
              await page.waitForTimeout(2500);
              break;
            }
          } catch {}
        }

        const pageUrl = page.url();
        const content = await page.content();
        const $ = cheerio.load(content);
        const links = [];
        $("a[href]").each((_,el) => {
          const href = $(el).attr("href");
          if (!href) return;
          try {
            const u = new URL(href, pageUrl);
            if (u.protocol !== "https:" || u.hostname !== start.hostname) return;
            if (/\.(m3u8?|pdf|jpg|jpeg|png|webp|zip)(?:$|[?#])/i.test(u.href)) return;
            const label = clean($(el).text() || $(el).attr("title") || $(el).attr("aria-label") || u.pathname);
            const score = scoreLink(label, u.href);
            if (score >= 1) links.push({url:u.href,label:label || "Kanal sayfası",score});
          } catch {}
        });
        links.sort((a,b)=>b.score-a.score);
        for (const l of links) {
          if (queue.length + visited.size >= MAX_PAGES * 3) break;
          if (!queued.has(l.url) && !visited.has(l.url)) {
            queued.add(l.url);
            queue.push(l);
          }
        }
        pagesFound.push({url:item.url,title:item.label || clean($("title").text()) || "Kaynak sayfası"});
      } catch (e) {
        errors.push({url:item.url,error:String(e.message || e).slice(0,180)});
      } finally {
        if (page) await page.close().catch(()=>{});
      }
    }

    const channelPages = pagesFound.map(p => ({
      url:p.url, title:p.title, type:"channel", source:start.toString()
    }));
    const items = [...channelPages, ...streams.values()];
    res.json({
      ok:true, version:"3.0", engine:"playwright",
      scannedPages:visited.size, count:items.length,
      streamCount:streams.size, items, diagnostics:pagesFound,
      errors,
      message: streams.size
        ? "Tarayıcı sayfaları açtı ve ağ isteklerinde herkese açık M3U/M3U8 adresleri yakaladı."
        : "Sayfalar açıldı ancak bu taramada doğrudan M3U/M3U8 isteği yakalanmadı. Oynatıcı kullanıcı etkileşimi, desteklenmeyen harici servis veya erişim kısıtlaması gerektiriyor olabilir."
    });
  } catch (e) {
    res.status(400).json({ok:false,error:e.message || "Tarama başarısız."});
  } finally {
    if (browser) await browser.close().catch(()=>{});
  }
});
app.listen(PORT,"0.0.0.0",()=>console.log("TV scanner v3 listening on "+PORT));
