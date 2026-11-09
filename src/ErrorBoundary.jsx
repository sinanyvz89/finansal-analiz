import React from 'react'

/* Uygulama cokerse bos beyaz sayfa yerine hatayi ve cozum dugmelerini gosterir. */
async function tumVerileriTemizle() {
  try { localStorage.clear() } catch (e) { /* yoksay */ }
  try { await new Promise((r) => { const q = indexedDB.deleteDatabase('finanaliz'); q.onsuccess = q.onerror = q.onblocked = () => r() }) } catch (e) { /* yoksay */ }
  try { if ('caches' in window) { const ks = await caches.keys(); await Promise.all(ks.map((k) => caches.delete(k))) } } catch (e) { /* yoksay */ }
  try { if (navigator.serviceWorker) { const rs = await navigator.serviceWorker.getRegistrations(); await Promise.all(rs.map((r) => r.unregister())) } } catch (e) { /* yoksay */ }
  location.replace(location.pathname)
}

export default class ErrorBoundary extends React.Component {
  constructor(p) { super(p); this.state = { err: null } }
  static getDerivedStateFromError(err) { return { err } }
  componentDidCatch(err, info) { try { console.error('FinAnaliz hata:', err, info && info.componentStack) } catch (e) { /* yoksay */ } }
  render() {
    const { err } = this.state
    if (!err) return this.props.children
    const box = { maxWidth: 560, margin: '48px auto', padding: 24, borderRadius: 14, border: '1px solid rgba(163,45,45,0.4)', background: 'var(--color-background-primary, #fff)', color: 'var(--color-text-primary, #1a1a1a)', fontFamily: '-apple-system, Segoe UI, Roboto, sans-serif' }
    const btn = { padding: '10px 16px', fontSize: 14, fontWeight: 600, borderRadius: 10, border: 'none', cursor: 'pointer', marginRight: 8, marginTop: 8 }
    return (
      <div style={box}>
        <div style={{ fontSize: 18, fontWeight: 650, marginBottom: 8 }}>Uygulama acilirken bir hata olustu</div>
        <div style={{ fontSize: 14, lineHeight: 1.7, color: 'var(--color-text-secondary, #555)' }}>
          Once sayfayi yenileyin. Duzelmezse bu cihazda kayitli verileri temizleyip yeniden baslatin (yuklediginiz mizanlari tekrar yuklemeniz gerekir).
        </div>
        <div>
          <button style={{ ...btn, background: '#185FA5', color: '#fff' }} onClick={() => location.reload()}>Yenile</button>
          <button style={{ ...btn, background: '#FCEBEB', color: '#A32D2D' }} onClick={tumVerileriTemizle}>Verileri temizle ve yeniden baslat</button>
        </div>
        <pre style={{ marginTop: 16, padding: 12, borderRadius: 8, background: 'rgba(0,0,0,0.05)', fontSize: 12, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{String((err && (err.stack || err.message)) || err).slice(0, 1200)}</pre>
        <div style={{ fontSize: 12, color: '#888' }}>Sorun surerse bu kutudaki yaziyi kopyalayip gonderin.</div>
      </div>
    )
  }
}
export { tumVerileriTemizle }
