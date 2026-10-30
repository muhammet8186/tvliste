import express from "express";
import * as cheerio from "cheerio";

const app = express();
const PORT = process.env.PORT || 10000;
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || "https://blog.canlitvizle.tv/").split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
const MAX_PAGES = 25;

app.use((req,res,next) => {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if(req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

function validate(raw) {
  const u = new URL(raw);
  const host = u.hostname.toLowerCase();
  const allowed = ALLOWED_HOSTS.some(h => host === h || host.endsWith("." + h));
  if (u.protocol !== "https:" || !allowed || u.username || u.password || u.port) {
    throw new Error("Bu HTTPS alan adı tarama izin listesinde değil: " + host);
  }
  return u;
}

async function getPage(raw) {
  let u = validate(raw);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    let r;
    for (let i = 0; i < 4; i++) {
      r = await fetch(u, { redirect: "manual", signal: controller.signal, headers: {
        "User-Agent": "Mozilla/5.0 (compatible; PublicChannelScanner/2.0)",
        "Accept": "text/html,application/json,*/*"
      }});
      if ([301,302,303,307,308].includes(r.status)) {
        const loc = r.headers.get("location");
        if (!loc) throw new Error("Yönlendirme adresi yok.");
        u = validate(new URL(loc, u).toString());
        continue;
      }
      break;
    }
    if (!r?.ok) throw new Error("Site yanıt vermedi (HTTP " + (r?.status || "?") + ")");
    const reader = r.body.getReader(), chunks = []; let total = 0;
    while (true) {
      const {done,value} = await reader.read(); if (done) break;
      total += value.byteLength;
      if (total > 2000000) { await reader.cancel(); throw new Error("Sayfa 2 MB sınırını aşıyor."); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total); let off = 0;
    for (const c of chunks) { bytes.set(c,off); off += c.length; }
    return { html: new TextDecoder().decode(bytes), url: u.toString(), type: r.headers.get("content-type") || "" };
  } finally { clearTimeout(timer); }
}

function cleanLabel(s) {
  return String(s || "").replace(/\s+/g," ").trim().slice(0,160);
}
function add(items, seen, value, title, type, base, channelName = "") {
  try {
    const u = new URL(String(value).replace(/\\\//g,"/"), base);
    if (!["http:","https:"].includes(u.protocol)) return;
    if (u.username || u.password) return;
    const key = u.href;
    if (seen.has(key)) return;
    seen.add(key);
    const stream = /\.m3u8?(?:$|[?#])/i.test(u.href);
    items.push({ url:u.href, title:cleanLabel(title || channelName || "Bulunan bağlantı"),
      channelName:cleanLabel(channelName), type:stream ? "stream" : type, source:base });
  } catch {}
}

const ignoreLink = /^(iletişim|iletisim|hakkımızda|hakkimizda|gizlilik|privacy|çerez|cookie|reklam|advert|giriş|login|kayıt|register|anasayfa|home|facebook|instagram|twitter|youtube|telegram)$/i;
const channelWords = /(trt|atv|show|fox|now|tv8|kanal|a\s*haber|a\s*spor|teve|beyaz|360|ntv|cnn|habertürk|haberturk|star|teve2|euro|yerel|ulusal|canlı|canli)/i;

function parse(html, page, items, seen, queue, channelName, diagnostics) {
  const $ = cheerio.load(html);
  const pageHost = new URL(page).hostname;
  const candidates = [];

  $("a[href],iframe[src],video[src],source[src],audio[src]").each((_,el) => {
    const tag = el.tagName.toLowerCase();
    const attr = tag === "a" ? "href" : "src";
    const value = $(el).attr(attr);
    if (!value) return;
    const label = cleanLabel($(el).text() || $(el).attr("title") || $(el).attr("aria-label") || "");
    add(items,seen,value,label || tag,tag,page,channelName);
    if (tag === "a") {
      try {
        const u = new URL(value,page);
        if (u.protocol !== "https:" || u.hostname !== pageHost || /\.(m3u8?|pdf|jpg|jpeg|png|webp|zip)(?:$|[?#])/i.test(u.href)) return;
        const name = label || decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() || "Kanal").replace(/[-_]/g," ");
        if (!name || ignoreLink.test(name)) return;
        const score = channelWords.test(name + " " + u.pathname) ? 3 : (/kategori|category|kanal|tv/i.test(u.pathname) ? 2 : 1);
        candidates.push({url:u.href,label:name,score});
      } catch {}
    }
  });

  // Static HTML and inline scripts: capture publicly exposed playlist URLs only.
  const text = html.replace(/\\u0026/gi,"&").replace(/\\\//g,"/");
  const patterns = [
    /https?:\/\/[^\s"'<>\\]+?\.m3u8?(?:\?[^\s"'<>\\]*)?/gi,
    /(?:file|src|source|hls|playlist)\s*[:=]\s*["']([^"']+\.m3u8?(?:\?[^"']*)?)["']/gi
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) add(items,seen,m[1] || m[0],"Doğrudan yayın adresi","stream",page,channelName);
  }

  candidates.sort((a,b) => b.score - a.score);
  for (const c of candidates) {
    if (queue.length >= 60) break;
    if (!queue.some(q => q.url === c.url)) queue.push({url:c.url,label:c.label,score:c.score});
  }
  diagnostics.push({page,channel:channelName || "",foundLinks:candidates.length});
}

app.get("/",(_q,s) => s.type("text").send("TV Kaynak Tarayıcı çalışıyor. /health veya /scan?url=..."));
app.get("/health",(_q,s) => s.json({ok:true,version:"2.0"}));
app.get("/scan",async(req,res) => {
  if (typeof req.query.url !== "string") return res.status(400).json({ok:false,error:"url parametresi gerekli."});
  try {
    const start = validate(req.query.url);
    const queue = [{url:start.toString(),label:"",score:99}], visited = new Set(), items = [], seen = new Set(), diagnostics = [];
    while (queue.length && visited.size < MAX_PAGES) {
      queue.sort((a,b) => b.score - a.score);
      const next = queue.shift();
      if (visited.has(next.url)) continue;
      visited.add(next.url);
      const r = await getPage(next.url);
      if (/mpegurl/i.test(r.type) || /\.m3u8?(?:$|[?#])/i.test(r.url)) {
        add(items,seen,r.url,"Doğrudan yayın listesi","stream",r.url,next.label); continue;
      }
      const before = items.filter(x => x.type === "stream").length;
      parse(r.html,r.url,items,seen,queue,next.label,diagnostics);
      const after = items.filter(x => x.type === "stream").length;
      diagnostics[diagnostics.length-1].directStreamsFound = after-before;
    }
    const streamCount = items.filter(x => x.type === "stream").length;
    res.json({ok:true,scannedPages:visited.size,count:items.length,streamCount,
      message:streamCount ? "Doğrudan yayın adresleri bulundu." : "Kanal sayfaları bulundu; ancak taranan sayfaların herkese açık HTML içeriğinde doğrudan M3U/M3U8 adresi görünmedi.",
      items,diagnostics});
  } catch(e) {
    res.status(400).json({ok:false,error:e.name === "AbortError" ? "Site zaman aşımına uğradı." : e.message || "Tarama başarısız."});
  }
});
app.listen(PORT,"0.0.0.0",() => console.log("TV scanner v2 listening on " + PORT));
