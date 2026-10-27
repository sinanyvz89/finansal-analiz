/* ── Yapay zeka yorumu: veri paketi + sunucu ile akisli iletisim ──
   Gizlilik: yalnizca 3 haneli ana hesap toplamlari, tablolar, oranlar ve gider kalemleri gonderilir.
   Alt hesaplardaki musteri/tedarikci/personel isimleri gonderilmez. */

// Sunucudaki (api/yorum.js) talimatin aynisi; "Claude'da yorumlat" yedek yolunda kullanilir.
export const SYSTEM_PROMPT = `Sen Türkiye'de çalışan deneyimli bir Serbest Muhasebeci Mali Müşavir ve finansal analistsin. Tek Düzen Hesap Planı, VUK ve TFRS uygulamalarını iyi bilirsin.

Sana bir şirketin mizanından "FinAnaliz" programının hesapladığı tablolar, oranlar ve veri kontrolleri verilecek. Görevin bunları işletme sahibi ve yönetici için yorumlamak.

Kurallar:
- Yalnızca verilen rakamlara dayan; rakam uydurma. Bir bilgi veride yoksa "veride yok" de.
- Önce "Veri kontrolleri" bölümüne bak. Açılış kaydı eksikliği, satılan mal maliyeti kaydı olmaması, ters bakiye gibi sorunlar varsa hangi sonuçların bu yüzden güvenilmez olduğunu açıkça söyle ve o oranları aşırı yorumlama.
- Mizanlar yıl başından dönem sonuna kümülatiftir. Dönem bir yıldan kısaysa kârlılık, ROE ve ROA dönemliktir; yıllık sektör aralıklarıyla karşılaştırırken bunu belirt.
- Rakamları Türk biçimiyle ve TL olarak yaz (örn. 1.250.000 TL). Yüzdeleri bir ondalıkla ver.
- Somut ol: hangi hesap, hangi tutar, hangi oran. Genel geçer tavsiyelerden kaçın.
- Vergi ve hukuki konularda kesin hüküm verme; "kontrol edilmeli" diye belirt. Yatırım tavsiyesi verme.
- Türkçe karakterleri doğru kullanarak sade ve yönetici dostu yaz. Markdown kullan.

İlk yorumda şu başlıkları kullan:
## Özet
(3-4 cümle: işletmenin genel durumu)
## Öne çıkan bulgular
## Riskler ve dikkat edilmesi gerekenler
## Kayıt / veri kaynaklı uyarılar
(veri kontrollerinde sorun yoksa bu başlığı atla)
## Dönem karşılaştırması
(birden fazla dönem verildiyse; yoksa atla)
## Öneriler
(öncelik sırasına göre numaralı; her biri tek cümlelik eylem ve gerekçe)

Toplam uzunluk yaklaşık 400-700 kelime olsun. Sonraki takip sorularına kısa ve doğrudan, verideki rakamlara atıfla cevap ver.`;

const fN = (n) => (n == null || isNaN(n) ? "-" : Number(n).toLocaleString("tr-TR", { minimumFractionDigits: 0, maximumFractionDigits: 0 }));
const f2 = (n, d = 2) => (n == null || isNaN(n) || !isFinite(n) ? "-" : Number(n).toLocaleString("tr-TR", { minimumFractionDigits: d, maximumFractionDigits: d }));
const fmtD = (iso) => { if (!iso) return ""; const [y, m, d] = iso.split("-"); return d + "." + m + "." + y; };

function table(head, rows) {
  return "| " + head.join(" | ") + " |\n|" + head.map((_, i) => (i === 0 ? "---" : "---:")).join("|") + "|\n" + rows.map((r) => "| " + r.join(" | ") + " |").join("\n");
}

/* Programin hesapladigi her seyi tek bir metin paketine donusturur */
export function buildAiData({ mizanlar, gelirler, bilancolar, analizler, kontroller, idx, donemBilgi, sektor }) {
  const P = idx.filter((i) => mizanlar[i]);
  const names = P.map((i) => mizanlar[i].donem);
  const out = [];
  out.push("# FinAnaliz finansal veri paketi");
  out.push("Para birimi TL. Mizanlar yil basindan donem sonuna kumulatiftir.");
  P.forEach((i, k) => {
    const d = donemBilgi(mizanlar[i]);
    out.push((k === 0 ? "Ana donem: " : "Karsilastirma donemi: ") + mizanlar[i].donem + (d.bas ? " (" + fmtD(d.bas) + " - " + fmtD(d.son) + ", " + d.gun + " gun)" : " (donem uzunlugu bilinmiyor, 365 gun varsayildi)"));
  });

  // Gelir tablosu
  const G = P.map((i) => gelirler[i] || {});
  const gRows = [
    ["Brut satislar", "brutSatis"], ["Satis indirimleri (-)", "satisInd"], ["Net satislar", "netSatis"], ["Satislarin maliyeti (-)", "satisMal"], ["Brut kar", "brutKar"],
    ["Faaliyet giderleri (-)", "faalGid"], ["Faaliyet kari", "faalKar"], ["Diger faaliyet gelirleri", "digerGel"], ["Diger faaliyet giderleri (-)", "digerGid"],
    ["Finansman giderleri (-)", "finGid"], ["Olagan kar", "olaganKar"], ["Olagandisi gelirler", "odGel"], ["Olagandisi giderler (-)", "odGid"], ["Donem net kari", "donemKari"],
  ];
  out.push("\n## Gelir tablosu (TL)");
  out.push(table(["Kalem", ...names], gRows.map(([l, k]) => [l, ...G.map((g) => fN(g[k]))])));

  // Bilanco
  const B = P.map((i) => bilancolar[i] || {});
  const bRows = [
    ["Donen varliklar", "donen"], ["  Hazir degerler", "nakit"], ["  Ticari alacaklar", "tAlacak"], ["  Stoklar", "stok"], ["Duran varliklar", "duran"], ["AKTIF TOPLAM", "aktif"],
    ["Kisa vadeli yabanci kaynaklar", "kvyk"], ["  Ticari borclar", "tBorc"], ["Uzun vadeli yabanci kaynaklar", "uvyk"], ["Ozkaynaklar (donem kari dahil)", "ozk"], ["PASIF TOPLAM", "pasif"],
  ];
  out.push("\n## Bilanco ozeti (TL)");
  out.push(table(["Kalem", ...names], bRows.map(([l, k]) => [l, ...B.map((b) => fN(b[k]))])));

  // Oranlar
  const A = P.map((i) => analizler[i] || {});
  const sk = sektor || null;
  const rng = (key, pct) => (sk && sk[key] ? (pct ? "%" + sk[key][0] + " - %" + sk[key][1] : sk[key][0] + " - " + sk[key][1]) : "-");
  const oRows = [
    ["Cari oran", (a) => f2(a.co), rng("cariOran")], ["Asit-test orani", (a) => f2(a.at), rng("asitTest")], ["Nakit orani", (a) => f2(a.no), rng("nakitOrani")],
    ["Borc / Ozkaynak", (a) => f2(a.bo), rng("borcOzkaynak")], ["Brut kar marji %", (a) => f2(a.bkm, 1), rng("brutKarMarji", true)], ["Faaliyet kar marji %", (a) => f2(a.fkm, 1), rng("faalKarMarji", true)],
    ["Net kar marji %", (a) => f2(a.nkm, 1), rng("netKarMarji", true)], ["ROE % (donemlik)", (a) => f2(a.roe, 1), rng("roe", true)], ["ROA % (donemlik)", (a) => f2(a.roa, 1), rng("roa", true)],
    ["Alacak tahsil suresi (gun)", (a) => f2(a.ag, 0), rng("alacakGun")], ["Stok devir suresi (gun)", (a) => f2(a.sg, 0), rng("stokGun")],
  ];
  out.push("\n## Finansal oranlar");
  out.push(table(["Oran", ...names, "Sektor araligi" + (sk ? " (" + sk.ad + ", yillik)" : "")], oRows.map(([l, fn, r]) => [l, ...A.map((a) => fn(a)), r])));

  // Ana hesaplar (3 haneli)
  const main = P.map((i) => new Map(mizanlar[i].rows.filter((x) => /^\d{3}$/.test(x.kod)).map((x) => [x.kod, x])));
  const codes = [...new Set(main.flatMap((m) => [...m.keys()]))].sort();
  const accRows = [];
  for (const kod of codes) {
    const vals = main.map((m) => { const x = m.get(kod); return x ? x.bBak - x.aBak : 0; });
    if (vals.every((v) => Math.abs(v) < 0.5)) continue;
    const ad = (main.find((m) => m.get(kod)) || new Map()).get(kod)?.ad || "";
    accRows.push([kod, ad, ...vals.map((v) => (Math.abs(v) < 0.5 ? "0" : fN(Math.abs(v)) + (v > 0 ? " B" : " A")))]);
  }
  out.push("\n## Ana hesap bakiyeleri (3 haneli; B = borc bakiyesi, A = alacak bakiyesi)");
  out.push(table(["Kod", "Hesap", ...names], accRows));

  // Gider kalemleri (en yuksek 15 alt hesap, 6x/7x gider hesaplari)
  const isGider = (k) => /^(62|63|65|66|68|69|71|72|73|74|75|76|77|78)/.test(k);
  const leafs = P.map((i) => { const rows = mizanlar[i].rows; const set = new Set(rows.map((x) => x.kod)); return new Map(rows.filter((x) => isGider(x.kod) && x.kod.length > 3 && ![...set].some((o) => o !== x.kod && o.startsWith(x.kod + "."))).map((x) => [x.kod, x])); });
  const top = [...leafs[0].values()].map((x) => [x.kod, x.ad, x.bBak - x.aBak]).filter(([, , v]) => v > 0).sort((a, b) => b[2] - a[2]).slice(0, 15);
  if (top.length) {
    out.push("\n## En buyuk 15 gider kalemi (alt hesap, ana donem)");
    out.push(table(["Kod", "Gider", ...names], top.map(([k, ad]) => [k, ad, ...leafs.map((m) => { const x = m.get(k); return x ? fN(x.bBak - x.aBak) : "0"; })])));
  }

  // Veri kontrolleri
  out.push("\n## Veri kontrolleri (programin otomatik tespitleri)");
  P.forEach((i) => {
    const ks = kontroller[i] || [];
    out.push("### " + mizanlar[i].donem);
    out.push(ks.length ? ks.map((k) => "- [" + (k.seviye === "kotu" ? "HATA" : k.seviye === "orta" ? "DIKKAT" : "BILGI") + "] " + k.baslik + ": " + k.aciklama).join("\n") : "- Sorun bulunmadi.");
  });
  return out.join("\n");
}

export const ODAKLAR = [
  { id: "genel", ad: "Genel degerlendirme", ek: "" },
  { id: "karlilik", ad: "Karlilik", ek: "Ozellikle karlilik, maliyet yapisi ve gider kalemlerine odaklan." },
  { id: "likidite", ad: "Likidite ve nakit", ek: "Ozellikle likidite, nakit yonetimi, alacak/stok/borc dongusune odaklan." },
  { id: "risk", ad: "Vergi ve kayit riskleri", ek: "Ozellikle kayit hatalari, ters bakiyeler, vergi incelemesinde sorun cikarabilecek noktalara odaklan." },
  { id: "karsilastirma", ad: "Donem karsilastirmasi", ek: "Ozellikle donemler arasi degisimlere ve trendlere odaklan." },
];

export function ilkMesaj(data, odak) {
  const o = ODAKLAR.find((x) => x.id === odak) || ODAKLAR[0];
  return data + "\n\n---\nYukaridaki verileri yorumla." + (o.ek ? " " + o.ek : "");
}

/* Sunucu durumu: { durum: "hazir" | "anahtar-yok" | "sunucu-yok", kodGerekli } */
export async function sunucuDurumu() {
  try {
    const r = await fetch("/api/yorum", { method: "GET", headers: { accept: "application/json" }, cache: "no-store" });
    if (!r.ok) return { durum: "sunucu-yok" };
    const j = await r.json();
    return { durum: j.configured ? "hazir" : "anahtar-yok", kodGerekli: !!j.needsCode, model: j.model };
  } catch (e) {
    return { durum: "sunucu-yok" };
  }
}

/* Akisli istek: her parca geldikce onChunk(tumMetin) cagrilir */
export async function yorumIste(messages, { kod, signal, onChunk }) {
  const r = await fetch("/api/yorum", {
    method: "POST",
    headers: { "content-type": "application/json", ...(kod ? { "x-erisim-kodu": kod } : {}) },
    body: JSON.stringify({ messages }),
    signal,
  });
  if (!r.ok) {
    let j = {}; try { j = await r.json(); } catch (e) { /* yoksay */ }
    const msg = j.error === "BAD_CODE" ? "Erisim kodu hatali." : j.error === "NO_KEY" ? "Sunucuda ANTHROPIC_API_KEY tanimli degil." : j.error === "TOO_LARGE" ? "Gonderilen veri cok buyuk." : j.error === "UPSTREAM" ? "Yapay zeka servisi hata dondu (" + (j.status || "") + "). " + (j.detail || "") : "Sunucu hatasi (" + r.status + ").";
    const e = new Error(msg); e.code = j.error || r.status; throw e;
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
    onChunk && onChunk(text);
  }
  text += dec.decode();
  onChunk && onChunk(text);
  return text;
}
