import express from "express";
import * as cheerio from "cheerio";

const app = express();
const PORT = process.env.PORT || 10000;
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || "blog.canlitvizle.tv").split(",").map(x => x.trim().toLowerCase()).filter(Boolean);

app.use((req,res,next) => {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if(req.method==="OPTIONS") return res.sendStatus(204);
  next();
});

function validate(raw) {
  const u = new URL(raw);
  const ok = ALLOWED_HOSTS.some(h => u.hostname.toLowerCase()===h || u.hostname.toLowerCase().endsWith("."+h));
  if(u.protocol!=="https:" || !ok || u.username || u.password) throw new Error("Bu HTTPS alan adı tarama izin listesinde değil: "+u.hostname);
  return u;
}

async function getPage(raw) {
  let u=validate(raw);
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),10000);
  try {
    let r;
    for(let i=0;i<4;i++){
      r=await fetch(u,{redirect:"manual",signal:controller.signal,headers:{"User-Agent":"Mozilla/5.0 (compatible; PublicChannelScanner/1.0)","Accept":"text/html,*/*"}});
      if([301,302,303,307,308].includes(r.status)){
        const loc=r.headers.get("location");
        if(!loc) throw new Error("Yönlendirme adresi yok.");
        u=validate(new URL(loc,u).toString()); continue;
      }
      break;
    }
    if(!r?.ok) throw new Error("Site yanıt vermedi (HTTP "+(r?.status||"?")+")");
    const reader=r.body.getReader(), chunks=[]; let total=0;
    while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>1500000){await reader.cancel();throw new Error("Sayfa 1,5 MB sınırını aşıyor.");}chunks.push(value);}
    const bytes=new Uint8Array(total);let off=0;for(const c of chunks){bytes.set(c,off);off+=c.length;}
    return {html:new TextDecoder().decode(bytes),url:u.toString(),type:r.headers.get("content-type")||""};
  } finally {clearTimeout(timer);}
}

function add(items,seen,value,title,type,base){
  try{
    const u=new URL(value,base);
    if(!["http:","https:"].includes(u.protocol))return;
    if(seen.has(u.href))return;seen.add(u.href);
    const stream=/\.m3u8?(?:$|[?#])/i.test(u.href);
    items.push({url:u.href,title:(title||"Bulunan bağlantı").trim().slice(0,160),type:stream?"stream":type,source:base});
  }catch{}
}

function parse(html,page,items,seen,queue){
  const $=cheerio.load(html);
  $("a[href],iframe[src],video[src],source[src],audio[src]").each((_,el)=>{
    const tag=el.tagName.toLowerCase(), attr=tag==="a"?"href":"src", value=$(el).attr(attr);
    if(!value)return;
    const label=$(el).text().trim()||$(el).attr("title")||tag;
    add(items,seen,value,label,tag,page);
    if(tag==="a" && queue.length<12 && !/\.m3u8?(?:$|[?#])/i.test(value)){
      try{const u=new URL(value,page);if(u.hostname===new URL(page).hostname && u.protocol==="https:")queue.push(u.href);}catch{}
    }
  });
  for(const m of html.matchAll(/https?:\\?\/\\?\/[^"'\\s<>]+?\.m3u8?(?:\?[^"'\\s<>]*)?/gi)){
    add(items,seen,m[0].replace(/\\\//g,"/").replace(/\\u0026/g,"&"),"Bulunan yayın adresi","stream",page);
  }
}

app.get("/",(_q,s)=>s.type("text").send("TV Kaynak Tarayıcı çalışıyor. /health veya /scan?url=..."));
app.get("/health",(_q,s)=>s.json({ok:true}));
app.get("/scan",async(req,res)=>{
  if(typeof req.query.url!=="string")return res.status(400).json({ok:false,error:"url parametresi gerekli."});
  try{
    const start=validate(req.query.url), queue=[start.toString()], visited=new Set(), items=[], seen=new Set();
    while(queue.length && visited.size<5){
      const page=queue.shift();if(visited.has(page))continue;visited.add(page);
      const r=await getPage(page);
      if(/mpegurl/i.test(r.type)||/\.m3u8?(?:$|[?#])/i.test(r.url)){add(items,seen,r.url,"Doğrudan yayın listesi","stream",r.url);continue;}
      parse(r.html,r.url,items,seen,queue);
    }
    res.json({ok:true,scannedPages:visited.size,count:items.length,items});
  }catch(e){res.status(400).json({ok:false,error:e.name==="AbortError"?"Site zaman aşımına uğradı.":e.message||"Tarama başarısız."});}
});
app.listen(PORT,"0.0.0.0",()=>console.log("TV scanner listening on "+PORT));
