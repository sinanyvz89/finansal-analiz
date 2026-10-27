/* FinAnaliz yapay zeka yorum sunucusu (Vercel Edge Function)
   Gerekli ortam degiskeni:  ANTHROPIC_API_KEY  (Vercel > Project > Settings > Environment Variables)
   Istege bagli:             APP_ACCESS_CODE    (tanimlanirsa uygulamada bu kod istenir; baskalarinin anahtarinizi kullanmasini engeller)
                             ANTHROPIC_MODEL    (varsayilan: claude-sonnet-5-5)
   Anahtar sadece sunucuda durur, tarayiciya gonderilmez. */
export const config = { runtime: "edge" };

const SYSTEM_PROMPT = `Sen Türkiye'de çalışan deneyimli bir Serbest Muhasebeci Mali Müşavir ve finansal analistsin. Tek Düzen Hesap Planı, VUK ve TFRS uygulamalarını iyi bilirsin.

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

const MAX_CHARS = 120000;   // istek basina en fazla metin
const MAX_MESSAGES = 24;    // konusma basina en fazla mesaj

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

export default async function handler(req) {
  const key = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
  const code = process.env.APP_ACCESS_CODE || "";

  if (req.method === "GET") return json({ ok: true, configured: !!key, needsCode: !!code, model });
  if (req.method !== "POST") return json({ error: "METHOD" }, 405);
  if (!key) return json({ error: "NO_KEY" }, 501);
  if (code && req.headers.get("x-erisim-kodu") !== code) return json({ error: "BAD_CODE" }, 401);

  let body;
  try { body = await req.json(); } catch (e) { return json({ error: "BAD_JSON" }, 400); }
  const msgs = Array.isArray(body && body.messages) ? body.messages : null;
  if (!msgs || !msgs.length || msgs.length > MAX_MESSAGES) return json({ error: "BAD_MESSAGES" }, 400);
  let total = 0;
  const messages = [];
  for (const m of msgs) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string" || !m.content.trim()) return json({ error: "BAD_MESSAGES" }, 400);
    total += m.content.length;
    messages.push({ role: m.role, content: m.content });
  }
  if (total > MAX_CHARS) return json({ error: "TOO_LARGE" }, 413);
  if (messages[0].role !== "user" || messages[messages.length - 1].role !== "user") return json({ error: "BAD_MESSAGES" }, 400);

  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 4000, system: SYSTEM_PROMPT, messages, stream: true }),
  }).catch((e) => ({ ok: false, status: 0, text: async () => String(e && e.message) }));

  if (!upstream.ok) {
    const detail = (await upstream.text().catch(() => "")).slice(0, 400);
    return json({ error: "UPSTREAM", status: upstream.status, detail }, 502);
  }

  // Anthropic SSE akisini duz metin akisina cevir (tarayici tarafi basit kalsin)
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const stream = new ReadableStream({
    async start(controller) {
      const reader = upstream.body.getReader();
      let buf = "";
      const handle = (line) => {
        if (!line.startsWith("data:")) return;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") return;
        let ev; try { ev = JSON.parse(data); } catch (e) { return; }
        if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") controller.enqueue(enc.encode(ev.delta.text));
        else if (ev.type === "message_delta" && ev.delta && ev.delta.stop_reason === "max_tokens") controller.enqueue(enc.encode("\n\n_(Yanit uzunluk sinirina ulasti.)_"));
        else if (ev.type === "error") controller.enqueue(enc.encode("\n\n**Hata:** " + ((ev.error && ev.error.message) || "bilinmeyen hata")));
      };
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n")) >= 0) { handle(buf.slice(0, i).replace(/\r$/, "")); buf = buf.slice(i + 1); }
        }
        if (buf) handle(buf);
      } catch (e) {
        controller.enqueue(enc.encode("\n\n**Baglanti kesildi.**"));
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
}
