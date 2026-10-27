/* ── PDF Mizan Okuyucu ──
   PDF'teki metinleri konumlariyla birlikte okur, satir ve sutunlari yeniden kurar,
   uygulamanin mizan ayristiricisinin (parseMizan) anladigi tabloya cevirir.

   Farkli muhasebe programlarinin PDF duzenlerini destekler:
   - Ayri "Borc Bakiye / Alacak Bakiye" sutunlari (DIA, Luca, Zirve, Logo...)
   - Tek "Bakiye" sutunu + B/A isareti (ayri sutunda veya rakamin yaninda)
   - Iki satirli basliklar (TUTAR / BAKIYE ustte, Borc / Alacak altta)
   - Devir + donem + toplam sutunlu genis mizanlar (toplam sutunlari kullanilir)
   - Hesap kodu ile adi tek metin halinde ("100.01 KASA - TL")
   - Cok sayfali, her sayfada tekrar eden basliklar

   pdfjsLib disaridan verilir (tarayicida worker ayari pdfLoader.js'de yapilir). */

const CODE_RE = /^\d{1,3}(?:[.\-][0-9A-Za-zÇĞİÖŞÜçğıöşü]+)*$/;
const CODE_GLUED_RE = /^(\d{1,3}(?:[.\-][0-9A-Za-zÇĞİÖŞÜçğıöşü]*\d)+)([A-Za-zÇĞİÖŞÜçğıöşü].*)$/;
const CODE_HEAD_RE = /^(\d{1,3}(?:[.\-][0-9A-Za-zÇĞİÖŞÜçğıöşü]+)*)\s+(.+)$/;
// Turk bicimi: 1.234.567,89  |  Ingiliz bicimi: 1,234,567.89  | sade: 0  1234,5
const AMT_TR = /^\d{1,3}(?:\.\d{3})*(?:,\d{1,4})?$|^\d+(?:,\d{1,4})?$/;
const AMT_EN = /^\d{1,3}(?:,\d{3})+(?:\.\d{1,4})?$|^\d+\.\d{2}$/;
const GLUED_AMT_RE = /^(.*[A-Za-zÇĞİÖŞÜçğıöşü)\]])(\d{1,3}(?:\.\d{3})*,\d{2}|\d{1,3}(?:,\d{3})*\.\d{2})$/;
const SIDE_RE = /^\(?([BA])\)?$/i;

export function normTr(s) {
  return String(s || "")
    .replace(/İ/g, "i").replace(/I/g, "ı").toLowerCase()
    .replace(/ç/g, "c").replace(/ğ/g, "g").replace(/ı/g, "i").replace(/ö/g, "o").replace(/ş/g, "s").replace(/ü/g, "u")
    .replace(/\s+/g, " ").trim();
}

/* Tutar metnini sayiya cevirir; tutar degilse null.
   Donus: { v: sayi, side: "B" | "A" | null } */
export function parseAmount(raw) {
  let s = String(raw || "").replace(/ /g, " ").trim();
  if (!s) return null;
  let side = null;
  const m = s.match(/^(.*?)[\s]*\(?([BA])\)?$/);
  if (m && /\d/.test(m[1])) { side = m[2].toUpperCase(); s = m[1].trim(); }
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1).trim(); }
  if (/^[-−–]/.test(s)) { neg = true; s = s.replace(/^[-−–]\s*/, ""); }
  if (/[-−–]$/.test(s)) { neg = true; s = s.replace(/\s*[-−–]$/, ""); }
  s = s.replace(/\s/g, "");
  if (/^[₺$€]|TL$|TRY$/i.test(s)) s = s.replace(/^[₺$€]|TL$|TRY$/gi, "");
  let v;
  if (AMT_TR.test(s)) v = parseFloat(s.replace(/\./g, "").replace(",", "."));
  else if (AMT_EN.test(s)) v = parseFloat(s.replace(/,/g, ""));
  else return null;
  if (!isFinite(v)) return null;
  return { v: neg ? -v : v, side };
}

/* 1) PDF -> sayfa basina metin parcalari {s, x, r, y, h} */
async function extractFragments(data, pdfjsLib, onProgress) {
  const doc = await pdfjsLib.getDocument({
    data,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    verbosity: 0,
  }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent({ disableNormalization: false });
    const frags = [];
    for (const it of tc.items) {
      if (!it || typeof it.str !== "string") continue;
      const str = it.str.replace(/ /g, " ");
      if (!str.trim()) continue;
      const t = it.transform || [1, 0, 0, 1, 0, 0];
      const h = Math.abs(t[3]) || Math.abs(it.height) || 8;
      const x = t[4], y = t[5];
      const w = it.width || str.length * h * 0.5;
      // Tek parca icinde 2+ bosluk varsa (metin hizalamali ciktilar) parcalara bol
      if (/\S\s{2,}\S/.test(str)) {
        const cw = w / str.length;
        const re = /\S+(?: \S+)*/g; let mm;
        while ((mm = re.exec(str))) {
          const sx = x + mm.index * cw;
          frags.push({ s: mm[0], x: sx, r: sx + mm[0].length * cw, y, h });
        }
      } else {
        const lead = str.length - str.trimStart().length;
        const cw = w / str.length;
        const sx = x + lead * cw;
        const s2 = str.trim();
        // Uzun hesap adi yandaki tutara yapismis olabilir: "...FARKI750.129,97"
        const g = s2.match(GLUED_AMT_RE);
        if (g) {
          const cut = sx + g[1].length * cw;
          frags.push({ s: g[1].trim(), x: sx, r: cut, y, h });
          frags.push({ s: g[2], x: cut, r: sx + s2.length * cw, y, h });
        } else frags.push({ s: s2, x: sx, r: sx + s2.length * cw, y, h });
      }
    }
    pages.push(frags);
    page.cleanup && page.cleanup();
    if (onProgress) onProgress(p, doc.numPages);
  }
  try { doc.destroy(); } catch (e) { /* yoksay */ }
  return pages;
}

/* 2) Parcalari satirlara grupla (ayni y), satir icinde x'e gore sirala */
function groupLines(frags) {
  if (!frags.length) return [];
  const hs = frags.map((f) => f.h).sort((a, b) => a - b);
  const medH = hs[Math.floor(hs.length / 2)] || 8;
  const tol = Math.max(1.5, medH * 0.45);
  const sorted = [...frags].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const f of sorted) {
    const ln = lines.length ? lines[lines.length - 1] : null;
    if (ln && Math.abs(ln.y - f.y) <= tol) { ln.items.push(f); ln.ySum += f.y; ln.n++; ln.y = ln.ySum / ln.n; }
    else lines.push({ y: f.y, ySum: f.y, n: 1, items: [f] });
  }
  for (const ln of lines) ln.items.sort((a, b) => a.x - b.x);
  return lines.map((l) => ({ y: l.y, items: l.items, h: medH }));
}

/* Satirin hesap kodunu ve kod disindaki ilk parcayi bulur */
function codeOf(line) {
  const first = line.items[0];
  if (!first) return null;
  const s = first.s.trim();
  if (CODE_RE.test(s)) return { kod: s, rest: "", idx: 0 };
  // Kod ile ad bosluksuz yapismis: "120.01.A0002ALI VELI" -> "120.01.A0002" + "ALI VELI"
  const g = s.match(CODE_GLUED_RE);
  if (g && CODE_RE.test(g[1]) && /^[A-Za-zÇĞİÖŞÜçğıöşü]{2}/.test(g[2])) return { kod: g[1], rest: g[2].trim(), idx: 0 };
  const m = s.match(CODE_HEAD_RE);
  if (m && CODE_RE.test(m[1]) && !parseAmount(m[2])) return { kod: m[1], rest: m[2], idx: 0 };
  return null;
}

/* Sag kenarlari yakin olan tutarlari sutunlara kumele */
function clusterRights(vals, tol) {
  const xs = [...vals].sort((a, b) => a - b);
  const cl = [];
  for (const x of xs) {
    const c = cl.length ? cl[cl.length - 1] : null;
    if (c && x - c.max <= tol) { c.max = x; c.sum += x; c.n++; }
    else cl.push({ min: x, max: x, sum: x, n: 1 });
  }
  return cl.map((c) => ({ r: c.sum / c.n, min: c.min, max: c.max, n: c.n }));
}

/* 3) Ana donusum: sayfalar -> mizan tablosu */
export function fragmentsToMizanRows(pages) {
  const allLines = [];
  pages.forEach((frags, pi) => groupLines(frags).forEach((ln) => allLines.push({ ...ln, page: pi })));
  const totalChars = pages.reduce((s, fr) => s + fr.reduce((t, f) => t + f.s.length, 0), 0);
  if (totalChars < 40) return { rows: null, error: "SCANNED" };

  // Aday veri satirlari: hesap kodu ile baslayan ve en az bir tutar iceren satirlar
  const cand = [];
  for (const ln of allLines) {
    const c = codeOf(ln);
    if (!c) continue;
    const amts = [];
    ln.items.forEach((f, i) => {
      if (i === 0 && !c.rest) return;
      const a = parseAmount(f.s);
      if (a) amts.push({ f, a });
    });
    if (amts.length) cand.push({ ln, c, amts });
  }
  if (cand.length < 3) return { rows: null, error: "NOTABLE" };

  // Tutar sutunlari: sag kenar kumeleme
  const hMed = cand[Math.floor(cand.length / 2)].ln.h || 8;
  const tol = Math.max(4, hMed * 1.2);
  let clusters = clusterRights(cand.flatMap((r) => r.amts.map((x) => x.f.r)), tol);
  const minN = Math.max(2, Math.round(cand.length * 0.02));
  clusters = clusters.filter((c) => c.n >= minN);
  if (!clusters.length) return { rows: null, error: "NOTABLE" };
  // Her kumenin sol/sag kenar dagilimi
  const nearestRight = (r) => { let bi = -1, bd = Infinity; clusters.forEach((c, i) => { const d = Math.abs(c.r - r); if (d < bd) { bd = d; bi = i; } }); return bd <= tol * 2.5 ? bi : -1; };
  const measure = () => {
    clusters.forEach((c) => { c.lefts = []; c.rights = []; });
    for (const r of cand) for (const { f } of r.amts) { const ci = nearestRight(f.r); if (ci >= 0 && Math.abs(clusters[ci].r - f.r) <= tol) { clusters[ci].lefts.push(f.x); clusters[ci].rights.push(f.r); } }
    clusters.forEach((c) => {
      const ls = c.lefts.sort((a, b) => a - b);
      c.l = ls.length ? ls[Math.floor(ls.length / 2)] : c.r - 40;
      c.lmin = ls.length ? ls[0] : c.l;
      c.lspread = ls.length ? ls[ls.length - 1] - ls[0] : 0;
      c.rspread = c.rights.length ? Math.max(...c.rights) - Math.min(...c.rights) : 0;
    });
  };
  measure();
  // Sola yasli (metin olarak saklanmis) rakamlar sahte sutun olusturur: sol kenarlari ayni, sag kenarlari farkli
  if (clusters.length > 1) {
    const real = clusters.filter((c) => !(c.lefts.length >= 3 && c.lspread <= 1.5 && c.rspread >= 2.5));
    if (real.length && real.length < clusters.length) { clusters = real; measure(); }
  }
  const numLeft = Math.min(...clusters.map((c) => c.lmin));
  // Sutun bolgeleri: her tutar sutunu, bir onceki sutunun sag kenarindan kendi sag kenarina kadar
  const zoneLo = clusters.map((c, i) => (i === 0 ? c.lmin - tol * 3 : clusters[i - 1].r + 0.5));
  const zoneHi = clusters.map((c, i) => (i === clusters.length - 1 ? c.r + tol * 3 : c.r + 0.5));
  // Tutarin sutunu: once saga yasli eslesme, olmazsa orta noktanin dustugu bolge (sola/ortaya yasli rakamlar)
  const nearestCluster = (f) => {
    const ri = nearestRight(f.r);
    if (ri >= 0 && Math.abs(clusters[ri].r - f.r) <= tol) return ri;
    const fc = (f.x + f.r) / 2;
    const zi = clusters.findIndex((c, i) => fc > zoneLo[i] && fc <= zoneHi[i]);
    return zi >= 0 ? zi : ri;
  };

  // Baslik satirlari: ilk veri satirinin sayfasinda, ondan once gelen ve borc/alacak/bakiye iceren satirlar
  const firstPage = cand[0].ln.page;
  const firstY = cand[0].ln.y;
  const pageLines = allLines.filter((l) => l.page === firstPage && l.y > firstY);
  const kw = (l) => l.items.some((f) => /borc|alacak|bakiye|bakiy|tutar|toplam/.test(normTr(f.s)));
  // Veri satirina en yakin olandan yukari dogru tara; baslik blogu bitince dur
  const hdrLines = [];
  for (let i = pageLines.length - 1, scanned = 0; i >= 0 && scanned < 8; i--, scanned++) {
    const l = pageLines[i];
    if (hdrLines.length && l.y - hdrLines[hdrLines.length - 1].y > l.h * 2.6) break;
    if (kw(l)) hdrLines.push(l);
    if (hdrLines.length >= 3) break;
  }
  hdrLines.sort((a, b) => b.y - a.y);
  const labels = clusters.map(() => []);
  for (const hl of hdrLines) {
    const hItems = hl.items.filter((f) => f.r > numLeft - tol * 3);
    if (!hItems.length) continue;
    if (hItems.length >= Math.ceil(clusters.length * 0.75)) {
      // Her sutunun kendi basligi var (sola, saga veya ortaya yasli olabilir)
      for (const f of hItems) {
        const fc = (f.x + f.r) / 2;
        const ci = clusters.findIndex((c, i) => fc > zoneLo[i] && fc <= zoneHi[i]);
        if (ci >= 0) labels[ci].push(normTr(f.s));
      }
    } else {
      // Grup basligi (TUTAR / BAKIYE gibi birden fazla sutunu kapsayan): en yakin merkeze ata
      clusters.forEach((c, ci) => {
        const cc = (zoneLo[ci] + zoneHi[ci]) / 2;
        let best = null, bd = Infinity;
        for (const f of hItems) { const d = Math.abs((f.x + f.r) / 2 - cc); if (d < bd) { bd = d; best = f; } }
        if (best) labels[ci].push(normTr(best.s));
      });
    }
  }

  // Sutun rollerini belirle
  const roles = labels.map((ls) => {
    const t = ls.join(" ");
    const bak = /bak/.test(t), b = /borc/.test(t), a = /alacak/.test(t);
    const devir = /devir|onceki|acilis/.test(t), donem = /donem|hareket|ay ici/.test(t), top = /toplam|kumulatif/.test(t);
    if (bak && b && !a) return { role: "bb" };
    if (bak && a && !b) return { role: "ab" };
    if (bak && !b && !a) return { role: "bak" };
    if (b && !a) return { role: "b", devir, donem, top };
    if (a && !b) return { role: "a", devir, donem, top };
    if (/^b\b|\bb\/a\b/.test(t)) return { role: "side" };
    return { role: null };
  });
  const pick = (role) => {
    const idx = roles.map((r, i) => (r.role === role ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) return -1;
    if (idx.length === 1) return idx[0];
    const top = idx.find((i) => roles[i].top);
    if (top != null) return top;
    const notDevir = idx.filter((i) => !roles[i].devir && !roles[i].donem);
    return notDevir.length ? notDevir[notDevir.length - 1] : idx[idx.length - 1];
  };
  let col = { b: pick("b"), a: pick("a"), bb: pick("bb"), ab: pick("ab"), bak: pick("bak") };
  // Ayni etiketten iki tane varsa ve bakiye sutunu yoksa: ikinci cift bakiyedir (iki satirli baslik)
  const bIdx = roles.map((r, i) => (r.role === "b" ? i : -1)).filter((i) => i >= 0);
  const aIdx = roles.map((r, i) => (r.role === "a" ? i : -1)).filter((i) => i >= 0);
  if (col.bb < 0 && col.ab < 0 && col.bak < 0 && bIdx.length === 2 && aIdx.length === 2 && !roles.some((r) => r.top || r.devir || r.donem)) {
    col = { b: bIdx[0], a: aIdx[0], bb: bIdx[1], ab: aIdx[1], bak: -1 };
  }
  const known = Object.values(col).some((v) => v >= 0);
  if (!known) {
    // Baslik okunamadi: sutun sayisina gore tahmin
    const n = clusters.length;
    if (n >= 4) col = { b: n - 4, a: n - 3, bb: n - 2, ab: n - 1, bak: -1 };
    else if (n === 3) col = { b: 0, a: 1, bb: -1, ab: -1, bak: 2 };
    else if (n === 2) col = { b: 0, a: 1, bb: -1, ab: -1, bak: -1 };
    else col = { b: -1, a: -1, bb: -1, ab: -1, bak: 0 };
  }

  // Veri satirlarini kur
  const out = [["Hesap Kodu", "Hesap Adı", "Borç", "Alacak", "Borç Bakiye", "Alacak Bakiye"]];
  const seen = new Set();
  let lastRow = null, lastLine = null;
  const candSet = new Map(cand.map((r) => [r.ln, r]));
  for (const ln of allLines) {
    const r = candSet.get(ln);
    if (!r) {
      // Uzun hesap adi alt satira tasmissa onceki satira ekle
      if (lastRow && lastLine && ln.page === lastLine.page && lastLine.y - ln.y < ln.h * 1.8 && !codeOf(ln) &&
          ln.items.every((f) => f.r < numLeft - 2 && f.x > (lastRow._adX || 0) - 2 && !parseAmount(f.s)) && ln.items.length <= 3) {
        lastRow[1] = (lastRow[1] + " " + ln.items.map((f) => f.s).join(" ")).trim();
        lastLine = ln;
      } else if (ln.items.length) { lastLine = null; lastRow = null; }
      continue;
    }
    const { c } = r;
    const vals = clusters.map(() => null);
    let sideFlag = null;
    const nameParts = c.rest ? [c.rest] : [];
    let adX = null;
    ln.items.forEach((f, i) => {
      if (i === 0) { if (c.rest) adX = f.x; return; }
      const a = parseAmount(f.s);
      if (a && f.r > numLeft - tol) {
        const ci = nearestCluster(f);
        if (ci >= 0) { vals[ci] = a; return; }
      }
      const sm = f.s.trim().match(SIDE_RE);
      if (sm && f.x > numLeft) { sideFlag = sm[1].toUpperCase(); return; }
      if (f.x < numLeft - 2) { nameParts.push(f.s.trim()); if (adX == null) adX = f.x; }
    });
    const get = (i) => (i >= 0 && vals[i] ? vals[i].v : 0);
    let b = get(col.b), a = get(col.a), bb = 0, ab = 0;
    if (col.bb >= 0 || col.ab >= 0) {
      bb = get(col.bb); ab = get(col.ab);
      if (bb < 0) { ab += -bb; bb = 0; }
      if (ab < 0) { bb += -ab; ab = 0; }
    } else if (col.bak >= 0 && vals[col.bak]) {
      const bv = vals[col.bak];
      const side = bv.side || sideFlag;
      const v = Math.abs(bv.v);
      if (side === "B") bb = v;
      else if (side === "A") ab = v;
      else if (bv.v < 0) ab = v;
      else if (b || a) { if (b >= a) bb = v; else ab = v; }
      else bb = v;
    } else {
      bb = Math.max(0, b - a); ab = Math.max(0, a - b);
    }
    const kod = c.kod.replace(/\s+/g, "");
    const key = kod + "|" + b + "|" + a + "|" + bb + "|" + ab;
    if (seen.has(key)) continue; // ayni satir iki kez (sayfa tekrari) gelmissse
    seen.add(key);
    const row = [kod, nameParts.join(" ").replace(/\s+/g, " ").trim(), b, a, bb, ab];
    row._adX = adX;
    out.push(row);
    lastRow = row; lastLine = ln;
  }
  if (out.length < 4) return { rows: null, error: "NOTABLE" };
  // Tablonun ustundeki baslik blogu (sirket adi, Baslangic/Bitis tarihleri): donem tespiti icin basa eklenir
  const headBlock = allLines.filter((l) => l.page === firstPage && l.y > firstY && !hdrLines.includes(l)).slice(0, 12).map((l) => l.items.map((f) => f.s));
  out.unshift(...headBlock);
  const info = { pages: pages.length, accounts: out.length - 1 - headBlock.length, columns: clusters.length, roles: col, clusters: clusters.map((c) => ({ r: Math.round(c.r), n: c.n })), labels };
  return { rows: out.map((r) => Array.from(r)), info };
}

export async function pdfToMizanRows(data, pdfjsLib, onProgress) {
  let pages;
  try {
    pages = await extractFragments(data, pdfjsLib, onProgress);
  } catch (e) {
    if (e && (e.name === "PasswordException" || /password/i.test(e.message || ""))) return { rows: null, error: "PASSWORD" };
    return { rows: null, error: "BROKEN", detail: e && e.message };
  }
  return fragmentsToMizanRows(pages);
}

export const PDF_ERRORS = {
  SCANNED: "Bu PDF taranmis (resim) gorunuyor; icinde okunabilir metin yok. Muhasebe programinizdan mizani PDF yerine Excel veya CSV olarak alin ya da PDF'i 'yazdir > PDF olarak kaydet' ile yeniden olusturun.",
  NOTABLE: "PDF okundu ama icinde mizan tablosu bulunamadi. Dosyanin hesap kodu, borc ve alacak sutunlari olan bir mizan oldugundan emin olun.",
  PASSWORD: "Bu PDF sifreli. Sifresiz bir kopyasini yukleyin.",
  BROKEN: "PDF dosyasi acilamadi (bozuk veya desteklenmeyen bir dosya olabilir).",
};
