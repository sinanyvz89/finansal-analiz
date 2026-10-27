import { useState, useCallback, useMemo, useRef, useEffect, useLayoutEffect } from "react";
import Papa from "papaparse";
import * as XLSX from "xlsx";

/* ── Utilities ── */
function parseNum(v) {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  const s = String(v).trim();
  if (!s) return 0;
  return parseFloat(s.replace(/\./g, "").replace(",", ".")) || 0;
}
function formatN(n) {
  if (n == null || isNaN(n)) return "0,00";
  return n.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function pct(a, b) { return b ? (a / b) * 100 : 0; }
function degFn(y, e) { return (e == null || e === 0) ? null : ((y - e) / Math.abs(e)) * 100; }

/* ── DOWNLOAD / SHARE HELPER ──
   Mobilde (dokunmatik cihazlarda) dosya, telefonun paylasim menusuyle acilir:
   WhatsApp, Mail, Dosyalar, Drive vb. Paylasim desteklenmezse klasik indirme yapilir. */
function saveFile(blob, filename) {
  try {
    const coarse = typeof window !== "undefined" && window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
    if (coarse && navigator.canShare && typeof File !== "undefined") {
      const file = new File([blob], filename, { type: blob.type });
      if (navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file], title: filename }).catch((e) => {
          if (e && e.name !== "AbortError") anchorDownload(blob, filename);
        });
        return;
      }
    }
  } catch (e) { /* paylasim yoksa indirmeye dus */ }
  anchorDownload(blob, filename);
}
function anchorDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
function downloadCSV(content, filename) {
  saveFile(new Blob(["\uFEFF" + content], { type: "text/csv;charset=utf-8" }), filename);
}
function downloadHTML(content, filename) {
  saveFile(new Blob([content], { type: "text/html;charset=utf-8" }), filename);
}

/* ── Cihazda kalici saklama (IndexedDB) ──
   Yuklenen mizanlar ve girilen bilgiler sadece bu cihazda tutulur, sunucuya gitmez. */
const IDB_NAME = "finanaliz", IDB_STORE = "kv";
function idbOpen() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("no idb"));
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet(key) {
  try { const db = await idbOpen(); return await new Promise((res) => { const r = db.transaction(IDB_STORE).objectStore(IDB_STORE).get(key); r.onsuccess = () => res(r.result); r.onerror = () => res(undefined); }); } catch (e) { return undefined; }
}
async function idbSet(key, val) {
  try { const db = await idbOpen(); await new Promise((res) => { const tx = db.transaction(IDB_STORE, "readwrite"); tx.objectStore(IDB_STORE).put(val, key); tx.oncomplete = res; tx.onerror = res; }); } catch (e) { /* sessiz */ }
}
async function idbClear() {
  try { const db = await idbOpen(); await new Promise((res) => { const tx = db.transaction(IDB_STORE, "readwrite"); tx.objectStore(IDB_STORE).clear(); tx.oncomplete = res; tx.onerror = res; }); } catch (e) { /* sessiz */ }
}

/* ── Mobil yerlesim yardimcilari ── */
const MOBILE_BP = 760;
function useIsMobile() {
  const q = "(max-width: " + MOBILE_BP + "px)";
  const get = () => typeof window !== "undefined" && window.matchMedia ? window.matchMedia(q).matches : false;
  const [m, setM] = useState(get);
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia(q);
    const on = () => setM(mq.matches);
    mq.addEventListener ? mq.addEventListener("change", on) : mq.addListener(on);
    return () => { mq.removeEventListener ? mq.removeEventListener("change", on) : mq.removeListener(on); };
  }, []);
  return m;
}
function parseTracks(tpl) {
  const out = []; let depth = 0, cur = "";
  for (const ch of String(tpl).trim()) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === " " && depth === 0) { if (cur) out.push(cur); cur = ""; } else cur += ch;
  }
  if (cur) out.push(cur);
  const res = [];
  for (const t of out) { const m = t.match(/^repeat\((\d+),\s*(.+)\)$/); if (m) { for (let i = 0; i < +m[1]; i++) res.push(m[2]); } else res.push(t); }
  return res;
}
function trackFr(t) { const m = String(t).match(/([\d.]+)fr\)?$/); return m ? parseFloat(m[1]) : null; }
function effectiveBg(el) {
  let n = el;
  while (n && n.nodeType === 1) {
    const c = getComputedStyle(n).backgroundColor;
    if (c && c !== "transparent" && !/rgba\(\s*0,\s*0,\s*0,\s*0\s*\)/.test(c)) return c;
    n = n.parentElement;
  }
  return "var(--color-background-primary)";
}
/* Masaustu icin yazilmis grid yapilarini telefona uyarlar:
   - kart gridleri (repeat(4/3)) -> 2 sutun, yan yana paneller -> alt alta
   - cok sutunlu tablo satirlari -> yatay kaydirilabilir, hesap adi sutunu sabit (sticky) */
const FA_CLS = ["fa-cards1", "fa-cards2", "fa-wide", "fa-sticky", "fa-sticky2", "fa-xscroll"];
function applyMobileLayout(root, mobile) {
  if (!root) return;
  // 1) Okuma asamasi (DOM'a yazmadan olcum yap -> tek yerlesim hesabi)
  const plan = new Map();
  const P = (el) => { let p = plan.get(el); if (!p) { p = { cls: new Set(), vars: {} }; plan.set(el, p); } return p; };
  if (mobile) {
    root.querySelectorAll('div[style*="grid-template-columns"]').forEach((el) => {
      if (el.classList.contains("fa-keep") || el.classList.contains("fa-stack")) return;
      const raw = el.style.gridTemplateColumns || "";
      if (/auto-fit|auto-fill/.test(raw)) return;
      const tracks = parseTracks(raw); const n = tracks.length;
      if (n < 2) return;
      const gap = parseFloat(el.style.columnGap || el.style.gap) || 0;
      if (/^repeat\(/.test(raw.trim())) { P(el).cls.add(n >= 3 ? "fa-cards2" : "fa-cards1"); return; }
      if (n === 2 && gap >= 12) { P(el).cls.add("fa-cards1"); return; }
      const frs = tracks.map(trackFr);
      if (gap >= 8 && frs.every((f) => f != null && f === frs[0])) { P(el).cls.add(n >= 3 ? "fa-cards2" : "fa-cards1"); return; }
      if (n < 3) return;
      // Tablo satiri: hesap adi sutunu sabit, rakamlar yatay kaydirilir
      const known = frs.filter((x) => x != null);
      const maxFr = known.length ? Math.max(...known) : 1;
      const li = frs.findIndex((f) => f != null && f === maxFr);
      const cs = getComputedStyle(el);
      const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) + gap * (n - 1);
      const ws = frs.map((f, i) => (i === li ? 128 : f == null ? 44 : Math.max(52, Math.round(f * 96))));
      const cols = frs.map((f, i) => (i === li ? "minmax(128px, 1.25fr)" : f == null ? "auto" : "minmax(" + ws[i] + "px, " + f + "fr)")).join(" ");
      const minw = ws.reduce((s2, w) => s2 + w, 0) + padX;
      const p = P(el);
      p.cls.add("fa-wide");
      p.vars["--fa-cols"] = cols;
      p.vars["--fa-minw"] = Math.round(minw) + "px";
      if (li === 0 || li === 1) { p.cls.add(li === 0 ? "fa-sticky" : "fa-sticky2"); p.vars["--fa-bg"] = effectiveBg(el); }
      const parent = el.parentElement;
      if (!parent || minw <= parent.clientWidth) return;
      let a = parent, box = null, last = parent;
      while (a && a !== root) {
        if (getComputedStyle(a).overflowX !== "visible") { box = a; break; }
        last = a; a = a.parentElement;
      }
      P(box || last).cls.add("fa-xscroll");
    });
  }
  // 2) Yazma asamasi: sadece degisenleri guncelle
  root.querySelectorAll("." + FA_CLS.join(",.")).forEach((el) => { if (!plan.has(el)) el.classList.remove(...FA_CLS); });
  plan.forEach((p, el) => {
    for (const c of FA_CLS) { const want = p.cls.has(c); if (el.classList.contains(c) !== want) el.classList.toggle(c, want); }
    for (const k in p.vars) if (el.style.getPropertyValue(k) !== p.vars[k]) el.style.setProperty(k, p.vars[k]);
  });
}

const FA_MOBILE_CSS = `
.fa-app { -webkit-tap-highlight-color: transparent; }
.fa-app button { touch-action: manipulation; }
.fa-hscroll { overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none; }
.fa-hscroll::-webkit-scrollbar { display: none; }
@media (max-width: ${MOBILE_BP}px) {
  .fa-app .fa-cards1, .fa-app .fa-stack { grid-template-columns: minmax(0, 1fr) !important; }
  .fa-app .fa-cards2 { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; gap: 10px !important; }
  .fa-app .fa-cards1 > *, .fa-app .fa-cards2 > * { min-width: 0; }
  .fa-app .fa-cards2 [style*="font-size: 2"] { font-size: 18px !important; overflow-wrap: anywhere; }
  .fa-app .fa-cards2 [style*="padding: 18px 16px"], .fa-app .fa-cards2 [style*="padding: 16px 18px"] { padding: 12px !important; }
  .fa-app .fa-wide { grid-template-columns: var(--fa-cols) !important; min-width: var(--fa-minw) !important; font-size: 12.5px !important; }
  .fa-app .fa-sticky > :first-child, .fa-app .fa-sticky2 > :nth-child(2) { position: sticky; left: 0; z-index: 2; background: var(--fa-bg); white-space: normal !important; display: -webkit-box !important; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; line-height: 1.3; padding-right: 8px; }
  .fa-app .fa-wide > span:not(:first-child) { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .fa-app .fa-xscroll { overflow-x: auto !important; -webkit-overflow-scrolling: touch; overscroll-behavior-x: contain; }
  .fa-app input, .fa-app select, .fa-app textarea { font-size: 16px !important; }
  .fa-app .fa-content button { min-height: 36px; }
  .fa-app .fa-content div[style*="justify-content: space-between"] { flex-wrap: wrap; row-gap: 8px; }
  .fa-app .fa-content svg { max-width: 100%; height: auto; }
}
`;

/* ── CSV Builder ── */
function buildCSV(rows2d) {
  return rows2d.map(r => r.join(";")).join("\n");
}

/* ── HTML Report Builder ── */
function buildHTMLReport(title, tables, notes) {
  let h = '<html><head><meta charset="utf-8"><title>' + title + '</title><style>';
  h += 'body{font-family:Arial,sans-serif;font-size:11px;color:#1a1a1a;max-width:850px;margin:0 auto;padding:24px;}';
  h += 'h1{font-size:18px;color:#2F5496;margin:0 0 4px;} h2{font-size:13px;margin:20px 0 6px;border-bottom:2px solid #2F5496;padding-bottom:4px;color:#2F5496;}';
  h += 'table{width:100%;border-collapse:collapse;margin-bottom:16px;} th,td{padding:5px 8px;border-bottom:1px solid #ddd;font-size:11px;} th{background:#2F5496;color:#fff;text-align:left;}';
  h += '.r{text-align:right;font-variant-numeric:tabular-nums;} .b{font-weight:700;} .hl{background:#F2F7FC;}';
  h += '.g{color:#0F6E56;} .rd{color:#A32D2D;} .y{color:#BA7517;}';
  h += '.note{padding:8px 12px;margin:4px 0;border-radius:4px;font-size:11px;} .ng{background:#f0faf5;border-left:3px solid #0F6E56;} .nr{background:#fef0f0;border-left:3px solid #A32D2D;} .ny{background:#fef9ee;border-left:3px solid #BA7517;}';
  h += '@media print{body{padding:10px;}}';
  h += '</style></head><body>';
  h += '<h1>' + title + '</h1>';
  h += tables;
  if (notes) h += notes;
  h += '<br><p style="color:#999;font-size:9px;">Otomatik olusturulmustur.</p></body></html>';
  return h;
}

/* ── File Reading ── */
async function readFile(file) {
  const name = file.name.toLowerCase();

  // Excel, ODS, XML spreadsheet files
  if (/\.(xlsx?|ods|xml)$/i.test(name)) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const data = new Uint8Array(e.target.result);
          const workbook = XLSX.read(data, { type: "array" });
          const sheetName = workbook.SheetNames[0];
          const sheet = workbook.Sheets[sheetName];
          const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
          resolve({ rows });
        } catch (err) {
          resolve({ rows: null, error: "Dosya okuma hatasi: " + err.message });
        }
      };
      reader.readAsArrayBuffer(file);
    });
  }

  // CSV / TSV / TXT files
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const result = Papa.parse(e.target.result, { header: false, skipEmptyLines: true, delimiter: "" });
      resolve({ rows: result.data });
    };
    reader.readAsText(file, "windows-1254");
  });
}

/* ── Mizan Parser ── */
function parseMizan(allRows, fileName) {
  if (!allRows || allRows.length < 5) return { data: null, err: "Dosya bos." };
  let hi = -1;
  for (let i = 0; i < Math.min(allRows.length, 25); i++) {
    const r = allRows[i].map((c) => String(c || "").toLowerCase().trim());
    if (r.some((c) => c.includes("hesap") && (c.includes("kod") || c.includes("no"))) && r.some((c) => c.includes("borç") || c.includes("borc")) && r.some((c) => c.includes("alacak"))) { hi = i; break; }
  }
  if (hi === -1) return { data: null, err: "Baslik bulunamadi." };
  const hdr = allRows[hi].map((h) => String(h || "").toLowerCase().trim());
  let kodI = 0, adI = 1, bI = -1, aI = -1, bbI = -1, abI = -1;
  for (let i = 0; i < hdr.length; i++) {
    const h = hdr[i];
    if ((h.includes("hesap") && (h.includes("kod") || h.includes("no"))) || h === "kod") kodI = i;
    else if (h.includes("hesap") && h.includes("ad")) adI = i;
    else if ((h.includes("borç") || h.includes("borc")) && (h.includes("bak") || h.includes("bakiye"))) bbI = i;
    else if (h.includes("alacak") && (h.includes("bak") || h.includes("bakiye"))) abI = i;
    else if (h.includes("borç") || h.includes("borc")) bI = i;
    else if (h.includes("alacak")) aI = i;
    else if ((h.includes("ad") || h.includes("açıklama")) && !h.includes("bak")) adI = i;
  }
  const items = [];
  for (const c of allRows.slice(hi + 1)) {
    if (!c || c.length < 2) continue;
    const rk = String(c[kodI] || "").trim();
    if (!rk || !/^\d/.test(rk) || rk.toLowerCase().startsWith("listelenen")) continue;
    const kod = rk.replace(/\s+/g, "");
    const borc = bI >= 0 ? parseNum(c[bI]) : 0;
    const alacak = aI >= 0 ? parseNum(c[aI]) : 0;
    let bBak, aBak;
    if (bbI >= 0 && abI >= 0) { bBak = parseNum(c[bbI]); aBak = parseNum(c[abI]); }
    else { bBak = Math.max(0, borc - alacak); aBak = Math.max(0, alacak - borc); }
    items.push({ kod, ad: String(c[adI] || "").trim(), borc, alacak, bBak, aBak });
  }
  if (!items.length) return { data: null, err: "Hesap verisi bulunamadi." };
  return { data: { fileName, rows: items, donem: fileName.replace(/\.[^.]+$/, "") }, err: null };
}

/* ── Accounting ── */
function getGrp(rows, p) { const e = rows.find((r) => r.kod === p); if (e) return { aBak: e.aBak, bBak: e.bBak }; let a = 0, b = 0; for (const r of rows) if (r.kod.startsWith(p) && r.kod.length === 3 && !r.kod.includes(".")) { a += r.aBak; b += r.bBak; } return { aBak: a, bBak: b }; }
function gA(rows, p) { const b = getGrp(rows, p); return b.aBak - b.bBak; }
function gB(rows, p) { const b = getGrp(rows, p); return b.bBak - b.aBak; }
function getSubs(rows, prefix) { return rows.filter((r) => r.kod.startsWith(prefix) && r.kod.length === 3 && !r.kod.includes(".") && r.kod !== prefix); }
function getTop5(rows, prefix3, type) {
  const all = rows.filter((r) => { if (!r.kod.startsWith(prefix3) || r.kod === prefix3) return false; return (r.kod.match(/\./g) || []).length >= 2; });
  const scored = all.map((r) => ({ ...r, val: type === "alacak" ? (r.aBak - r.bBak) : (r.bBak - r.aBak) })).filter((r) => r.val > 0);
  scored.sort((a, b) => b.val - a.val);
  return scored.slice(0, 5);
}

/* ── Calculations ── */
function calcGelir(m) {
  if (!m) return null;
  const r = m.rows;
  const brutSatis = gA(r, "60"), satisInd = gB(r, "61"), netSatis = brutSatis - satisInd;

  // Her zaman hem 6x hem 7x hesaplari topla (hangisi varsa)
  const smm62 = gB(r, "62");
  const smm72 = gB(r, "72") + gB(r, "73");
  const satisMal = smm62 + smm72;

  const fg63 = gB(r, "63");
  const fg76 = gB(r, "76") + gB(r, "77");
  const faalGid = fg63 + fg76;

  const fin66 = gB(r, "66");
  const fin78 = gB(r, "78");
  let finGid = fin66 + fin78;

  // Alt hesap prefixleri - bakiyesi olan gruplari topla
  const malP = []; const faalP = []; const finP = [];
  if (smm62 !== 0 || r.some((x) => x.kod.startsWith("62") && x.kod.length === 3)) malP.push("62");
  if (gB(r, "72") !== 0 || r.some((x) => x.kod.startsWith("72") && x.kod.length === 3)) malP.push("72");
  if (gB(r, "73") !== 0 || r.some((x) => x.kod.startsWith("73") && x.kod.length === 3)) malP.push("73");
  if (fg63 !== 0 || r.some((x) => x.kod.startsWith("63") && x.kod.length === 3)) faalP.push("63");
  if (gB(r, "76") !== 0 || r.some((x) => x.kod.startsWith("76") && x.kod.length === 3)) faalP.push("76");
  if (gB(r, "77") !== 0 || r.some((x) => x.kod.startsWith("77") && x.kod.length === 3)) faalP.push("77");
  if (fin66 !== 0 || r.some((x) => x.kod.startsWith("66") && x.kod.length === 3)) finP.push("66");
  if (fin78 !== 0 || r.some((x) => x.kod.startsWith("78") && x.kod.length === 3)) finP.push("78");

  const brutKar = netSatis - satisMal, faalKar = brutKar - faalGid;
  const digerGel = gA(r, "64"), digerGid = gB(r, "65");
  const olaganKar = faalKar + digerGel - digerGid - finGid;
  const odGel = gA(r, "67"), odGid = gB(r, "68"), donemKari = olaganKar + odGel - odGid;
  const subs60 = getSubs(r, "60"), subs61 = getSubs(r, "61");
  let subsMal = [], subsFaal = [], subsFin = [];
  for (const p of malP) subsMal = subsMal.concat(getSubs(r, p));
  for (const p of faalP) subsFaal = subsFaal.concat(getSubs(r, p));
  for (const p of finP) subsFin = subsFin.concat(getSubs(r, p));
  const subs64 = getSubs(r, "64"), subs65 = getSubs(r, "65"), subs67 = getSubs(r, "67"), subs68 = getSubs(r, "68");
  const top5Map = {};
  for (const s of subs60) top5Map[s.kod] = getTop5(r, s.kod, "alacak");
  for (const s of [...subs61, ...subsMal, ...subsFaal, ...subsFin, ...subs65, ...subs68]) top5Map[s.kod] = getTop5(r, s.kod, "borc");
  for (const s of [...subs64, ...subs67]) top5Map[s.kod] = getTop5(r, s.kod, "alacak");
  return { brutSatis, satisInd, netSatis, satisMal, brutKar, faalGid, faalKar, digerGel, digerGid, finGid, olaganKar, odGel, odGid, donemKari, subs60, subs61, subsMal, subsFaal, subs64, subs65, subsFin, subs67, subs68, top5Map, malP, faalP, finP };
}
function calcBil(m, dk) {
  if (!m) return null; const r = m.rows;
  const ga = (p) => { const e = r.find((x) => x.kod === p); return e ? e.bBak - e.aBak : 0; };
  const gp = (p) => { const e = r.find((x) => x.kod === p); return e ? e.aBak - e.bBak : 0; };
  const sa = (p) => { const e = r.find((x) => x.kod === p); if (e) return e.bBak - e.aBak; let t = 0; for (const x of r) if (x.kod.startsWith(p) && x.kod.length === 3) t += x.bBak - x.aBak; return t; };
  const sp = (p) => { const e = r.find((x) => x.kod === p); if (e) return e.aBak - e.bBak; let t = 0; for (const x of r) if (x.kod.startsWith(p) && x.kod.length === 3) t += x.aBak - x.bBak; return t; };
  const donen = ga("1"), duran = ga("2"), aktif = donen + duran;
  const kvyk = gp("3"), uvyk = gp("4"), ozk = gp("5") + (dk || 0), pasif = kvyk + uvyk + ozk;
  return { donen, duran, aktif, kvyk, uvyk, ozk, pasif, nakit: sa("10"), tAlacak: sa("12"), stok: sa("15"), tBorc: sp("32") };
}
function calcAnaliz(g, b) {
  if (!g || !b) return null;
  return { co: b.kvyk ? b.donen / b.kvyk : 0, at: b.kvyk ? (b.donen - b.stok) / b.kvyk : 0, no: b.kvyk ? b.nakit / b.kvyk : 0, bo: b.ozk ? (b.kvyk + b.uvyk) / b.ozk : 0, bkm: g.netSatis ? g.brutKar / g.netSatis * 100 : 0, nkm: g.netSatis ? g.donemKari / g.netSatis * 100 : 0, fkm: g.netSatis ? g.faalKar / g.netSatis * 100 : 0, roe: b.ozk ? g.donemKari / b.ozk * 100 : 0, roa: b.aktif ? g.donemKari / b.aktif * 100 : 0, ag: b.tAlacak && g.netSatis ? 365 / (g.netSatis / b.tAlacak) : 0, sg: b.stok && g.satisMal ? 365 / (g.satisMal / b.stok) : 0 };
}
function calcDikey(b, g) { if (!b || !g) return null; return { b: { dvY: pct(b.donen, b.aktif), durY: pct(b.duran, b.aktif), kvY: pct(b.kvyk, b.pasif), uvY: pct(b.uvyk, b.pasif), ozY: pct(b.ozk, b.pasif) }, g: { malY: pct(g.satisMal, g.netSatis), bkY: pct(g.brutKar, g.netSatis), fgY: pct(g.faalGid, g.netSatis), fkY: pct(g.faalKar, g.netSatis), nkY: pct(g.donemKari, g.netSatis) } }; }
function genRapor(aa) {
  if (!aa || !aa.length) return null; const s = aa[aa.length - 1]; if (!s) return null;
  const ar = [], ek = [], on = [];
  if (s.co >= 1.5) ar.push("Cari oran guclu (" + s.co.toFixed(2) + ")"); else if (s.co >= 1) ar.push("Cari oran kabul edilebilir (" + s.co.toFixed(2) + ")"); else { ek.push("Cari oran dusuk (" + s.co.toFixed(2) + ")"); on.push("KVYK yapilandirmasi yapilmali"); }
  if (s.bkm >= 30) ar.push("Brut kar marji yuksek (%" + s.bkm.toFixed(1) + ")"); else if (s.bkm >= 15) ar.push("Brut kar marji makul (%" + s.bkm.toFixed(1) + ")"); else { ek.push("Brut kar marji dusuk (%" + s.bkm.toFixed(1) + ")"); on.push("Satis maliyetleri optimize edilmeli"); }
  if (s.nkm >= 10) ar.push("Net kar marji guclu (%" + s.nkm.toFixed(1) + ")"); else if (s.nkm > 0) ar.push("Isletme karli (%" + s.nkm.toFixed(1) + ")"); else { ek.push("Isletme zarar ediyor (%" + s.nkm.toFixed(1) + ")"); on.push("Maliyet dusurme programi baslatilmali"); }
  if (s.bo <= 1) ar.push("Borc/ozkaynak saglikli (" + s.bo.toFixed(2) + ")"); else { ek.push("Borcluluk yuksek (" + s.bo.toFixed(2) + ")"); on.push("Borc yapilandirma plani olusturulmali"); }
  if (s.ag > 0 && s.ag <= 45) ar.push("Alacak tahsilat iyi (" + Math.round(s.ag) + " gun)"); else if (s.ag > 45) { ek.push("Tahsilat suresi uzun (" + Math.round(s.ag) + " gun)"); on.push("Tahsilat politikasi sikilastirilmali"); }
  if (s.sg > 0 && s.sg <= 60) ar.push("Stok devir hizi iyi (" + Math.round(s.sg) + " gun)"); else if (s.sg > 60) { ek.push("Stok devir yavas (" + Math.round(s.sg) + " gun)"); on.push("Stok yonetimi optimize edilmeli"); }
  if (s.roa >= 5) ar.push("ROA iyi (%" + s.roa.toFixed(1) + ")"); if (s.roe >= 15) ar.push("ROE guclu (%" + s.roe.toFixed(1) + ")");
  if (!ar.length) ar.push("Belirgin guclu yon yok"); if (!ek.length) ek.push("Kritik olumsuzluk yok"); if (!on.length) on.push("Performans surdurilmeli");
  return { ar, ek, on };
}

/* ── EXPORT FUNCTIONS ── */
function exportGelirCSV(g, gK, d1, d2) {
  const fn = (n) => formatN(n);
  const hasK = gK != null;
  const rows = [];
  if (hasK) rows.push(["Hesap", d1, d2, "Fark", "Degisim %"]);
  else rows.push(["Hesap", d1]);

  const addRow = (label, v1, v2, prefix) => {
    const pre = prefix || "";
    if (hasK && v2 != null) { const f = v1 - v2; const p = v2 !== 0 ? ((v1 - v2) / Math.abs(v2) * 100).toFixed(1) + "%" : "-"; rows.push([pre + label, fn(v1), fn(v2), fn(f), p]); }
    else rows.push([pre + label, fn(v1)]);
  };

  const addSubs = (subs, type, subsKField) => {
    const subsK = gK ? (gK[subsKField] || []) : [];
    for (const s of subs) {
      const val = type === "alacak" ? (s.aBak - s.bBak) : (s.bBak - s.aBak);
      if (val === 0) continue;
      const matchK = subsK.find((sk) => sk.kod === s.kod);
      const valK = matchK ? (type === "alacak" ? (matchK.aBak - matchK.bBak) : (matchK.bBak - matchK.aBak)) : null;
      addRow(s.kod + " " + s.ad, val, valK, "  ");
      const top5 = (g.top5Map && g.top5Map[s.kod]) ? g.top5Map[s.kod] : [];
      const top5K = (gK && gK.top5Map && gK.top5Map[s.kod]) ? gK.top5Map[s.kod] : [];
      for (const t of top5) {
        const tK = top5K.find((tk) => tk.kod === t.kod);
        addRow(t.kod + " " + t.ad, t.val, tK ? tK.val : null, "    ");
      }
    }
  };

  addRow("A. Brut Satislar", g.brutSatis, gK?.brutSatis);
  addSubs(g.subs60, "alacak", "subs60");
  addRow("B. Satis Indirimleri (-)", g.satisInd, gK?.satisInd);
  addSubs(g.subs61, "borc", "subs61");
  addRow("C. Net Satislar", g.netSatis, gK?.netSatis);
  addRow("D. Satislarin Maliyeti (-)", g.satisMal, gK?.satisMal);
  addSubs(g.subsMal, "borc", "subsMal");
  addRow("BRUT KAR", g.brutKar, gK?.brutKar);
  addRow("E. Faaliyet Giderleri (-)", g.faalGid, gK?.faalGid);
  addSubs(g.subsFaal, "borc", "subsFaal");
  addRow("FAALIYET KARI", g.faalKar, gK?.faalKar);
  addRow("F. Diger Faal. Gelirleri", g.digerGel, gK?.digerGel);
  addSubs(g.subs64, "alacak", "subs64");
  addRow("G. Diger Faal. Giderleri (-)", g.digerGid, gK?.digerGid);
  addSubs(g.subs65, "borc", "subs65");
  addRow("H. Finansman Giderleri (-)", g.finGid, gK?.finGid);
  addSubs(g.subsFin, "borc", "subsFin");
  addRow("OLAGAN KAR", g.olaganKar, gK?.olaganKar);
  addRow("I. Olagandisi Gelirler", g.odGel, gK?.odGel);
  addSubs(g.subs67, "alacak", "subs67");
  addRow("J. Olagandisi Giderler (-)", g.odGid, gK?.odGid);
  addSubs(g.subs68, "borc", "subs68");
  addRow("DONEM NET KARI (ZARARI)", g.donemKari, gK?.donemKari);

  downloadCSV(buildCSV(rows), "Gelir_Tablosu_" + d1.replace(/\s/g, "_") + ".csv");
}

function exportGelirHTML(g, gK, d1, d2) {
  const fn = (n) => formatN(n);
  const hasK = gK != null;
  let t = '<h2>Gelir Tablosu' + (hasK ? ' - Karsilastirma' : '') + '</h2>';
  t += '<table><tr><th>Hesap</th><th class="r">' + d1 + '</th>';
  if (hasK) t += '<th class="r">' + d2 + '</th><th class="r">Fark</th><th class="r">%</th>';
  t += '</tr>';

  const tr = (label, v1, v2, bold, hl, indent) => {
    const cls = (bold ? ' b' : '') + (hl ? ' hl' : '');
    const pad = indent ? 'padding-left:' + (indent * 16) + 'px;' : '';
    let r = '<tr class="' + cls + '"><td style="' + pad + '">' + label + '</td><td class="r">' + fn(v1) + '</td>';
    if (hasK && v2 != null) {
      const f = v1 - v2; const p = v2 !== 0 ? ((v1 - v2) / Math.abs(v2) * 100) : 0;
      r += '<td class="r">' + fn(v2) + '</td><td class="r">' + fn(f) + '</td><td class="r ' + (p >= 0 ? 'g' : 'rd') + '">' + (p >= 0 ? '+' : '') + p.toFixed(1) + '%</td>';
    }
    return r + '</tr>';
  };

  const addSubs = (subs, type, subsKField) => {
    let s = '';
    const subsK = gK ? (gK[subsKField] || []) : [];
    for (const sub of subs) {
      const val = type === "alacak" ? (sub.aBak - sub.bBak) : (sub.bBak - sub.aBak);
      if (val === 0) continue;
      const matchK = subsK.find((sk) => sk.kod === sub.kod);
      const valK = matchK ? (type === "alacak" ? (matchK.aBak - matchK.bBak) : (matchK.bBak - matchK.aBak)) : null;
      s += tr(sub.kod + ' ' + sub.ad, val, valK, false, false, 1);
      const top5 = (g.top5Map && g.top5Map[sub.kod]) ? g.top5Map[sub.kod] : [];
      const top5K = (gK && gK.top5Map && gK.top5Map[sub.kod]) ? gK.top5Map[sub.kod] : [];
      for (const tt of top5) {
        const tK = top5K.find((tk) => tk.kod === tt.kod);
        s += tr(tt.kod + ' ' + tt.ad, tt.val, tK ? tK.val : null, false, false, 2);
      }
    }
    return s;
  };

  t += tr('A. Brut Satislar', g.brutSatis, gK?.brutSatis, true, false);
  t += addSubs(g.subs60, 'alacak', 'subs60');
  t += tr('B. Satis Indirimleri (-)', g.satisInd, gK?.satisInd, false, false);
  t += addSubs(g.subs61, 'borc', 'subs61');
  t += tr('C. Net Satislar', g.netSatis, gK?.netSatis, true, true);
  t += tr('D. Satislarin Maliyeti (-)', g.satisMal, gK?.satisMal, false, false);
  t += addSubs(g.subsMal, 'borc', 'subsMal');
  t += tr('BRUT KAR', g.brutKar, gK?.brutKar, true, true);
  t += tr('E. Faaliyet Giderleri (-)', g.faalGid, gK?.faalGid, false, false);
  t += addSubs(g.subsFaal, 'borc', 'subsFaal');
  t += tr('FAALIYET KARI', g.faalKar, gK?.faalKar, true, true);
  t += tr('F. Diger Faal. Gelirleri', g.digerGel, gK?.digerGel, false, false);
  t += addSubs(g.subs64, 'alacak', 'subs64');
  t += tr('G. Diger Faal. Giderleri (-)', g.digerGid, gK?.digerGid, false, false);
  t += addSubs(g.subs65, 'borc', 'subs65');
  t += tr('H. Finansman Giderleri (-)', g.finGid, gK?.finGid, false, false);
  t += addSubs(g.subsFin, 'borc', 'subsFin');
  t += tr('OLAGAN KAR', g.olaganKar, gK?.olaganKar, true, false);
  t += tr('I. Olagandisi Gelirler', g.odGel, gK?.odGel, false, false);
  t += addSubs(g.subs67, 'alacak', 'subs67');
  t += tr('J. Olagandisi Giderler (-)', g.odGid, gK?.odGid, false, false);
  t += addSubs(g.subs68, 'borc', 'subs68');
  t += tr('DONEM NET KARI (ZARARI)', g.donemKari, gK?.donemKari, true, true);
  t += '</table>';

  downloadHTML(buildHTMLReport('Gelir Tablosu - ' + d1, t, ''), 'Gelir_Tablosu_' + d1.replace(/\s/g, '_') + '.html');
}

function exportBilancoCSV(b, bK, g, d1, d2) {
  const fn = (n) => formatN(n);
  const items = [["I. Donen Varliklar", b.donen, bK?.donen], ["  Nakit", b.nakit, bK?.nakit], ["  Ticari Alacak", b.tAlacak, bK?.tAlacak], ["  Stoklar", b.stok, bK?.stok], ["II. Duran Varliklar", b.duran, bK?.duran], ["AKTIF TOPLAM", b.aktif, bK?.aktif], ["I. KVYK", b.kvyk, bK?.kvyk], ["  Ticari Borc", b.tBorc, bK?.tBorc], ["II. UVYK", b.uvyk, bK?.uvyk], ["III. Ozkaynaklar", b.ozk, bK?.ozk], ["PASIF TOPLAM", b.pasif, bK?.pasif]];
  const rows = [];
  if (bK) rows.push(["Hesap", d1, d2, "Fark", "Degisim %"]);
  else rows.push(["Hesap", d1]);
  for (const [l, v1, v2] of items) {
    if (bK && v2 != null) { const f = v1 - v2; const p = v2 !== 0 ? ((v1 - v2) / Math.abs(v2) * 100).toFixed(1) + "%" : "-"; rows.push([l, fn(v1), fn(v2), fn(f), p]); }
    else rows.push([l, fn(v1)]);
  }
  downloadCSV(buildCSV(rows), "Bilanco_" + d1.replace(/\s/g, "_") + ".csv");
}

function exportAnalizCSV(a, d1) {
  const rows = [["Oran", "Deger", "Standart", "Durum"]];
  const items = [["Cari Oran", a.co.toFixed(2), ">1.5"], ["Asit-Test", a.at.toFixed(2), ">1.0"], ["Nakit Orani", a.no.toFixed(2), ">0.2"], ["Borc/Ozkaynak", a.bo.toFixed(2), "<1.0"], ["Brut Kar Marji", "%" + a.bkm.toFixed(1), ">%20"], ["Net Kar Marji", "%" + a.nkm.toFixed(1), ">%5"], ["ROE", "%" + a.roe.toFixed(1), ">%15"], ["ROA", "%" + a.roa.toFixed(1), ">%5"], ["Alacak Tahsil", Math.round(a.ag) + " gun", "<45 gun"], ["Stok Devir", Math.round(a.sg) + " gun", "<60 gun"]];
  for (const [l, v, s] of items) { const d = l.includes("Borc") ? (parseFloat(v) <= 1 ? "SAGLAM" : "RISK") : (v.startsWith("%") ? (parseFloat(v.slice(1)) >= parseFloat(s.slice(2)) ? "SAGLAM" : "TAKIP") : "SAGLAM"); rows.push([l, v, s, d]); }
  downloadCSV(buildCSV(rows), "Analizler_" + d1.replace(/\s/g, "_") + ".csv");
}

function exportDashboardHTML(g, b, a, rapor, d1) {
  const fn = (n) => formatN(n);
  let t = '<h2>Temel Gostergeler</h2><table><tr><th>Gosterge</th><th class="r">Deger</th></tr>';
  t += '<tr class="b"><td>Net Satislar</td><td class="r">' + fn(g.netSatis) + '</td></tr>';
  t += '<tr class="b"><td>Donem Net Kari</td><td class="r ' + (g.donemKari >= 0 ? 'g' : 'rd') + '">' + fn(g.donemKari) + '</td></tr>';
  t += '<tr><td>Aktif Toplam</td><td class="r">' + fn(b.aktif) + '</td></tr>';
  t += '<tr><td>Ozkaynaklar</td><td class="r">' + fn(b.ozk) + '</td></tr>';
  t += '<tr><td>Toplam Borc</td><td class="r">' + fn(b.kvyk + b.uvyk) + '</td></tr>';
  t += '</table>';
  t += '<h2>Finansal Oranlar</h2><table><tr><th>Oran</th><th class="r">Deger</th><th>Standart</th><th>Durum</th></tr>';
  const oranlar = [["Cari Oran", a.co.toFixed(2), ">1.5", a.co >= 1.5], ["Asit-Test", a.at.toFixed(2), ">1.0", a.at >= 1], ["Borc/Ozkaynak", a.bo.toFixed(2), "<1.0", a.bo <= 1], ["Brut Kar Marji", "%" + a.bkm.toFixed(1), ">%20", a.bkm >= 20], ["Net Kar Marji", "%" + a.nkm.toFixed(1), ">%5", a.nkm >= 5], ["ROE", "%" + a.roe.toFixed(1), ">%15", a.roe >= 15], ["ROA", "%" + a.roa.toFixed(1), ">%5", a.roa >= 5]];
  for (const [l, v, s, ok] of oranlar) t += '<tr><td>' + l + '</td><td class="r">' + v + '</td><td>' + s + '</td><td class="' + (ok ? 'g' : 'rd') + '">' + (ok ? 'SAGLAM' : 'RISK') + '</td></tr>';
  t += '</table>';
  let n = '<h2>Yonetici Notlari</h2>';
  if (rapor) {
    for (const r of rapor.ar) n += '<div class="note ng">+ ' + r + '</div>';
    for (const r of rapor.ek) n += '<div class="note nr">! ' + r + '</div>';
    for (const r of rapor.on) n += '<div class="note ny">> ' + r + '</div>';
  }
  downloadHTML(buildHTMLReport("Dashboard - " + d1, t, n), "Dashboard_" + d1.replace(/\s/g, "_") + ".html");
}

function exportFullHTML(g, gK, b, bK, a, rapor, d1, d2) {
  const fn = (n) => formatN(n);
  const hasK = gK != null;
  let t = '<h2>Gelir Tablosu</h2><table><tr><th>Hesap</th><th class="r">' + d1 + '</th>';
  if (hasK) t += '<th class="r">' + d2 + '</th><th class="r">Fark</th><th class="r">%</th>';
  t += '</tr>';
  const gItems = [["A. Brut Satislar", g.brutSatis, gK?.brutSatis, 1, 1], ["B. Satis Indirimleri (-)", g.satisInd, gK?.satisInd, 0, 0], ["C. Net Satislar", g.netSatis, gK?.netSatis, 1, 1], ["D. Satislarin Maliyeti (-)", g.satisMal, gK?.satisMal, 0, 0], ["BRUT KAR", g.brutKar, gK?.brutKar, 1, 1], ["E. Faaliyet Giderleri (-)", g.faalGid, gK?.faalGid, 0, 0], ["FAALIYET KARI", g.faalKar, gK?.faalKar, 1, 1], ["F. Diger Faal. Gelirleri", g.digerGel, gK?.digerGel, 0, 0], ["G. Diger Faal. Giderleri (-)", g.digerGid, gK?.digerGid, 0, 0], ["H. Finansman Giderleri (-)", g.finGid, gK?.finGid, 0, 0], ["OLAGAN KAR", g.olaganKar, gK?.olaganKar, 1, 0], ["Donem Net Kari", g.donemKari, gK?.donemKari, 1, 1]];
  for (const [l, v1, v2, isBold, isHl] of gItems) {
    const cls = (isBold ? ' b' : '') + (isHl ? ' hl' : '');
    t += '<tr class="' + cls + '"><td>' + l + '</td><td class="r">' + fn(v1) + '</td>';
    if (hasK && v2 != null) { const f = v1 - v2; const p = v2 !== 0 ? ((v1 - v2) / Math.abs(v2) * 100) : 0; t += '<td class="r">' + fn(v2) + '</td><td class="r">' + fn(f) + '</td><td class="r ' + (p >= 0 ? 'g' : 'rd') + '">' + (p >= 0 ? '+' : '') + p.toFixed(1) + '%</td>'; }
    t += '</tr>';
  }
  t += '</table>';
  t += '<h2>Bilanco</h2><table><tr><th>Hesap</th><th class="r">' + d1 + '</th>';
  if (hasK) t += '<th class="r">' + d2 + '</th><th class="r">Fark</th><th class="r">%</th>';
  t += '</tr>';
  const bItems = [["I. Donen Varliklar", b.donen, bK?.donen, 1, 0], ["  Nakit", b.nakit, bK?.nakit, 0, 0], ["  Ticari Alacak", b.tAlacak, bK?.tAlacak, 0, 0], ["  Stoklar", b.stok, bK?.stok, 0, 0], ["II. Duran Varliklar", b.duran, bK?.duran, 1, 0], ["AKTIF TOPLAM", b.aktif, bK?.aktif, 1, 1], ["I. KVYK", b.kvyk, bK?.kvyk, 1, 0], ["II. UVYK", b.uvyk, bK?.uvyk, 1, 0], ["III. Ozkaynaklar", b.ozk, bK?.ozk, 1, 0], ["PASIF TOPLAM", b.pasif, bK?.pasif, 1, 1]];
  for (const [l, v1, v2, isBold, isHl] of bItems) {
    const cls = (isBold ? ' b' : '') + (isHl ? ' hl' : '');
    t += '<tr class="' + cls + '"><td>' + l + '</td><td class="r">' + fn(v1) + '</td>';
    if (hasK && v2 != null) { const f = v1 - v2; const p = v2 !== 0 ? ((v1 - v2) / Math.abs(v2) * 100) : 0; t += '<td class="r">' + fn(v2) + '</td><td class="r">' + fn(f) + '</td><td class="r ' + (p >= 0 ? 'g' : 'rd') + '">' + (p >= 0 ? '+' : '') + p.toFixed(1) + '%</td>'; }
    t += '</tr>';
  }
  t += '</table>';
  let n = '<h2>Degerlendirme</h2>';
  if (rapor) { for (const r of rapor.ar) n += '<div class="note ng">+ ' + r + '</div>'; for (const r of rapor.ek) n += '<div class="note nr">! ' + r + '</div>'; n += '<h3>Oneriler</h3>'; for (const r of rapor.on) n += '<div class="note ny">> ' + r + '</div>'; }
  downloadHTML(buildHTMLReport("Finansal Rapor - " + d1, t, n), "Tam_Rapor_" + d1.replace(/\s/g, "_") + ".html");
}

/* ── UI Components ── */
const SEC = { fontSize: 16, fontWeight: 500, color: "var(--color-text-primary)", margin: "1.5rem 0 0.75rem", paddingBottom: 6, borderBottom: "0.5px solid var(--color-border-tertiary)" };
const CARD = { background: "var(--color-background-secondary)", borderRadius: "var(--border-radius-md)", padding: "1rem" };
const DL_STYLE = { padding: "7px 14px", fontSize: 12, fontWeight: 500, cursor: "pointer", background: "var(--color-background-info)", color: "var(--color-text-info)", border: "0.5px solid var(--color-border-info)", borderRadius: "var(--border-radius-md)" };

function Badge({ val }) { if (val == null || isNaN(val)) return null; return (<span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 99, background: val >= 0 ? "#E1F5EE" : "#FCEBEB", color: val >= 0 ? "#0F6E56" : "#A32D2D", fontWeight: 500, whiteSpace: "nowrap" }}>{val >= 0 ? "+" : ""}{val.toFixed(1)}%</span>); }
function CHeader({ d1, d2, extras }) {
  // extras = [{donem: "...", ...}] for multi-period
  const allD = extras && extras.length > 0 ? [d1, ...extras.map((e) => e)] : (d2 ? [d1, d2] : [d1]);
  const hasMulti = allD.length > 1;
  const cols = hasMulti ? "minmax(0,1.8fr) " + allD.map(() => "minmax(0,1fr)").join(" ") : "minmax(0,2.5fr) minmax(0,1fr)";
  return (<div style={{ display: "grid", gridTemplateColumns: cols, padding: "8px 8px", background: "var(--color-background-secondary)", fontWeight: 500, fontSize: allD.length > 4 ? 10 : 12, color: "var(--color-text-secondary)", borderBottom: "0.5px solid var(--color-border-tertiary)", minWidth: allD.length > 5 ? allD.length * 100 + 160 : "auto" }}><span>Hesap</span>{allD.map((dn, i) => <span key={i} style={{ textAlign: "right", fontWeight: i === 0 ? 600 : 400, color: i === 0 ? "var(--color-text-info)" : "var(--color-text-secondary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{String(dn).substring(0, 12)}</span>)}</div>);
}
function CRow({ label, v1, v2, bold, sub, leaf, hl, extraVals }) {
  // extraVals = [num, num, ...] for multi-period
  const allV = extraVals && extraVals.length > 0 ? [v1, ...extraVals] : (v2 != null ? [v1, v2] : [v1]);
  const hasMulti = allV.length > 1;
  const fs = leaf ? 12 : sub ? 13 : 14; const pl = leaf ? 40 : sub ? 28 : 8;
  const clr = leaf ? "var(--color-text-tertiary)" : sub ? "var(--color-text-secondary)" : "var(--color-text-primary)";
  const py = leaf ? "3px 0" : sub ? "5px 0" : "8px 0"; const bb = leaf ? "none" : "0.5px solid var(--color-border-tertiary)";
  const cols = hasMulti ? "minmax(0,1.8fr) " + allV.map(() => "minmax(0,1fr)").join(" ") : "minmax(0,2.5fr) minmax(0,1fr)";
  return (<div style={{ display: "grid", gridTemplateColumns: cols, padding: py, paddingLeft: pl, borderBottom: bb, fontWeight: bold ? 500 : 400, fontSize: fs, color: clr, background: hl ? "var(--color-background-secondary)" : "transparent", alignItems: "center", gap: 2, minWidth: allV.length > 5 ? allV.length * 100 + 160 : "auto" }}><span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>{allV.map((v, i) => <span key={i} style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", fontWeight: i === 0 ? (bold ? 600 : 500) : 400, color: i === 0 ? clr : "var(--color-text-secondary)" }}>{formatN(v)}</span>)}</div>);
}
function SubCRows({ subs, type, top5Map, gK, subsKField, extraGelirler }) {
  if (!subs || !subs.length) return null;
  const subsK = gK && gK[subsKField] ? gK[subsKField] : [];
  const extraSubsList = (extraGelirler || []).map((eg) => eg && eg[subsKField] ? eg[subsKField] : []);
  return (<>{subs.map((s) => { const val = type === "alacak" ? (s.aBak - s.bBak) : (s.bBak - s.aBak); if (val === 0) return null; const matchK = subsK.find((sk) => sk.kod === s.kod); const valK = matchK ? (type === "alacak" ? (matchK.aBak - matchK.bBak) : (matchK.bBak - matchK.aBak)) : null; const extraV = extraSubsList.map((esubs) => { const m = esubs.find((sk) => sk.kod === s.kod); return m ? (type === "alacak" ? (m.aBak - m.bBak) : (m.bBak - m.aBak)) : 0; }); const top5 = (top5Map && top5Map[s.kod]) ? top5Map[s.kod] : []; const top5K = (gK && gK.top5Map && gK.top5Map[s.kod]) ? gK.top5Map[s.kod] : []; return (<div key={s.kod}><CRow label={s.kod + " " + s.ad} v1={val} v2={extraV.length > 0 ? null : valK} sub extraVals={extraV.length > 0 ? extraV : undefined} />{top5.map((t) => { const tK = top5K.find((tk) => tk.kod === t.kod); return <CRow key={t.kod} label={t.kod + " " + t.ad} v1={t.val} v2={extraV.length > 0 ? null : (tK ? tK.val : null)} leaf />; })}</div>); })}</>);
}
function OranCard({ ad, deger, ac, renk }) { return (<div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-lg)", padding: "1rem 1.25rem" }}><div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 6 }}>{ad}</div><div style={{ fontSize: 22, fontWeight: 500, color: renk }}>{deger}</div>{ac && <div style={{ fontSize: 12, color: "var(--color-text-tertiary)", marginTop: 4 }}>{ac}</div>}</div>); }

/* ── Cash Flow Calculation ── */
function calcNakitAkis(mSel, mKarsi, gSel) {
  if (!mSel || !mKarsi || !gSel) return null;
  const rS = mSel.rows, rK = mKarsi.rows;
  const aktS = (p) => { const e = rS.find((x) => x.kod === p); return e ? e.bBak - e.aBak : 0; };
  const aktK = (p) => { const e = rK.find((x) => x.kod === p); return e ? e.bBak - e.aBak : 0; };
  const pasS = (p) => { const e = rS.find((x) => x.kod === p); return e ? e.aBak - e.bBak : 0; };
  const pasK = (p) => { const e = rK.find((x) => x.kod === p); return e ? e.aBak - e.bBak : 0; };

  const donemKari = gSel.donemKari;

  // Amortisman (257 + 268 birikimli amortisman farki)
  const amor = (pasS("257") + pasS("268")) - (pasK("257") + pasK("268"));

  // Isletme sermayesi degisimleri
  const ticAlacak = -(aktS("12") - aktK("12"));
  const digAlacak = -(aktS("13") - aktK("13"));
  const stok = -(aktS("15") - aktK("15"));
  const digDonenVarlik = -((aktS("18") - aktK("18")) + (aktS("19") - aktK("19")));
  const ticBorc = pasS("32") - pasK("32");
  const digBorc = pasS("33") - pasK("33");
  const vergiBorc = pasS("36") - pasK("36");
  const borcKarsilik = pasS("37") - pasK("37");
  const digKvyk = (pasS("38") - pasK("38")) + (pasS("39") - pasK("39"));

  const isletmeSermayesi = ticAlacak + digAlacak + stok + digDonenVarlik + ticBorc + digBorc + vergiBorc + borcKarsilik + digKvyk;
  const faaliyetNakit = donemKari + amor + isletmeSermayesi;

  // Yatirim: MDV + MODK (brut) degisimi
  const mdvBrut = (aktS("25") + pasS("257")) - (aktK("25") + pasK("257"));
  const modkBrut = (aktS("26") + pasS("268")) - (aktK("26") + pasK("268"));
  const uzunAlacak = -(aktS("22") - aktK("22"));
  const digDuranV = -((aktS("28") - aktK("28")));
  const yatirimNakit = -(mdvBrut + modkBrut) + uzunAlacak + digDuranV;

  // Finansman: kredi + ozkaynak
  const kvMaliBorc = pasS("30") - pasK("30");
  const uvMaliBorc = pasS("40") - pasK("40");
  const sermaye = pasS("50") - pasK("50");
  const sermayeYedek = (pasS("52") - pasK("52")) + (pasS("54") - pasK("54"));
  const finansmanNakit = kvMaliBorc + uvMaliBorc + sermaye + sermayeYedek;

  const netNakit = faaliyetNakit + yatirimNakit + finansmanNakit;
  const nakitBasi = aktK("10");
  const nakitSonu = aktS("10");

  return {
    donemKari, amor,
    ticAlacak, digAlacak, stok, digDonenVarlik,
    ticBorc, digBorc, vergiBorc, borcKarsilik, digKvyk,
    isletmeSermayesi, faaliyetNakit,
    mdvBrut: -(mdvBrut), modkBrut: -(modkBrut), uzunAlacak, digDuranV, yatirimNakit,
    kvMaliBorc, uvMaliBorc, sermaye, sermayeYedek, finansmanNakit,
    netNakit, nakitBasi, nakitSonu,
  };
}

/* ── Main App ── */
/* ── Sector Benchmark Data ── */
const SEKTORLER = {
  "gida": {
    ad: "Gida Uretim",
    cariOran: [1.3, 1.8],
    asitTest: [0.8, 1.2],
    nakitOrani: [0.1, 0.3],
    borcOzkaynak: [0.5, 1.5],
    brutKarMarji: [20, 35],
    netKarMarji: [3, 8],
    faalKarMarji: [5, 12],
    roe: [8, 20],
    roa: [3, 10],
    alacakGun: [30, 60],
    stokGun: [30, 90],
  },
  "perakende": {
    ad: "Perakende / E-ticaret",
    cariOran: [1.0, 1.5],
    asitTest: [0.5, 1.0],
    nakitOrani: [0.1, 0.3],
    borcOzkaynak: [0.8, 2.0],
    brutKarMarji: [15, 30],
    netKarMarji: [2, 6],
    faalKarMarji: [3, 10],
    roe: [10, 25],
    roa: [3, 8],
    alacakGun: [15, 45],
    stokGun: [30, 75],
  },
  "uretim": {
    ad: "Uretim / Imalat",
    cariOran: [1.2, 2.0],
    asitTest: [0.7, 1.2],
    nakitOrani: [0.05, 0.2],
    borcOzkaynak: [0.5, 1.5],
    brutKarMarji: [15, 30],
    netKarMarji: [3, 10],
    faalKarMarji: [5, 15],
    roe: [8, 18],
    roa: [3, 8],
    alacakGun: [30, 75],
    stokGun: [45, 120],
  },
  "hizmet": {
    ad: "Hizmet",
    cariOran: [1.2, 2.0],
    asitTest: [1.0, 1.8],
    nakitOrani: [0.2, 0.5],
    borcOzkaynak: [0.3, 1.0],
    brutKarMarji: [30, 60],
    netKarMarji: [5, 15],
    faalKarMarji: [8, 25],
    roe: [12, 30],
    roa: [5, 15],
    alacakGun: [20, 60],
    stokGun: [0, 15],
  },
  "insaat": {
    ad: "Insaat / Gayrimenkul",
    cariOran: [1.0, 1.5],
    asitTest: [0.6, 1.0],
    nakitOrani: [0.05, 0.2],
    borcOzkaynak: [1.0, 3.0],
    brutKarMarji: [10, 25],
    netKarMarji: [3, 10],
    faalKarMarji: [5, 15],
    roe: [8, 20],
    roa: [2, 7],
    alacakGun: [30, 90],
    stokGun: [60, 180],
  },
  "teknoloji": {
    ad: "Teknoloji / Yazilim",
    cariOran: [1.5, 3.0],
    asitTest: [1.2, 2.5],
    nakitOrani: [0.3, 1.0],
    borcOzkaynak: [0.2, 0.8],
    brutKarMarji: [50, 80],
    netKarMarji: [10, 25],
    faalKarMarji: [15, 35],
    roe: [15, 35],
    roa: [8, 20],
    alacakGun: [30, 60],
    stokGun: [0, 10],
  },
  "tarim": {
    ad: "Tarim / Hayvancilik",
    cariOran: [1.0, 1.5],
    asitTest: [0.5, 0.9],
    nakitOrani: [0.05, 0.15],
    borcOzkaynak: [0.5, 2.0],
    brutKarMarji: [15, 30],
    netKarMarji: [2, 8],
    faalKarMarji: [3, 12],
    roe: [5, 15],
    roa: [2, 7],
    alacakGun: [20, 60],
    stokGun: [60, 150],
  },
};

const TABS = ["Mizan Yukle", "Gelir Tablosu", "Bilanco", "Nakit Akis", "Analizler", "Dashboard", "Rapor", "Vergi", "Sektor", "Gider Analizi", "Gelir Vergisi", "KDV"];
const TAB_GROUPS = [
  { grp: "Veri", tabs: [0] },
  { grp: "Tablolar", tabs: [1, 2, 3] },
  { grp: "Analiz", tabs: [4, 5, 6] },
  { grp: "Vergi", tabs: [7, 10, 11] },
  { grp: "Detay", tabs: [8, 9] },
];
const NAV_ICONS = {
  Veri: '<path d="M12 15V4M7.5 8.5 12 4l4.5 4.5"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  Tablolar: '<rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M3.5 9.5h17M3.5 14.5h17M9.5 9.5V20"/>',
  Analiz: '<path d="M4 20h16"/><path d="M7 16v-4M12 16V6M17 16v-7"/>',
  Vergi: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  Detay: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
};

export default function App() {
  const [tab, setTab] = useState(0);
  const [mizanlar, setMizanlar] = useState([]);
  const [sel, setSel] = useState(0);
  const [karsiList, setKarsiList] = useState([]);
  const [loading, setLoading] = useState(false);
  const [info, setInfo] = useState(null);
  const [detay, setDetay] = useState(true);
  const [vergiSMM, setVergiSMM] = useState("");
  const [vergiOran, setVergiOran] = useState("25");
  const [vergiOdenen, setVergiOdenen] = useState("");
  const [sektor, setSektor] = useState("gida");
  const [expandedGider, setExpandedGider] = useState({});
  const [expandedBil, setExpandedBil] = useState({});
  const [gvDilimler, setGvDilimler] = useState([
    { limit: 158000, oran: 15 },
    { limit: 330000, oran: 20 },
    { limit: 800000, oran: 27 },
    { limit: 4300000, oran: 35 },
    { limit: Infinity, oran: 40 },
  ]);
  const [gvCeyrekler, setGvCeyrekler] = useState([
    { ad: "1. Ceyrek (Ocak-Mart)", matrah: "", odenen: "" },
    { ad: "2. Ceyrek (Nisan-Haziran)", matrah: "", odenen: "" },
    { ad: "3. Ceyrek (Temmuz-Eylul)", matrah: "", odenen: "" },
    { ad: "4. Ceyrek (Ekim-Aralik)", matrah: "", odenen: "" },
  ]);
  const [gvGeciciOran, setGvGeciciOran] = useState("15");
  const [gvBagkur, setGvBagkur] = useState("");
  const [gvHataPayi, setGvHataPayi] = useState("9");
  const [gvVergiIndirimi, setGvVergiIndirimi] = useState("5");
  const fRef = useRef();

  /* ── Mobil / PWA durumlari ── */
  const isMobile = useIsMobile();
  const contentRef = useRef(null);
  const [periodOpen, setPeriodOpen] = useState(false);
  const [lastInGroup, setLastInGroup] = useState({});
  const [toast, setToast] = useState(null);
  const [online, setOnline] = useState(() => typeof navigator === "undefined" ? true : navigator.onLine !== false);
  const [restored, setRestored] = useState(false);
  const [installEvt, setInstallEvt] = useState(() => (typeof window !== "undefined" && window.__faInstall) || null);
  const [installHidden, setInstallHidden] = useState(() => { try { return localStorage.getItem("fa-install-hidden") === "1"; } catch (e) { return false; } });
  const [clearArm, setClearArm] = useState(false);
  const [layoutTick, setLayoutTick] = useState(0);
  const isStandalone = typeof window !== "undefined" && ((window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || window.navigator.standalone === true);
  const isIOS = typeof navigator !== "undefined" && (/iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

  const showToast = useCallback((t) => { setToast(t); clearTimeout(showToast._t); showToast._t = setTimeout(() => setToast(null), 2800); }, []);

  // Cevrimici / cevrimdisi, kurulum istemi, ekran boyutu
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    const inst = () => setInstallEvt(window.__faInstall || null);
    const installed = () => { setInstallEvt(null); window.__faInstall = null; };
    let rt; const rs = () => { clearTimeout(rt); rt = setTimeout(() => setLayoutTick((x) => x + 1), 150); };
    window.addEventListener("online", on); window.addEventListener("offline", off);
    window.addEventListener("fa-installable", inst); window.addEventListener("appinstalled", installed);
    window.addEventListener("resize", rs);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); window.removeEventListener("fa-installable", inst); window.removeEventListener("appinstalled", installed); window.removeEventListener("resize", rs); };
  }, []);

  // Acilista: cihazda kayitli mizanlari ve ayarlari geri yukle
  useEffect(() => {
    let alive = true;
    (async () => {
      const saved = await idbGet("mizanlar");
      const st = (await idbGet("ayarlar")) || {};
      if (!alive) return;
      if (Array.isArray(saved) && saved.length) {
        setMizanlar((p) => (p.length ? p : saved));
        const n = saved.length;
        if (typeof st.sel === "number" && st.sel < n) setSel(st.sel);
        if (Array.isArray(st.karsiList)) setKarsiList(st.karsiList.filter((x) => typeof x === "number" && x < n && x !== st.sel));
        let urlTab = null;
        try { const q = new URLSearchParams(window.location.search).get("tab"); if (q != null && !isNaN(+q)) urlTab = +q; } catch (e) {}
        const t = urlTab != null ? urlTab : st.tab;
        if (typeof t === "number" && t >= 0 && t < TABS.length) setTab(t);
        showToast(n + " donem bu cihazdan geri yuklendi");
      }
      if (st.vergiSMM != null) setVergiSMM(st.vergiSMM);
      if (st.vergiOran != null) setVergiOran(st.vergiOran);
      if (st.vergiOdenen != null) setVergiOdenen(st.vergiOdenen);
      if (st.sektor) setSektor(st.sektor);
      if (Array.isArray(st.gvDilimler) && st.gvDilimler.length) setGvDilimler(st.gvDilimler);
      if (Array.isArray(st.gvCeyrekler) && st.gvCeyrekler.length === 4) setGvCeyrekler(st.gvCeyrekler);
      if (st.gvGeciciOran != null) setGvGeciciOran(st.gvGeciciOran);
      if (st.gvBagkur != null) setGvBagkur(st.gvBagkur);
      if (st.gvHataPayi != null) setGvHataPayi(st.gvHataPayi);
      if (st.gvVergiIndirimi != null) setGvVergiIndirimi(st.gvVergiIndirimi);
      setRestored(true);
    })();
    return () => { alive = false; };
  }, []);

  // Degisiklikleri cihaza kaydet
  useEffect(() => { if (restored) idbSet("mizanlar", mizanlar); }, [restored, mizanlar]);
  useEffect(() => {
    if (!restored) return;
    const t = setTimeout(() => idbSet("ayarlar", { sel, karsiList, tab, vergiSMM, vergiOran, vergiOdenen, sektor, gvDilimler, gvCeyrekler, gvGeciciOran, gvBagkur, gvHataPayi, gvVergiIndirimi }), 400);
    return () => clearTimeout(t);
  }, [restored, sel, karsiList, tab, vergiSMM, vergiOran, vergiOdenen, sektor, gvDilimler, gvCeyrekler, gvGeciciOran, gvBagkur, gvHataPayi, gvVergiIndirimi]);

  // Sekme degisince basa kaydir, grubun son sekmesini hatirla
  useEffect(() => {
    try { window.scrollTo({ top: 0, behavior: "instant" }); } catch (e) { window.scrollTo(0, 0); }
    setPeriodOpen(false);
    const gr = TAB_GROUPS.find((x) => x.tabs.includes(tab));
    if (gr) setLastInGroup((p) => (p[gr.grp] === tab ? p : { ...p, [gr.grp]: tab }));
  }, [tab]);

  // Her cizimden sonra tablolari telefona uyarla
  useLayoutEffect(() => { applyMobileLayout(contentRef.current, isMobile); });

  const doInstall = async () => {
    const ev = installEvt || window.__faInstall;
    if (!ev) return;
    ev.prompt();
    try { const r = await ev.userChoice; if (r && r.outcome === "accepted") showToast("Uygulama ana ekrana eklendi"); } catch (e) {}
    window.__faInstall = null; setInstallEvt(null);
  };
  const hideInstall = () => { setInstallHidden(true); try { localStorage.setItem("fa-install-hidden", "1"); } catch (e) {} };
  const clearAll = async () => {
    if (!clearArm) { setClearArm(true); setTimeout(() => setClearArm(false), 4000); return; }
    setClearArm(false);
    await idbClear();
    setMizanlar([]); setSel(0); setKarsiList([]); setInfo(null); setTab(0);
    showToast("Bu cihazdaki tum veriler silindi");
  };

  const toggleKarsi = (idx) => setKarsiList((p) => p.includes(idx) ? p.filter((x) => x !== idx) : [...p, idx]);
  const karsi = karsiList.length > 0 ? karsiList[0] : -1; // backward compat

  const onFile = useCallback(async (e) => {
    const files = Array.from(e.target.files || []); if (!files.length) return;
    setLoading(true); setInfo(null);
    for (const file of files) { try { const result = await readFile(file); if (result.error) { setInfo({ ok: false, text: result.error }); continue; } if (!result.rows) { setInfo({ ok: false, text: "Dosya okunamadi." }); continue; } const { data, err } = parseMizan(result.rows, file.name); if (data) { setMizanlar((p) => [...p, data]); setInfo({ ok: true, text: file.name + ": " + data.rows.length + " hesap yuklendi." }); } else { setInfo({ ok: false, text: err }); } } catch (ex) { setInfo({ ok: false, text: ex.message }); } }
    setLoading(false); if (fRef.current) fRef.current.value = "";
  }, []);
  const remove = (i) => { setMizanlar((p) => p.filter((_, j) => j !== i)); setSel(0); setKarsiList([]); };

  const gelirler = useMemo(() => mizanlar.map(calcGelir), [mizanlar]);
  const bilancolar = useMemo(() => mizanlar.map((m, i) => calcBil(m, gelirler[i] ? gelirler[i].donemKari : 0)), [mizanlar, gelirler]);
  const analizler = useMemo(() => mizanlar.map((_, i) => calcAnaliz(gelirler[i], bilancolar[i])), [gelirler, bilancolar]);
  const dikeyler = useMemo(() => mizanlar.map((_, i) => calcDikey(bilancolar[i], gelirler[i])), [bilancolar, gelirler]);
  const rapor = useMemo(() => genRapor(analizler), [analizler]);

  const g = gelirler[sel], b = bilancolar[sel], a = analizler[sel], d = dikeyler[sel];
  const gK = karsi >= 0 ? gelirler[karsi] : null, bK = karsi >= 0 ? bilancolar[karsi] : null;
  const hasK = karsi >= 0 && gK != null;
  const d1 = mizanlar[sel] ? mizanlar[sel].donem : "";
  const d2 = hasK ? mizanlar[karsi].donem : null;

  // Multi-period extras (excluding sel and first karsi)
  const multiMode = karsiList.length > 1;
  const extraDonems = karsiList.map((i) => mizanlar[i]?.donem || "?");
  const extraGelirler = karsiList.map((i) => gelirler[i]);
  const extraBilancolar = karsiList.map((i) => bilancolar[i]);
  const multiGelirVal = (field) => extraGelirler.map((eg) => eg ? eg[field] : 0);
  const multiBilVal = (field) => extraBilancolar.map((eb) => eb ? eb[field] : 0);

  const renk = (v, iyi, orta) => v >= iyi ? "#0F6E56" : v >= (orta != null ? orta : iyi) ? "#BA7517" : "#A32D2D";

  const activeGroup = TAB_GROUPS.find((gr) => gr.tabs.includes(tab)) || TAB_GROUPS[0];
  const hasData = mizanlar.length > 0;
  const showPeriods = mizanlar.length > 1 && tab > 0 && tab < 12;
  const periodControls = (
    <>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center", marginBottom: karsiList.length > 0 ? 10 : 0 }}>
            <label style={{ fontSize: 13, color: "var(--color-text-secondary)", display: "flex", alignItems: "center", gap: 6 }}>Ana donem: <select value={sel} onChange={(e) => { setSel(+e.target.value); setKarsiList((p) => p.filter((x) => x !== +e.target.value)); }} style={{ padding: "4px 8px", borderRadius: "var(--border-radius-md)", border: "0.5px solid var(--color-border-secondary)", fontSize: 13, fontWeight: 500 }}>{mizanlar.map((m, i) => <option key={i} value={i}>{m.donem}</option>)}</select></label>
            <span style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>Karsilastir:</span>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {mizanlar.map((m, i) => i !== sel ? (
                <button key={i} onClick={() => toggleKarsi(i)} style={{ padding: "4px 12px", fontSize: 12, borderRadius: 99, cursor: "pointer", fontWeight: karsiList.includes(i) ? 600 : 400, background: karsiList.includes(i) ? "var(--color-background-info)" : "var(--color-background-primary)", color: karsiList.includes(i) ? "var(--color-text-info)" : "var(--color-text-secondary)", border: "0.5px solid " + (karsiList.includes(i) ? "var(--color-border-info)" : "var(--color-border-tertiary)"), transition: "all 0.15s" }}>{m.donem}</button>
              ) : null)}
              {karsiList.length > 0 && <button onClick={() => setKarsiList([])} style={{ padding: "4px 10px", fontSize: 11, borderRadius: 99, cursor: "pointer", background: "var(--color-background-danger)", color: "var(--color-text-danger)", border: "0.5px solid var(--color-border-danger)" }}>Temizle</button>}
              {mizanlar.length > 2 && karsiList.length === 0 && <button onClick={() => setKarsiList(mizanlar.map((_, i) => i).filter((i) => i !== sel))} style={{ padding: "4px 10px", fontSize: 11, borderRadius: 99, cursor: "pointer", background: "var(--color-background-primary)", color: "var(--color-text-info)", border: "0.5px solid var(--color-border-info)" }}>Tumunu sec</button>}
            </div>
          </div>
          {karsiList.length > 0 && <div style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>{karsiList.length} donem secildi — tablolarda karsilastirma aktif{karsiList.length > 1 ? " (coklu donem)" : ""}</div>}
    </>
  );
  const barStyle = { background: "var(--fa-bar-bg)", backdropFilter: "saturate(1.6) blur(14px)", WebkitBackdropFilter: "saturate(1.6) blur(14px)" };

  return (
    <div className="fa-app" style={{ fontFamily: "var(--font-sans)", padding: isMobile ? 0 : "0.5rem 0", paddingBottom: isMobile ? "calc(86px + env(safe-area-inset-bottom))" : undefined }}>
      <style>{FA_MOBILE_CSS}</style>

      {/* ── Masaustu navigasyon ── */}
      {!isMobile && (<>
      <div style={{ marginBottom: "1.25rem" }}>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", paddingBottom: 8, borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
          {TAB_GROUPS.map((group) => (
            <div key={group.grp} style={{ display: "flex", gap: 2, alignItems: "center" }}>
              {group.tabs.map((i) => {
                const disabled = i > 0 && !mizanlar.length;
                return (<button key={i} data-tab={i} onClick={() => !disabled && setTab(i)} style={{ padding: "8px 12px", fontSize: 12, cursor: disabled ? "default" : "pointer", fontWeight: tab === i ? 600 : 400, background: tab === i ? "var(--color-background-info)" : "transparent", border: tab === i ? "0.5px solid var(--color-border-info)" : "0.5px solid transparent", borderRadius: "var(--border-radius-md)", color: tab === i ? "var(--color-text-info)" : disabled ? "var(--color-text-tertiary)" : "var(--color-text-secondary)", opacity: disabled ? 0.5 : 1, transition: "all 0.15s" }}>{TABS[i]}</button>);
              })}
              {group !== TAB_GROUPS[TAB_GROUPS.length - 1] && <span style={{ margin: "0 6px", color: "var(--color-border-tertiary)", fontSize: 11 }}>|</span>}
            </div>
          ))}
        </div>
      </div>
      {showPeriods && (
        <div style={{ marginBottom: "1rem", padding: "12px 14px", background: "var(--color-background-secondary)", borderRadius: "var(--border-radius-md)" }}>
          {periodControls}
        </div>
      )}
      </>)}

      {/* ── Mobil ust cubuk: sekme adi, donem, alt sekmeler ── */}
      {isMobile && (
        <div style={{ position: "sticky", top: 0, zIndex: 50, margin: "0 -16px 14px", padding: "calc(env(safe-area-inset-top) + 10px) 16px 10px", borderBottom: "0.5px solid var(--color-border-tertiary)", ...barStyle }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
              <span style={{ width: 30, height: 30, borderRadius: 9, background: "linear-gradient(135deg, #2F5496, #4A78C8)", color: "#fff", fontSize: 12, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, letterSpacing: 0.3 }}>FA</span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 16, fontWeight: 650, lineHeight: 1.2, color: "var(--color-text-primary)" }}>{TABS[tab]}</div>
                <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{hasData ? d1 + (karsiList.length ? " · +" + karsiList.length + " donem karsilastirma" : "") : "Finansal Analiz"}</div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
              {!online && <span style={{ fontSize: 10, padding: "3px 8px", borderRadius: 99, background: "var(--color-background-warning)", color: "var(--color-text-warning)", fontWeight: 600 }}>Cevrimdisi</span>}
              {showPeriods && <button onClick={() => setPeriodOpen((o) => !o)} aria-expanded={periodOpen} style={{ padding: "7px 12px", fontSize: 12, fontWeight: 600, borderRadius: 99, cursor: "pointer", background: periodOpen || karsiList.length ? "var(--color-background-info)" : "var(--color-background-secondary)", color: periodOpen || karsiList.length ? "var(--color-text-info)" : "var(--color-text-secondary)", border: "0.5px solid " + (periodOpen || karsiList.length ? "var(--color-border-info)" : "var(--color-border-tertiary)") }}>Donem {periodOpen ? "\u25B4" : "\u25BE"}</button>}
            </div>
          </div>
          {activeGroup.tabs.length > 1 && (
            <div className="fa-hscroll" style={{ display: "flex", gap: 6, marginTop: 10, marginRight: -16, paddingRight: 16 }}>
              {activeGroup.tabs.map((i) => (
                <button key={i} data-tab={i} onClick={() => setTab(i)} style={{ flexShrink: 0, padding: "8px 14px", fontSize: 13, borderRadius: 99, cursor: "pointer", whiteSpace: "nowrap", fontWeight: tab === i ? 600 : 500, background: tab === i ? "var(--color-text-info)" : "var(--color-background-secondary)", color: tab === i ? "var(--color-background-primary)" : "var(--color-text-secondary)", border: "none", transition: "all 0.15s" }}>{TABS[i]}</button>
              ))}
            </div>
          )}
          {showPeriods && periodOpen && (
            <div style={{ marginTop: 10, padding: "12px", background: "var(--color-background-secondary)", borderRadius: 12, maxHeight: "55vh", overflowY: "auto" }}>
              {periodControls}
              <button onClick={() => setPeriodOpen(false)} style={{ marginTop: 10, width: "100%", padding: "10px", fontSize: 14, fontWeight: 600, borderRadius: 10, border: "none", cursor: "pointer", background: "var(--color-text-info)", color: "var(--color-background-primary)" }}>Tamam</button>
            </div>
          )}
        </div>
      )}

      {toast && <div role="status" style={{ position: "fixed", left: "50%", transform: "translateX(-50%)", bottom: isMobile ? "calc(80px + env(safe-area-inset-bottom))" : 24, zIndex: 70, padding: "10px 16px", borderRadius: 99, background: "var(--color-text-primary)", color: "var(--color-background-primary)", fontSize: 13, fontWeight: 500, boxShadow: "0 6px 24px rgba(0,0,0,0.18)", maxWidth: "90vw", textAlign: "center" }}>{toast}</div>}

      <div className="fa-content" ref={contentRef}>

      {/* TAB 0: Mizan Yukle — Wizard */}
      {tab === 0 && (<div>
        {/* Uygulamayi ana ekrana ekle (PWA) */}
        {!isStandalone && !installHidden && (installEvt || isIOS) && (
          <div style={{ marginBottom: "1rem", padding: "14px 16px", borderRadius: 14, border: "0.5px solid var(--color-border-info)", background: "var(--color-background-primary)", display: "flex", gap: 12, alignItems: "flex-start" }}>
            <span style={{ width: 40, height: 40, borderRadius: 11, background: "linear-gradient(135deg, #2F5496, #4A78C8)", color: "#fff", fontSize: 14, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>FA</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 2 }}>Uygulama olarak kullanin</div>
              {installEvt ? (
                <div style={{ fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.6 }}>Ana ekrana ekleyin; tam ekran acilir, internet olmadan da calisir. Magaza veya hesap gerekmez.</div>
              ) : (
                <div style={{ fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.6 }}>Safari'de alttaki <b>Paylas</b> simgesine (kare ve yukari ok) dokunun, ardindan <b>Ana Ekrana Ekle</b>'yi secin. Tam ekran acilir, internet olmadan da calisir.</div>
              )}
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                {installEvt && <button onClick={doInstall} style={{ padding: "8px 16px", fontSize: 13, fontWeight: 600, borderRadius: 99, border: "none", cursor: "pointer", background: "var(--color-text-info)", color: "var(--color-background-primary)" }}>Ana ekrana ekle</button>}
                <button onClick={hideInstall} style={{ padding: "8px 14px", fontSize: 13, borderRadius: 99, border: "0.5px solid var(--color-border-tertiary)", cursor: "pointer", background: "transparent", color: "var(--color-text-secondary)" }}>Simdi degil</button>
              </div>
            </div>
          </div>
        )}

        {/* Step 1: Bilgilendirme */}
        {mizanlar.length === 0 && (
          <div style={{ marginBottom: "1.5rem", padding: "20px", background: "linear-gradient(135deg, var(--color-background-info) 0%, var(--color-background-primary) 100%)", borderRadius: 16, border: "0.5px solid var(--color-border-info)" }}>
            <div style={{ fontSize: 17, fontWeight: 600, color: "var(--color-text-info)", marginBottom: 8 }}>Hosgeldiniz</div>
            <div style={{ fontSize: 13, color: "var(--color-text-secondary)", lineHeight: 1.8 }}>
              Bu uygulama muhasebe programinizdan aldığınız <b>mizan</b> dosyasini yukleyerek otomatik finansal analiz yapar.
              Gelir tablosu, bilanco, nakit akis, finansal oranlar, dashboard, gider analizi, vergi ve KDV tablolari otomatik olusturulur.
            </div>
            <div className="fa-stack" style={{ marginTop: 14, display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
              {[
                ["1", "Mizan yukle", "Asagidaki alana dosyanizi surukleyin veya tiklayin"],
                ["2", "Donemi dogrulayin", "Sistem dosya adindan donemi algilayacak"],
                ["3", "Analiz baslat", "Tum tablolar otomatik olusturulur"],
              ].map(([n, title, desc]) => (
                <div key={n} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                  <span style={{ width: 24, height: 24, borderRadius: "50%", background: "var(--color-text-info)", color: "#fff", fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{n}</span>
                  <div><div style={{ fontSize: 13, fontWeight: 500 }}>{title}</div><div style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>{desc}</div></div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Upload Area */}
        <div style={{ marginBottom: "1rem" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <span style={{ fontSize: 15, fontWeight: 500 }}>{mizanlar.length === 0 ? "Adim 1: Mizan dosyasini yukleyin" : "Baska bir donem daha ekleyin"}</span>
            {mizanlar.length > 0 && <span style={{ fontSize: 11, padding: "2px 10px", borderRadius: 99, background: "var(--color-background-success)", color: "var(--color-text-success)", fontWeight: 500 }}>{mizanlar.length} donem yuklendi</span>}
          </div>
          <div onClick={() => fRef.current && fRef.current.click()} style={{ border: "2px dashed var(--color-border-secondary)", borderRadius: 16, padding: "2.5rem 1.5rem", textAlign: "center", cursor: "pointer", background: "var(--color-background-secondary)", transition: "border-color 0.2s" }}>
            <div style={{ fontSize: 40, opacity: 0.2, lineHeight: 1, marginBottom: 8 }}>+</div>
            <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 4 }}>{loading ? "Yukleniyor..." : "Dosya secmek icin tiklayin"}</div>
            <div style={{ fontSize: 13, color: "var(--color-text-secondary)", marginBottom: 8 }}>Excel (.xlsx .xls) / CSV (.csv) / ODS / XML / TXT</div>
            <div style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>Birden fazla dosya secebilirsiniz — her biri ayri donem olarak yuklenir</div>
          </div>
          <input ref={fRef} type="file" accept=".csv,.tsv,.txt,.xlsx,.xls,.ods,.xml" multiple onChange={onFile} style={{ display: "none" }} />
        </div>

        {/* Info Note */}
        <div style={{ padding: "12px 14px", background: "var(--color-background-warning)", borderRadius: "var(--border-radius-md)", borderLeft: "3px solid var(--color-border-warning)", marginBottom: "1rem", fontSize: 12, color: "var(--color-text-warning)", lineHeight: 1.7 }}>
          <b>Mizan dosyasi nasil olmali?</b> Muhasebe programinizdan (Logo, Mikro, Eta, Luca, Parasut, Netsis, Zirve vb.) mizan raporunu alistiginiz sekilde disari aktarin.
          Sistemimiz baslik satirini otomatik algilar — "Hesap Kodu", "Borc Bakiye", "Alacak Bakiye" sutunlarini bulur.
          Dosya adini donem bilgisi iceren sekilde verin (orn: "Ocak_2025_Mizan.xlsx") — sistem donemi buradan algilar.
        </div>

        {/* Upload Result */}
        {info && (<div style={{ marginBottom: "1rem", padding: "12px 16px", borderRadius: "var(--border-radius-md)", background: info.ok ? "var(--color-background-success)" : "var(--color-background-danger)", borderLeft: "3px solid " + (info.ok ? "var(--color-border-success)" : "var(--color-border-danger)") }}>
          <div style={{ fontSize: 13, fontWeight: 500, color: info.ok ? "var(--color-text-success)" : "var(--color-text-danger)" }}>{info.ok ? "Basariyla yuklendi" : "Yukleme hatasi"}</div>
          <div style={{ fontSize: 12, color: info.ok ? "var(--color-text-success)" : "var(--color-text-danger)", opacity: 0.8, marginTop: 2 }}>{info.text}</div>
        </div>)}

        {/* Loaded Mizans */}
        {mizanlar.length > 0 && (<div style={{ marginBottom: "1.5rem" }}>
          <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 10 }}>Yuklenen donemler ({mizanlar.length})</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {mizanlar.map((m, i) => {
              const gl = gelirler[i];
              const bl = bilancolar[i];
              return (
                <div key={i} style={{ padding: "14px 16px", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 14, background: "var(--color-background-primary)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span style={{ width: 32, height: 32, borderRadius: 8, background: "var(--color-background-info)", color: "var(--color-text-info)", fontSize: 14, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center" }}>{i + 1}</span>
                      <div><div style={{ fontSize: 15, fontWeight: 600 }}>{m.donem}</div><div style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>{m.rows.length} hesap satirı algilandi</div></div>
                    </div>
                    <button onClick={() => remove(i)} style={{ fontSize: 12, color: "var(--color-text-danger)", background: "var(--color-background-danger)", border: "none", cursor: "pointer", padding: "4px 12px", borderRadius: "var(--border-radius-md)", fontWeight: 500 }}>Kaldir</button>
                  </div>
                  {gl && bl && (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
                      {[
                        ["Net Satis", gl.netSatis, "#85B7EB"],
                        ["Donem Kari", gl.donemKari, gl.donemKari >= 0 ? "#5DCAA5" : "#F09595"],
                        ["Aktif Top.", bl.aktif, "#AFA9EC"],
                        ["Ozkaynak", bl.ozk, "#9FE1CB"],
                      ].map(([l, v, c]) => (
                        <div key={l} style={{ padding: "8px 10px", borderRadius: 8, background: "var(--color-background-secondary)", position: "relative", overflow: "hidden" }}>
                          <div style={{ position: "absolute", top: 0, left: 0, width: "100%", height: 2, background: c }} />
                          <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginBottom: 2 }}>{l}</div>
                          <div style={{ fontSize: 13, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{formatN(v)}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>)}

        {/* Cihazda saklama bilgisi */}
        {mizanlar.length > 0 && (
          <div style={{ marginBottom: "1.5rem", padding: "12px 14px", borderRadius: "var(--border-radius-md)", background: "var(--color-background-secondary)", display: "flex", gap: 12, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
            <div style={{ fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.6, flex: "1 1 220px" }}>
              <b style={{ color: "var(--color-text-primary)" }}>Verileriniz bu cihazda saklanir.</b> Uygulamayi kapatip actiginizda kaldiginiz yerden devam edersiniz. Hicbir veri sunucuya gonderilmez.
            </div>
            <button onClick={clearAll} style={{ padding: "8px 14px", fontSize: 12, fontWeight: 600, borderRadius: 99, cursor: "pointer", border: "0.5px solid var(--color-border-danger)", background: clearArm ? "var(--color-text-danger)" : "var(--color-background-danger)", color: clearArm ? "#fff" : "var(--color-text-danger)", whiteSpace: "nowrap" }}>{clearArm ? "Emin misiniz? Tekrar dokunun" : "Tum verileri sil"}</button>
          </div>
        )}

        {/* Quick Start Cards */}
        {mizanlar.length > 0 && (
          <div>
            <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 10 }}>Hizli erisim</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
              {[
                [1, "Gelir Tablosu", "Satis, maliyet, kar/zarar", "#85B7EB"],
                [2, "Bilanco", "Aktif-pasif yapisi", "#AFA9EC"],
                [5, "Dashboard", "Gorunumu", "#5DCAA5"],
                [7, "Vergi", "Vergi hesaplama", "#FAC775"],
              ].map(([ti, l, d2x, c]) => (
                <div key={ti} onClick={() => setTab(ti)} style={{ padding: "14px", borderRadius: 12, background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", cursor: "pointer", position: "relative", overflow: "hidden", transition: "transform 0.1s" }}>
                  <div style={{ position: "absolute", top: 0, left: 0, width: "100%", height: 3, background: c }} />
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>{l}</div>
                  <div style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>{d2x}</div>
                </div>
              ))}
            </div>
            {mizanlar.length === 1 && (
              <div style={{ marginTop: 12, padding: "10px 14px", background: "var(--color-background-info)", borderRadius: "var(--border-radius-md)", borderLeft: "3px solid var(--color-border-info)", fontSize: 12, color: "var(--color-text-info)", lineHeight: 1.7 }}>
                <b>Ipucu:</b> Karsilastirmali analiz icin ikinci bir donem daha yukleyin. Boylece tum tablolarda onceki donem ile fark ve degisim yuzdeleri goruntulenecektir.
              </div>
            )}
          </div>
        )}
      </div>)}

      {/* TAB 1 */}
      {tab === 1 && g && (<div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", ...SEC }}>
          <span>{hasK ? "Gelir tablosu — Karsilastirma" : "Gelir tablosu — " + d1}</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => setDetay(!detay)} style={{ fontSize: 12, padding: "4px 12px", cursor: "pointer", background: "transparent", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", color: "var(--color-text-secondary)" }}>{detay ? "Gizle" : "Detay"}</button>
            <button onClick={() => exportGelirCSV(g, gK, d1, d2)} style={DL_STYLE}>CSV Indir</button>
            <button onClick={() => exportGelirHTML(g, gK, d1, d2)} style={{ ...DL_STYLE, background: "var(--color-background-success)", color: "var(--color-text-success)", border: "0.5px solid var(--color-border-success)" }}>PDF (HTML) Indir</button>
          </div></div>
        <div style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-lg)", overflow: "hidden", overflowX: karsiList.length > 3 ? "auto" : "visible" }}>
          <CHeader d1={d1} d2={!multiMode ? d2 : null} extras={multiMode ? extraDonems : undefined} />
          <CRow label="A. Brut satislar" v1={g.brutSatis} v2={!multiMode && gK ? gK.brutSatis : null} bold extraVals={multiMode ? multiGelirVal("brutSatis") : undefined} />
          {detay && <SubCRows subs={g.subs60} type="alacak" top5Map={g.top5Map} gK={!multiMode ? gK : null} subsKField="subs60" extraGelirler={multiMode ? extraGelirler : undefined} />}
          <CRow label="B. Satis indirimleri (-)" v1={g.satisInd} v2={!multiMode && gK ? gK.satisInd : null} extraVals={multiMode ? multiGelirVal("satisInd") : undefined} />
          {detay && <SubCRows subs={g.subs61} type="borc" top5Map={g.top5Map} gK={!multiMode ? gK : null} subsKField="subs61" extraGelirler={multiMode ? extraGelirler : undefined} />}
          <CRow label="C. Net satislar" v1={g.netSatis} v2={!multiMode && gK ? gK.netSatis : null} bold hl extraVals={multiMode ? multiGelirVal("netSatis") : undefined} />
          <CRow label="D. Satislarin maliyeti (-)" v1={g.satisMal} v2={!multiMode && gK ? gK.satisMal : null} extraVals={multiMode ? multiGelirVal("satisMal") : undefined} />
          {detay && <SubCRows subs={g.subsMal} type="borc" top5Map={g.top5Map} gK={!multiMode ? gK : null} subsKField="subsMal" extraGelirler={multiMode ? extraGelirler : undefined} />}
          <CRow label="BRUT KAR" v1={g.brutKar} v2={!multiMode && gK ? gK.brutKar : null} bold hl extraVals={multiMode ? multiGelirVal("brutKar") : undefined} />
          <CRow label="E. Faaliyet giderleri (-)" v1={g.faalGid} v2={!multiMode && gK ? gK.faalGid : null} extraVals={multiMode ? multiGelirVal("faalGid") : undefined} />
          {detay && <SubCRows subs={g.subsFaal} type="borc" top5Map={g.top5Map} gK={!multiMode ? gK : null} subsKField="subsFaal" extraGelirler={multiMode ? extraGelirler : undefined} />}
          <CRow label="FAALIYET KARI" v1={g.faalKar} v2={!multiMode && gK ? gK.faalKar : null} bold hl extraVals={multiMode ? multiGelirVal("faalKar") : undefined} />
          <CRow label="F. Diger faal. gelirleri" v1={g.digerGel} v2={!multiMode && gK ? gK.digerGel : null} extraVals={multiMode ? multiGelirVal("digerGel") : undefined} />
          {detay && <SubCRows subs={g.subs64} type="alacak" top5Map={g.top5Map} gK={!multiMode ? gK : null} subsKField="subs64" extraGelirler={multiMode ? extraGelirler : undefined} />}
          <CRow label="G. Diger faal. giderleri (-)" v1={g.digerGid} v2={!multiMode && gK ? gK.digerGid : null} extraVals={multiMode ? multiGelirVal("digerGid") : undefined} />
          {detay && <SubCRows subs={g.subs65} type="borc" top5Map={g.top5Map} gK={!multiMode ? gK : null} subsKField="subs65" extraGelirler={multiMode ? extraGelirler : undefined} />}
          <CRow label="H. Finansman giderleri (-)" v1={g.finGid} v2={!multiMode && gK ? gK.finGid : null} extraVals={multiMode ? multiGelirVal("finGid") : undefined} />
          {detay && <SubCRows subs={g.subsFin} type="borc" top5Map={g.top5Map} gK={!multiMode ? gK : null} subsKField="subsFin" extraGelirler={multiMode ? extraGelirler : undefined} />}
          <CRow label="OLAGAN KAR" v1={g.olaganKar} v2={!multiMode && gK ? gK.olaganKar : null} bold extraVals={multiMode ? multiGelirVal("olaganKar") : undefined} />
          <CRow label="I. Olagandisi gelirler" v1={g.odGel} v2={!multiMode && gK ? gK.odGel : null} extraVals={multiMode ? multiGelirVal("odGel") : undefined} />
          {detay && <SubCRows subs={g.subs67} type="alacak" top5Map={g.top5Map} gK={!multiMode ? gK : null} subsKField="subs67" extraGelirler={multiMode ? extraGelirler : undefined} />}
          <CRow label="J. Olagandisi giderler (-)" v1={g.odGid} v2={!multiMode && gK ? gK.odGid : null} extraVals={multiMode ? multiGelirVal("odGid") : undefined} />
          {detay && <SubCRows subs={g.subs68} type="borc" top5Map={g.top5Map} gK={!multiMode ? gK : null} subsKField="subs68" extraGelirler={multiMode ? extraGelirler : undefined} />}
          <CRow label="DONEM NET KARI (ZARARI)" v1={g.donemKari} v2={!multiMode && gK ? gK.donemKari : null} bold hl extraVals={multiMode ? multiGelirVal("donemKari") : undefined} />
        </div>
      </div>)}

      {/* TAB 2: Bilanco Detayli */}
      {tab === 2 && b && (() => {
        const r = mizanlar[sel].rows;
        const rK = karsi >= 0 ? mizanlar[karsi].rows : null;
        const aktSub = (rows, p) => { const e = rows.find((x) => x.kod === p); return e ? e.bBak - e.aBak : 0; };
        const pasSub = (rows, p) => { const e = rows.find((x) => x.kod === p); return e ? e.aBak - e.bBak : 0; };

        // Donen varlik alt kalemleri (2 haneli)
        const donenItems = [["10", "Hazir Degerler"], ["11", "Menkul Kiymetler"], ["12", "Ticari Alacaklar"], ["13", "Diger Alacaklar"], ["15", "Stoklar"], ["17", "Yillara Yaygin Insaat"], ["18", "Gelecek Aylara Ait Gid."], ["19", "Diger Donen Varliklar"]];
        const duranItems = [["22", "Ticari Alacaklar (UV)"], ["24", "Mali Duran Varliklar"], ["25", "Maddi Duran Varliklar"], ["26", "Maddi Olmayan DV"], ["28", "Gelecek Yillara Ait Gid."], ["29", "Diger Duran Varliklar"]];
        const kvykItems = [["30", "Mali Borclar"], ["32", "Ticari Borclar"], ["33", "Diger Borclar"], ["34", "Alinan Avanslar"], ["35", "Yillara Yaygin Insaat"], ["36", "Odenecek Vergi ve Yuk."], ["37", "Borc ve Gider Karsiliklari"], ["38", "Gelecek Aylara Ait Gel."], ["39", "Diger KVYK"]];
        const uvykItems = [["40", "Mali Borclar (UV)"], ["42", "Ticari Borclar (UV)"], ["43", "Diger Borclar (UV)"], ["47", "Borc ve Gider Karsiliklari (UV)"], ["48", "Gelecek Yillara Ait Gel."], ["49", "Diger UVYK"]];
        const ozkItems = [["50", "Odenmis Sermaye"], ["52", "Sermaye Yedekleri"], ["54", "Kar Yedekleri"], ["57", "Gecmis Yillar Karlari"], ["58", "Gecmis Yillar Zararlari"], ["59", "Donem Net Kari"]];

        const filterSubs = (items, rows, type) => {
          return items.map(([kod, ad]) => {
            const val = type === "aktif" ? aktSub(rows, kod) : pasSub(rows, kod);
            const valK = rK ? (type === "aktif" ? aktSub(rK, kod) : pasSub(rK, kod)) : null;
            const realAd = rows.find((x) => x.kod === kod)?.ad || ad;
            // Find 3-digit children
            const children = rows.filter((x) => x.kod.startsWith(kod) && x.kod.length === 3 && x.kod !== kod)
              .map((x) => {
                const cVal = type === "aktif" ? (x.bBak - x.aBak) : (x.aBak - x.bBak);
                const cRow = rK ? rK.find((rr) => rr.kod === x.kod) : null;
                const cValK = cRow ? (type === "aktif" ? (cRow.bBak - cRow.aBak) : (cRow.aBak - cRow.bBak)) : null;
                return { kod: x.kod, ad: x.ad, val: cVal, valK: cValK };
              }).filter((c) => c.val !== 0 || (c.valK && c.valK !== 0));
            // Also check rK for children that only exist there
            if (rK) {
              const existingKods = new Set(children.map((c) => c.kod));
              const kChildren = rK.filter((x) => x.kod.startsWith(kod) && x.kod.length === 3 && x.kod !== kod && !existingKods.has(x.kod))
                .map((x) => {
                  const cValK = type === "aktif" ? (x.bBak - x.aBak) : (x.aBak - x.bBak);
                  return { kod: x.kod, ad: x.ad, val: 0, valK: cValK };
                }).filter((c) => c.valK !== 0);
              children.push(...kChildren);
              children.sort((a2, b2) => a2.kod.localeCompare(b2.kod));
            }
            return { kod, ad: realAd, val, valK, children };
          }).filter((x) => x.val !== 0 || (x.valK && x.valK !== 0));
        };

        const toggleBil = (kod) => setExpandedBil((p) => ({ ...p, [kod]: !p[kod] }));

        const dSubs = filterSubs(donenItems, r, "aktif");
        const durSubs = filterSubs(duranItems, r, "aktif");
        const kvSubs = filterSubs(kvykItems, r, "pasif");
        const uvSubs = filterSubs(uvykItems, r, "pasif");
        const ozSubs = filterSubs(ozkItems, r, "pasif");

        // Donem kari ozkaynaklara eklenmeli
        const donemKariRow = { kod: "DK", ad: "Donem Net Kari (Hesaplanan)", val: g ? g.donemKari : 0, valK: gK ? gK.donemKari : null };

        const doExportCSV = () => {
          const fn = (n) => formatN(n);
          const rows2 = [["BILANCO - " + d1], []];
          if (hasK) rows2.push(["Hesap", d1, d2, "Fark", "%"]);
          else rows2.push(["Hesap", "Tutar"]);
          const addR = (label, v1, v2, bold) => {
            if (hasK && v2 != null) { const f = v1 - v2; const p = v2 !== 0 ? ((v1 - v2) / Math.abs(v2) * 100).toFixed(1) + "%" : "-"; rows2.push([(bold ? "" : "  ") + label, fn(v1), fn(v2), fn(f), p]); }
            else rows2.push([(bold ? "" : "  ") + label, fn(v1)]);
          };
          addR("I. DONEN VARLIKLAR", b.donen, bK?.donen, true);
          for (const s of dSubs) addR(s.kod + " " + s.ad, s.val, s.valK);
          addR("II. DURAN VARLIKLAR", b.duran, bK?.duran, true);
          for (const s of durSubs) addR(s.kod + " " + s.ad, s.val, s.valK);
          addR("AKTIF TOPLAM", b.aktif, bK?.aktif, true);
          rows2.push([]);
          addR("I. KISA VADELI YABANCI KAYNAKLAR", b.kvyk, bK?.kvyk, true);
          for (const s of kvSubs) addR(s.kod + " " + s.ad, s.val, s.valK);
          addR("II. UZUN VADELI YABANCI KAYNAKLAR", b.uvyk, bK?.uvyk, true);
          for (const s of uvSubs) addR(s.kod + " " + s.ad, s.val, s.valK);
          addR("III. OZKAYNAKLAR", b.ozk, bK?.ozk, true);
          for (const s of ozSubs) addR(s.kod + " " + s.ad, s.val, s.valK);
          addR("Donem Net Kari (Hesaplanan)", donemKariRow.val, donemKariRow.valK);
          addR("PASIF TOPLAM", b.pasif, bK?.pasif, true);
          downloadCSV(buildCSV(rows2), "Bilanco_" + d1.replace(/\s/g, "_") + ".csv");
        };

        const doExportHTML = () => {
          const fn = (n) => formatN(n);
          let t = '<h2>Bilanco</h2><table><tr><th>Hesap</th><th class="r">' + d1 + '</th>';
          if (hasK) t += '<th class="r">' + d2 + '</th><th class="r">Fark</th><th class="r">%</th>';
          t += '</tr>';
          const tr = (l, v1, v2, bold, hl, indent) => {
            const cls = (bold ? ' b' : '') + (hl ? ' hl' : '');
            const pad = indent ? 'padding-left:20px;font-size:10px;color:#666;' : '';
            let r2 = '<tr class="' + cls + '"><td style="' + pad + '">' + l + '</td><td class="r">' + fn(v1) + '</td>';
            if (hasK && v2 != null) { const f = v1 - v2; const p = v2 !== 0 ? ((v1 - v2) / Math.abs(v2) * 100) : 0; r2 += '<td class="r">' + fn(v2) + '</td><td class="r">' + fn(f) + '</td><td class="r ' + (p >= 0 ? 'g' : 'rd') + '">' + (p >= 0 ? '+' : '') + p.toFixed(1) + '%</td>'; }
            return r2 + '</tr>';
          };
          t += tr('I. DONEN VARLIKLAR', b.donen, bK?.donen, true);
          for (const s of dSubs) t += tr(s.kod + ' ' + s.ad, s.val, s.valK, false, false, true);
          t += tr('II. DURAN VARLIKLAR', b.duran, bK?.duran, true);
          for (const s of durSubs) t += tr(s.kod + ' ' + s.ad, s.val, s.valK, false, false, true);
          t += tr('AKTIF TOPLAM', b.aktif, bK?.aktif, true, true);
          t += '<tr><td colspan="5" style="height:8px;background:#eee;"></td></tr>';
          t += tr('I. KVYK', b.kvyk, bK?.kvyk, true);
          for (const s of kvSubs) t += tr(s.kod + ' ' + s.ad, s.val, s.valK, false, false, true);
          t += tr('II. UVYK', b.uvyk, bK?.uvyk, true);
          for (const s of uvSubs) t += tr(s.kod + ' ' + s.ad, s.val, s.valK, false, false, true);
          t += tr('III. OZKAYNAKLAR', b.ozk, bK?.ozk, true);
          for (const s of ozSubs) t += tr(s.kod + ' ' + s.ad, s.val, s.valK, false, false, true);
          t += tr('Donem Net Kari (Hesaplanan)', donemKariRow.val, donemKariRow.valK, false, false, true);
          t += tr('PASIF TOPLAM', b.pasif, bK?.pasif, true, true);
          t += '</table>';
          // Dagilim gorseli
          t += '<h2>Varlik ve Kaynak Dagilimi</h2>';
          t += '<div style="display:flex;gap:24px;">';
          t += '<div style="flex:1;"><div style="font-size:11px;font-weight:600;margin-bottom:6px;">Aktif</div><div style="display:flex;height:20px;border-radius:99px;overflow:hidden;">';
          t += '<div style="width:' + pct(b.donen, b.aktif) + '%;background:#85B7EB;"></div><div style="width:' + pct(b.duran, b.aktif) + '%;background:#AFA9EC;"></div></div>';
          t += '<div style="font-size:10px;color:#666;margin-top:4px;">Donen: %' + pct(b.donen, b.aktif).toFixed(0) + ' | Duran: %' + pct(b.duran, b.aktif).toFixed(0) + '</div></div>';
          t += '<div style="flex:1;"><div style="font-size:11px;font-weight:600;margin-bottom:6px;">Pasif</div><div style="display:flex;height:20px;border-radius:99px;overflow:hidden;">';
          t += '<div style="width:' + pct(b.kvyk, b.pasif) + '%;background:#F09595;"></div><div style="width:' + pct(b.uvyk, b.pasif) + '%;background:#FAC775;"></div><div style="width:' + pct(b.ozk, b.pasif) + '%;background:#9FE1CB;"></div></div>';
          t += '<div style="font-size:10px;color:#666;margin-top:4px;">KVYK: %' + pct(b.kvyk, b.pasif).toFixed(0) + ' | UVYK: %' + pct(b.uvyk, b.pasif).toFixed(0) + ' | Ozk: %' + pct(b.ozk, b.pasif).toFixed(0) + '</div></div>';
          t += '</div>';
          downloadHTML(buildHTMLReport('Bilanco - ' + d1, t, ''), 'Bilanco_' + d1.replace(/\s/g, '_') + '.html');
        };

        const BRow = ({ label, v1, v2, bold, hl, sub }) => {
          const hasK2 = v2 != null;
          const fark = hasK2 ? v1 - v2 : null;
          const dg = hasK2 ? degFn(v1, v2) : null;
          if (!hasK2) return (<div style={{ display: "grid", gridTemplateColumns: "minmax(0,2.5fr) minmax(0,1fr)", padding: sub ? "5px 12px" : "8px 12px", paddingLeft: sub ? 28 : 12, borderBottom: "0.5px solid var(--color-border-tertiary)", fontWeight: bold ? 500 : 400, fontSize: sub ? 13 : 14, color: sub ? "var(--color-text-secondary)" : "var(--color-text-primary)", background: hl ? "var(--color-background-secondary)" : "transparent" }}><span>{label}</span><span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatN(v1)}</span></div>);
          return (<div style={{ display: "grid", gridTemplateColumns: "minmax(0,2.2fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) minmax(0,0.7fr)", padding: sub ? "5px 12px" : "8px 12px", paddingLeft: sub ? 28 : 12, borderBottom: "0.5px solid var(--color-border-tertiary)", fontWeight: bold ? 500 : 400, fontSize: sub ? 13 : 14, color: sub ? "var(--color-text-secondary)" : "var(--color-text-primary)", background: hl ? "var(--color-background-secondary)" : "transparent", gap: 2 }}><span>{label}</span><span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatN(v1)}</span><span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatN(v2)}</span><span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: fark >= 0 ? "#0F6E56" : "#A32D2D" }}>{fark >= 0 ? "+" : ""}{formatN(fark)}</span><span style={{ textAlign: "right" }}><Badge val={dg} /></span></div>);
        };

        const DistBar = ({ items: barItems, total, label }) => (
          <div style={{ padding: "16px", background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-lg)" }}>
            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 10 }}>{label}</div>
            <div style={{ display: "flex", height: 24, borderRadius: 99, overflow: "hidden", marginBottom: 10 }}>
              {barItems.map(([l, v, bg]) => { const p = pct(v, total); return p > 0.5 ? <div key={l} style={{ width: p + "%", background: bg, minWidth: 2 }} /> : null; })}
            </div>
            {barItems.map(([l, v, bg]) => { const p = pct(v, total); return p > 0.5 ? (
              <div key={l} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "3px 0", fontSize: 12 }}>
                <span style={{ display: "flex", alignItems: "center", gap: 6 }}><span style={{ width: 8, height: 8, borderRadius: 2, background: bg, flexShrink: 0 }} />{l}</span>
                <span style={{ color: "var(--color-text-secondary)" }}>{formatN(v)} <span style={{ fontSize: 11 }}>(%{p.toFixed(1)})</span></span>
              </div>
            ) : null; })}
          </div>
        );

        return (<div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", ...SEC }}>
            <span>{hasK ? "Bilanco — Karsilastirma" : "Bilanco — " + d1}</span>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={doExportCSV} style={DL_STYLE}>CSV Indir</button>
              <button onClick={doExportHTML} style={{ ...DL_STYLE, background: "var(--color-background-success)", color: "var(--color-text-success)", border: "0.5px solid var(--color-border-success)" }}>PDF (HTML)</button>
            </div>
          </div>

          {/* Dagilim Barlari */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: "1.5rem" }}>
            <DistBar label="Varlik dagilimi" total={b.aktif} items={[["Hazir Degerler", b.nakit, "#5DCAA5"], ["Ticari Alacaklar", b.tAlacak, "#85B7EB"], ["Stoklar", b.stok, "#AFA9EC"], ["Duran Varliklar", b.duran, "#D4537E"], ["Diger", Math.max(0, b.aktif - b.nakit - b.tAlacak - b.stok - b.duran), "#FAC775"]]} />
            <DistBar label="Kaynak dagilimi" total={b.pasif} items={[["KVYK", b.kvyk, "#F09595"], ["UVYK", b.uvyk, "#FAC775"], ["Ozkaynaklar", b.ozk, "#9FE1CB"]]} />
          </div>

          {/* Aktif Tablosu */}
          <div style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-lg)", overflow: "hidden", marginBottom: 16 }}>
            <div style={{ padding: "10px 14px", background: "var(--color-background-info)", color: "var(--color-text-info)", fontWeight: 500, fontSize: 14 }}>Aktif (Varliklar)</div>
            <CHeader d1={d1} d2={d2} />
            <BRow label="I. Donen Varliklar" v1={b.donen} v2={bK ? bK.donen : null} bold />
            {dSubs.map((s) => (<div key={s.kod}><div onClick={() => s.children.length > 0 ? toggleBil(s.kod) : null} style={{ display: "grid", gridTemplateColumns: hasK ? "minmax(0,2.2fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) minmax(0,0.7fr)" : "minmax(0,2.5fr) minmax(0,1fr)", padding: "5px 12px", paddingLeft: 28, borderBottom: "0.5px solid var(--color-border-tertiary)", fontSize: 13, color: "var(--color-text-secondary)", cursor: s.children.length > 0 ? "pointer" : "default", background: expandedBil[s.kod] ? "rgba(133,183,235,0.06)" : "transparent" }}><span style={{ display: "flex", alignItems: "center", gap: 6 }}>{s.children.length > 0 && <span style={{ fontSize: 9, color: "var(--color-text-tertiary)", transition: "transform 0.2s", transform: expandedBil[s.kod] ? "rotate(90deg)" : "rotate(0deg)" }}>▶</span>}{s.kod} {s.ad}</span><span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatN(s.val)}</span>{hasK && s.valK != null && <><span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatN(s.valK)}</span><span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: s.val - s.valK >= 0 ? "#0F6E56" : "#A32D2D" }}>{s.val - s.valK >= 0 ? "+" : ""}{formatN(s.val - s.valK)}</span><span style={{ textAlign: "right" }}><Badge val={degFn(s.val, s.valK)} /></span></>}</div>{expandedBil[s.kod] && s.children.map((c) => (<div key={c.kod} style={{ display: "grid", gridTemplateColumns: hasK ? "minmax(0,2.2fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) minmax(0,0.7fr)" : "minmax(0,2.5fr) minmax(0,1fr)", padding: "3px 12px", paddingLeft: 48, borderBottom: "0.5px solid var(--color-border-tertiary)", fontSize: 12, color: "var(--color-text-tertiary)" }}><span>{c.kod} {c.ad}</span><span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatN(c.val)}</span>{hasK && c.valK != null && <><span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatN(c.valK)}</span><span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: c.val - c.valK >= 0 ? "#0F6E56" : "#A32D2D" }}>{c.val - c.valK >= 0 ? "+" : ""}{formatN(c.val - c.valK)}</span><span style={{ textAlign: "right" }}><Badge val={degFn(c.val, c.valK)} /></span></>}</div>))}</div>))}
            <BRow label="II. Duran Varliklar" v1={b.duran} v2={bK ? bK.duran : null} bold />
            {durSubs.map((s) => (<div key={s.kod}><div onClick={() => s.children.length > 0 ? toggleBil(s.kod) : null} style={{ display: "grid", gridTemplateColumns: hasK ? "minmax(0,2.2fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) minmax(0,0.7fr)" : "minmax(0,2.5fr) minmax(0,1fr)", padding: "5px 12px", paddingLeft: 28, borderBottom: "0.5px solid var(--color-border-tertiary)", fontSize: 13, color: "var(--color-text-secondary)", cursor: s.children.length > 0 ? "pointer" : "default", background: expandedBil[s.kod] ? "rgba(133,183,235,0.06)" : "transparent" }}><span style={{ display: "flex", alignItems: "center", gap: 6 }}>{s.children.length > 0 && <span style={{ fontSize: 9, color: "var(--color-text-tertiary)", transition: "transform 0.2s", transform: expandedBil[s.kod] ? "rotate(90deg)" : "rotate(0deg)" }}>▶</span>}{s.kod} {s.ad}</span><span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatN(s.val)}</span>{hasK && s.valK != null && <><span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatN(s.valK)}</span><span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: s.val - s.valK >= 0 ? "#0F6E56" : "#A32D2D" }}>{s.val - s.valK >= 0 ? "+" : ""}{formatN(s.val - s.valK)}</span><span style={{ textAlign: "right" }}><Badge val={degFn(s.val, s.valK)} /></span></>}</div>{expandedBil[s.kod] && s.children.map((c) => (<div key={c.kod} style={{ display: "grid", gridTemplateColumns: hasK ? "minmax(0,2.2fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) minmax(0,0.7fr)" : "minmax(0,2.5fr) minmax(0,1fr)", padding: "3px 12px", paddingLeft: 48, borderBottom: "0.5px solid var(--color-border-tertiary)", fontSize: 12, color: "var(--color-text-tertiary)" }}><span>{c.kod} {c.ad}</span><span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatN(c.val)}</span>{hasK && c.valK != null && <><span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatN(c.valK)}</span><span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: c.val - c.valK >= 0 ? "#0F6E56" : "#A32D2D" }}>{c.val - c.valK >= 0 ? "+" : ""}{formatN(c.val - c.valK)}</span><span style={{ textAlign: "right" }}><Badge val={degFn(c.val, c.valK)} /></span></>}</div>))}</div>))}
            <BRow label="AKTIF TOPLAM" v1={b.aktif} v2={bK ? bK.aktif : null} bold hl />
          </div>

          {/* Pasif Tablosu */}
          <div style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-lg)", overflow: "hidden" }}>
            <div style={{ padding: "10px 14px", background: "var(--color-background-success)", color: "var(--color-text-success)", fontWeight: 500, fontSize: 14 }}>Pasif (Kaynaklar)</div>
            <CHeader d1={d1} d2={d2} />
            <BRow label="I. Kisa Vadeli Yabanci Kaynaklar" v1={b.kvyk} v2={bK ? bK.kvyk : null} bold />
            {kvSubs.map((s) => (<div key={s.kod}><div onClick={() => s.children.length > 0 ? toggleBil(s.kod) : null} style={{ display: "grid", gridTemplateColumns: hasK ? "minmax(0,2.2fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) minmax(0,0.7fr)" : "minmax(0,2.5fr) minmax(0,1fr)", padding: "5px 12px", paddingLeft: 28, borderBottom: "0.5px solid var(--color-border-tertiary)", fontSize: 13, color: "var(--color-text-secondary)", cursor: s.children.length > 0 ? "pointer" : "default", background: expandedBil[s.kod] ? "rgba(133,183,235,0.06)" : "transparent" }}><span style={{ display: "flex", alignItems: "center", gap: 6 }}>{s.children.length > 0 && <span style={{ fontSize: 9, color: "var(--color-text-tertiary)", transition: "transform 0.2s", transform: expandedBil[s.kod] ? "rotate(90deg)" : "rotate(0deg)" }}>▶</span>}{s.kod} {s.ad}</span><span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatN(s.val)}</span>{hasK && s.valK != null && <><span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatN(s.valK)}</span><span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: s.val - s.valK >= 0 ? "#0F6E56" : "#A32D2D" }}>{s.val - s.valK >= 0 ? "+" : ""}{formatN(s.val - s.valK)}</span><span style={{ textAlign: "right" }}><Badge val={degFn(s.val, s.valK)} /></span></>}</div>{expandedBil[s.kod] && s.children.map((c) => (<div key={c.kod} style={{ display: "grid", gridTemplateColumns: hasK ? "minmax(0,2.2fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) minmax(0,0.7fr)" : "minmax(0,2.5fr) minmax(0,1fr)", padding: "3px 12px", paddingLeft: 48, borderBottom: "0.5px solid var(--color-border-tertiary)", fontSize: 12, color: "var(--color-text-tertiary)" }}><span>{c.kod} {c.ad}</span><span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatN(c.val)}</span>{hasK && c.valK != null && <><span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatN(c.valK)}</span><span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: c.val - c.valK >= 0 ? "#0F6E56" : "#A32D2D" }}>{c.val - c.valK >= 0 ? "+" : ""}{formatN(c.val - c.valK)}</span><span style={{ textAlign: "right" }}><Badge val={degFn(c.val, c.valK)} /></span></>}</div>))}</div>))}
            <BRow label="II. Uzun Vadeli Yabanci Kaynaklar" v1={b.uvyk} v2={bK ? bK.uvyk : null} bold />
            {uvSubs.map((s) => (<div key={s.kod}><div onClick={() => s.children.length > 0 ? toggleBil(s.kod) : null} style={{ display: "grid", gridTemplateColumns: hasK ? "minmax(0,2.2fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) minmax(0,0.7fr)" : "minmax(0,2.5fr) minmax(0,1fr)", padding: "5px 12px", paddingLeft: 28, borderBottom: "0.5px solid var(--color-border-tertiary)", fontSize: 13, color: "var(--color-text-secondary)", cursor: s.children.length > 0 ? "pointer" : "default", background: expandedBil[s.kod] ? "rgba(133,183,235,0.06)" : "transparent" }}><span style={{ display: "flex", alignItems: "center", gap: 6 }}>{s.children.length > 0 && <span style={{ fontSize: 9, color: "var(--color-text-tertiary)", transition: "transform 0.2s", transform: expandedBil[s.kod] ? "rotate(90deg)" : "rotate(0deg)" }}>▶</span>}{s.kod} {s.ad}</span><span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatN(s.val)}</span>{hasK && s.valK != null && <><span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatN(s.valK)}</span><span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: s.val - s.valK >= 0 ? "#0F6E56" : "#A32D2D" }}>{s.val - s.valK >= 0 ? "+" : ""}{formatN(s.val - s.valK)}</span><span style={{ textAlign: "right" }}><Badge val={degFn(s.val, s.valK)} /></span></>}</div>{expandedBil[s.kod] && s.children.map((c) => (<div key={c.kod} style={{ display: "grid", gridTemplateColumns: hasK ? "minmax(0,2.2fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) minmax(0,0.7fr)" : "minmax(0,2.5fr) minmax(0,1fr)", padding: "3px 12px", paddingLeft: 48, borderBottom: "0.5px solid var(--color-border-tertiary)", fontSize: 12, color: "var(--color-text-tertiary)" }}><span>{c.kod} {c.ad}</span><span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatN(c.val)}</span>{hasK && c.valK != null && <><span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatN(c.valK)}</span><span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: c.val - c.valK >= 0 ? "#0F6E56" : "#A32D2D" }}>{c.val - c.valK >= 0 ? "+" : ""}{formatN(c.val - c.valK)}</span><span style={{ textAlign: "right" }}><Badge val={degFn(c.val, c.valK)} /></span></>}</div>))}</div>))}
            <BRow label="III. Ozkaynaklar" v1={b.ozk} v2={bK ? bK.ozk : null} bold />
            {ozSubs.map((s) => (<div key={s.kod}><div onClick={() => s.children.length > 0 ? toggleBil(s.kod) : null} style={{ display: "grid", gridTemplateColumns: hasK ? "minmax(0,2.2fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) minmax(0,0.7fr)" : "minmax(0,2.5fr) minmax(0,1fr)", padding: "5px 12px", paddingLeft: 28, borderBottom: "0.5px solid var(--color-border-tertiary)", fontSize: 13, color: "var(--color-text-secondary)", cursor: s.children.length > 0 ? "pointer" : "default", background: expandedBil[s.kod] ? "rgba(133,183,235,0.06)" : "transparent" }}><span style={{ display: "flex", alignItems: "center", gap: 6 }}>{s.children.length > 0 && <span style={{ fontSize: 9, color: "var(--color-text-tertiary)", transition: "transform 0.2s", transform: expandedBil[s.kod] ? "rotate(90deg)" : "rotate(0deg)" }}>▶</span>}{s.kod} {s.ad}</span><span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatN(s.val)}</span>{hasK && s.valK != null && <><span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatN(s.valK)}</span><span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: s.val - s.valK >= 0 ? "#0F6E56" : "#A32D2D" }}>{s.val - s.valK >= 0 ? "+" : ""}{formatN(s.val - s.valK)}</span><span style={{ textAlign: "right" }}><Badge val={degFn(s.val, s.valK)} /></span></>}</div>{expandedBil[s.kod] && s.children.map((c) => (<div key={c.kod} style={{ display: "grid", gridTemplateColumns: hasK ? "minmax(0,2.2fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) minmax(0,0.7fr)" : "minmax(0,2.5fr) minmax(0,1fr)", padding: "3px 12px", paddingLeft: 48, borderBottom: "0.5px solid var(--color-border-tertiary)", fontSize: 12, color: "var(--color-text-tertiary)" }}><span>{c.kod} {c.ad}</span><span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatN(c.val)}</span>{hasK && c.valK != null && <><span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatN(c.valK)}</span><span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: c.val - c.valK >= 0 ? "#0F6E56" : "#A32D2D" }}>{c.val - c.valK >= 0 ? "+" : ""}{formatN(c.val - c.valK)}</span><span style={{ textAlign: "right" }}><Badge val={degFn(c.val, c.valK)} /></span></>}</div>))}</div>))}
            <BRow label={"  Donem Net Kari (Hesaplanan)"} v1={donemKariRow.val} v2={hasK ? donemKariRow.valK : null} sub />
            <BRow label="PASIF TOPLAM" v1={b.pasif} v2={bK ? bK.pasif : null} bold hl />
          </div>

          {/* Yonetici Notlari */}
          {a && (() => {
            const notlar = [];
            // Aktif-Pasif dengesi
            const fark = Math.abs(b.aktif - b.pasif);
            if (fark > 1) notlar.push({ tip: "orta", mesaj: "Aktif-Pasif fark: " + formatN(fark) + " TL. Donem kari farktan kaynaklanabilir." });

            // Donen varlik yapisi
            const stokOran = b.aktif > 0 ? (b.stok / b.aktif * 100) : 0;
            if (stokOran > 50) notlar.push({ tip: "kotu", mesaj: "Stoklarin aktif icindeki payi %" + stokOran.toFixed(0) + " — cok yuksek. Stok yonetimi gozden gecirilmeli." });
            else if (stokOran > 30) notlar.push({ tip: "orta", mesaj: "Stoklarin aktif icindeki payi %" + stokOran.toFixed(0) + " — takip edilmeli." });

            // Nakit durumu
            if (b.nakit < 0) notlar.push({ tip: "kotu", mesaj: "Nakit bakiye negatif (" + formatN(b.nakit) + "). Banka hesaplarinda acik krediler kullaniliyor olabilir." });
            else if (b.nakit > 0 && b.aktif > 0 && (b.nakit / b.aktif * 100) < 5) notlar.push({ tip: "orta", mesaj: "Nakit aktifin yalnizca %" + (b.nakit / b.aktif * 100).toFixed(1) + "'i. Nakit rezervi arttirilabilir." });
            else if (b.nakit > 0) notlar.push({ tip: "iyi", mesaj: "Nakit pozisyonu pozitif: " + formatN(b.nakit) + " TL." });

            // Ticari alacak / borc
            if (b.tAlacak > 0 && b.tBorc > 0) {
              const net = b.tAlacak - b.tBorc;
              if (net > 0) notlar.push({ tip: "orta", mesaj: "Ticari alacaklar ticari borclardan " + formatN(net) + " TL fazla. Tahsilat sureci onemli." });
              else notlar.push({ tip: "iyi", mesaj: "Ticari borclar alacaklardan fazla — tedarikci finansmani kullaniliyor." });
            }

            // Borcluluk
            const toplamBorc = b.kvyk + b.uvyk;
            if (b.aktif > 0) {
              const borcOran = toplamBorc / b.aktif * 100;
              if (borcOran > 70) notlar.push({ tip: "kotu", mesaj: "Toplam borclar aktiflerin %" + borcOran.toFixed(0) + "'ini olusturuyor — yuksek borcluluk." });
              else if (borcOran > 50) notlar.push({ tip: "orta", mesaj: "Borcluluk orani %" + borcOran.toFixed(0) + " — orta seviye." });
              else notlar.push({ tip: "iyi", mesaj: "Borcluluk orani %" + borcOran.toFixed(0) + " — saglikli seviyede." });
            }

            // Ozkaynak payi
            if (b.pasif > 0) {
              const ozkOran = b.ozk / b.pasif * 100;
              if (ozkOran > 60) notlar.push({ tip: "iyi", mesaj: "Ozkaynak payi %" + ozkOran.toFixed(0) + " — guclu sermaye yapisi." });
              else if (ozkOran > 40) notlar.push({ tip: "orta", mesaj: "Ozkaynak payi %" + ozkOran.toFixed(0) + " — kabul edilebilir." });
              else notlar.push({ tip: "kotu", mesaj: "Ozkaynak payi %" + ozkOran.toFixed(0) + " — sermaye guclendirilmeli." });
            }

            // Karsilastirma notlari
            if (bK) {
              if (b.aktif > bK.aktif) notlar.push({ tip: "iyi", mesaj: "Aktif toplam onceki doneme gore %" + ((b.aktif - bK.aktif) / Math.abs(bK.aktif) * 100).toFixed(1) + " buyudu." });
              else if (b.aktif < bK.aktif) notlar.push({ tip: "orta", mesaj: "Aktif toplam onceki doneme gore %" + ((bK.aktif - b.aktif) / Math.abs(bK.aktif) * 100).toFixed(1) + " kuculdu." });
              if (b.ozk > bK.ozk) notlar.push({ tip: "iyi", mesaj: "Ozkaynaklar %" + ((b.ozk - bK.ozk) / Math.abs(bK.ozk) * 100).toFixed(1) + " artti." });
            }

            if (!notlar.length) return null;

            const skorBg = (s) => s === "iyi" ? "#E1F5EE" : s === "orta" ? "#FAEEDA" : "#FCEBEB";
            const skorRenk = (s) => s === "iyi" ? "#0F6E56" : s === "orta" ? "#BA7517" : "#A32D2D";

            return (
              <div style={{ marginTop: "1.5rem" }}>
                <div style={SEC}>Bilanco degerlendirme notlari</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {notlar.map((n, i) => (
                    <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "10px 14px", background: skorBg(n.tip), borderRadius: "var(--border-radius-md)", borderLeft: "3px solid " + skorRenk(n.tip) }}>
                      <span style={{ fontWeight: 500, flexShrink: 0, color: skorRenk(n.tip) }}>{n.tip === "iyi" ? "+" : n.tip === "orta" ? "~" : "!"}</span>
                      <span style={{ fontSize: 13, lineHeight: 1.6, color: "var(--color-text-primary)" }}>{n.mesaj}</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}
        </div>);
      })()}

      {/* TAB 3: Nakit Akis Tablosu */}
      {tab === 3 && (() => {
        if (!hasK) return (<div style={{ textAlign: "center", padding: "3rem 1rem", color: "var(--color-text-secondary)" }}><div style={{ fontSize: 32, opacity: 0.25, marginBottom: 8 }}>?</div><div style={{ fontSize: 14 }}>Nakit akis tablosu icin karsilastirma donemi secmelisiniz.</div><div style={{ fontSize: 13, marginTop: 8 }}>Yukaridaki "Karsilastir" dropdown'undan onceki donemi secin.</div></div>);
        const na = calcNakitAkis(mizanlar[sel], mizanlar[karsi], g);
        if (!na) return (<div style={{ textAlign: "center", padding: "3rem", color: "var(--color-text-secondary)" }}>Nakit akis hesaplanamadi.</div>);

        const doExportCSV = () => {
          const fn = (n) => formatN(n);
          const rows = [["NAKIT AKIS TABLOSU (Dolayli Yontem)"], ["Donem: " + d1 + " / Karsilastirma: " + d2], [],
            ["A. ISLETME FAALIYETLERINDEN NAKIT AKISLARI"],
            ["Donem Net Kari", fn(na.donemKari)],
            ["+ Amortisman Giderleri", fn(na.amor)],
            ["Isletme Sermayesi Degisimleri:"],
            ["  Ticari Alacaklardaki Degisim", fn(na.ticAlacak)],
            ["  Diger Alacaklardaki Degisim", fn(na.digAlacak)],
            ["  Stoklardaki Degisim", fn(na.stok)],
            ["  Diger Donen Varliklardaki Degisim", fn(na.digDonenVarlik)],
            ["  Ticari Borclardaki Degisim", fn(na.ticBorc)],
            ["  Diger Borclardaki Degisim", fn(na.digBorc)],
            ["  Vergi Borclardaki Degisim", fn(na.vergiBorc)],
            ["  Borc Karsiliklari Degisimi", fn(na.borcKarsilik)],
            ["  Diger KVYK Degisimi", fn(na.digKvyk)],
            ["ISLETME FAALIYETLERINDEN NET NAKIT", fn(na.faaliyetNakit)], [],
            ["B. YATIRIM FAALIYETLERINDEN NAKIT AKISLARI"],
            ["  Maddi Duran Varlik Alis/Satis", fn(na.mdvBrut)],
            ["  Maddi Olmayan Duran Varlik", fn(na.modkBrut)],
            ["  Uzun Vadeli Alacak Degisimi", fn(na.uzunAlacak)],
            ["  Diger Duran Varlik Degisimi", fn(na.digDuranV)],
            ["YATIRIM FAALIYETLERINDEN NET NAKIT", fn(na.yatirimNakit)], [],
            ["C. FINANSMAN FAALIYETLERINDEN NAKIT AKISLARI"],
            ["  Kisa Vadeli Mali Borc Degisimi", fn(na.kvMaliBorc)],
            ["  Uzun Vadeli Mali Borc Degisimi", fn(na.uvMaliBorc)],
            ["  Sermaye Degisimi", fn(na.sermaye)],
            ["  Sermaye Yedekleri Degisimi", fn(na.sermayeYedek)],
            ["FINANSMAN FAALIYETLERINDEN NET NAKIT", fn(na.finansmanNakit)], [],
            ["NET NAKIT DEGISIMI", fn(na.netNakit)],
            ["Donem Basi Nakit", fn(na.nakitBasi)],
            ["Donem Sonu Nakit", fn(na.nakitSonu)],
          ];
          downloadCSV(buildCSV(rows), "Nakit_Akis_" + d1.replace(/\s/g, "_") + ".csv");
        };
        const doExportHTML = () => {
          const fn = (n) => formatN(n);
          const clr = (v) => v >= 0 ? 'g' : 'rd';
          let t = '<h2>Nakit Akis Tablosu (Dolayli Yontem)</h2>';
          t += '<p style="color:#666;font-size:11px;margin-bottom:12px;">Donem: ' + d1 + ' / Karsilastirma: ' + d2 + '</p>';
          t += '<table><tr><th>Kalem</th><th class="r">Tutar</th></tr>';
          const sec = (label) => '<tr style="background:#2F5496;color:#fff;"><td colspan="2" class="b">' + label + '</td></tr>';
          const row = (label, val, bold, hl) => '<tr class="' + (bold ? 'b' : '') + (hl ? ' hl' : '') + '"><td>' + label + '</td><td class="r ' + clr(val) + '">' + fn(val) + '</td></tr>';
          t += sec('A. Isletme faaliyetlerinden nakit akislari');
          t += row('Donem net kari', na.donemKari, true);
          t += row('+ Amortisman giderleri', na.amor);
          t += '<tr><td colspan="2" class="b" style="padding-top:8px;">Isletme sermayesi degisimleri:</td></tr>';
          t += row('  Ticari alacaklardaki degisim', na.ticAlacak);
          t += row('  Diger alacaklardaki degisim', na.digAlacak);
          t += row('  Stoklardaki degisim', na.stok);
          t += row('  Diger donen varlik degisimi', na.digDonenVarlik);
          t += row('  Ticari borclardaki degisim', na.ticBorc);
          t += row('  Diger borclardaki degisim', na.digBorc);
          t += row('  Vergi borclardaki degisim', na.vergiBorc);
          t += row('  Borc karsiliklari degisimi', na.borcKarsilik);
          t += row('  Diger KVYK degisimi', na.digKvyk);
          t += row('Isletme faaliyetlerinden net nakit', na.faaliyetNakit, true, true);
          t += sec('B. Yatirim faaliyetlerinden nakit akislari');
          t += row('  Maddi duran varlik alis/satis', na.mdvBrut);
          t += row('  Maddi olmayan duran varlik', na.modkBrut);
          t += row('  Uzun vadeli alacak degisimi', na.uzunAlacak);
          t += row('  Diger duran varlik degisimi', na.digDuranV);
          t += row('Yatirim faaliyetlerinden net nakit', na.yatirimNakit, true, true);
          t += sec('C. Finansman faaliyetlerinden nakit akislari');
          t += row('  Kisa vadeli mali borc degisimi', na.kvMaliBorc);
          t += row('  Uzun vadeli mali borc degisimi', na.uvMaliBorc);
          t += row('  Sermaye degisimi', na.sermaye);
          t += row('  Sermaye yedekleri degisimi', na.sermayeYedek);
          t += row('Finansman faaliyetlerinden net nakit', na.finansmanNakit, true, true);
          t += '<tr style="border-top:2px solid #2F5496;"><td></td><td></td></tr>';
          t += row('NET NAKIT DEGISIMI', na.netNakit, true, true);
          t += row('Donem basi nakit', na.nakitBasi);
          t += row('Donem sonu nakit', na.nakitSonu, true);
          t += '</table>';
          downloadHTML(buildHTMLReport('Nakit Akis - ' + d1, t, ''), 'Nakit_Akis_' + d1.replace(/\s/g, '_') + '.html');
        };

        const NRow = ({ label, value, bold, hl, indent }) => (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 12px", paddingLeft: indent ? 28 : 12, borderBottom: "0.5px solid var(--color-border-tertiary)", fontWeight: bold ? 500 : 400, fontSize: 14, background: hl ? "var(--color-background-secondary)" : "transparent" }}>
            <span>{label}</span>
            <span style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", color: value >= 0 ? "var(--color-text-success)" : "var(--color-text-danger)" }}>{formatN(value)}</span>
          </div>
        );
        const NSec = ({ label }) => (
          <div style={{ padding: "10px 12px", background: "var(--color-background-info)", color: "var(--color-text-info)", fontWeight: 500, fontSize: 13 }}>{label}</div>
        );

        return (<div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", ...SEC }}>
            <span>Nakit akis tablosu (dolayli yontem)</span>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={doExportCSV} style={DL_STYLE}>CSV Indir</button>
              <button onClick={doExportHTML} style={{ ...DL_STYLE, background: "var(--color-background-success)", color: "var(--color-text-success)", border: "0.5px solid var(--color-border-success)" }}>PDF (HTML)</button>
            </div>
          </div>
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 12 }}>Donem: {d1} / Karsilastirma: {d2}</div>
          <div style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-lg)", overflow: "hidden" }}>
            <NSec label="A. Isletme faaliyetlerinden nakit akislari" />
            <NRow label="Donem net kari" value={na.donemKari} bold />
            <NRow label="+ Amortisman giderleri" value={na.amor} />
            <div style={{ padding: "8px 12px", fontWeight: 500, fontSize: 13, color: "var(--color-text-secondary)", borderBottom: "0.5px solid var(--color-border-tertiary)" }}>Isletme sermayesi degisimleri:</div>
            <NRow label="Ticari alacaklardaki degisim" value={na.ticAlacak} indent />
            <NRow label="Diger alacaklardaki degisim" value={na.digAlacak} indent />
            <NRow label="Stoklardaki degisim" value={na.stok} indent />
            <NRow label="Diger donen varlik degisimi" value={na.digDonenVarlik} indent />
            <NRow label="Ticari borclardaki degisim" value={na.ticBorc} indent />
            <NRow label="Diger borclardaki degisim" value={na.digBorc} indent />
            <NRow label="Vergi borclardaki degisim" value={na.vergiBorc} indent />
            <NRow label="Borc karsiliklari degisimi" value={na.borcKarsilik} indent />
            <NRow label="Diger KVYK degisimi" value={na.digKvyk} indent />
            <NRow label="ISLETME FAALIYETLERINDEN NET NAKIT" value={na.faaliyetNakit} bold hl />

            <NSec label="B. Yatirim faaliyetlerinden nakit akislari" />
            <NRow label="Maddi duran varlik alis/satis" value={na.mdvBrut} indent />
            <NRow label="Maddi olmayan duran varlik" value={na.modkBrut} indent />
            <NRow label="Uzun vadeli alacak degisimi" value={na.uzunAlacak} indent />
            <NRow label="Diger duran varlik degisimi" value={na.digDuranV} indent />
            <NRow label="YATIRIM FAALIYETLERINDEN NET NAKIT" value={na.yatirimNakit} bold hl />

            <NSec label="C. Finansman faaliyetlerinden nakit akislari" />
            <NRow label="Kisa vadeli mali borc degisimi" value={na.kvMaliBorc} indent />
            <NRow label="Uzun vadeli mali borc degisimi" value={na.uvMaliBorc} indent />
            <NRow label="Sermaye degisimi" value={na.sermaye} indent />
            <NRow label="Sermaye yedekleri degisimi" value={na.sermayeYedek} indent />
            <NRow label="FINANSMAN FAALIYETLERINDEN NET NAKIT" value={na.finansmanNakit} bold hl />

            <div style={{ height: 4, background: "var(--color-background-tertiary)" }} />
            <NRow label="NET NAKIT DEGISIMI" value={na.netNakit} bold hl />
            <NRow label="Donem basi nakit" value={na.nakitBasi} />
            <NRow label="Donem sonu nakit" value={na.nakitSonu} bold />
          </div>

          {/* Yonetici Notlari */}
          {(() => {
            const notlar = [];
            const skorBg = (s) => s === "iyi" ? "#E1F5EE" : s === "orta" ? "#FAEEDA" : "#FCEBEB";
            const skorRenk = (s) => s === "iyi" ? "#0F6E56" : s === "orta" ? "#BA7517" : "#A32D2D";

            // Net nakit degisimi
            if (na.netNakit > 0) notlar.push({ tip: "iyi", mesaj: "Net nakit degisimi pozitif (" + formatN(na.netNakit) + " TL). Isletme nakit uretiyor." });
            else if (na.netNakit < 0) notlar.push({ tip: "kotu", mesaj: "Net nakit degisimi negatif (" + formatN(na.netNakit) + " TL). Isletme nakit tuketiyor — kaynagi belirlenip onlem alinmali." });

            // A. Isletme faaliyetleri
            if (na.faaliyetNakit > 0) notlar.push({ tip: "iyi", mesaj: "Isletme faaliyetleri " + formatN(na.faaliyetNakit) + " TL nakit uretmis. Bu, isletmenin ana faaliyetlerinden nakit kazandigini gosterir — en saglikli nakit kaynagi budur." });
            else notlar.push({ tip: "kotu", mesaj: "Isletme faaliyetleri " + formatN(na.faaliyetNakit) + " TL nakit tuketmis. Ana faaliyetler nakit uretemiyor — bu durum surdurulebilir degil, acil onlem gerektirir." });

            // Amortisman
            if (na.amor > 0) notlar.push({ tip: "iyi", mesaj: "Amortisman giderleri (" + formatN(na.amor) + " TL) nakit cikisi olmayan gider — gercek nakit durumu kardan daha iyidir." });
            else if (na.amor < 0) notlar.push({ tip: "orta", mesaj: "Amortisman degisimi negatif. Onceki donemde daha yuksek birikimli amortisman vardi — varlik satisi yapilmis olabilir." });

            // Ticari alacak etkisi
            if (na.ticAlacak > 0) notlar.push({ tip: "iyi", mesaj: "Ticari alacaklar " + formatN(na.ticAlacak) + " TL azalmis — tahsilatlar guclu, nakde donusum basarili." });
            else if (na.ticAlacak < 0) notlar.push({ tip: "kotu", mesaj: "Ticari alacaklar " + formatN(Math.abs(na.ticAlacak)) + " TL artmis — musterilere daha fazla vade verilmis, tahsilat yavaslamis olabilir." });

            // Stok etkisi
            if (na.stok > 0) notlar.push({ tip: "iyi", mesaj: "Stoklar " + formatN(na.stok) + " TL azalmis — stok nakde donusmus, stok yonetimi verimli." });
            else if (na.stok < 0) notlar.push({ tip: "orta", mesaj: "Stoklar " + formatN(Math.abs(na.stok)) + " TL artmis — nakit stoklara baglanmis. Stok artisinin nedeni (buyume mi, yavas satis mi?) degerlendirilmeli." });

            // Ticari borc etkisi
            if (na.ticBorc > 0) notlar.push({ tip: "orta", mesaj: "Ticari borclar " + formatN(na.ticBorc) + " TL artmis — tedarikcilere daha gec odeme yapiliyor, bu kisa vadede nakit avantaj saglasa da tedarikci iliskilerini zorlayabilir." });
            else if (na.ticBorc < 0) notlar.push({ tip: "orta", mesaj: "Ticari borclar " + formatN(Math.abs(na.ticBorc)) + " TL azalmis — tedarikcilere odemeler yapilmis, bu nakdi azaltmis ancak tedarikci guvenini artirmistir." });

            // B. Yatirim faaliyetleri
            if (na.yatirimNakit < 0) notlar.push({ tip: "orta", mesaj: "Yatirim faaliyetleri " + formatN(Math.abs(na.yatirimNakit)) + " TL nakit kullanmis. Isletme buyume icin yatirim yapiyor — bu normal ve saglikli bir durumdur (isletme faaliyetlerinden finanse ediliyorsa)." });
            else if (na.yatirimNakit > 0) notlar.push({ tip: "orta", mesaj: "Yatirim faaliyetleri " + formatN(na.yatirimNakit) + " TL nakit saglamis. Varlik satisi yapilmis olabilir — bunun stratejik bir karar mi yoksa nakit ihtiyacindan mi kaynaklandigi degerlendirilmeli." });

            // C. Finansman faaliyetleri
            if (na.finansmanNakit > 0) notlar.push({ tip: "orta", mesaj: "Finansman faaliyetleri " + formatN(na.finansmanNakit) + " TL nakit saglamis. Yeni kredi kullanilmis veya sermaye artirimi yapilmis olabilir." });
            else if (na.finansmanNakit < 0) notlar.push({ tip: "iyi", mesaj: "Finansman faaliyetleri " + formatN(Math.abs(na.finansmanNakit)) + " TL nakit kullanmis. Borc odemesi yapilmis — borcluluk azaliyor." });

            // Donem sonu nakit
            if (na.nakitSonu < 0) notlar.push({ tip: "kotu", mesaj: "Donem sonu nakit bakiyesi negatif (" + formatN(na.nakitSonu) + " TL). Banka hesaplarinda acik kredi kullaniliyor — kisa vadeli finansman maliyetlerine dikkat edilmeli." });
            else if (na.nakitSonu > 0 && na.nakitBasi > 0 && na.nakitSonu > na.nakitBasi) notlar.push({ tip: "iyi", mesaj: "Nakit bakiye donem basina gore artmis: " + formatN(na.nakitBasi) + " TL -> " + formatN(na.nakitSonu) + " TL." });

            // Genel degerlendirme
            if (na.faaliyetNakit > 0 && na.yatirimNakit < 0 && na.faaliyetNakit > Math.abs(na.yatirimNakit)) notlar.push({ tip: "iyi", mesaj: "Ideal durum: Isletme faaliyetlerinden kazanilan nakit, yatirim harcamalarini karsilayabiliyor. Dis finansmana bagimsiz buyume mumkun." });
            else if (na.faaliyetNakit < 0 && na.finansmanNakit > 0) notlar.push({ tip: "kotu", mesaj: "Dikkat: Isletme faaliyetleri nakit uretemiyor ve borc ile finanse ediliyor. Bu durum surdurulebilir degil." });

            return (
              <div style={{ marginTop: "1.5rem" }}>
                <div style={SEC}>Nakit akis degerlendirme notlari</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {notlar.map((n, i) => (
                    <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "10px 14px", background: skorBg(n.tip), borderRadius: "var(--border-radius-md)", borderLeft: "3px solid " + skorRenk(n.tip) }}>
                      <span style={{ fontWeight: 500, flexShrink: 0, color: skorRenk(n.tip) }}>{n.tip === "iyi" ? "+" : n.tip === "orta" ? "~" : "!"}</span>
                      <span style={{ fontSize: 13, lineHeight: 1.6, color: "var(--color-text-primary)" }}>{n.mesaj}</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}
        </div>);
      })()}

      {/* TAB 4: Analizler with comparison */}
      {tab === 4 && a && (() => {
        const aK = karsi >= 0 ? analizler[karsi] : null;
        const dK = karsi >= 0 ? dikeyler[karsi] : null;
        const oranData = [
          ["Cari oran", a.co, aK?.co, ">1.5", renk(a.co, 1.5, 1)],
          ["Asit-test", a.at, aK?.at, ">1.0", renk(a.at, 1, 0.5)],
          ["Nakit orani", a.no, aK?.no, ">0.2", renk(a.no, 0.2, 0.1)],
          ["Borc/Ozkaynak", a.bo, aK?.bo, "<1.0", a.bo <= 1 ? "#0F6E56" : "#A32D2D"],
          ["Brut kar marji %", a.bkm, aK?.bkm, ">%20", renk(a.bkm, 20, 10)],
          ["Net kar marji %", a.nkm, aK?.nkm, ">%5", renk(a.nkm, 5, 0)],
          ["ROE %", a.roe, aK?.roe, ">%15", renk(a.roe, 15, 5)],
          ["ROA %", a.roa, aK?.roa, ">%5", renk(a.roa, 5, 2)],
          ["Alacak tahsil (gun)", a.ag, aK?.ag, "<45", a.ag > 0 && a.ag <= 45 ? "#0F6E56" : "#A32D2D"],
          ["Stok devir (gun)", a.sg, aK?.sg, "<60", a.sg > 0 && a.sg <= 60 ? "#0F6E56" : "#A32D2D"],
        ];
        const fmtO = (v, l) => l.includes("%") ? "%" + v.toFixed(1) : l.includes("gun") ? Math.round(v) + " gun" : v.toFixed(2);

        const doExportCSV = () => {
          const rows = [];
          if (aK) rows.push(["Oran", d1, d2, "Fark", "Standart"]);
          else rows.push(["Oran", "Deger", "Standart"]);
          for (const [l, v1, v2, std] of oranData) {
            if (aK && v2 != null) { rows.push([l, fmtO(v1, l), fmtO(v2, l), (v1 - v2).toFixed(2), std]); }
            else rows.push([l, fmtO(v1, l), std]);
          }
          if (d) { rows.push([]); rows.push(["DIKEY ANALIZ - BILANCO"]); rows.push(["Kalem", d1 + " %", ...(dK ? [d2 + " %"] : [])]); for (const [l, v, vk] of [["Donen varliklar", d.b.dvY, dK?.b.dvY], ["Duran varliklar", d.b.durY, dK?.b.durY], ["KVYK", d.b.kvY, dK?.b.kvY], ["UVYK", d.b.uvY, dK?.b.uvY], ["Ozkaynaklar", d.b.ozY, dK?.b.ozY]]) { rows.push([l, "%" + v.toFixed(1), ...(dK && vk != null ? ["%" + vk.toFixed(1)] : [])]); }
            rows.push([]); rows.push(["DIKEY ANALIZ - GELIR"]); rows.push(["Kalem", d1 + " %", ...(dK ? [d2 + " %"] : [])]); for (const [l, v, vk] of [["Satis maliyeti", d.g.malY, dK?.g.malY], ["Brut kar", d.g.bkY, dK?.g.bkY], ["Faaliyet gideri", d.g.fgY, dK?.g.fgY], ["Faaliyet kari", d.g.fkY, dK?.g.fkY], ["Net kar", d.g.nkY, dK?.g.nkY]]) { rows.push([l, "%" + v.toFixed(1), ...(dK && vk != null ? ["%" + vk.toFixed(1)] : [])]); }
          }
          downloadCSV(buildCSV(rows), "Analizler_" + d1.replace(/\s/g, "_") + ".csv");
        };
        const doExportHTML = () => {
          let t = '<h2>Finansal Oranlar</h2><table><tr><th>Oran</th><th class="r">' + d1 + '</th>';
          if (aK) t += '<th class="r">' + d2 + '</th><th class="r">Fark</th>';
          t += '<th>Standart</th></tr>';
          for (const [l, v1, v2, std, clr] of oranData) {
            t += '<tr><td>' + l + '</td><td class="r" style="color:' + clr + '">' + fmtO(v1, l) + '</td>';
            if (aK && v2 != null) { const f = v1 - v2; t += '<td class="r">' + fmtO(v2, l) + '</td><td class="r ' + (f >= 0 ? 'g' : 'rd') + '">' + (f >= 0 ? '+' : '') + f.toFixed(2) + '</td>'; }
            t += '<td>' + std + '</td></tr>';
          }
          t += '</table>';
          if (d) {
            t += '<h2>Dikey Analiz - Bilanco</h2><table><tr><th>Kalem</th><th class="r">' + d1 + '</th>' + (dK ? '<th class="r">' + d2 + '</th>' : '') + '</tr>';
            for (const [l, v, vk] of [["Donen varliklar", d.b.dvY, dK?.b.dvY], ["Duran varliklar", d.b.durY, dK?.b.durY], ["KVYK", d.b.kvY, dK?.b.kvY], ["UVYK", d.b.uvY, dK?.b.uvY], ["Ozkaynaklar", d.b.ozY, dK?.b.ozY]]) { t += '<tr><td>' + l + '</td><td class="r">%' + v.toFixed(1) + '</td>' + (dK && vk != null ? '<td class="r">%' + vk.toFixed(1) + '</td>' : '') + '</tr>'; }
            t += '</table><h2>Dikey Analiz - Gelir</h2><table><tr><th>Kalem</th><th class="r">' + d1 + '</th>' + (dK ? '<th class="r">' + d2 + '</th>' : '') + '</tr>';
            for (const [l, v, vk] of [["Satis maliyeti", d.g.malY, dK?.g.malY], ["Brut kar", d.g.bkY, dK?.g.bkY], ["Faaliyet gideri", d.g.fgY, dK?.g.fgY], ["Faaliyet kari", d.g.fkY, dK?.g.fkY], ["Net kar", d.g.nkY, dK?.g.nkY]]) { t += '<tr><td>' + l + '</td><td class="r">%' + v.toFixed(1) + '</td>' + (dK && vk != null ? '<td class="r">%' + vk.toFixed(1) + '</td>' : '') + '</tr>'; }
            t += '</table>';
          }
          downloadHTML(buildHTMLReport('Analizler - ' + d1, t, ''), 'Analizler_' + d1.replace(/\s/g, '_') + '.html');
        };

        return (<div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", ...SEC }}>
            <span>Finansal analizler{aK ? " — Karsilastirma" : ""}</span>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={doExportCSV} style={DL_STYLE}>CSV Indir</button>
              <button onClick={doExportHTML} style={{ ...DL_STYLE, background: "var(--color-background-success)", color: "var(--color-text-success)", border: "0.5px solid var(--color-border-success)" }}>PDF (HTML)</button>
            </div>
          </div>
          {aK && (<div style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-lg)", overflow: "hidden", marginBottom: "1.5rem" }}>
            <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr 0.7fr", padding: "8px 12px", background: "var(--color-background-secondary)", fontWeight: 500, fontSize: 12, color: "var(--color-text-secondary)" }}><span>Oran</span><span style={{ textAlign: "right" }}>{d1}</span><span style={{ textAlign: "right" }}>{d2}</span><span style={{ textAlign: "right" }}>Fark</span><span style={{ textAlign: "right" }}>Std</span></div>
            {oranData.map(([l, v1, v2, std, clr]) => { const f = v1 - v2; return (<div key={l} style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr 0.7fr", padding: "7px 12px", borderBottom: "0.5px solid var(--color-border-tertiary)", fontSize: 13 }}><span>{l}</span><span style={{ textAlign: "right", fontWeight: 500, color: clr }}>{fmtO(v1, l)}</span><span style={{ textAlign: "right" }}>{fmtO(v2, l)}</span><span style={{ textAlign: "right", color: f >= 0 ? "#0F6E56" : "#A32D2D" }}>{f >= 0 ? "+" : ""}{f.toFixed(2)}</span><span style={{ textAlign: "right", fontSize: 11, color: "var(--color-text-tertiary)" }}>{std}</span></div>); })}
          </div>)}
          {!aK && (<div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
            {oranData.map(([l, v1, v2, std, clr]) => (<OranCard key={l} ad={l} deger={fmtO(v1, l)} ac={std} renk={clr} />))}
          </div>)}
          {d && (<div><div style={SEC}>Dikey analiz</div><div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <div style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-lg)", overflow: "hidden" }}><div style={{ padding: "8px 12px", background: "var(--color-background-secondary)", fontWeight: 500, fontSize: 13 }}>Bilanco</div>{[["Donen varliklar", d.b.dvY, dK?.b.dvY], ["Duran varliklar", d.b.durY, dK?.b.durY], ["KVYK", d.b.kvY, dK?.b.kvY], ["UVYK", d.b.uvY, dK?.b.uvY], ["Ozkaynaklar", d.b.ozY, dK?.b.ozY]].map(([l, v, vk]) => (<div key={l} style={{ display: "flex", justifyContent: "space-between", padding: "8px 12px", borderBottom: "0.5px solid var(--color-border-tertiary)", fontSize: 14 }}><span>{l}</span><span>%{v.toFixed(1)}{dK && vk != null ? <span style={{ fontSize: 11, color: "var(--color-text-tertiary)", marginLeft: 8 }}>({d2}: %{vk.toFixed(1)})</span> : null}</span></div>))}</div>
            <div style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-lg)", overflow: "hidden" }}><div style={{ padding: "8px 12px", background: "var(--color-background-secondary)", fontWeight: 500, fontSize: 13 }}>Gelir tablosu</div>{[["Satis maliyeti", d.g.malY, dK?.g.malY], ["Brut kar", d.g.bkY, dK?.g.bkY], ["Faaliyet gideri", d.g.fgY, dK?.g.fgY], ["Faaliyet kari", d.g.fkY, dK?.g.fkY], ["Net kar", d.g.nkY, dK?.g.nkY]].map(([l, v, vk]) => (<div key={l} style={{ display: "flex", justifyContent: "space-between", padding: "8px 12px", borderBottom: "0.5px solid var(--color-border-tertiary)", fontSize: 14 }}><span>{l}</span><span>%{v.toFixed(1)}{dK && vk != null ? <span style={{ fontSize: 11, color: "var(--color-text-tertiary)", marginLeft: 8 }}>({d2}: %{vk.toFixed(1)})</span> : null}</span></div>))}</div>
          </div></div>)}

          {/* Yonetici Notlari - Oran Aciklamalari */}
          {(() => {
            const skorBg2 = (s) => s === "iyi" ? "#E1F5EE" : s === "orta" ? "#FAEEDA" : "#FCEBEB";
            const skorRenk2 = (s) => s === "iyi" ? "#0F6E56" : s === "orta" ? "#BA7517" : "#A32D2D";
            const skorIcon2 = (s) => s === "iyi" ? "+" : s === "orta" ? "~" : "!";

            const oranNotlari = [
              {
                ad: "Cari Oran (" + a.co.toFixed(2) + ")",
                durum: a.co >= 1.5 ? "iyi" : a.co >= 1 ? "orta" : "kotu",
                anlam: "Her 1 TL kisa vadeli borca karsi " + a.co.toFixed(2) + " TL donen varlik var. " + (a.co >= 1.5 ? "Kisa vadeli borclari rahat karsilayabilirsiniz." : a.co >= 1 ? "Borclari karsilayabilirsiniz ancak guvenlik marji dusuk." : "Kisa vadeli borclari karsilamakta zorlanabilirsiniz."),
                aksiyonlar: a.co < 1.5 ? ["Kisa vadeli borclari uzun vadeye cevirmeyi degerlendirin", "Stok ve alacak devir hizini artirarak donen varliklari guclendirin", "Gereksiz kisa vadeli kredi kullanimindan kacinin"] : ["Mevcut seviyeyi korumaya devam edin", "Fazla likiditeyi kisa vadeli yatirimlarda degerlendirin"],
              },
              {
                ad: "Asit-Test Orani (" + a.at.toFixed(2) + ")",
                durum: a.at >= 1 ? "iyi" : a.at >= 0.7 ? "orta" : "kotu",
                anlam: "Stoklar haric donen varliklar ile kisa vadeli borclarin orani. " + (a.at >= 1 ? "Stoklari satmadan bile borclari odeyebilirsiniz." : "Stok satisi olmadan borclari odemek zor olabilir."),
                aksiyonlar: a.at < 1 ? ["Nakit ve alacak agirlikli donen varlik yapisina gecin", "Stok bagimliliginizi azaltin", "Alacak tahsilatini hizlandirarak likit varliklari artirin"] : ["Stok harici likidite guclu, mevcut yapiyi koruyun"],
              },
              {
                ad: "Nakit Orani (" + a.no.toFixed(2) + ")",
                durum: a.no >= 0.2 ? "iyi" : a.no >= 0.1 ? "orta" : "kotu",
                anlam: "Sadece nakit ile kisa vadeli borclarin orani. " + (a.no >= 0.2 ? "Acil nakit ihtiyaclarini karsilayabilecek nakdiniz var." : "Nakit rezervi dusuk — beklenmedik harcamalarda sikinti yasanabilir."),
                aksiyonlar: a.no < 0.2 ? ["Minimum 1-2 aylik giderleri karsilayacak nakit rezervi olusturun", "Tahsilat surelerini kisaltin", "Nakit akis butcesi hazirlayarak onceden planlama yapin"] : ["Nakit pozisyonu yeterli — atil nakit varsa degerlendirin"],
              },
              {
                ad: "Borc/Ozkaynak (" + a.bo.toFixed(2) + ")",
                durum: a.bo <= 1 ? "iyi" : a.bo <= 2 ? "orta" : "kotu",
                anlam: "Her 1 TL ozkaynak basina " + a.bo.toFixed(2) + " TL borc var. " + (a.bo <= 1 ? "Ozkaynak agirlikli finansman — dusuk risk." : "Borc agirlikli yapida — finansal risk yuksek."),
                aksiyonlar: a.bo > 1 ? ["Kardan dagitim yerine ozkaynaga ekleyin", "Yuksek faizli borclari once odeyin", "Sermaye artirimi degerlendirin"] : ["Saglikli yapi — kontollu borc kullanimi degerlendirilelebilir"],
              },
              {
                ad: "Brut Kar Marji (%" + a.bkm.toFixed(1) + ")",
                durum: a.bkm >= 20 ? "iyi" : a.bkm >= 10 ? "orta" : "kotu",
                anlam: "Her 100 TL satistan " + a.bkm.toFixed(1) + " TL brut kar kaliyor. " + (a.bkm >= 20 ? "Fiyatlama gucu ve maliyet yonetimi basarili." : "Satis maliyetleri yuksek — marj baskisi var."),
                aksiyonlar: a.bkm < 20 ? ["Tedarikci anlasmalarini yeniden muzakere edin", "Dusuk marjli urunlerin payini azaltin", "Uretim verimliligini artirin", "Fiyat artisi imkani arastirin"] : ["Marj guclu — rekabetci avantaji koruyun"],
              },
              {
                ad: "Net Kar Marji (%" + a.nkm.toFixed(1) + ")",
                durum: a.nkm >= 5 ? "iyi" : a.nkm > 0 ? "orta" : "kotu",
                anlam: "Tum giderler sonrasi her 100 TL satistan " + a.nkm.toFixed(1) + " TL kar. " + (a.nkm >= 5 ? "Isletme verimli calisiyor." : a.nkm > 0 ? "Kar var ama ince — gider kontrolu onemli." : "Isletme zarar ediyor."),
                aksiyonlar: a.nkm < 5 ? ["Faaliyet giderlerini kalem kalem inceleyin", "Finansman giderlerini dusurun", "Personel verimliligi artirin", "Sabit giderlerde tasarruf arayin"] : ["Net karlilik iyi — gelir cesitlendirmesi yapin"],
              },
              {
                ad: "Faaliyet Kar Marji (%" + a.fkm.toFixed(1) + ")",
                durum: a.fkm >= 10 ? "iyi" : a.fkm >= 3 ? "orta" : "kotu",
                anlam: "Ana faaliyetlerden elde edilen kar orani. Finansman ve olagandisi kalemler haric operasyonel verimlilik gostergesi.",
                aksiyonlar: a.fkm < 10 ? ["Genel yonetim giderlerini gozden gecirin", "Pazarlama harcamalarinin geri donusunu olcun", "Ar-Ge'yi verimlilik odakli yonlendirin"] : ["Operasyonel verimlilik iyi seviyede"],
              },
              {
                ad: "ROE (%" + a.roe.toFixed(1) + ")",
                durum: a.roe >= 15 ? "iyi" : a.roe >= 5 ? "orta" : "kotu",
                anlam: "Ortaklarin her 100 TL yatirimi icin " + a.roe.toFixed(1) + " TL kar. " + (a.roe >= 15 ? "Ortaklara iyi getiri saglaniyor." : "Alternatif yatirim getirileriyle karsilastirin."),
                aksiyonlar: a.roe < 15 ? ["Net karliligi artirin", "Varlik devir hizini yukselttin", "Atil varliklari elden cikarin"] : ["Guclu getiri — devam edin"],
              },
              {
                ad: "ROA (%" + a.roa.toFixed(1) + ")",
                durum: a.roa >= 5 ? "iyi" : a.roa >= 2 ? "orta" : "kotu",
                anlam: "Her 100 TL varlik icin " + a.roa.toFixed(1) + " TL kar. " + (a.roa >= 5 ? "Varliklar verimli kullaniliyor." : "Varlik verimliligi arttirilabilir."),
                aksiyonlar: a.roa < 5 ? ["Kullanilmayan varliklari satin", "Kapasite kullanim oranini artirin", "Yeni yatirimlarda getiri analizi yapin"] : ["Varlik verimliligi iyi"],
              },
              {
                ad: "Alacak Tahsil (" + Math.round(a.ag) + " gun)",
                durum: a.ag > 0 && a.ag <= 45 ? "iyi" : a.ag <= 75 ? "orta" : "kotu",
                anlam: "Satislardan alacaklar ortalama " + Math.round(a.ag) + " gunde tahsil ediliyor. " + (a.ag <= 45 ? "Hizli tahsilat — nakit dongusu verimli." : "Tahsilat yavas — nakit sikisikligi riski."),
                aksiyonlar: a.ag > 45 ? ["Vade surelerini kisaltin", "Erken odeme indirimi sunun", "Geciken alacaklar icin takip sistemi kurun", "Buyuk satislarda pesinat isteyin"] : ["Tahsilat hizli — politikayi surdurun"],
              },
              {
                ad: "Stok Devir (" + Math.round(a.sg) + " gun)",
                durum: a.sg > 0 && a.sg <= 60 ? "iyi" : a.sg <= 120 ? "orta" : "kotu",
                anlam: "Stoklar ortalama " + Math.round(a.sg) + " gunde satiliyor. " + (a.sg <= 60 ? "Stok devir hizi iyi." : "Stoklar yavas donuyor — sermaye baglu kaliyor."),
                aksiyonlar: a.sg > 60 ? ["ABC analizi ile yuksek degerli urunlere oncelik verin", "Olu stoklari kampanya ile eritin", "Min-max stok seviyeleri belirleyin", "Siparis bazli tedarik modelini degerlendirin"] : ["Stok yonetimi verimli"],
              },
            ];

            return (
              <div style={{ marginTop: "1.5rem" }}>
                <div style={SEC}>Oran aciklamalari ve yonetici onerileri</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {oranNotlari.map((o, oi) => (
                    <div key={oi} style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-lg)", overflow: "hidden" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", background: skorBg2(o.durum), borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ fontWeight: 600, color: skorRenk2(o.durum) }}>{skorIcon2(o.durum)}</span>
                          <span style={{ fontSize: 14, fontWeight: 500 }}>{o.ad}</span>
                        </div>
                        <span style={{ fontSize: 11, padding: "2px 10px", borderRadius: 99, background: "var(--color-background-primary)", color: skorRenk2(o.durum), fontWeight: 500 }}>{o.durum === "iyi" ? "SAGLAM" : o.durum === "orta" ? "TAKIP ET" : "IYILESTIR"}</span>
                      </div>
                      <div style={{ padding: "12px 14px" }}>
                        <div style={{ fontSize: 13, lineHeight: 1.7, color: "var(--color-text-primary)", marginBottom: 10 }}>{o.anlam}</div>
                        <div style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)", marginBottom: 6 }}>{o.durum === "iyi" ? "Surdurulebilirlik icin:" : "Iyilestirme aksiyonlari:"}</div>
                        {o.aksiyonlar.map((ak, ai) => (
                          <div key={ai} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "4px 0" }}>
                            <span style={{ fontSize: 11, color: skorRenk2(o.durum), flexShrink: 0, marginTop: 2 }}>{ai + 1}.</span>
                            <span style={{ fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.6 }}>{ak}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}
        </div>);
      })()}

      {/* TAB 5: Dashboard Premium */}
      {tab === 5 && g && b && a && (() => {
        const aK = karsi >= 0 ? analizler[karsi] : null;
        const gK2 = gK, bK2 = bK;
        const skor = (val, iyi, orta) => val >= iyi ? "iyi" : val >= orta ? "orta" : "kotu";
        const skorRenk = (s) => s === "iyi" ? "#0F6E56" : s === "orta" ? "#BA7517" : "#A32D2D";
        const skorBg = (s) => s === "iyi" ? "#E1F5EE" : s === "orta" ? "#FAEEDA" : "#FCEBEB";
        const skorLabel = (s) => s === "iyi" ? "SAGLAM" : s === "orta" ? "TAKIP ET" : "RISK";
        const notlar = [];
        if (a.co < 1) notlar.push({ tip: "kotu", mesaj: "Cari oran 1'in altinda. Kisa vadeli yukumlulukleri karsilamakta zorluk yasanabilir." }); else if (a.co < 1.5) notlar.push({ tip: "orta", mesaj: "Cari oran kabul edilebilir ama guvenlik marji dusuk." }); else notlar.push({ tip: "iyi", mesaj: "Cari oran guclu. Kisa vadeli borclari rahat karsilayabilirsiniz." });
        if (a.nkm < 0) notlar.push({ tip: "kotu", mesaj: "Isletme zarar ediyor. Gelir-gider dengesi acilen gozden gecirilmeli." }); else if (a.nkm < 5) notlar.push({ tip: "orta", mesaj: "Net kar marji dusuk. Faaliyet giderleri optimize edilmeli." }); else notlar.push({ tip: "iyi", mesaj: "Karlilik guclu. Operasyonel verimlilik iyi seviyede." });
        if (a.bo > 2) notlar.push({ tip: "kotu", mesaj: "Borcluluk kritik seviyede. Borc yapilandirmasi ve sermaye artirimi degerlendirilmeli." }); else if (a.bo > 1) notlar.push({ tip: "orta", mesaj: "Borcluluk takip edilmeli. Yeni borc almadan once dikkatli degerlendirme yapilmali." }); else notlar.push({ tip: "iyi", mesaj: "Borc/ozkaynak dengesi saglikli. Finansal risk dusuk." });
        if (a.ag > 60) notlar.push({ tip: "kotu", mesaj: "Alacak tahsil suresi " + Math.round(a.ag) + " gun — tahsilat politikasi sikilastirilmali." }); else if (a.ag > 45) notlar.push({ tip: "orta", mesaj: "Alacak tahsilati " + Math.round(a.ag) + " gun — takip edilmeli." });
        if (a.sg > 90) notlar.push({ tip: "kotu", mesaj: "Stok devir suresi " + Math.round(a.sg) + " gun — sermaye stoklarda baglu." }); else if (a.sg > 60) notlar.push({ tip: "orta", mesaj: "Stok devir " + Math.round(a.sg) + " gun — iyilestirme imkani var." });

        const durum = [
          ["Likidite", skor(a.at, 1, 0.7), a.at.toFixed(2), "Asit-test orani", a.at >= 1 ? "Borclari karsilar" : "Dikkat gerekli"],
          ["Karlilik", skor(a.nkm, 10, 2), "%" + a.nkm.toFixed(1), "Net kar marji", a.nkm >= 5 ? "Verimli" : "Iyilestirin"],
          ["Borcluluk", a.bo <= 1 ? "iyi" : a.bo <= 2 ? "orta" : "kotu", a.bo.toFixed(2), "Borc/Ozkaynak", a.bo <= 1 ? "Dusuk risk" : "Yuksek risk"],
          ["Buyume", hasK && gK2 ? (g.netSatis > gK2.netSatis ? "iyi" : "kotu") : "orta", hasK && gK2 ? ((g.netSatis - gK2.netSatis) / Math.abs(gK2.netSatis) * 100).toFixed(1) + "%" : "-", "Satis degisimi", hasK && gK2 ? (g.netSatis > gK2.netSatis ? "Buyuyor" : "Kuculuyor") : "Karsilastirma secin"],
        ];
        const metrikler = [["Net Satis", g.netSatis, gK2?.netSatis, "#85B7EB"], ["Donem Kari", g.donemKari, gK2?.donemKari, g.donemKari >= 0 ? "#5DCAA5" : "#F09595"], ["Aktif Toplam", b.aktif, bK2?.aktif, "#AFA9EC"], ["Ozkaynaklar", b.ozk, bK2?.ozk, "#9FE1CB"], ["Toplam Borc", b.kvyk + b.uvyk, bK2 ? bK2.kvyk + bK2.uvyk : null, "#F09595"], ["Brut Kar", g.brutKar, gK2?.brutKar, "#5DCAA5"]];

        const doExportCSV = () => {
          const rows = [["YONETICI DASHBOARD - " + d1], []];
          rows.push(["Durum", "Seviye", "Deger"]);
          for (const [l, sk, val] of durum) rows.push([l, skorLabel(sk), val]);
          rows.push([]); rows.push(["Gosterge", d1, ...(hasK ? [d2, "Degisim"] : [])]);
          for (const [l, v1, v2] of metrikler) rows.push([l, formatN(v1), ...(hasK && v2 != null ? [formatN(v2), ((v1 - v2) / Math.abs(v2) * 100).toFixed(1) + "%"] : [])]);
          rows.push([]); rows.push(["Notlar"]); for (const n of notlar) rows.push([n.tip === "iyi" ? "+" : n.tip === "orta" ? "~" : "!", n.mesaj]);
          downloadCSV(buildCSV(rows), "Dashboard_" + d1.replace(/\s/g, "_") + ".csv");
        };
        const doExportHTML = () => {
          let t = '<div style="display:flex;gap:12px;margin-bottom:20px;">';
          for (const [l, sk, val, sub, desc] of durum) t += '<div style="flex:1;padding:14px;border-radius:12px;background:' + skorBg(sk) + ';"><div style="font-size:11px;color:' + skorRenk(sk) + ';margin-bottom:4px;">' + l + '</div><div style="font-size:22px;font-weight:700;color:' + skorRenk(sk) + ';">' + val + '</div><div style="font-size:10px;color:' + skorRenk(sk) + ';opacity:0.7;">' + desc + '</div></div>';
          t += '</div>';
          t += '<h2>Temel Gostergeler</h2><table><tr><th>Gosterge</th><th class="r">' + d1 + '</th>' + (hasK ? '<th class="r">' + d2 + '</th><th class="r">Degisim</th>' : '') + '</tr>';
          for (const [l, v1, v2] of metrikler) { t += '<tr><td class="b">' + l + '</td><td class="r">' + formatN(v1) + '</td>'; if (hasK && v2 != null) { const p = (v1 - v2) / Math.abs(v2) * 100; t += '<td class="r">' + formatN(v2) + '</td><td class="r ' + (p >= 0 ? 'g' : 'rd') + '">' + (p >= 0 ? '+' : '') + p.toFixed(1) + '%</td>'; } t += '</tr>'; }
          t += '</table>';
          t += '<h2>Karlilik</h2>';
          for (const [l, v, c] of [["Brut kar", a.bkm, "#5DCAA5"], ["Faaliyet kari", a.fkm, "#85B7EB"], ["Net kar", a.nkm, "#AFA9EC"]]) t += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;"><span style="font-size:11px;color:#666;min-width:80px;">' + l + '</span><div style="flex:1;height:14px;border-radius:99px;background:#eee;overflow:hidden;"><div style="width:' + Math.max(0, Math.min(100, v)) + '%;height:100%;background:' + c + ';border-radius:99px;"></div></div><span style="font-size:11px;font-weight:600;min-width:50px;text-align:right;">%' + v.toFixed(1) + '</span></div>';
          let n = '<h2>Yonetici Notlari</h2>';
          for (const nt of notlar) n += '<div class="note n' + (nt.tip === "iyi" ? "g" : nt.tip === "orta" ? "y" : "r") + '">' + (nt.tip === "iyi" ? "+" : nt.tip === "orta" ? "~" : "!") + ' ' + nt.mesaj + '</div>';
          downloadHTML(buildHTMLReport('Dashboard - ' + d1, t, n), 'Dashboard_' + d1.replace(/\s/g, '_') + '.html');
        };

        const Gauge = ({ value, max, label, color, format }) => {
          const pctVal = Math.max(0, Math.min(100, (value / max) * 100));
          const r = 40, cx = 50, cy = 52;
          const startAngle = -210 * (Math.PI / 180);
          const endAngle = 30 * (Math.PI / 180);
          const totalAngle = endAngle - startAngle;
          const valAngle = startAngle + totalAngle * (pctVal / 100);
          const arc = (a1, a2) => { const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1), x2 = cx + r * Math.cos(a2), y2 = cy + r * Math.sin(a2); const large = (a2 - a1) > Math.PI ? 1 : 0; return "M " + x1 + " " + y1 + " A " + r + " " + r + " 0 " + large + " 1 " + x2 + " " + y2; };
          return (<div style={{ textAlign: "center" }}>
            <svg width="100" height="72" viewBox="0 0 100 72">
              <path d={arc(startAngle, endAngle)} fill="none" stroke="var(--color-background-tertiary)" strokeWidth="8" strokeLinecap="round" />
              <path d={arc(startAngle, valAngle)} fill="none" stroke={color} strokeWidth="8" strokeLinecap="round" style={{ transition: "d 0.6s" }} />
              <text x="50" y="50" textAnchor="middle" fontSize="15" fontWeight="700" fill="var(--color-text-primary)">{format}</text>
            </svg>
            <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: -2 }}>{label}</div>
          </div>);
        };

        const MiniDonut = ({ items, size }) => {
          const sz = size || 80; const r = 30; const cx = sz / 2; const cy = sz / 2;
          let cumAngle = -90;
          const total = items.reduce((s, [, v]) => s + Math.max(0, v), 0);
          return (<svg width={sz} height={sz} viewBox={"0 0 " + sz + " " + sz}>
            {items.map(([label, val, color], i) => {
              const v = Math.max(0, val);
              const angle = total > 0 ? (v / total) * 360 : 0;
              const startRad = (cumAngle * Math.PI) / 180;
              const endRad = ((cumAngle + angle) * Math.PI) / 180;
              cumAngle += angle;
              const x1 = cx + r * Math.cos(startRad), y1 = cy + r * Math.sin(startRad);
              const x2 = cx + r * Math.cos(endRad), y2 = cy + r * Math.sin(endRad);
              if (angle < 0.5) return null;
              return <path key={i} d={`M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${angle > 180 ? 1 : 0} 1 ${x2} ${y2} Z`} fill={color} />;
            })}
            <circle cx={cx} cy={cy} r={16} fill="var(--color-background-primary)" />
          </svg>);
        };

        return (<div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.25rem" }}>
            <div><div style={{ fontSize: 20, fontWeight: 600 }}>Yonetici Dashboard</div><div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>{d1}{hasK ? " / " + d2 : ""}</div></div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={doExportCSV} style={DL_STYLE}>CSV</button>
              <button onClick={doExportHTML} style={{ ...DL_STYLE, background: "var(--color-background-success)", color: "var(--color-text-success)", border: "0.5px solid var(--color-border-success)" }}>PDF</button>
            </div>
          </div>

          {/* Durum Kartlari */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: "1.5rem" }}>
            {durum.map(([label, sk, val, sub, desc]) => (
              <div key={label} style={{ padding: "18px 16px", borderRadius: 16, background: "linear-gradient(135deg, " + skorBg(sk) + " 0%, var(--color-background-primary) 100%)", border: "0.5px solid var(--color-border-tertiary)", position: "relative", overflow: "hidden" }}>
                <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 2, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
                <div style={{ fontSize: 26, fontWeight: 700, color: skorRenk(sk), marginBottom: 4 }}>{val}</div>
                <div style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>{desc}</div>
                <div style={{ marginTop: 8 }}><span style={{ fontSize: 10, padding: "2px 10px", borderRadius: 99, background: skorBg(sk), color: skorRenk(sk), fontWeight: 600 }}>{skorLabel(sk)}</span></div>
              </div>))}
          </div>

          {/* Temel Gostergeler */}
          <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 10 }}>Temel gostergeler</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: "1.5rem" }}>
            {metrikler.map(([l, v1, v2, clr], i) => { const dg2 = hasK && v2 != null ? degFn(v1, v2) : null; return (
              <div key={i} style={{ padding: "16px 18px", borderRadius: 14, background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", position: "relative", overflow: "hidden" }}>
                <div style={{ position: "absolute", top: 0, left: 0, width: "100%", height: 3, background: clr }} />
                <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 8 }}>{l}</div>
                <div style={{ fontSize: 22, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{formatN(v1)}</div>
                {dg2 != null && <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 6 }}><Badge val={dg2} /><span style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>onceki donem</span></div>}
              </div>); })}
          </div>

          {/* Karlilik & Bilanco Yapisi */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: "1.5rem" }}>
            <div style={{ padding: 18, borderRadius: 14, background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)" }}>
              <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 12 }}>Karlilik kademeleri</div>
              <div style={{ display: "flex", justifyContent: "space-around", marginBottom: 12 }}>
                <Gauge value={a.bkm} max={100} label="Brut" color="#5DCAA5" format={"%" + a.bkm.toFixed(0)} />
                <Gauge value={a.fkm} max={100} label="Faaliyet" color="#85B7EB" format={"%" + a.fkm.toFixed(0)} />
                <Gauge value={Math.max(0, a.nkm)} max={100} label="Net" color="#AFA9EC" format={"%" + a.nkm.toFixed(0)} />
              </div>
              {[["Brut kar marji", a.bkm, "#5DCAA5"], ["Faaliyet kar marji", a.fkm, "#85B7EB"], ["Net kar marji", a.nkm, "#AFA9EC"]].map(([l, v, c]) => (
                <div key={l} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                  <span style={{ fontSize: 11, color: "var(--color-text-secondary)", minWidth: 100 }}>{l}</span>
                  <div style={{ flex: 1, height: 10, borderRadius: 99, background: "var(--color-background-secondary)", overflow: "hidden" }}><div style={{ width: Math.max(0, Math.min(100, v)) + "%", height: "100%", background: c, borderRadius: 99 }} /></div>
                  <span style={{ fontSize: 12, fontWeight: 600, minWidth: 45, textAlign: "right", color: v >= 0 ? c : "#A32D2D" }}>%{v.toFixed(1)}</span>
                </div>))}
            </div>
            <div style={{ padding: 18, borderRadius: 14, background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)" }}>
              <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 12 }}>Bilanco yapisi</div>
              <div style={{ display: "flex", justifyContent: "space-around", marginBottom: 12 }}>
                <div style={{ textAlign: "center" }}><MiniDonut items={[["Donen", b.donen, "#85B7EB"], ["Duran", b.duran, "#AFA9EC"]]} /><div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 4 }}>Varliklar</div></div>
                <div style={{ textAlign: "center" }}><MiniDonut items={[["KVYK", b.kvyk, "#F09595"], ["UVYK", b.uvyk, "#FAC775"], ["Ozk", b.ozk, "#9FE1CB"]]} /><div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 4 }}>Kaynaklar</div></div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, fontSize: 11 }}>
                {[["Donen", pct(b.donen, b.aktif), "#85B7EB"], ["Duran", pct(b.duran, b.aktif), "#AFA9EC"]].map(([l, p, c]) => (<div key={l} style={{ display: "flex", alignItems: "center", gap: 4 }}><span style={{ width: 8, height: 8, borderRadius: 2, background: c }} /><span style={{ color: "var(--color-text-secondary)" }}>{l}: %{p.toFixed(0)}</span></div>))}
                {[["KVYK", pct(b.kvyk, b.pasif), "#F09595"], ["UVYK", pct(b.uvyk, b.pasif), "#FAC775"], ["Ozk", pct(b.ozk, b.pasif), "#9FE1CB"]].map(([l, p, c]) => (<div key={l} style={{ display: "flex", alignItems: "center", gap: 4 }}><span style={{ width: 8, height: 8, borderRadius: 2, background: c }} /><span style={{ color: "var(--color-text-secondary)" }}>{l}: %{p.toFixed(0)}</span></div>))}
              </div>
            </div>
          </div>

          {/* Oranlar Grid */}
          <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 10 }}>Finansal oranlar</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginBottom: "1.5rem" }}>
            {[["Cari Oran", a.co.toFixed(2), ">1.5", skor(a.co, 1.5, 1)], ["Asit-Test", a.at.toFixed(2), ">1.0", skor(a.at, 1, 0.7)], ["Nakit Orani", a.no.toFixed(2), ">0.2", skor(a.no, 0.2, 0.1)], ["B/O Orani", a.bo.toFixed(2), "<1.0", a.bo <= 1 ? "iyi" : a.bo <= 2 ? "orta" : "kotu"], ["ROE", "%" + a.roe.toFixed(1), ">%15", skor(a.roe, 15, 5)], ["ROA", "%" + a.roa.toFixed(1), ">%5", skor(a.roa, 5, 2)]].map(([l, v, std, sk]) => (
              <div key={l} style={{ padding: 14, borderRadius: 12, background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}><span style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>{l}</span><span style={{ width: 8, height: 8, borderRadius: "50%", background: skorRenk(sk) }} /></div>
                <div style={{ fontSize: 20, fontWeight: 600, color: skorRenk(sk) }}>{v}</div>
                <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 2 }}>standart: {std}</div>
              </div>))}
          </div>

          {/* Notlar */}
          <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 10 }}>Yonetici notlari</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: "1.5rem" }}>
            {notlar.map((n, i) => (<div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "12px 16px", background: skorBg(n.tip), borderRadius: 10, borderLeft: "3px solid " + skorRenk(n.tip) }}><span style={{ fontWeight: 600, flexShrink: 0, color: skorRenk(n.tip) }}>{n.tip === "iyi" ? "+" : n.tip === "orta" ? "~" : "!"}</span><span style={{ fontSize: 13, lineHeight: 1.6 }}>{n.mesaj}</span></div>))}
          </div>

          {/* Donemler Arasi — Coklu donem destekli */}
          {karsiList.length > 0 && (() => {
            const allIdx = [sel, ...karsiList];
            const allDonem = allIdx.map((i) => mizanlar[i]?.donem || "?");
            const allG = allIdx.map((i) => gelirler[i]);
            const allB = allIdx.map((i) => bilancolar[i]);
            const rows = [
              ["Net Satis", allG.map((gx) => gx?.netSatis || 0)],
              ["Donem Kari", allG.map((gx) => gx?.donemKari || 0)],
              ["Brut Kar", allG.map((gx) => gx?.brutKar || 0)],
              ["Aktif Toplam", allB.map((bx) => bx?.aktif || 0)],
              ["Ozkaynaklar", allB.map((bx) => bx?.ozk || 0)],
              ["Toplam Borc", allB.map((bx) => (bx?.kvyk || 0) + (bx?.uvyk || 0))],
            ];
            const colW = allDonem.length <= 4 ? "1fr" : "minmax(80px,1fr)";
            return (<div>
              <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 10 }}>Donemler arasi karsilastirma ({allDonem.length} donem)</div>
              <div style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: 14, overflow: "hidden", overflowX: "auto" }}>
                <div style={{ display: "grid", gridTemplateColumns: "1.5fr " + allDonem.map(() => colW).join(" "), padding: "10px 14px", background: "var(--color-background-secondary)", fontWeight: 500, fontSize: 11, color: "var(--color-text-secondary)", minWidth: allDonem.length > 5 ? allDonem.length * 110 + 150 : "auto" }}>
                  <span>Gosterge</span>
                  {allDonem.map((dn, di) => <span key={di} style={{ textAlign: "right", fontWeight: di === 0 ? 600 : 400, color: di === 0 ? "var(--color-text-info)" : "var(--color-text-secondary)" }}>{dn.substring(0, 12)}</span>)}
                </div>
                {rows.map(([label, vals]) => (
                  <div key={label} style={{ display: "grid", gridTemplateColumns: "1.5fr " + allDonem.map(() => colW).join(" "), padding: "8px 14px", borderBottom: "0.5px solid var(--color-border-tertiary)", fontSize: 13, minWidth: allDonem.length > 5 ? allDonem.length * 110 + 150 : "auto" }}>
                    <span style={{ fontWeight: 500, whiteSpace: "nowrap" }}>{label}</span>
                    {vals.map((v, vi) => <span key={vi} style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: vi === 0 ? 600 : 400, color: vi === 0 ? "var(--color-text-primary)" : "var(--color-text-secondary)" }}>{formatN(v)}</span>)}
                  </div>
                ))}
              </div>
            </div>);
          })()}
        </div>);
      })()}

      {/* TAB 6: Rapor with comparison */}
      {tab === 6 && rapor && (<div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", ...SEC }}>
          <span>Degerlendirme ve oneriler{hasK ? " — Karsilastirma" : ""}</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => exportFullHTML(g, gK, b, bK, a, rapor, d1, d2)} style={DL_STYLE}>Tam Rapor HTML</button>
            <button onClick={() => { exportGelirCSV(g, gK, d1, d2); setTimeout(() => exportBilancoCSV(b, bK, g, d1, d2), 300); }} style={{ ...DL_STYLE, background: "var(--color-background-success)", color: "var(--color-text-success)", border: "0.5px solid var(--color-border-success)" }}>Tum CSV</button>
          </div></div>
        {hasK && (<div style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-lg)", overflow: "hidden", marginBottom: "1.5rem" }}>
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr", padding: "8px 12px", background: "var(--color-background-secondary)", fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)" }}><span>Gosterge</span><span style={{ textAlign: "right" }}>{d1}</span><span style={{ textAlign: "right" }}>{d2}</span><span style={{ textAlign: "right" }}>Degisim</span></div>
          {[["Net satis", g.netSatis, gK.netSatis], ["Brut kar", g.brutKar, gK.brutKar], ["Faaliyet kari", g.faalKar, gK.faalKar], ["Net kar", g.donemKari, gK.donemKari]].map(([l, v1, v2]) => (<div key={l} style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr", padding: "8px 12px", borderBottom: "0.5px solid var(--color-border-tertiary)", fontSize: 13 }}><span>{l}</span><span style={{ textAlign: "right" }}>{formatN(v1)}</span><span style={{ textAlign: "right" }}>{formatN(v2)}</span><span style={{ textAlign: "right" }}><Badge val={degFn(v1, v2)} /></span></div>))}
        </div>)}
        {[["Guclu yonler", rapor.ar, "#0F6E56", "+"], ["Zayif yonler", rapor.ek, "#A32D2D", "!"], ["Oneriler", rapor.on, "#185FA5", ">"]].map(([title, items, color, icon]) => (
          <div key={title}><div style={SEC}>{title}</div><div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{items.map((it, i) => (<div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "10px 14px", background: "var(--color-background-secondary)", borderRadius: "var(--border-radius-md)", borderLeft: "3px solid " + color }}><span style={{ fontWeight: 500, flexShrink: 0 }}>{icon}</span><span style={{ fontSize: 14, lineHeight: 1.6 }}>{it}</span></div>))}</div></div>))}
      </div>)}

      {/* TAB 7: Vergi */}
      {tab === 7 && g && (() => {
        const donemKari = g.donemKari;
        const r = mizanlar[sel].rows;
        const kkeg689 = (() => { const e = r.find((x) => x.kod === "689"); return e ? e.bBak - e.aBak : 0; })();
        const smmVal = parseFloat(String(vergiSMM).replace(/\./g, "").replace(",", ".")) || 0;
        const matrah = donemKari - smmVal + kkeg689;
        const oranVal = parseFloat(String(vergiOran).replace(",", ".")) || 25;
        const hesaplananVergi = matrah * (oranVal / 100);
        const odenenVal = parseFloat(String(vergiOdenen).replace(/\./g, "").replace(",", ".")) || 0;
        const odenmesiGereken = hesaplananVergi - odenenVal;

        // Auto-format: 1234567 -> 1.234.567
        const formatInput = (raw) => {
          const clean = raw.replace(/[^0-9,]/g, "");
          const parts = clean.split(",");
          const intPart = parts[0].replace(/^0+(?=\d)/, "");
          const formatted = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
          return parts.length > 1 ? formatted + "," + parts[1] : formatted;
        };

        const handleSMM = (e) => setVergiSMM(formatInput(e.target.value));
        const handleOdenen = (e) => setVergiOdenen(formatInput(e.target.value));

        const doExportCSV = () => {
          const fn = (n) => formatN(n);
          const rows = [["VERGI HESAPLAMA - " + d1], [],
            ["Kalem", "Tutar"],
            ["Donem Kari/Zarari", fn(donemKari)],
            ["Satilan Mal Maliyeti (Manuel)", fn(smmVal)],
            ["KKEG (689)", fn(kkeg689)],
            ["Matrah (1 - 2 + 3)", fn(matrah)],
            ["Vergi Orani", "%" + oranVal],
            ["Hesaplanan Vergi", fn(hesaplananVergi)],
            ["Odenen (Manuel)", fn(odenenVal)],
            ["Odenmesi Gereken Vergi", fn(odenmesiGereken)],
          ];
          downloadCSV(buildCSV(rows), "Vergi_" + d1.replace(/\s/g, "_") + ".csv");
        };
        const doExportHTML = () => {
          const fn = (n) => formatN(n);
          const clr = (v) => v >= 0 ? "#0F6E56" : "#A32D2D";
          let t = '<h2>Vergi Hesaplama</h2>';
          t += '<table><tr><th style="width:60%">Kalem</th><th class="r">Tutar</th></tr>';
          t += '<tr class="b"><td>1. Donem Kari / Zarari</td><td class="r">' + fn(donemKari) + '</td></tr>';
          t += '<tr><td>2. Satilan Mal Maliyeti</td><td class="r">' + fn(smmVal) + '</td></tr>';
          t += '<tr><td>3. KKEG (689 Hesap)</td><td class="r">' + fn(kkeg689) + '</td></tr>';
          t += '<tr class="b hl"><td>4. Matrah (1 - 2 + 3)</td><td class="r">' + fn(matrah) + '</td></tr>';
          t += '<tr class="b"><td>5. Hesaplanan Vergi (Matrah x %' + oranVal + ')</td><td class="r" style="color:' + clr(-hesaplananVergi) + '">' + fn(hesaplananVergi) + '</td></tr>';
          t += '<tr><td>6. Odenen Vergi</td><td class="r">' + fn(odenenVal) + '</td></tr>';
          t += '<tr class="b hl"><td>7. Odenmesi Gereken Vergi (5 - 6)</td><td class="r" style="color:' + clr(-odenmesiGereken) + '">' + fn(odenmesiGereken) + '</td></tr>';
          t += '</table>';
          downloadHTML(buildHTMLReport('Vergi Hesaplama - ' + d1, t, ''), 'Vergi_' + d1.replace(/\s/g, '_') + '.html');
        };

        const manuelInputStyle = { padding: "10px 14px", fontSize: 15, fontWeight: 500, border: "2px solid #185FA5", borderRadius: "var(--border-radius-md)", background: "#E6F1FB", color: "#185FA5", textAlign: "right", width: 200, fontVariantNumeric: "tabular-nums", outline: "none" };
        const oranInputStyle = { width: 48, padding: "6px 4px", fontSize: 15, fontWeight: 600, border: "2px solid #185FA5", borderRadius: "var(--border-radius-md)", background: "#E6F1FB", color: "#185FA5", textAlign: "center", outline: "none" };
        const labelStyle = { fontSize: 14, color: "var(--color-text-primary)" };
        const autoStyle = { fontSize: 14, fontWeight: 500, fontVariantNumeric: "tabular-nums", textAlign: "right", minWidth: 180 };
        const rowStyle = (hl, isManuel) => ({ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", borderBottom: "0.5px solid var(--color-border-tertiary)", background: isManuel ? "rgba(24,95,165,0.04)" : hl ? "var(--color-background-secondary)" : "transparent" });
        const manuelBadge = <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 99, background: "#E6F1FB", color: "#185FA5", fontWeight: 500, marginLeft: 6 }}>GIRIS</span>;

        return (<div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", ...SEC }}>
            <span>Vergi hesaplama — {d1}</span>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={doExportCSV} style={DL_STYLE}>CSV Indir</button>
              <button onClick={doExportHTML} style={{ ...DL_STYLE, background: "var(--color-background-success)", color: "var(--color-text-success)", border: "0.5px solid var(--color-border-success)" }}>PDF (HTML)</button>
            </div>
          </div>

          <div style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-lg)", overflow: "hidden" }}>
            {/* 1. Donem Kari */}
            <div style={rowStyle(false, false)}>
              <div><span style={{ fontSize: 12, color: "var(--color-text-tertiary)", marginRight: 6 }}>1</span><span style={labelStyle}>Donem kari / zarari</span></div>
              <span style={{ ...autoStyle, color: donemKari >= 0 ? "var(--color-text-success)" : "var(--color-text-danger)" }}>{formatN(donemKari)}</span>
            </div>

            {/* 2. SMM - MANUEL */}
            <div style={rowStyle(false, true)}>
              <div style={{ display: "flex", alignItems: "center" }}><span style={{ fontSize: 12, color: "var(--color-text-tertiary)", marginRight: 6 }}>2</span><span style={labelStyle}>Satilan mal maliyeti</span>{manuelBadge}</div>
              <input type="text" value={vergiSMM} onChange={handleSMM} placeholder="0" style={manuelInputStyle} />
            </div>

            {/* 3. KKEG 689 */}
            <div style={rowStyle(false, false)}>
              <div><span style={{ fontSize: 12, color: "var(--color-text-tertiary)", marginRight: 6 }}>3</span><span style={labelStyle}>KKEG (689 hesap)</span></div>
              <span style={autoStyle}>{formatN(kkeg689)}</span>
            </div>

            {/* 4. Matrah */}
            <div style={rowStyle(true, false)}>
              <div><span style={{ fontSize: 12, color: "var(--color-text-tertiary)", marginRight: 6 }}>4</span><span style={{ ...labelStyle, fontWeight: 600 }}>Matrah</span><span style={{ fontSize: 11, color: "var(--color-text-tertiary)", marginLeft: 6 }}>(1 - 2 + 3)</span></div>
              <span style={{ ...autoStyle, fontSize: 18, color: "var(--color-text-primary)" }}>{formatN(matrah)}</span>
            </div>

            {/* 5. Hesaplanan Vergi - ORAN MANUEL */}
            <div style={rowStyle(false, true)}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>5</span>
                <span style={labelStyle}>Hesaplanan vergi</span>
                <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
                  <span style={{ fontSize: 13, color: "#185FA5", fontWeight: 600 }}>%</span>
                  <input type="text" value={vergiOran} onChange={(e) => setVergiOran(e.target.value.replace(/[^0-9.,]/g, ""))} style={oranInputStyle} />
                </div>
                {manuelBadge}
              </div>
              <span style={{ ...autoStyle, color: "var(--color-text-danger)", fontSize: 16 }}>{formatN(hesaplananVergi)}</span>
            </div>

            {/* 6. Odenen - MANUEL */}
            <div style={rowStyle(false, true)}>
              <div style={{ display: "flex", alignItems: "center" }}><span style={{ fontSize: 12, color: "var(--color-text-tertiary)", marginRight: 6 }}>6</span><span style={labelStyle}>Odenen</span>{manuelBadge}</div>
              <input type="text" value={vergiOdenen} onChange={handleOdenen} placeholder="0" style={manuelInputStyle} />
            </div>

            {/* 7. Odenmesi Gereken */}
            <div style={{ ...rowStyle(true, false), borderBottom: "none" }}>
              <div><span style={{ fontSize: 12, color: "var(--color-text-tertiary)", marginRight: 6 }}>7</span><span style={{ ...labelStyle, fontWeight: 600 }}>Odenmesi gereken vergi</span><span style={{ fontSize: 11, color: "var(--color-text-tertiary)", marginLeft: 6 }}>(5 - 6)</span></div>
              <span style={{ ...autoStyle, fontSize: 22, color: odenmesiGereken > 0 ? "var(--color-text-danger)" : "var(--color-text-success)" }}>{formatN(odenmesiGereken)}</span>
            </div>
          </div>

          <div style={{ marginTop: 16, padding: "12px 16px", background: "var(--color-background-secondary)", borderRadius: "var(--border-radius-md)", fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.7 }}>
            <span style={{ display: "inline-block", fontSize: 10, padding: "2px 8px", borderRadius: 99, background: "#E6F1FB", color: "#185FA5", fontWeight: 500, marginRight: 6 }}>GIRIS</span> isaretli alanlar manuel duzenlenir. Diger degerler mizandan otomatik gelir.
          </div>

          {/* Stok Takip - Bilgi Amacli */}
          {(() => {
            const stokRows = mizanlar[sel].rows.filter((x) => x.kod.startsWith("15") && x.kod.length === 3 && x.kod !== "15");
            const stok15 = mizanlar[sel].rows.find((x) => x.kod === "15");
            const toplamStok = stok15 ? stok15.bBak - stok15.aBak : stokRows.reduce((s, x) => s + (x.bBak - x.aBak), 0);
            const kalanStok = toplamStok - smmVal;

            return (
              <div style={{ marginTop: "2rem" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 16, fontWeight: 500, color: "var(--color-text-primary)", marginBottom: 12, paddingBottom: 6, borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
                  <span>Stok takibi</span>
                  <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 99, background: "var(--color-background-secondary)", color: "var(--color-text-tertiary)", fontWeight: 500 }}>BILGI AMACLI</span>
                </div>

                <div style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: 14, overflow: "hidden" }}>
                  {/* Stok kalemleri */}
                  <div style={{ padding: "10px 14px", background: "var(--color-background-info)", color: "var(--color-text-info)", fontWeight: 500, fontSize: 13 }}>Mizandaki stoklar (15 hesap grubu)</div>
                  {stokRows.map((sr) => {
                    const net = sr.bBak - sr.aBak;
                    if (net === 0) return null;
                    return (
                      <div key={sr.kod} style={{ display: "flex", justifyContent: "space-between", padding: "8px 14px", borderBottom: "0.5px solid var(--color-border-tertiary)", fontSize: 13 }}>
                        <span style={{ color: "var(--color-text-secondary)" }}><span style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>{sr.kod}</span> {sr.ad}</span>
                        <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 500 }}>{formatN(net)}</span>
                      </div>
                    );
                  })}
                  <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 14px", background: "var(--color-background-secondary)", fontWeight: 600, fontSize: 14, borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
                    <span>Toplam stok</span>
                    <span style={{ fontVariantNumeric: "tabular-nums" }}>{formatN(toplamStok)}</span>
                  </div>

                  {/* SMM ve Kalan */}
                  <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 14px", borderBottom: "0.5px solid var(--color-border-tertiary)", fontSize: 14 }}>
                    <span>(-) Satilan mal maliyeti (yukarida girilen)</span>
                    <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 500, color: "#A32D2D" }}>{smmVal > 0 ? "-" : ""}{formatN(smmVal)}</span>
                  </div>

                  <div style={{ display: "flex", justifyContent: "space-between", padding: "12px 14px", background: kalanStok >= 0 ? "#E1F5EE" : "#FCEBEB", fontSize: 15, fontWeight: 700 }}>
                    <span>Kalan stok</span>
                    <span style={{ fontVariantNumeric: "tabular-nums", color: kalanStok >= 0 ? "#0F6E56" : "#A32D2D" }}>{formatN(kalanStok)}</span>
                  </div>
                </div>

                {kalanStok < 0 && (
                  <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "flex-start", padding: "10px 14px", background: "#FCEBEB", borderRadius: "var(--border-radius-md)", borderLeft: "3px solid #A32D2D" }}>
                    <span style={{ fontWeight: 600, color: "#A32D2D" }}>!</span>
                    <span style={{ fontSize: 12, color: "#A32D2D" }}>Girdiginiz satilan mal maliyeti ({formatN(smmVal)}) mizandaki toplam stoktan ({formatN(toplamStok)}) fazla. Donem ici alis yapilmis olabilir veya SMM tutarini kontrol edin.</span>
                  </div>
                )}
              </div>
            );
          })()}
        </div>);
      })()}

      {/* TAB 8: Sektor Karsilastirmasi */}
      {tab === 8 && a && (() => {
        const sk = SEKTORLER[sektor];
        if (!sk) return null;

        const karsi2 = (label, val, range, unit, reverse) => {
          const [low, high] = range;
          const mid = (low + high) / 2;
          let durum, durumLabel, durumBg, durumClr;
          if (reverse) {
            if (val <= low) { durum = "iyi"; durumLabel = "SEKTOR USTUNDE"; durumBg = "#E1F5EE"; durumClr = "#0F6E56"; }
            else if (val <= high) { durum = "orta"; durumLabel = "SEKTOR ORTALAMASI"; durumBg = "#FAEEDA"; durumClr = "#BA7517"; }
            else { durum = "kotu"; durumLabel = "SEKTOR ALTINDA"; durumBg = "#FCEBEB"; durumClr = "#A32D2D"; }
          } else {
            if (val >= high) { durum = "iyi"; durumLabel = "SEKTOR USTUNDE"; durumBg = "#E1F5EE"; durumClr = "#0F6E56"; }
            else if (val >= low) { durum = "orta"; durumLabel = "SEKTOR ORTALAMASI"; durumBg = "#FAEEDA"; durumClr = "#BA7517"; }
            else { durum = "kotu"; durumLabel = "SEKTOR ALTINDA"; durumBg = "#FCEBEB"; durumClr = "#A32D2D"; }
          }
          const fmtV = unit === "%" ? "%" + val.toFixed(1) : unit === "gun" ? Math.round(val) + " gun" : val.toFixed(2);
          const fmtR = unit === "%" ? "%" + low + " - %" + high : unit === "gun" ? low + " - " + high + " gun" : low.toFixed(1) + " - " + high.toFixed(1);
          const barMin = Math.min(low, val) * 0.8;
          const barMax = Math.max(high, val) * 1.2 || 1;
          const barRange = barMax - barMin;
          const barLowPct = ((low - barMin) / barRange) * 100;
          const barHighPct = ((high - barMin) / barRange) * 100;
          const barValPct = Math.max(0, Math.min(100, ((val - barMin) / barRange) * 100));

          return { label, val, fmtV, fmtR, durum, durumLabel, durumBg, durumClr, barLowPct, barHighPct, barValPct };
        };

        const items = [
          karsi2("Cari Oran", a.co, sk.cariOran, "x", false),
          karsi2("Asit-Test", a.at, sk.asitTest, "x", false),
          karsi2("Nakit Orani", a.no, sk.nakitOrani, "x", false),
          karsi2("Borc/Ozkaynak", a.bo, sk.borcOzkaynak, "x", true),
          karsi2("Brut Kar Marji", a.bkm, sk.brutKarMarji, "%", false),
          karsi2("Net Kar Marji", a.nkm, sk.netKarMarji, "%", false),
          karsi2("Faaliyet Kar Marji", a.fkm, sk.faalKarMarji, "%", false),
          karsi2("ROE", a.roe, sk.roe, "%", false),
          karsi2("ROA", a.roa, sk.roa, "%", false),
          karsi2("Alacak Tahsil Suresi", a.ag, sk.alacakGun, "gun", true),
          karsi2("Stok Devir Suresi", a.sg, sk.stokGun, "gun", true),
        ];

        const ustunde = items.filter((i) => i.durum === "iyi").length;
        const ortalama = items.filter((i) => i.durum === "orta").length;
        const altinda = items.filter((i) => i.durum === "kotu").length;

        const doExportCSV = () => {
          const rows = [["SEKTOR KARSILASTIRMASI - " + sk.ad], ["Donem: " + d1], [],
            ["Oran", "Firma Degeri", "Sektor Araligi", "Durum"]];
          for (const i of items) rows.push([i.label, i.fmtV, i.fmtR, i.durumLabel]);
          rows.push([]); rows.push(["Ozet"]); rows.push(["Sektor ustunde", ustunde]); rows.push(["Sektor ortalamasi", ortalama]); rows.push(["Sektor altinda", altinda]);
          downloadCSV(buildCSV(rows), "Sektor_" + d1.replace(/\s/g, "_") + ".csv");
        };

        const doExportHTML = () => {
          let t = '<h2>Sektor Karsilastirmasi: ' + sk.ad + '</h2>';
          t += '<div style="display:flex;gap:12px;margin-bottom:16px;">';
          t += '<div style="padding:8px 16px;background:#E1F5EE;border-radius:8px;"><span style="font-weight:600;color:#0F6E56;">' + ustunde + '</span> <span style="font-size:11px;color:#0F6E56;">sektor ustunde</span></div>';
          t += '<div style="padding:8px 16px;background:#FAEEDA;border-radius:8px;"><span style="font-weight:600;color:#BA7517;">' + ortalama + '</span> <span style="font-size:11px;color:#BA7517;">ortalamada</span></div>';
          t += '<div style="padding:8px 16px;background:#FCEBEB;border-radius:8px;"><span style="font-weight:600;color:#A32D2D;">' + altinda + '</span> <span style="font-size:11px;color:#A32D2D;">sektor altinda</span></div>';
          t += '</div>';
          t += '<table><tr><th>Oran</th><th class="r">Firma</th><th class="r">Sektor Araligi</th><th>Durum</th></tr>';
          for (const i of items) {
            t += '<tr><td>' + i.label + '</td><td class="r b">' + i.fmtV + '</td><td class="r">' + i.fmtR + '</td><td style="color:' + i.durumClr + ';font-weight:600;">' + i.durumLabel + '</td></tr>';
          }
          t += '</table>';
          // Add recommendations to HTML
          const altItems = items.filter((i) => i.durum === "kotu");
          if (altItems.length > 0) {
            t += '<h2>Sektor Ortalamasini Yakalamak Icin Oneriler</h2>';
            for (const ai of altItems) {
              t += '<div style="margin-bottom:12px;"><div style="background:#FCEBEB;padding:8px 12px;border-radius:4px 4px 0 0;font-weight:600;color:#A32D2D;font-size:12px;">! ' + ai.label + ' - Iyilestirme Gerekli</div>';
              t += '<div style="padding:8px 12px;border:1px solid #ddd;border-top:none;border-radius:0 0 4px 4px;font-size:11px;">';
              t += 'Firma degeri: ' + ai.fmtV + ' | Sektor araligi: ' + ai.fmtR;
              t += '</div></div>';
            }
          }
          downloadHTML(buildHTMLReport('Sektor Karsilastirmasi - ' + d1, t, ''), 'Sektor_' + d1.replace(/\s/g, '_') + '.html');
        };

        return (<div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", ...SEC }}>
            <span>Sektor karsilastirmasi</span>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={doExportCSV} style={DL_STYLE}>CSV Indir</button>
              <button onClick={doExportHTML} style={{ ...DL_STYLE, background: "var(--color-background-success)", color: "var(--color-text-success)", border: "0.5px solid var(--color-border-success)" }}>PDF (HTML)</button>
            </div>
          </div>

          {/* Sektor Secimi */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: "1.5rem", padding: "12px 16px", background: "var(--color-background-secondary)", borderRadius: "var(--border-radius-md)" }}>
            <span style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>Sektor:</span>
            <select value={sektor} onChange={(e) => setSektor(e.target.value)} style={{ fontSize: 14, padding: "6px 12px", borderRadius: "var(--border-radius-md)", border: "0.5px solid var(--color-border-secondary)", background: "var(--color-background-primary)", color: "var(--color-text-primary)" }}>
              {Object.entries(SEKTORLER).map(([k, v]) => (<option key={k} value={k}>{v.ad}</option>))}
            </select>
          </div>

          {/* Ozet Kartlari */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: "1.5rem" }}>
            <div style={{ padding: "16px", background: "#E1F5EE", borderRadius: "var(--border-radius-lg)", textAlign: "center" }}>
              <div style={{ fontSize: 28, fontWeight: 600, color: "#0F6E56" }}>{ustunde}</div>
              <div style={{ fontSize: 12, color: "#0F6E56" }}>Sektor ustunde</div>
            </div>
            <div style={{ padding: "16px", background: "#FAEEDA", borderRadius: "var(--border-radius-lg)", textAlign: "center" }}>
              <div style={{ fontSize: 28, fontWeight: 600, color: "#BA7517" }}>{ortalama}</div>
              <div style={{ fontSize: 12, color: "#BA7517" }}>Sektor ortalamasi</div>
            </div>
            <div style={{ padding: "16px", background: "#FCEBEB", borderRadius: "var(--border-radius-lg)", textAlign: "center" }}>
              <div style={{ fontSize: 28, fontWeight: 600, color: "#A32D2D" }}>{altinda}</div>
              <div style={{ fontSize: 12, color: "#A32D2D" }}>Sektor altinda</div>
            </div>
          </div>

          {/* Detayli Karsilastirma */}
          <div style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-lg)", overflow: "hidden" }}>
            <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1.2fr 0.5fr 1fr", padding: "8px 12px", background: "var(--color-background-secondary)", fontWeight: 500, fontSize: 12, color: "var(--color-text-secondary)" }}>
              <span>Oran</span><span style={{ textAlign: "right" }}>Firma</span><span style={{ textAlign: "center" }}>Pozisyon</span><span></span><span style={{ textAlign: "right" }}>Sektor</span>
            </div>
            {items.map((item) => (
              <div key={item.label} style={{ padding: "10px 12px", borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
                <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1.2fr 0.5fr 1fr", alignItems: "center", marginBottom: 6 }}>
                  <span style={{ fontSize: 13, fontWeight: 500 }}>{item.label}</span>
                  <span style={{ textAlign: "right", fontSize: 14, fontWeight: 600, color: item.durumClr }}>{item.fmtV}</span>
                  <span style={{ textAlign: "center" }}>
                    <span style={{ fontSize: 10, padding: "2px 10px", borderRadius: 99, background: item.durumBg, color: item.durumClr, fontWeight: 500 }}>{item.durumLabel}</span>
                  </span>
                  <span></span>
                  <span style={{ textAlign: "right", fontSize: 12, color: "var(--color-text-tertiary)" }}>{item.fmtR}</span>
                </div>
                {/* Visual bar */}
                <div style={{ position: "relative", height: 8, background: "var(--color-background-secondary)", borderRadius: 99, overflow: "visible" }}>
                  {/* Sektor range band */}
                  <div style={{ position: "absolute", left: item.barLowPct + "%", width: Math.max(1, item.barHighPct - item.barLowPct) + "%", height: "100%", background: "#FAEEDA", borderRadius: 99 }} />
                  {/* Firma position dot */}
                  <div style={{ position: "absolute", left: "calc(" + item.barValPct + "% - 5px)", top: -1, width: 10, height: 10, borderRadius: "50%", background: item.durumClr, border: "2px solid var(--color-background-primary)" }} />
                </div>
              </div>
            ))}
          </div>

          <div style={{ marginTop: 16, padding: "12px 16px", background: "var(--color-background-secondary)", borderRadius: "var(--border-radius-md)", fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.7 }}>
            Sektor ortalamalari genel piyasa verilerine dayanmaktadir. Sari band sektor araligini, renkli nokta firmanizin pozisyonunu gosterir.
          </div>

          {/* Aksiyon Onerileri */}
          {(() => {
            const oneriler = [];

            if (items.find((i) => i.label === "Cari Oran")?.durum === "kotu") {
              oneriler.push({ baslik: "Cari Oran - Sektor Altinda", tip: "kotu", maddeler: [
                "Kisa vadeli borclarinizi yapilandirin veya vade surelerini uzatin",
                "Stok fazlasini nakde cevirin — durgun stoklari eritmek icin kampanya duzeleyin",
                "Alacak tahsilatini hizlandirin — vade surelerini kisaltin",
                "Gereksiz kisa vadeli kredi kullanimi yerine uzun vadeli finansmani tercih edin",
                "Donen varlik kalitesini artirin — likit varliklara agirlik verin",
              ]});
            }
            if (items.find((i) => i.label === "Asit-Test")?.durum === "kotu") {
              oneriler.push({ baslik: "Asit-Test Orani - Sektor Altinda", tip: "kotu", maddeler: [
                "Stok bagimliliginizi azaltin — tam zamaninda (JIT) tedarik modeline gecmeyi degerlendirin",
                "Nakit ve nakit benzeri varliklari artirin",
                "Stok devir hizini yukseltmek icin urun cesitliliginizi gozden gecirin",
                "Yuksek stok maliyetli urunlerde siparis bazli uretim/tedarik yapin",
              ]});
            }
            if (items.find((i) => i.label === "Nakit Orani")?.durum === "kotu") {
              oneriler.push({ baslik: "Nakit Orani - Sektor Altinda", tip: "kotu", maddeler: [
                "Nakit rezervinizi artirin — minimum 1-2 aylik giderleri karsilayacak nakit bulundurun",
                "Tahsilat surelerini kisaltin ve pesinat oranlarini artirin",
                "Gereksiz stok ve yatirim harcamalarindan kacinin",
                "Nakit akis butcesi hazirlayarak aylyk nakit ihtiyacini onceden planlyin",
              ]});
            }
            if (items.find((i) => i.label === "Borc/Ozkaynak")?.durum === "kotu") {
              oneriler.push({ baslik: "Borcluluk - Sektor Ustunde (Yuksek Risk)", tip: "kotu", maddeler: [
                "Yeni borc almaktan kacinin — mevcut borclari yapilandirin",
                "Sermaye artirimi ile ozkaynaklari guclendirmeyi degerlendirin",
                "Karliliktan elde edilen fonlari borc odemesine yonlendirin",
                "Yuksek faizli kredileri dusuk faizli seceneklerle refinanse edin",
                "Varlik satisi ile borc azaltma stratejisi uygulyin",
              ]});
            }
            if (items.find((i) => i.label === "Brut Kar Marji")?.durum === "kotu") {
              oneriler.push({ baslik: "Brut Kar Marji - Sektor Altinda", tip: "kotu", maddeler: [
                "Tedarikci anlasmalarini yeniden muzakere edin — toplu alis indirimi isteyin",
                "Urun maliyetlerini kalem kalem analiz edip tasarruf alanlari belirleyin",
                "Dusuk marjli urunlerin payini azaltip yuksek marjli urunlere odaklanin",
                "Fiyatlandirma stratejinizi gozden gecirin — fiyat artisi yapilabilir mi degerlendirin",
                "Uretim verimliligini artirmak icin surec iyilestirmeleri yapin",
              ]});
            }
            if (items.find((i) => i.label === "Net Kar Marji")?.durum === "kotu") {
              oneriler.push({ baslik: "Net Kar Marji - Sektor Altinda", tip: "kotu", maddeler: [
                "Faaliyet giderlerini detayli inceleyin — gereksiz giderleri kesin",
                "Finansman giderlerini dusurmek icin kredi yapilandirmasi yapin",
                "Personel verimliligini artirin — is surecleri optimizasyonu",
                "Pazarlama harcamalarinin geri donusunu olcun — verimli kanallara odaklanin",
                "Kira, enerji gibi sabit giderlerde tasarruf imkanlari arayin",
              ]});
            }
            if (items.find((i) => i.label === "ROE")?.durum === "kotu") {
              oneriler.push({ baslik: "ROE (Ozkaynak Karliligi) - Sektor Altinda", tip: "kotu", maddeler: [
                "Net kar marjini iyilestirin (yukardaki onerilere bakin)",
                "Varlik devir hizini artirin — ayni varliklarla daha fazla satis yapin",
                "Finansal kaldiracin optimal seviyesini degerlendirin",
                "Atil varliklari elden cikarin — ozkaynak verimliligini artirin",
              ]});
            }
            if (items.find((i) => i.label === "ROA")?.durum === "kotu") {
              oneriler.push({ baslik: "ROA (Aktif Karliligi) - Sektor Altinda", tip: "kotu", maddeler: [
                "Kullanilmayan veya dusuk getirili varliklari satin veya kiralayin",
                "Varlik devir hizini artirin — stok ve alacak yonetimini iyilestirin",
                "Yeni yatirim kararlarinda getiri analizini mutlaka yapin",
                "Mevcut varliklarin kapasitesini tam kullanip kullanmadiginizi kontrol edin",
              ]});
            }
            if (items.find((i) => i.label === "Alacak Tahsil Suresi")?.durum === "kotu") {
              oneriler.push({ baslik: "Alacak Tahsil Suresi - Sektor Ustunde (Yavas)", tip: "kotu", maddeler: [
                "Musterilere verilen vade surelerini kisaltin",
                "Erken odeme indirimi sunarak hizli tahsilati tesvik edin",
                "Geciken alacaklar icin sistematik takip sureci olusturun",
                "Yeni musteriler icin kredi limiti ve vade politikasi belirleyin",
                "Buyuk tutarli satislarda pesinat veya teminat mektubu isteyin",
                "Alacak sigortasi ile risk azaltmayi degerlendirin",
              ]});
            }
            if (items.find((i) => i.label === "Stok Devir Suresi")?.durum === "kotu") {
              oneriler.push({ baslik: "Stok Devir Suresi - Sektor Ustunde (Yavas)", tip: "kotu", maddeler: [
                "ABC analizi yapin — dusuk devir hizli urunleri belirleyin",
                "Olu stoklari kampanya veya indirimle eritin",
                "Minimum-maksimum stok seviyeleri belirleyip otomatik siparis sistemi kurun",
                "Tedarikci teslimat surelerini kisaltarak daha az stok tutun",
                "Mevsimsel talep degisimlerine gore stok planlamasi yapin",
                "Siparis bazli uretim/tedarik modelini degerlendirin",
              ]});
            }

            // Iyi durumda olanlar icin de notlar
            const iyiNotlar = [];
            if (items.find((i) => i.label === "Cari Oran")?.durum === "iyi") iyiNotlar.push("Cari oraniniz sektor ortalamasinin ustunde — likidite guclu");
            if (items.find((i) => i.label === "Brut Kar Marji")?.durum === "iyi") iyiNotlar.push("Brut kar marjiniz sektor ustunde — fiyatlama gucu ve maliyet yonetimi basarili");
            if (items.find((i) => i.label === "Net Kar Marji")?.durum === "iyi") iyiNotlar.push("Net kar marjiniz sektor ustunde — operasyonel verimlilik yuksek");
            if (items.find((i) => i.label === "Borc/Ozkaynak")?.durum === "iyi") iyiNotlar.push("Borcluluk sektor ortalamasinin altinda — finansal risk dusuk");
            if (items.find((i) => i.label === "ROE")?.durum === "iyi") iyiNotlar.push("ROE sektor ustunde — ortaklara iyi getiri saglaniyor");

            if (oneriler.length === 0 && iyiNotlar.length === 0) return null;

            return (
              <div style={{ marginTop: "1.5rem" }}>
                {iyiNotlar.length > 0 && (
                  <div>
                    <div style={SEC}>Guclu yonleriniz</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: "1.5rem" }}>
                      {iyiNotlar.map((n, i) => (
                        <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", padding: "10px 14px", background: "#E1F5EE", borderRadius: "var(--border-radius-md)", borderLeft: "3px solid #0F6E56" }}>
                          <span style={{ fontWeight: 500, color: "#0F6E56", flexShrink: 0 }}>+</span>
                          <span style={{ fontSize: 13, color: "#0F6E56" }}>{n}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {oneriler.length > 0 && (
                  <div>
                    <div style={SEC}>Sektor ortalamasini yakalamak icin yapilmasi gerekenler</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                      {oneriler.map((o, oi) => (
                        <div key={oi} style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-lg)", overflow: "hidden" }}>
                          <div style={{ padding: "10px 14px", background: "#FCEBEB", borderBottom: "0.5px solid var(--color-border-tertiary)", display: "flex", alignItems: "center", gap: 8 }}>
                            <span style={{ fontSize: 12, fontWeight: 600, color: "#A32D2D" }}>!</span>
                            <span style={{ fontSize: 13, fontWeight: 500, color: "#A32D2D" }}>{o.baslik}</span>
                          </div>
                          <div style={{ padding: "12px 14px" }}>
                            {o.maddeler.map((m, mi) => (
                              <div key={mi} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "6px 0", borderBottom: mi < o.maddeler.length - 1 ? "0.5px solid var(--color-border-tertiary)" : "none" }}>
                                <span style={{ fontSize: 12, color: "var(--color-text-tertiary)", flexShrink: 0, marginTop: 1 }}>{mi + 1}.</span>
                                <span style={{ fontSize: 13, color: "var(--color-text-primary)", lineHeight: 1.6 }}>{m}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })()}
        </div>);
      })()}

      {/* TAB 9: Gider Analizi */}
      {tab === 9 && g && (() => {
        if (!hasK) return (<div style={{ textAlign: "center", padding: "3rem 1rem", color: "var(--color-text-secondary)" }}><div style={{ fontSize: 32, opacity: 0.25, marginBottom: 8 }}>?</div><div style={{ fontSize: 14 }}>Gider analizi icin karsilastirma donemi secmelisiniz.</div><div style={{ fontSize: 13, marginTop: 8 }}>Yukaridaki "Karsilastir" dropdown'undan onceki donemi secin.</div></div>);

        const rS = mizanlar[sel].rows;
        const rK = mizanlar[karsi].rows;

        // Find all leaf accounts in 7xx (no children)
        const all7S = rS.filter((r) => r.kod[0] === "7");
        const all7K = rK.filter((r) => r.kod[0] === "7");
        const allKods = new Set([...all7S.map((r) => r.kod), ...all7K.map((r) => r.kod)]);

        // Get 2-digit groups
        const groups2 = {};
        for (const r of all7S) {
          if (r.kod.length < 2) continue;
          const g2 = r.kod.substring(0, 2);
          if (g2.length === 2 && g2[0] === "7" && g2[1] >= "0" && g2[1] <= "9") {
            if (!groups2[g2]) groups2[g2] = { kod: g2, ad: "" };
          }
        }
        for (const r of all7K) {
          if (r.kod.length < 2) continue;
          const g2 = r.kod.substring(0, 2);
          if (g2.length === 2 && g2[0] === "7" && g2[1] >= "0" && g2[1] <= "9") {
            if (!groups2[g2]) groups2[g2] = { kod: g2, ad: "" };
          }
        }
        // Get names from 2-digit accounts
        for (const r of [...all7S, ...all7K]) {
          if (r.kod.length === 2 && r.kod[0] === "7" && groups2[r.kod]) groups2[r.kod].ad = r.ad;
        }

        // For each 2-digit group, find leaf accounts using COMBINED tree
        const getLeafKods = (prefix) => {
          // Merge all account codes from both periods
          const allMatching = new Set();
          for (const r of rS) { if (r.kod.startsWith(prefix) && r.kod !== prefix) allMatching.add(r.kod); }
          for (const r of rK) { if (r.kod.startsWith(prefix) && r.kod !== prefix) allMatching.add(r.kod); }
          const allKodsList = [...allMatching];
          // A leaf is one that has no children in the combined set
          return allKodsList.filter((k) => !allKodsList.some((k2) => k2.startsWith(k) && k2 !== k && k2.length > k.length));
        };

        const getVal = (rows, kod) => {
          const r = rows.find((x) => x.kod === kod);
          return r ? r.bBak - r.aBak : 0;
        };
        const getName = (kod) => {
          const r = rS.find((x) => x.kod === kod) || rK.find((x) => x.kod === kod);
          return r ? r.ad : kod;
        };

        // Build comparison data per group
        const groupData = [];
        let toplamS = 0, toplamK = 0;

        for (const g2 of Object.keys(groups2).sort()) {
          const leafKods = getLeafKods(g2);

          let grpTotalS = 0, grpTotalK = 0;
          const items = [];

          for (const kod of leafKods.sort()) {
            const vS = getVal(rS, kod);
            const vK = getVal(rK, kod);
            if (vS === 0 && vK === 0) continue;
            grpTotalS += vS;
            grpTotalK += vK;
            const fark = vS - vK;
            items.push({ kod, ad: getName(kod), vS, vK, fark, pct: vK !== 0 ? ((vS - vK) / Math.abs(vK) * 100) : (vS !== 0 ? 100 : 0) });
          }

          toplamS += grpTotalS;
          toplamK += grpTotalK;
          items.sort((a, b) => Math.abs(b.fark) - Math.abs(a.fark));

          if (items.length > 0) {
            groupData.push({
              kod: g2,
              ad: groups2[g2].ad || g2,
              totalS: grpTotalS,
              totalK: grpTotalK,
              fark: grpTotalS - grpTotalK,
              items,
            });
          }
        }

        // Top artis/azalis - add group info
        const allItems = groupData.flatMap((g3) => g3.items.map((item) => ({ ...item, grpAd: g3.ad })));
        const topArtis = [...allItems].filter((i) => i.fark > 0).sort((a, b) => b.fark - a.fark).slice(0, 10);
        const topAzalis = [...allItems].filter((i) => i.fark < 0).sort((a, b) => a.fark - b.fark).slice(0, 10);
        const yeniKalemler = allItems.filter((i) => i.vK === 0 && i.vS > 0);
        const kaybolan = allItems.filter((i) => i.vS === 0 && i.vK > 0);

        const doExportCSV = () => {
          const rows2 = [["GIDER ANALIZI - " + d1 + " / " + d2], []];
          rows2.push(["Hesap Kodu", "Hesap Adi", d1, d2, "Fark", "Degisim %"]);
          for (const grp of groupData) {
            rows2.push([grp.kod, grp.ad, formatN(grp.totalS), formatN(grp.totalK), formatN(grp.fark), grp.totalK !== 0 ? ((grp.fark / Math.abs(grp.totalK)) * 100).toFixed(1) + "%" : "-"]);
            for (const item of grp.items) {
              rows2.push(["  " + item.kod, item.ad, formatN(item.vS), formatN(item.vK), formatN(item.fark), item.pct.toFixed(1) + "%"]);
            }
          }
          rows2.push([]); rows2.push(["TOPLAM", "", formatN(toplamS), formatN(toplamK), formatN(toplamS - toplamK), toplamK !== 0 ? (((toplamS - toplamK) / Math.abs(toplamK)) * 100).toFixed(1) + "%" : "-"]);
          downloadCSV(buildCSV(rows2), "Gider_Analizi_" + d1.replace(/\s/g, "_") + ".csv");
        };

        const doExportHTML = () => {
          let t = '<h2>Gider Analizi</h2><p style="color:#666;font-size:11px;">' + d1 + ' / ' + d2 + '</p>';
          t += '<h3>En Cok Artan 10 Kalem</h3><table><tr><th>Hesap</th><th class="r">' + d1 + '</th><th class="r">' + d2 + '</th><th class="r">Fark</th><th class="r">%</th></tr>';
          for (const i of topArtis) t += '<tr><td>' + i.kod + ' ' + i.ad + '</td><td class="r">' + formatN(i.vS) + '</td><td class="r">' + formatN(i.vK) + '</td><td class="r rd">+' + formatN(i.fark) + '</td><td class="r rd">+' + i.pct.toFixed(1) + '%</td></tr>';
          t += '</table><h3>En Cok Azalan 10 Kalem</h3><table><tr><th>Hesap</th><th class="r">' + d1 + '</th><th class="r">' + d2 + '</th><th class="r">Fark</th><th class="r">%</th></tr>';
          for (const i of topAzalis) t += '<tr><td>' + i.kod + ' ' + i.ad + '</td><td class="r">' + formatN(i.vS) + '</td><td class="r">' + formatN(i.vK) + '</td><td class="r g">' + formatN(i.fark) + '</td><td class="r g">' + i.pct.toFixed(1) + '%</td></tr>';
          t += '</table>';
          downloadHTML(buildHTMLReport('Gider Analizi - ' + d1, t, ''), 'Gider_Analizi_' + d1.replace(/\s/g, '_') + '.html');
        };

        const toggleGroup = (kod) => setExpandedGider((p) => ({ ...p, [kod]: !p[kod] }));

        return (<div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.25rem" }}>
            <div><div style={{ fontSize: 20, fontWeight: 600 }}>Gider Analizi</div><div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>{d1} / {d2}</div></div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={doExportCSV} style={DL_STYLE}>CSV</button>
              <button onClick={doExportHTML} style={{ ...DL_STYLE, background: "var(--color-background-success)", color: "var(--color-text-success)", border: "0.5px solid var(--color-border-success)" }}>PDF</button>
            </div>
          </div>

          {/* Ozet Kartlari */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: "1.5rem" }}>
            <div style={{ padding: "16px", borderRadius: 14, background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)" }}>
              <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 4 }}>Toplam Gider ({d1.substring(0, 10)})</div>
              <div style={{ fontSize: 20, fontWeight: 600 }}>{formatN(toplamS)}</div>
            </div>
            <div style={{ padding: "16px", borderRadius: 14, background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)" }}>
              <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 4 }}>Toplam Gider ({d2.substring(0, 10)})</div>
              <div style={{ fontSize: 20, fontWeight: 600 }}>{formatN(toplamK)}</div>
            </div>
            <div style={{ padding: "16px", borderRadius: 14, background: toplamS - toplamK > 0 ? "#FCEBEB" : "#E1F5EE", border: "0.5px solid var(--color-border-tertiary)" }}>
              <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 4 }}>Fark</div>
              <div style={{ fontSize: 20, fontWeight: 600, color: toplamS - toplamK > 0 ? "#A32D2D" : "#0F6E56" }}>{toplamS - toplamK > 0 ? "+" : ""}{formatN(toplamS - toplamK)}</div>
            </div>
            <div style={{ padding: "16px", borderRadius: 14, background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)" }}>
              <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 4 }}>Degisim</div>
              <div style={{ fontSize: 20, fontWeight: 600, color: toplamS > toplamK ? "#A32D2D" : "#0F6E56" }}>{toplamK !== 0 ? (((toplamS - toplamK) / Math.abs(toplamK)) * 100).toFixed(1) : "-"}%</div>
            </div>
          </div>

          {/* Top 10 Artis */}
          {topArtis.length > 0 && (<div style={{ marginBottom: "1.5rem" }}>
            <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 10, color: "#A32D2D" }}>En cok artan 10 gider kalemi</div>
            <div style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: 14, overflow: "hidden" }}>
              <div style={{ display: "grid", gridTemplateColumns: "0.8fr 2fr 1fr 1fr 1fr 0.7fr", padding: "8px 12px", background: "#FCEBEB", fontSize: 11, fontWeight: 500, color: "#A32D2D" }}><span>Kod</span><span>Hesap</span><span style={{ textAlign: "right" }}>{d1}</span><span style={{ textAlign: "right" }}>{d2}</span><span style={{ textAlign: "right" }}>Artis</span><span style={{ textAlign: "right" }}>%</span></div>
              {topArtis.map((item, idx) => (
                <div key={item.kod + "-" + idx} style={{ display: "grid", gridTemplateColumns: "0.8fr 2fr 1fr 1fr 1fr 0.7fr", padding: "8px 12px", borderBottom: "0.5px solid var(--color-border-tertiary)", fontSize: 13 }}>
                  <span style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>{item.kod}</span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.ad}</span>
                  <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatN(item.vS)}</span>
                  <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: "var(--color-text-secondary)" }}>{formatN(item.vK)}</span>
                  <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: "#A32D2D", fontWeight: 500 }}>+{formatN(item.fark)}</span>
                  <span style={{ textAlign: "right" }}><span style={{ fontSize: 11, padding: "2px 6px", borderRadius: 99, background: "#FCEBEB", color: "#A32D2D", fontWeight: 500 }}>+{item.pct.toFixed(0)}%</span></span>
                </div>
              ))}
            </div>
          </div>)}

          {/* Top 10 Azalis */}
          {topAzalis.length > 0 && (<div style={{ marginBottom: "1.5rem" }}>
            <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 10, color: "#0F6E56" }}>En cok azalan 10 gider kalemi</div>
            <div style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: 14, overflow: "hidden" }}>
              <div style={{ display: "grid", gridTemplateColumns: "0.8fr 2fr 1fr 1fr 1fr 0.7fr", padding: "8px 12px", background: "#E1F5EE", fontSize: 11, fontWeight: 500, color: "#0F6E56" }}><span>Kod</span><span>Hesap</span><span style={{ textAlign: "right" }}>{d1}</span><span style={{ textAlign: "right" }}>{d2}</span><span style={{ textAlign: "right" }}>Azalis</span><span style={{ textAlign: "right" }}>%</span></div>
              {topAzalis.map((item, idx) => (
                <div key={item.kod + "-" + idx} style={{ display: "grid", gridTemplateColumns: "0.8fr 2fr 1fr 1fr 1fr 0.7fr", padding: "8px 12px", borderBottom: "0.5px solid var(--color-border-tertiary)", fontSize: 13 }}>
                  <span style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>{item.kod}</span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.ad}</span>
                  <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatN(item.vS)}</span>
                  <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: "var(--color-text-secondary)" }}>{formatN(item.vK)}</span>
                  <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: "#0F6E56", fontWeight: 500 }}>{formatN(item.fark)}</span>
                  <span style={{ textAlign: "right" }}><span style={{ fontSize: 11, padding: "2px 6px", borderRadius: 99, background: "#E1F5EE", color: "#0F6E56", fontWeight: 500 }}>{item.pct.toFixed(0)}%</span></span>
                </div>
              ))}
            </div>
          </div>)}

          {/* Yeni ve Kaybolan Kalemler */}
          {(yeniKalemler.length > 0 || kaybolan.length > 0) && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: "1.5rem" }}>
              {yeniKalemler.length > 0 && (<div style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: 14, overflow: "hidden" }}>
                <div style={{ padding: "10px 14px", background: "#FAEEDA", fontWeight: 500, fontSize: 13, color: "#BA7517" }}>Yeni gider kalemleri ({yeniKalemler.length})</div>
                {yeniKalemler.slice(0, 10).map((item) => (
                  <div key={item.kod} style={{ display: "flex", justifyContent: "space-between", padding: "7px 14px", borderBottom: "0.5px solid var(--color-border-tertiary)", fontSize: 12 }}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}><span style={{ color: "var(--color-text-tertiary)", fontSize: 10 }}>{item.kod}</span> {item.ad}</span>
                    <span style={{ fontWeight: 500, whiteSpace: "nowrap", marginLeft: 8 }}>{formatN(item.vS)}</span>
                  </div>
                ))}
              </div>)}
              {kaybolan.length > 0 && (<div style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: 14, overflow: "hidden" }}>
                <div style={{ padding: "10px 14px", background: "var(--color-background-secondary)", fontWeight: 500, fontSize: 13, color: "var(--color-text-secondary)" }}>Kaybolan gider kalemleri ({kaybolan.length})</div>
                {kaybolan.slice(0, 10).map((item) => (
                  <div key={item.kod} style={{ display: "flex", justifyContent: "space-between", padding: "7px 14px", borderBottom: "0.5px solid var(--color-border-tertiary)", fontSize: 12 }}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}><span style={{ color: "var(--color-text-tertiary)", fontSize: 10 }}>{item.kod}</span> {item.ad}</span>
                    <span style={{ fontWeight: 500, whiteSpace: "nowrap", marginLeft: 8, textDecoration: "line-through", color: "var(--color-text-tertiary)" }}>{formatN(item.vK)}</span>
                  </div>
                ))}
              </div>)}
            </div>
          )}

          {/* Grup Bazli Detay - Accordion */}
          <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 10 }}>Grup bazli detay</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {groupData.map((grp) => {
              const isOpen = expandedGider[grp.kod] !== false;
              const grpPct = grp.totalK !== 0 ? ((grp.fark / Math.abs(grp.totalK)) * 100) : 0;
              return (
                <div key={grp.kod} style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, overflow: "hidden" }}>
                  <div onClick={() => toggleGroup(grp.kod)} style={{ display: "grid", gridTemplateColumns: "auto 2fr 1fr 1fr 1fr 0.7fr", gap: 8, padding: "12px 14px", background: "var(--color-background-secondary)", cursor: "pointer", alignItems: "center" }}>
                    <span style={{ fontSize: 12, color: "var(--color-text-tertiary)", transition: "transform 0.2s", transform: isOpen ? "rotate(90deg)" : "rotate(0deg)" }}>▶</span>
                    <span style={{ fontSize: 14, fontWeight: 500 }}>{grp.kod} {grp.ad}</span>
                    <span style={{ textAlign: "right", fontSize: 13, fontWeight: 500, fontVariantNumeric: "tabular-nums" }}>{formatN(grp.totalS)}</span>
                    <span style={{ textAlign: "right", fontSize: 13, color: "var(--color-text-secondary)", fontVariantNumeric: "tabular-nums" }}>{formatN(grp.totalK)}</span>
                    <span style={{ textAlign: "right", fontSize: 13, fontWeight: 500, color: grp.fark > 0 ? "#A32D2D" : "#0F6E56", fontVariantNumeric: "tabular-nums" }}>{grp.fark > 0 ? "+" : ""}{formatN(grp.fark)}</span>
                    <span style={{ textAlign: "right" }}><Badge val={grpPct} /></span>
                  </div>
                  {isOpen && (
                    <div>
                      <div style={{ display: "grid", gridTemplateColumns: "2.5fr 1fr 1fr 1fr 0.7fr", padding: "6px 14px 6px 34px", fontSize: 10, color: "var(--color-text-tertiary)", borderBottom: "0.5px solid var(--color-border-tertiary)" }}><span>Hesap</span><span style={{ textAlign: "right" }}>{d1}</span><span style={{ textAlign: "right" }}>{d2}</span><span style={{ textAlign: "right" }}>Fark</span><span style={{ textAlign: "right" }}>%</span></div>
                      {grp.items.map((item) => (
                        <div key={item.kod} style={{ display: "grid", gridTemplateColumns: "2.5fr 1fr 1fr 1fr 0.7fr", padding: "6px 14px 6px 34px", borderBottom: "0.5px solid var(--color-border-tertiary)", fontSize: 12, background: Math.abs(item.fark) > 50000 ? (item.fark > 0 ? "rgba(163,45,45,0.03)" : "rgba(15,110,86,0.03)") : "transparent" }}>
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={item.ad}><span style={{ color: "var(--color-text-tertiary)", fontSize: 10 }}>{item.kod}</span> {item.ad}</span>
                          <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatN(item.vS)}</span>
                          <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: "var(--color-text-secondary)" }}>{item.vK !== 0 ? formatN(item.vK) : <span style={{ fontSize: 10, color: "#BA7517" }}>YENİ</span>}</span>
                          <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 500, color: item.fark > 0 ? "#A32D2D" : item.fark < 0 ? "#0F6E56" : "var(--color-text-tertiary)" }}>{item.fark > 0 ? "+" : ""}{formatN(item.fark)}</span>
                          <span style={{ textAlign: "right" }}><Badge val={item.pct} /></span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Toplam */}
          <div style={{ display: "grid", gridTemplateColumns: "2.5fr 1fr 1fr 1fr 0.7fr", padding: "12px 14px", marginTop: 8, background: "var(--color-background-secondary)", borderRadius: 12, fontWeight: 600, fontSize: 14 }}>
            <span>TOPLAM GIDERLER</span>
            <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatN(toplamS)}</span>
            <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: "var(--color-text-secondary)" }}>{formatN(toplamK)}</span>
            <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: toplamS - toplamK > 0 ? "#A32D2D" : "#0F6E56" }}>{toplamS - toplamK > 0 ? "+" : ""}{formatN(toplamS - toplamK)}</span>
            <span style={{ textAlign: "right" }}><Badge val={toplamK !== 0 ? ((toplamS - toplamK) / Math.abs(toplamK) * 100) : 0} /></span>
          </div>
        </div>);
      })()}

      {/* TAB 10: Gelir Vergisi */}
      {tab === 10 && (() => {
        const formatInput = (raw) => { const clean = raw.replace(/[^0-9,]/g, ""); const parts = clean.split(","); const intPart = parts[0].replace(/^0+(?=\d)/, ""); const formatted = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, "."); return parts.length > 1 ? formatted + "," + parts[1] : formatted; };
        const parseInput = (v) => parseFloat(String(v).replace(/\./g, "").replace(",", ".")) || 0;
        const geciciOranVal = parseFloat(String(gvGeciciOran).replace(",", ".")) || 15;
        const bagkurVal = parseInput(gvBagkur);
        const hataPayiOran = parseFloat(String(gvHataPayi).replace(",", ".")) || 0;
        const vergiIndirimOran = parseFloat(String(gvVergiIndirimi).replace(",", ".")) || 0;

        // Kumulatif matrahlar
        const kumMatrahlar = gvCeyrekler.map((c) => parseInput(c.matrah));
        const odenenler = gvCeyrekler.map((c) => parseInput(c.odenen));

        const ceyrekHesap = kumMatrahlar.map((km, i) => {
          const kumGeciciVergi = km * (geciciOranVal / 100);
          const oncekiKumVergi = i > 0 ? kumMatrahlar[i - 1] * (geciciOranVal / 100) : 0;
          const ceyrekVergi = kumGeciciVergi - oncekiKumVergi;
          const ceyrekMatrah = i > 0 ? km - kumMatrahlar[i - 1] : km;
          return { kumMatrah: km, ceyrekMatrah, kumGeciciVergi, oncekiKumVergi, ceyrekVergi, odenen: odenenler[i] };
        });

        const sonKumMatrah = kumMatrahlar[3] || kumMatrahlar[2] || kumMatrahlar[1] || kumMatrahlar[0] || 0;
        const toplamOdenen = odenenler.reduce((s, v) => s + v, 0);

        // Indirimler
        const hataPayiTutar = sonKumMatrah * (hataPayiOran / 100);
        const toplamIndirim = bagkurVal + hataPayiTutar;
        const vergiMatrahi = Math.max(0, sonKumMatrah - toplamIndirim);

        // Yillik gelir vergisi dilimlerle
        const hesaplaGV = (matrah) => {
          let kalan = matrah; let toplam = 0; let prev = 0; const detay = [];
          for (const dilim of gvDilimler) {
            const band = (dilim.limit === Infinity ? kalan : dilim.limit - prev);
            if (kalan <= 0) break;
            const tutar = Math.min(kalan, band);
            const vergi = tutar * (dilim.oran / 100);
            detay.push({ alt: prev, ust: dilim.limit, oran: dilim.oran, tutar, vergi });
            toplam += vergi; kalan -= tutar; prev = dilim.limit;
          }
          return { toplam, detay };
        };

        const gv = hesaplaGV(vergiMatrahi);

        // GVK Mukerrer 121 - Vergi indirimi (hesaplanan vergiden dusulur)
        const vergiIndirimTutar = gv.toplam * (vergiIndirimOran / 100);
        const netVergi = Math.max(0, gv.toplam - vergiIndirimTutar);
        const kalanOdenecek = netVergi - toplamOdenen;

        const updateCeyrek = (idx, field, val) => {
          setGvCeyrekler((p) => p.map((c, i) => i === idx ? { ...c, [field]: formatInput(val) } : c));
        };
        const updateDilim = (idx, field, val) => {
          setGvDilimler((p) => p.map((d, i) => i === idx ? { ...d, [field]: field === "oran" ? (parseFloat(val) || 0) : (parseFloat(val.replace(/\./g, "").replace(",", ".")) || 0) } : d));
        };

        const mStyle = { padding: "8px 12px", fontSize: 14, fontWeight: 500, border: "2px solid #185FA5", borderRadius: "var(--border-radius-md)", background: "#E6F1FB", color: "#185FA5", textAlign: "right", width: 140, fontVariantNumeric: "tabular-nums", outline: "none" };
        const mOranStyle = { ...mStyle, width: 50, textAlign: "center" };
        const mBadge = <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 99, background: "#E6F1FB", color: "#185FA5", fontWeight: 500, marginLeft: 6 }}>GIRIS</span>;
        const rowM = "rgba(24,95,165,0.04)";
        const secStyle = { fontSize: 16, fontWeight: 500, color: "var(--color-text-primary)", margin: "1.5rem 0 0.75rem", paddingBottom: 6, borderBottom: "0.5px solid var(--color-border-tertiary)" };
        const sumRow = (label, val, color) => (<div style={{ display: "flex", justifyContent: "space-between", padding: "12px 16px", borderBottom: "0.5px solid var(--color-border-tertiary)" }}><span style={{ fontSize: 14 }}>{label}</span><span style={{ fontSize: 16, fontWeight: 600, color: color || "var(--color-text-primary)", fontVariantNumeric: "tabular-nums" }}>{formatN(val)}</span></div>);

        return (<div>
          <div style={{ fontSize: 20, fontWeight: 600, marginBottom: 4 }}>Gelir Vergisi Hesaplama</div>
          <div style={{ fontSize: 13, color: "var(--color-text-secondary)", marginBottom: "1.5rem" }}>Sahis firmasi — gecici vergi (kumulatif) + indirimler + yillik gelir vergisi</div>

          {/* Gecici Vergi Orani */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: "1.5rem", padding: "12px 16px", background: "var(--color-background-secondary)", borderRadius: "var(--border-radius-md)" }}>
            <span style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>Gecici vergi orani:</span>
            <span style={{ fontSize: 14, fontWeight: 600, color: "#185FA5" }}>%</span>
            <input type="text" value={gvGeciciOran} onChange={(e) => setGvGeciciOran(e.target.value.replace(/[^0-9.,]/g, ""))} style={mOranStyle} />
            {mBadge}
          </div>

          {/* Ceyrek Bazli */}
          <div style={secStyle}>Gecici vergi beyanlari (kumulatif matrah)</div>
          <div style={{ padding: "10px 14px", background: "var(--color-background-secondary)", borderRadius: "var(--border-radius-md) var(--border-radius-md) 0 0", fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
            Her ceyrek matrahi ocaktan o ayin sonuna kadar kumulatif girilir.
          </div>
          <div style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: "0 0 14px 14px", overflow: "hidden", marginBottom: "1.5rem" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr 1fr 1fr 1fr", padding: "10px 14px", background: "var(--color-background-secondary)", fontSize: 11, fontWeight: 500, color: "var(--color-text-secondary)" }}>
              <span>Donem</span><span style={{ textAlign: "right" }}>Kum. Matrah</span><span style={{ textAlign: "right" }}>Ceyrek Matrah</span><span style={{ textAlign: "right" }}>Ceyrek Vergi</span><span style={{ textAlign: "right" }}>Odenen</span>
            </div>
            {ceyrekHesap.map((c, i) => (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr 1fr 1fr 1fr", padding: "10px 14px", borderBottom: "0.5px solid var(--color-border-tertiary)", alignItems: "center", background: rowM }}>
                <span style={{ fontSize: 13, fontWeight: 500 }}>{gvCeyrekler[i].ad}</span>
                <span style={{ textAlign: "right" }}><input type="text" value={gvCeyrekler[i].matrah} onChange={(e) => updateCeyrek(i, "matrah", e.target.value)} placeholder="0" style={{ ...mStyle, width: 120 }} /></span>
                <span style={{ textAlign: "right", fontSize: 13, color: "var(--color-text-secondary)", fontVariantNumeric: "tabular-nums" }}>{formatN(c.ceyrekMatrah)}</span>
                <span style={{ textAlign: "right", fontSize: 13, fontWeight: 500, color: "#A32D2D", fontVariantNumeric: "tabular-nums" }}>{formatN(c.ceyrekVergi)}</span>
                <span style={{ textAlign: "right" }}><input type="text" value={gvCeyrekler[i].odenen} onChange={(e) => updateCeyrek(i, "odenen", e.target.value)} placeholder="0" style={{ ...mStyle, width: 120 }} /></span>
              </div>
            ))}
            <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr 1fr 1fr 1fr", padding: "12px 14px", background: "var(--color-background-secondary)", fontWeight: 600, fontSize: 13 }}>
              <span>YILLIK</span>
              <span style={{ textAlign: "right" }}>{formatN(sonKumMatrah)}</span>
              <span style={{ textAlign: "right" }}>{formatN(sonKumMatrah)}</span>
              <span style={{ textAlign: "right", color: "#A32D2D" }}>{formatN(sonKumMatrah * (geciciOranVal / 100))}</span>
              <span style={{ textAlign: "right", color: "#0F6E56" }}>{formatN(toplamOdenen)}</span>
            </div>
          </div>

          {/* Indirimler */}
          <div style={secStyle}>Matrahtan indirimler</div>
          <div style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: 14, overflow: "hidden", marginBottom: "1.5rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", borderBottom: "0.5px solid var(--color-border-tertiary)", background: rowM }}>
              <div style={{ display: "flex", alignItems: "center" }}><span style={{ fontSize: 14 }}>Yillik matrah (kumulatif)</span></div>
              <span style={{ fontSize: 16, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{formatN(sonKumMatrah)}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", borderBottom: "0.5px solid var(--color-border-tertiary)", background: rowM }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}><span style={{ fontSize: 14 }}>Bag-Kur odeme indirimi</span>{mBadge}</div>
              <input type="text" value={gvBagkur} onChange={(e) => setGvBagkur(formatInput(e.target.value))} placeholder="Tutar girin" style={{ padding: "10px 14px", fontSize: 15, fontWeight: 500, border: "2px solid #185FA5", borderRadius: "var(--border-radius-md)", background: "#E6F1FB", color: "#185FA5", textAlign: "right", width: 160, fontVariantNumeric: "tabular-nums", outline: "none" }} />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", borderBottom: "0.5px solid var(--color-border-tertiary)", background: rowM }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 14 }}>Hata payi</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: "#185FA5" }}>%</span>
                <input type="text" value={gvHataPayi} onChange={(e) => setGvHataPayi(e.target.value.replace(/[^0-9.,]/g, ""))} style={mOranStyle} />
                {mBadge}
              </div>
              <span style={{ fontSize: 14, fontWeight: 500, fontVariantNumeric: "tabular-nums", color: "var(--color-text-secondary)" }}>{formatN(hataPayiTutar)}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", borderBottom: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)" }}>
              <span style={{ fontSize: 14, fontWeight: 500 }}>Toplam indirim</span>
              <span style={{ fontSize: 14, fontWeight: 600, color: "#0F6E56", fontVariantNumeric: "tabular-nums" }}>-{formatN(toplamIndirim)}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 16px", background: "var(--color-background-secondary)" }}>
              <span style={{ fontSize: 15, fontWeight: 600 }}>Vergiye tabi matrah</span>
              <span style={{ fontSize: 18, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{formatN(vergiMatrahi)}</span>
            </div>
          </div>

          {/* Vergi Dilimleri */}
          <div style={secStyle}>Gelir vergisi dilimleri (2025)</div>
          <div style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: 14, overflow: "hidden", marginBottom: "1.5rem" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 0.5fr 1fr 1fr", padding: "10px 14px", background: "var(--color-background-secondary)", fontSize: 11, fontWeight: 500, color: "var(--color-text-secondary)" }}>
              <span>Dilim Siniri</span><span style={{ textAlign: "center" }}>Oran</span><span style={{ textAlign: "right" }}>Bu Dilimden</span><span style={{ textAlign: "right" }}>Vergi</span>
            </div>
            {gv.detay.map((d, i) => (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 0.5fr 1fr 1fr", padding: "10px 14px", borderBottom: "0.5px solid var(--color-border-tertiary)", alignItems: "center", background: rowM }}>
                <span>{gvDilimler[i].limit === Infinity ? <span style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>Ustu</span> : <input type="text" value={formatN(gvDilimler[i].limit).split(",")[0]} onChange={(e) => updateDilim(i, "limit", e.target.value)} style={{ ...mStyle, width: 110, fontSize: 13 }} />}</span>
                <span style={{ textAlign: "center" }}><input type="text" value={gvDilimler[i].oran} onChange={(e) => updateDilim(i, "oran", e.target.value)} style={mOranStyle} /></span>
                <span style={{ textAlign: "right", fontSize: 13, fontVariantNumeric: "tabular-nums" }}>{formatN(d.tutar)}</span>
                <span style={{ textAlign: "right", fontSize: 13, fontWeight: 500, fontVariantNumeric: "tabular-nums" }}>{formatN(d.vergi)}</span>
              </div>
            ))}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 0.5fr 1fr 1fr", padding: "12px 14px", background: "var(--color-background-secondary)", fontWeight: 600, fontSize: 14 }}>
              <span>TOPLAM</span><span></span>
              <span style={{ textAlign: "right" }}>{formatN(vergiMatrahi)}</span>
              <span style={{ textAlign: "right", color: "#A32D2D" }}>{formatN(gv.toplam)}</span>
            </div>
          </div>

          {/* Vergi Indirimi GVK 121 */}
          <div style={secStyle}>Hesaplanan vergiden indirimler</div>
          <div style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: 14, overflow: "hidden", marginBottom: "1.5rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
              <span style={{ fontSize: 14 }}>Hesaplanan gelir vergisi</span>
              <span style={{ fontSize: 16, fontWeight: 600, color: "#A32D2D", fontVariantNumeric: "tabular-nums" }}>{formatN(gv.toplam)}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", borderBottom: "0.5px solid var(--color-border-tertiary)", background: rowM }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 14 }}>Vergi Indirimi (GVK Mk. 121)</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: "#185FA5" }}>%</span>
                <input type="text" value={gvVergiIndirimi} onChange={(e) => setGvVergiIndirimi(e.target.value.replace(/[^0-9.,]/g, ""))} style={mOranStyle} />
                {mBadge}
              </div>
              <span style={{ fontSize: 14, fontWeight: 500, color: "#0F6E56", fontVariantNumeric: "tabular-nums" }}>-{formatN(vergiIndirimTutar)}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 16px", background: "var(--color-background-secondary)" }}>
              <span style={{ fontSize: 15, fontWeight: 600 }}>Odenecek net gelir vergisi</span>
              <span style={{ fontSize: 18, fontWeight: 700, color: "#A32D2D", fontVariantNumeric: "tabular-nums" }}>{formatN(netVergi)}</span>
            </div>
          </div>

          {/* Nihai Sonuc */}
          <div style={secStyle}>Nihai sonuc</div>
          <div style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: 14, overflow: "hidden", marginBottom: "1.5rem" }}>
            {sumRow("Yillik matrah (kumulatif)", sonKumMatrah)}
            {sumRow("(-) Bag-Kur indirimi", bagkurVal, "#0F6E56")}
            {sumRow("(-) Hata payi (%" + hataPayiOran + ")", hataPayiTutar, "#0F6E56")}
            {sumRow("Vergiye tabi matrah", vergiMatrahi)}
            {sumRow("Hesaplanan gelir vergisi (dilimlerle)", gv.toplam, "#A32D2D")}
            {sumRow("(-) Vergi indirimi GVK 121 (%" + vergiIndirimOran + ")", vergiIndirimTutar, "#0F6E56")}
            {sumRow("Odenecek net gelir vergisi", netVergi, "#A32D2D")}
            {sumRow("(-) Yil ici odenen gecici vergi", toplamOdenen, "#0F6E56")}
            <div style={{ display: "flex", justifyContent: "space-between", padding: "16px", background: kalanOdenecek > 0 ? "#FCEBEB" : "#E1F5EE" }}>
              <span style={{ fontSize: 16, fontWeight: 700 }}>{kalanOdenecek > 0 ? "ODENECEK GELIR VERGISI" : "IADE ALINACAK"}</span>
              <span style={{ fontSize: 24, fontWeight: 700, color: kalanOdenecek > 0 ? "#A32D2D" : "#0F6E56", fontVariantNumeric: "tabular-nums" }}>{formatN(Math.abs(kalanOdenecek))}</span>
            </div>
          </div>

          <div style={{ padding: "12px 16px", background: "var(--color-background-secondary)", borderRadius: "var(--border-radius-md)", fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.7 }}>
            <span style={{ display: "inline-block", fontSize: 10, padding: "2px 8px", borderRadius: 99, background: "#E6F1FB", color: "#185FA5", fontWeight: 500, marginRight: 6 }}>GIRIS</span>
            Kumulatif matrah her ceyrekte ocaktan o ayin sonuna kadar girilir. Bag-Kur indirimi yillik odenen tutari giriniz. Hata payi varsayilan %9, Vergi Indirimi (GVK Mk. 121) varsayilan %5'tir — degistirilebilir. Dilimler 2025 resmi tarifesidir.
          </div>
        </div>);
      })()}

      {/* TAB 11: KDV */}
      {tab === 11 && g && (() => {
        const r = mizanlar[sel].rows;
        const rK = karsi >= 0 ? mizanlar[karsi].rows : null;
        const getSubVal = (rows, prefix) => {
          return rows.filter((x) => x.kod.startsWith(prefix) && x.kod !== prefix && !rows.some((y) => y.kod.startsWith(x.kod) && y.kod !== x.kod && y.kod.length > x.kod.length))
            .map((x) => ({ kod: x.kod, ad: x.ad, val: x.kod.startsWith("19") ? x.bBak - x.aBak : x.aBak - x.bBak }))
            .filter((x) => x.val !== 0);
        };
        const getTotal = (rows, kod) => { const e = rows.find((x) => x.kod === kod); return e ? (kod.startsWith("19") ? e.bBak - e.aBak : e.aBak - e.bBak) : 0; };

        // Hesaplanan KDV (391)
        const hesaplananSubs = getSubVal(r, "391");
        const hesaplananTop = getTotal(r, "391");
        const hesaplananKSubs = rK ? getSubVal(rK, "391") : [];
        const hesaplananKTop = rK ? getTotal(rK, "391") : null;

        // Indirilecek KDV (191)
        const indirilecekSubs = getSubVal(r, "191");
        const indirilecekTop = getTotal(r, "191");
        const indirilecekKSubs = rK ? getSubVal(rK, "191") : [];
        const indirilecekKTop = rK ? getTotal(rK, "191") : null;

        // Devreden KDV
        const devreden190 = getTotal(r, "190");
        const devreden190K = rK ? getTotal(rK, "190") : null;

        // Odenecek veya Devreden
        const fark = hesaplananTop - indirilecekTop;
        const odenecek = fark > 0 ? fark : 0;
        const sonrakiDevreden = fark < 0 ? Math.abs(fark) : 0;

        // Satis matrahi
        const satisMatrah = g.brutSatis;
        const satisMatrahK = gK ? gK.brutSatis : null;

        const doExportCSV = () => {
          const rows2 = [["KDV TABLOSU - " + d1], []];
          rows2.push(["Kalem", "Tutar"]); rows2.push(["Toplam Matrah (Brut Satis)", formatN(satisMatrah)]);
          rows2.push([]); rows2.push(["HESAPLANAN KDV (391)"]); for (const s of hesaplananSubs) rows2.push(["  " + s.kod + " " + s.ad, formatN(s.val)]); rows2.push(["TOPLAM HESAPLANAN KDV", formatN(hesaplananTop)]);
          rows2.push([]); rows2.push(["INDIRILECEK KDV (191)"]); for (const s of indirilecekSubs) rows2.push(["  " + s.kod + " " + s.ad, formatN(s.val)]); rows2.push(["TOPLAM INDIRILECEK KDV", formatN(indirilecekTop)]);
          rows2.push([]); rows2.push(["Hesaplanan - Indirilecek", formatN(fark)]); rows2.push(["Odenecek KDV", formatN(odenecek)]); rows2.push(["Sonraki Doneme Devreden KDV", formatN(sonrakiDevreden)]);
          downloadCSV(buildCSV(rows2), "KDV_" + d1.replace(/\s/g, "_") + ".csv");
        };

        const KDVRow = ({ label, val, valK, bold, hl, sub }) => {
          const hasK2 = valK != null;
          return (<div style={{ display: "grid", gridTemplateColumns: hasK2 ? "2.2fr 1fr 1fr 1fr 0.7fr" : "2.5fr 1fr", padding: sub ? "5px 14px 5px 34px" : "8px 14px", borderBottom: "0.5px solid var(--color-border-tertiary)", fontWeight: bold ? 600 : 400, fontSize: sub ? 12 : 14, color: sub ? "var(--color-text-secondary)" : "var(--color-text-primary)", background: hl ? "var(--color-background-secondary)" : "transparent" }}>
            <span>{label}</span>
            <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatN(val)}</span>
            {hasK2 && <><span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: "var(--color-text-secondary)" }}>{formatN(valK)}</span><span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: val - valK >= 0 ? "#0F6E56" : "#A32D2D" }}>{val - valK >= 0 ? "+" : ""}{formatN(val - valK)}</span><span style={{ textAlign: "right" }}><Badge val={degFn(val, valK)} /></span></>}
          </div>);
        };

        return (<div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.25rem" }}>
            <div><div style={{ fontSize: 20, fontWeight: 600 }}>KDV Tablosu</div><div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>{d1}{hasK ? " / " + d2 : ""} — Mizandan otomatik</div></div>
            <button onClick={doExportCSV} style={DL_STYLE}>CSV Indir</button>
          </div>

          {/* Ozet Kartlar */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: "1.5rem" }}>
            <div style={{ padding: 16, borderRadius: 14, background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", position: "relative", overflow: "hidden" }}>
              <div style={{ position: "absolute", top: 0, left: 0, width: "100%", height: 3, background: "#85B7EB" }} />
              <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 4 }}>Toplam Matrah</div>
              <div style={{ fontSize: 18, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{formatN(satisMatrah)}</div>
            </div>
            <div style={{ padding: 16, borderRadius: 14, background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", position: "relative", overflow: "hidden" }}>
              <div style={{ position: "absolute", top: 0, left: 0, width: "100%", height: 3, background: "#A32D2D" }} />
              <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 4 }}>Hesaplanan KDV</div>
              <div style={{ fontSize: 18, fontWeight: 600, color: "#A32D2D", fontVariantNumeric: "tabular-nums" }}>{formatN(hesaplananTop)}</div>
            </div>
            <div style={{ padding: 16, borderRadius: 14, background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", position: "relative", overflow: "hidden" }}>
              <div style={{ position: "absolute", top: 0, left: 0, width: "100%", height: 3, background: "#0F6E56" }} />
              <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 4 }}>Indirilecek KDV</div>
              <div style={{ fontSize: 18, fontWeight: 600, color: "#0F6E56", fontVariantNumeric: "tabular-nums" }}>{formatN(indirilecekTop)}</div>
            </div>
            <div style={{ padding: 16, borderRadius: 14, background: odenecek > 0 ? "#FCEBEB" : "#E1F5EE", border: "0.5px solid var(--color-border-tertiary)", position: "relative", overflow: "hidden" }}>
              <div style={{ position: "absolute", top: 0, left: 0, width: "100%", height: 3, background: odenecek > 0 ? "#A32D2D" : "#0F6E56" }} />
              <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 4 }}>{odenecek > 0 ? "Odenecek KDV" : "Devreden KDV"}</div>
              <div style={{ fontSize: 18, fontWeight: 600, color: odenecek > 0 ? "#A32D2D" : "#0F6E56", fontVariantNumeric: "tabular-nums" }}>{formatN(odenecek > 0 ? odenecek : sonrakiDevreden)}</div>
            </div>
          </div>

          {/* Hesaplanan KDV Detay */}
          <div style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: 14, overflow: "hidden", marginBottom: 16 }}>
            <div style={{ padding: "10px 14px", background: "#FCEBEB", color: "#A32D2D", fontWeight: 500, fontSize: 14 }}>Hesaplanan KDV (391)</div>
            {hasK && <div style={{ display: "grid", gridTemplateColumns: "2.2fr 1fr 1fr 1fr 0.7fr", padding: "6px 14px", background: "var(--color-background-secondary)", fontSize: 11, fontWeight: 500, color: "var(--color-text-secondary)" }}><span>Hesap</span><span style={{ textAlign: "right" }}>{d1}</span><span style={{ textAlign: "right" }}>{d2}</span><span style={{ textAlign: "right" }}>Fark</span><span style={{ textAlign: "right" }}>%</span></div>}
            {hesaplananSubs.map((s) => { const kItem = hesaplananKSubs.find((k) => k.kod === s.kod); return <KDVRow key={s.kod} label={s.kod + " " + s.ad} val={s.val} valK={kItem ? kItem.val : (hasK ? 0 : null)} sub />; })}
            <KDVRow label="TOPLAM HESAPLANAN KDV" val={hesaplananTop} valK={hesaplananKTop} bold hl />
          </div>

          {/* Indirilecek KDV Detay */}
          <div style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: 14, overflow: "hidden", marginBottom: 16 }}>
            <div style={{ padding: "10px 14px", background: "#E1F5EE", color: "#0F6E56", fontWeight: 500, fontSize: 14 }}>Indirilecek KDV (191)</div>
            {hasK && <div style={{ display: "grid", gridTemplateColumns: "2.2fr 1fr 1fr 1fr 0.7fr", padding: "6px 14px", background: "var(--color-background-secondary)", fontSize: 11, fontWeight: 500, color: "var(--color-text-secondary)" }}><span>Hesap</span><span style={{ textAlign: "right" }}>{d1}</span><span style={{ textAlign: "right" }}>{d2}</span><span style={{ textAlign: "right" }}>Fark</span><span style={{ textAlign: "right" }}>%</span></div>}
            {indirilecekSubs.map((s) => { const kItem = indirilecekKSubs.find((k) => k.kod === s.kod); return <KDVRow key={s.kod} label={s.kod + " " + s.ad} val={s.val} valK={kItem ? kItem.val : (hasK ? 0 : null)} sub />; })}
            <KDVRow label="TOPLAM INDIRILECEK KDV" val={indirilecekTop} valK={indirilecekKTop} bold hl />
          </div>

          {/* Sonuc */}
          <div style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: 14, overflow: "hidden" }}>
            <div style={{ padding: "10px 14px", background: "var(--color-background-secondary)", fontWeight: 500, fontSize: 14 }}>KDV Hesaplama Sonucu</div>
            <KDVRow label="Hesaplanan KDV" val={hesaplananTop} valK={hesaplananKTop} />
            <KDVRow label="(-) Indirilecek KDV" val={indirilecekTop} valK={indirilecekKTop} />
            <KDVRow label="Fark (Hesaplanan - Indirilecek)" val={fark} valK={hesaplananKTop != null && indirilecekKTop != null ? hesaplananKTop - indirilecekKTop : null} bold />
            {odenecek > 0 ? (
              <div style={{ display: "flex", justifyContent: "space-between", padding: "14px", background: "#FCEBEB" }}>
                <span style={{ fontSize: 15, fontWeight: 700 }}>ODENECEK KDV</span>
                <span style={{ fontSize: 22, fontWeight: 700, color: "#A32D2D", fontVariantNumeric: "tabular-nums" }}>{formatN(odenecek)}</span>
              </div>
            ) : (
              <div style={{ display: "flex", justifyContent: "space-between", padding: "14px", background: "#E1F5EE" }}>
                <span style={{ fontSize: 15, fontWeight: 700 }}>SONRAKI DONEME DEVREDEN KDV</span>
                <span style={{ fontSize: 22, fontWeight: 700, color: "#0F6E56", fontVariantNumeric: "tabular-nums" }}>{formatN(sonrakiDevreden)}</span>
              </div>
            )}
          </div>

          <div style={{ marginTop: 16, padding: "12px 16px", background: "var(--color-background-secondary)", borderRadius: "var(--border-radius-md)", fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.7 }}>
            Tum veriler mizandaki 391 (Hesaplanan KDV) ve 191 (Indirilecek KDV) hesaplarından otomatik akmaktadir. KDV oran bazli kirilimlar (1%, 10%, 20%) alt hesaplardan gelmektedir.
          </div>
        </div>);
      })()}

      {tab > 0 && !mizanlar.length && (<div style={{ textAlign: "center", padding: "3rem 1rem" }}>
        <div style={{ fontSize: 48, opacity: 0.15, marginBottom: 12 }}>+</div>
        <div style={{ fontSize: 16, fontWeight: 500, color: "var(--color-text-primary)", marginBottom: 6 }}>Henuz mizan yuklenmedi</div>
        <div style={{ fontSize: 13, color: "var(--color-text-secondary)", marginBottom: 16, lineHeight: 1.6 }}>Bu sekmeyi kullanabilmek icin once bir mizan dosyasi yuklemeniz gerekir.</div>
        <button onClick={() => setTab(0)} style={{ padding: "10px 24px", fontSize: 14, fontWeight: 500, cursor: "pointer", background: "var(--color-background-info)", color: "var(--color-text-info)", border: "0.5px solid var(--color-border-info)", borderRadius: "var(--border-radius-md)" }}>Mizan Yukle</button>
      </div>)}
      </div>

      {/* ── Mobil alt navigasyon ── */}
      {isMobile && (
        <nav style={{ position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 60, display: "grid", gridTemplateColumns: "repeat(5, 1fr)", borderTop: "0.5px solid var(--color-border-tertiary)", paddingBottom: "env(safe-area-inset-bottom)", ...barStyle }}>
          {TAB_GROUPS.map((gr) => {
            const active = gr === activeGroup;
            const disabled = gr.tabs[0] !== 0 && !hasData;
            return (
              <button key={gr.grp} data-group={gr.tabs.join(",")} disabled={disabled} onClick={() => setTab(lastInGroup[gr.grp] != null ? lastInGroup[gr.grp] : gr.tabs[0])} style={{ background: "none", border: "none", padding: "7px 0 6px", display: "flex", flexDirection: "column", alignItems: "center", gap: 3, cursor: disabled ? "default" : "pointer", color: active ? "var(--color-text-info)" : "var(--color-text-secondary)", opacity: disabled ? 0.38 : 1, fontSize: 10.5, fontWeight: active ? 650 : 500, fontFamily: "inherit" }}>
                <span style={{ width: 48, height: 28, borderRadius: 14, display: "flex", alignItems: "center", justifyContent: "center", background: active ? "var(--color-background-info)" : "transparent", transition: "background 0.2s" }}>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2 : 1.7} strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{ __html: NAV_ICONS[gr.grp] }} />
                </span>
                {gr.grp}
              </button>
            );
          })}
        </nav>
      )}
    </div>
  );
}
