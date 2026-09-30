// Shared site code: header and footer, formatting, API calls, wallet, avatars, charts, token box.
export const $ = s => document.querySelector(s);
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function api(path, opts) {
  const r = await fetch('/api' + path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || 'Something went wrong. Try again.'), { status: r.status, body: j });
  return j;
}
export const postJson = (path, body) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

let cfgP = null;
export const getConfig = () => (cfgP ||= api('/config').then(c => { ethUsd = c.ethUsd || null; return c; }));

// ---------- formatting
let ethUsd = null;
// dollars: $12.4K, $3.21, $0.0042
export function money(v) {
  v = Number(v) || 0;
  if (!v) return '$0';
  const f = v >= 1e9 ? (v / 1e9).toFixed(2) + 'B' : v >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : v >= 1e4 ? (v / 1e3).toFixed(1) + 'K' : v >= 1000 ? Math.round(v).toLocaleString('en-US') : v >= 1 ? v.toFixed(2) : v >= 0.01 ? v.toFixed(3) : v.toFixed(Math.min(12, Math.ceil(-Math.log10(v)) + 2));
  return '$' + f;
}
// an ETH amount shown in dollars (or ETH if the price is unknown)
export function usd(eth) {
  eth = Number(eth) || 0;
  return ethUsd ? money(eth * ethUsd) : ethAmt(eth);
}
export function ethAmt(eth, d = 4) { eth = Number(eth) || 0; return (eth >= 100 ? Math.round(eth).toLocaleString('en-US') : eth.toFixed(eth > 0 && eth < 0.0001 ? 6 : d).replace(/\.?0+$/, '') || '0') + ' ETH'; }
export function pct(x) {
  if (x == null || !isFinite(x)) return { t: '0%', c: 'up' };
  const p = x * 100; const a = Math.abs(p);
  const t = (p >= 0 ? '+' : '-') + (a >= 1000 ? Math.round(a).toLocaleString('en-US') : a >= 10 ? a.toFixed(0) : a.toFixed(1)) + '%';
  return { t, c: p >= 0 ? 'up' : 'dn' };
}
export function ago(d) {
  const s = Math.max(0, (Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return Math.floor(s) + 's ago'; if (s < 3600) return Math.floor(s / 60) + 'm ago'; if (s < 86400) return Math.floor(s / 3600) + 'h ago'; return Math.floor(s / 86400) + 'd ago';
}
export function followers(n) { n = Number(n) || 0; return n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'K' : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K' : String(n); }
export const CHECK = '<svg class="vf" viewBox="0 0 24 24" aria-label="Verified"><path fill="#1FE08A" d="M22.5 12.5c0-1.58-.88-2.95-2.18-3.65.15-.44.23-.91.23-1.4 0-2.21-1.71-3.98-3.82-3.98-.47 0-.92.08-1.34.25C14.77 2.39 13.44 1.5 11.9 1.5c-1.54 0-2.87.89-3.49 2.2-.42-.16-.87-.25-1.34-.25-2.11 0-3.82 1.77-3.82 3.98 0 .49.08.96.23 1.4C2.18 9.55 1.3 10.92 1.3 12.5c0 1.5.8 2.8 1.97 3.52-.02.16-.03.32-.03.48 0 2.21 1.71 3.98 3.82 3.98.47 0 .92-.09 1.34-.25.62 1.31 1.95 2.2 3.49 2.2 1.54 0 2.87-.89 3.49-2.2.42.16.87.25 1.34.25 2.11 0 3.82-1.77 3.82-3.98 0-.16-.01-.32-.03-.48 1.17-.72 1.97-2.02 1.97-3.52z"/><path fill="#04130A" d="M10.54 16.2 6.8 12.46l1.41-1.41 2.33 2.33 5.25-5.25 1.41 1.41z"/></svg>';
// small line under a handle: real name and followers when we know them
export function subline(c, fallback) { const p = c.profile; if (!p) return fallback; return esc(p.name || '') + (p.followers ? ` <span style="opacity:.7">${followers(p.followers)} followers</span>` : ''); }
export const short = a => a ? a.slice(0, 6) + '...' + a.slice(-4) : '';

// ---------- avatars (profile picture, or initials on a color picked from the handle)
const GR = [['#D9FF4A', '#1FE08A'], ['#6FE7FF', '#2E7BFF'], ['#FFB86B', '#FF5C7A'], ['#C69BFF', '#6A5BFF'], ['#7CFFCB', '#12B886'], ['#FFE27A', '#FF9F43'], ['#FF8FD8', '#B24BF3'], ['#9BE7FF', '#3FC1C9']];
export function hue(h) { let n = 0; for (const c of String(h).toLowerCase()) n = (n * 31 + c.charCodeAt(0)) >>> 0; return GR[n % GR.length]; }
export function avatar(handle, cls = '') {
  const g = hue(handle);
  return `<div class="av ${cls}" style="background:linear-gradient(135deg,${g[0]},${g[1]})">${esc(String(handle)[0].toUpperCase())}<img src="/avatar/${encodeURIComponent(handle)}" alt="" loading="lazy" onerror="this.remove()"></div>`;
}

// ---------- charts
export function spark(values, { w = 200, h = 54, up = true, big = false, id = Math.random().toString(36).slice(2) } = {}) {
  let a = (values || []).filter(v => v > 0);
  if (a.length === 1) a = [a[0], a[0]];
  if (a.length < 2) return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><line x1="0" y1="${h - 4}" x2="${w}" y2="${h - 4}" stroke="rgba(255,255,255,.08)" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
  const mx = Math.max(...a), mn = Math.min(...a), pad = 4;
  const p = a.map((v, i) => [(i / (a.length - 1)) * w, h - pad - ((v - mn) / (mx - mn || 1)) * (h - pad * 2)]);
  const d = p.map((q, i) => (i ? 'L' : 'M') + q[0].toFixed(1) + ' ' + q[1].toFixed(1)).join(' ');
  const c = up ? '#1FE08A' : '#FF5C7A';
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><defs><linearGradient id="g${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c}" stop-opacity=".35"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></linearGradient></defs><path d="${d} L${w} ${h} L0 ${h}Z" fill="url(#g${id})"/><path d="${d}" fill="none" stroke="${c}" stroke-width="${big ? 2.5 : 2}" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>`;
}
export const isUp = c => c.change24 == null || c.change24 >= 0;

// ---------- wallet: MetaMask, Rabby, Coinbase Wallet or any browser wallet, on Robinhood Chain
const CHAIN = { chainId: '0x1237', chainName: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://rpc.mainnet.chain.robinhood.com'], blockExplorerUrls: ['https://robinhoodchain.blockscout.com'] };
let current = null;
export function walletProvider() { return window.ethereum || null; }
function setBtn(a) { const b = document.getElementById('walletBtn'); if (b) b.textContent = a ? short(a) : 'Connect wallet'; }
async function onRobinhood(p) {
  const id = await p.request({ method: 'eth_chainId' });
  if (String(id).toLowerCase() === CHAIN.chainId) return;
  try { await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN.chainId }] }); }
  catch (e) {
    if (e.code === 4902 || /unrecognized|not added|unknown chain/i.test(e.message)) await p.request({ method: 'wallet_addEthereumChain', params: [CHAIN] });
    else throw e;
  }
}
export async function connectWallet() {
  const p = walletProvider();
  if (!p) throw new Error('Install a wallet like MetaMask or Rabby to continue.');
  const [a] = await p.request({ method: 'eth_requestAccounts' });
  if (!a) throw new Error('Wallet did not connect.');
  await onRobinhood(p);
  current = { provider: p, address: a };
  setBtn(a);
  return current;
}
export function connectedWallet() { return current; }
// fills in the wallet if the site was already allowed before (no popup)
export async function restoreWallet() {
  const p = walletProvider(); if (!p) return null;
  try { const [a] = await p.request({ method: 'eth_accounts' }); if (a) { current = { provider: p, address: a }; setBtn(a); } } catch {}
  return current;
}
// send a transaction the server built, then wait until it is in a block
export async function sendTx(w, t) {
  await onRobinhood(w.provider);
  const hash = await w.provider.request({ method: 'eth_sendTransaction', params: [{ from: w.address, to: t.to, data: t.data, value: t.value }] });
  for (let i = 0; i < 180; i++) {
    const rc = await w.provider.request({ method: 'eth_getTransactionReceipt', params: [hash] }).catch(() => null);
    if (rc) { if (rc.status === '0x1' || rc.status === 1) return hash; throw new Error('The transaction failed on chain. Nothing was taken except gas.'); }
    await new Promise(r => setTimeout(r, 1000));
  }
  return hash;
}
export const cancelled = e => e?.code === 4001 || /reject|denied|cancel/i.test(e?.message || '');
export const txLink = (cfg, hash) => `${cfg.explorer}/tx/${hash}`;
if (window.ethereum?.on) window.ethereum.on('accountsChanged', a => { current = a?.[0] ? { provider: window.ethereum, address: a[0] } : null; setBtn(current?.address); });

// ---------- ui bits
export function toast(html, ms = 2600) {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const t = document.createElement('div'); t.className = 'toast'; t.innerHTML = html; document.body.appendChild(t); setTimeout(() => t.remove(), ms);
}
export async function copy(text, btn) {
  try { await navigator.clipboard.writeText(text); if (btn) { const o = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => (btn.textContent = o), 1500); } else toast('Copied'); }
  catch { prompt('Copy this:', text); }
}
export function overlay(title, text) {
  const o = document.createElement('div'); o.className = 'ovl';
  o.innerHTML = `<div class="card"><div class="spin"></div><h3>${esc(title)}</h3><p>${esc(text)}</p></div>`;
  document.body.appendChild(o);
  return { set: (t, x) => { o.querySelector('h3').textContent = t; o.querySelector('p').textContent = x; }, close: () => o.remove() };
}
export const ARROW = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7M9 7h8v8"/></svg>';

export function header(active = '') {
  const el = document.getElementById('hdr');
  el.innerHTML = `<nav class="bar">
    <a class="brand" href="/"><img src="/coin.png" alt="">IPO</a>
    <div class="links"><a href="/markets" class="${active === 'markets' ? 'on' : ''}">Markets</a><a href="/markets?sort=new" class="${active === 'new' ? 'on' : ''}">Just listed</a><a href="/#how">How it works</a><a href="/claim" class="${active === 'claim' ? 'on' : ''}">Claim</a></div>
    <div class="navr"><a class="btn" id="buyIpo" href="#" target="_blank" rel="noopener">Buy $IPO</a><button class="btn pri" id="walletBtn">Connect wallet</button></div>
  </nav>`;
  const wb = el.querySelector('#walletBtn');
  wb.addEventListener('click', async () => { try { await connectWallet(); } catch (e) { toast(esc(e.message)); } });
  restoreWallet();
  getConfig().then(c => { const b = el.querySelector('#buyIpo'); if (c.buyUrl) b.href = c.buyUrl; else { b.removeAttribute('target'); b.href = '/#token'; } }).catch(() => {});
}

export function footer() {
  const el = document.getElementById('ftr');
  el.innerHTML = `<footer><span>© ${new Date().getFullYear()} IPO</span><div class="links"><a href="/markets">Markets</a><a href="/#how">How it works</a><a href="/claim">Claim your account</a><a id="xfoot" href="#" target="_blank" rel="noopener">X</a></div></footer>`;
  getConfig().then(c => { el.querySelector('#xfoot').href = 'https://x.com/' + c.xHandle; }).catch(() => {});
}

export async function tokenBox(el) {
  const c = await getConfig();
  const inner = c.tokenCa
    ? `<span class="lbl">Contract address</span><code><span>${esc(c.tokenCa)}</span><button id="caCopy">Copy</button></code><div class="row2"><a class="btn pri" href="${esc(c.buyUrl)}" target="_blank" rel="noopener">Buy $IPO</a><a class="btn" href="${esc(c.explorer)}/token/${esc(c.tokenCa)}" target="_blank" rel="noopener">View on explorer</a></div>`
    : `<span class="lbl">Contract address</span><code><span style="color:var(--mute)">Launching soon</span></code><div class="row2"><a class="btn" href="https://x.com/${esc(c.xHandle)}" target="_blank" rel="noopener">Follow on X</a></div>`;
  el.innerHTML = `<div class="token" id="token"><div class="in">
    <div><span class="eyebrow"><b>$IPO</b>The token behind every listing</span><h2 style="margin-top:22px">One token.<br>Every account.</h2><p>Every account that goes public on IPO feeds $IPO. The more accounts list and trade, the more the whole market grows.</p></div>
    <div class="ca">${inner}</div></div></div>`;
  el.querySelector('#caCopy')?.addEventListener('click', e => copy(c.tokenCa, e.currentTarget));
}
