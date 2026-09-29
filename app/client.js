// Resenha: cliente (UI + voz WebRTC + chat + DJ). Módulo ES.
import { RnnoiseWorkletNode } from './vendor/ns/index.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const native = window.resenhaNative || null;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const DJ_ID = 'dj-resenha';
const DJ_NAME = 'DJ Resenha';

// ---------------- Persistência ----------------
const LS = {
  get(k, d) { try { const v = localStorage.getItem('resenha.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { localStorage.setItem('resenha.' + k, JSON.stringify(v)); },
};
const COLORS = ['#5865f2', '#eb459e', '#57f287', '#fee75c', '#ed4245', '#f47b67', '#3ba55c', '#faa61a', '#9b59b6', '#1abc9c'];
const me = LS.get('profile', { name: '', color: COLORS[Math.floor(Math.random() * COLORS.length)], avatar: null });
const settings = Object.assign({
  inputDevice: 'default', outputDevice: 'default', micGain: 100, autoSens: true, threshold: -55,
  aiNoise: true, vadSens: 60, echoCancellation: true, autoGain: true, sounds: true,
  voiceFx: 'normal', pitchSemis: 0, theme: 'discord',
  keyMute: '', keyDeafen: '', chatWidth: 440, sidebarWidth: 240,
  layout: ['sidebar', 'call', 'chat'], tileOrder: [], pipCorner: 'br', fontScale: 100, compact: false,
  userVolumes: {}, userMuted: {}, streamVolumes: {},
}, LS.get('settings', {}));
if ('noiseSuppression' in settings) { settings.aiNoise = settings.noiseSuppression; delete settings.noiseSuppression; }
const saveSettings = () => LS.set('settings', settings);
// id fixo deste app: mantém as ligações de voz vivas quando a sala troca de anfitrião
const CID = LS.get('cid') || (() => { const c = [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, '0')).join(''); LS.set('cid', c); return c; })();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FX = {
  normal: { name: 'Normal', semis: 0, robot: 0 },
  grave: { name: 'Grave', semis: -4, robot: 0 },
  monstro: { name: 'Monstro', semis: -8, robot: 0 },
  agudo: { name: 'Agudo', semis: 4, robot: 0 },
  esquilo: { name: 'Esquilo', semis: 9, robot: 0 },
  robo: { name: 'Robô', semis: 0, robot: 0.85 },
  demonio: { name: 'Demônio', semis: -10, robot: 0.35 },
  custom: { name: 'Personalizado', semis: null, robot: 0 },
};

// ---------------- Estado ----------------
const S = {
  ws: null, addr: null, base: '', token: '', myId: null, turn: null, isHost: false, hostKey: null, password: '',
  users: new Map(), roomName: '', serverOffset: 0, closing: false, reconnectTries: 0, lastPing: null,
  channels: [], history: {}, textChannel: null, unread: new Set(), typing: new Map(),
  replyTo: null, editing: null, dj: null, djAvailable: false,
};
const V = {
  joined: false, channel: null, muted: LS.get('muted', false), deafened: LS.get('deafened', false), mutedBeforeDeafen: false,
  ctx: null, raw: null, src: null, micGain: null, rn: null, rnReady: false, fx: null, analyser: null, gate: null, dest: null,
  gateOpen: false, gateHold: 0, vadOpen: false, vadLevel: 0,
  master: null, screenMaster: null, peers: new Map(), speaking: new Set(), selfLevel: -100,
  screen: null, screenSenders: new Map(), focus: null, monitor: null,
  djAudio: null, djGain: null, djAnalyser: null, djTrack: null,
};
const semisToRatio = (s) => Math.pow(2, s / 12);

// ---------------- Utilidades de UI ----------------
function toast(msg, type = '', ms = 3500) {
  for (const old of $$('#toasts .toast')) if (old.textContent === msg) old.remove();
  const t = document.createElement('div');
  t.className = 'toast ' + type; t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), ms);
}
function initials(name) { return (name || '?').trim().split(/\s+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase() || '?'; }
function avatarHTML(u, cls = '') {
  if (u.bot || u.id === DJ_ID) return `<div class="avatar dj-av ${cls}">${icon('music', 18)}</div>`;
  const bg = u.avatar ? `background-image:url(${u.avatar})` : `background-color:${u.color || '#5865f2'}`;
  return `<div class="avatar ${cls}" style="${bg}">${u.avatar ? '' : esc(initials(u.name))}</div>`;
}
function setAvatarEl(el, u) {
  el.style.backgroundImage = u.avatar ? `url(${u.avatar})` : '';
  el.style.backgroundColor = u.avatar ? '' : (u.color || '#5865f2');
  el.textContent = u.avatar ? '' : initials(u.name);
}
function fmtSize(b) { if (b < 1024) return b + ' B'; if (b < 1048576) return (b / 1024).toFixed(1) + ' KB'; if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB'; return (b / 1073741824).toFixed(2) + ' GB'; }
function fmtTime(ts) {
  const d = new Date(ts), now = new Date();
  const hm = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return hm;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Ontem às ' + hm;
  return d.toLocaleDateString('pt-BR') + ' ' + hm;
}
function fmtDur(ms) { const s = Math.max(0, Math.floor(ms / 1000)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); }
const serverNow = () => Date.now() + S.serverOffset;
function copy(text) { navigator.clipboard.writeText(text).then(() => toast('Copiado!', 'ok', 1500)); }

function openModal(html, { wide = false, onClose, cls = '' } = {}) {
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `<div class="modal ${wide ? 'wide' : ''} ${cls}">${html}</div>`;
  const close = () => { ov.remove(); document.removeEventListener('keydown', onKey, true); onClose && onClose(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  document.addEventListener('keydown', onKey, true);
  $('#modal-root').appendChild(ov);
  $$('[data-close]', ov).forEach((b) => (b.onclick = close));
  return { el: ov, close };
}
function promptModal(title, { value = '', placeholder = '', ok = 'Salvar', extra = '' } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const m = openModal(`<header><div><h2>${esc(title)}</h2></div><button class="icon-btn" data-close>${icon('x')}</button></header>
      <div class="body">${extra}<div class="field"><input id="pm-in" maxlength="32" value="${esc(value)}" placeholder="${esc(placeholder)}"></div></div>
      <footer><button class="btn" data-close>Cancelar</button><button class="btn primary" id="pm-ok">${esc(ok)}</button></footer>`, { onClose: () => { if (!done) resolve(null); } });
    const inp = $('#pm-in', m.el); inp.focus(); inp.select();
    const go = () => { done = true; const r = { value: inp.value.trim(), el: m.el }; m.close(); resolve(r); };
    $('#pm-ok', m.el).onclick = go;
    inp.onkeydown = (e) => { if (e.key === 'Enter') go(); };
  });
}
function confirmModal(title, text, ok = 'Confirmar', danger = true) {
  return new Promise((resolve) => {
    let done = false;
    const m = openModal(`<header><div><h2>${esc(title)}</h2><p>${text}</p></div></header>
      <footer><button class="btn" data-close>Cancelar</button><button class="btn ${danger ? 'danger' : 'primary'}" id="cm-ok">${esc(ok)}</button></footer>`, { onClose: () => { if (!done) resolve(false); } });
    $('#cm-ok', m.el).onclick = () => { done = true; m.close(); resolve(true); };
  });
}

// Menu de contexto genérico
function showMenu(e, html, bindFn) {
  e.preventDefault(); e.stopPropagation();
  const menu = $('#ctx-menu');
  menu.innerHTML = html;
  menu.classList.remove('hidden');
  const r = menu.getBoundingClientRect();
  menu.style.left = clamp(e.clientX, 4, innerWidth - r.width - 4) + 'px';
  menu.style.top = clamp(e.clientY, 4, innerHeight - r.height - 4) + 'px';
  bindFn && bindFn(menu);
}
const hideMenu = () => $('#ctx-menu').classList.add('hidden');

// ---------------- Sons (sintetizados) ----------------
let sfxCtx = null;
function sfx(kind) {
  if (!settings.sounds) return;
  try {
    if (!sfxCtx) { sfxCtx = new AudioContext(); if (settings.outputDevice !== 'default' && sfxCtx.setSinkId) sfxCtx.setSinkId(settings.outputDevice).catch(() => {}); }
    const seq = { join: [[523, 0], [784, .09]], leave: [[784, 0], [523, .09]], mute: [[440, 0], [330, .07]], unmute: [[330, 0], [440, .07]], msg: [[880, 0], [1175, .06]], mention: [[988, 0], [1319, .07], [1568, .14]], share: [[523, 0], [659, .07], [784, .14]] }[kind] || [[600, 0]];
    const t0 = sfxCtx.currentTime + 0.01;
    for (const [f, dt] of seq) {
      const o = sfxCtx.createOscillator(), g = sfxCtx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0, t0 + dt); g.gain.linearRampToValueAtTime(0.12, t0 + dt + 0.01); g.gain.exponentialRampToValueAtTime(0.001, t0 + dt + 0.16);
      o.connect(g).connect(sfxCtx.destination); o.start(t0 + dt); o.stop(t0 + dt + 0.18);
    }
  } catch {}
}

// ---------------- Tela inicial ----------------
function parseAddr(s) {
  s = String(s || '').trim().replace(/^(https?|wss?):\/\//i, '').replace(/\/.*$/, '');
  if (!s) return null;
  let host, port;
  if (s.startsWith('[')) { const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(s); if (!m) return null; host = m[1]; port = m[2]; }
  else if ((s.match(/:/g) || []).length > 1) host = s;
  else [host, port] = s.split(':');
  port = Number(port) || 7777;
  if (!host) return null;
  const hf = host.includes(':') ? `[${host}]` : host;
  return { host, port, hf, text: `${hf}:${port}` };
}
const CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  const r = crypto.getRandomValues(new Uint8Array(8));
  const s = [...r].map((b) => CODE_ABC[b % CODE_ABC.length]).join('');
  return s.slice(0, 4) + '-' + s.slice(4);
}
const fmtCode = (c) => { const s = String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); return s.length === 8 ? s.slice(0, 4) + '-' + s.slice(4) : s; };
const looksLikeAddr = (s) => /[.:[]/.test(String(s || '').trim());

function initHome() {
  $('#home-name').value = me.name;
  $('#home-color').value = me.color;
  setAvatarEl($('#home-avatar'), me);
  $('#home-avatar').classList.add('avatar');
  $('#home-name').oninput = () => { me.name = $('#home-name').value; LS.set('profile', me); setAvatarEl($('#home-avatar'), me); };
  $('#home-color').oninput = () => { me.color = $('#home-color').value; LS.set('profile', me); setAvatarEl($('#home-avatar'), me); };
  $('#home-avatar').onclick = () => pickAvatar(() => setAvatarEl($('#home-avatar'), me));
  const last = LS.get('lastHost', {});
  $('#host-name').value = last.name || '';
  $('#host-port').value = last.port || 7777;
  $('#btn-host').onclick = hostRoom;
  $('#btn-join').onclick = () => joinRoom($('#join-addr').value, $('#join-pass').value);
  $('#join-addr').onkeydown = $('#join-pass').onkeydown = (e) => { if (e.key === 'Enter') $('#btn-join').click(); };
  if (!native) { $('#btn-host').disabled = true; $('#btn-host').textContent = 'Criar sala só no app'; }
  else native.version().then((v) => { $('#home-version').textContent = 'Resenha v' + v; });
  renderRecent();
}
function renderRecent() {
  const list = LS.get('recent', []);
  $('#recent').innerHTML = list.length ? `<div class="field" style="margin:0"><label>Recentes</label></div>` + list.map((r, i) =>
    `<div class="recent-item" data-i="${i}"><span><b>${esc(r.name || 'Sala')}</b> <span class="muted small">${esc(r.addr)}</span></span><span class="x" data-x="${i}">${icon('x', 16)}</span></div>`).join('') : '';
  $$('.recent-item', $('#recent')).forEach((el) => el.onclick = (e) => {
    const i = +el.dataset.i;
    if (e.target.closest('[data-x]')) { list.splice(i, 1); LS.set('recent', list); return renderRecent(); }
    $('#join-addr').value = list[i].addr; joinRoom(list[i].addr, $('#join-pass').value);
  });
}
function addRecent(addr, name) {
  const list = LS.get('recent', []).filter((r) => r.addr !== addr);
  list.unshift({ addr, name }); LS.set('recent', list.slice(0, 6));
}
function pickAvatar(done) {
  const inp = $('#avatar-input');
  inp.value = '';
  inp.onchange = () => {
    const f = inp.files[0]; if (!f) return;
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = c.height = 128;
      const s = Math.min(img.width, img.height);
      c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 128, 128);
      me.avatar = c.toDataURL('image/jpeg', 0.85); LS.set('profile', me);
      URL.revokeObjectURL(img.src); if (done) done(); sendProfile();
    };
    img.src = URL.createObjectURL(f);
  };
  inp.click();
}
function checkName() {
  if (!me.name.trim()) { $('#home-error').textContent = 'Coloca seu nome primeiro.'; $('#home-name').focus(); return false; }
  return true;
}

async function hostRoom() {
  if (!checkName()) return;
  const roomName = $('#host-name').value.trim() || `Sala do ${me.name}`;
  const port = Number($('#host-port').value) || 7777;
  const password = $('#host-pass').value;
  LS.set('lastHost', { name: $('#host-name').value.trim(), port });
  $('#btn-host').disabled = true; $('#home-error').textContent = '';
  const codes = LS.get('roomCodes', {});
  const code = codes[roomName] || (codes[roomName] = newCode());
  LS.set('roomCodes', codes);
  const r = await native.startHost({ roomName, port, password, code, rank: [0, Date.now(), CID] });
  $('#btn-host').disabled = false;
  if (!r.ok) { $('#home-error').textContent = r.error; return; }
  S.code = code; S.isHost = true; S.hostKey = r.hostKey; S.viaCode = null; S.joinedAt = Date.now(); S.epoch = 0; S.forceGuest = false;
  connect(parseAddr('127.0.0.1:' + r.port), password, true);
}

async function joinRoom(addrText, password) {
  if (!checkName()) return;
  S.viaCode = null;
  if (addrText && !looksLikeAddr(addrText)) return joinByCode(addrText, password);
  const a = parseAddr(addrText);
  if (!a) { $('#home-error').textContent = 'Código ou endereço inválido. Exemplo: K7P4-QX9M'; return; }
  $('#btn-join').disabled = true; $('#home-error').textContent = 'Conectando...';
  try {
    const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 7000);
    const info = await fetch(`http://${a.text}/api/info`, { signal: ctl.signal }).then((r) => r.json());
    clearTimeout(to);
    if (info.app !== 'resenha') throw new Error('não é sala do Resenha');
    if (info.needsPassword && !password) { $('#home-error').textContent = 'Essa sala tem senha.'; $('#join-pass').focus(); $('#btn-join').disabled = false; return; }
    S.isHost = false; S.hostKey = null; S.code = null; S.joinedAt = Date.now(); S.forceGuest = false;
    addRecent(a.text, info.name);
    connect(a, password, true);
  } catch (e) {
    $('#home-error').textContent = `Não consegui chegar na sala ${a.text}.\nConfere se o IP e a porta estão certos, se a sala está aberta e se o anfitrião liberou a porta.`;
  }
  $('#btn-join').disabled = false;
}

async function joinByCode(codeText, password) {
  const code = fmtCode(codeText);
  if (code.replace('-', '').length !== 8) { $('#home-error').textContent = 'O código tem 8 letras/números, tipo K7P4-QX9M.'; return; }
  if (!window.Tun) { $('#home-error').textContent = 'Entrar por código só funciona no app.'; return; }
  $('#btn-join').disabled = true; $('#home-error').textContent = 'Procurando a sala...';
  try {
    const t = await Tun.guestConnect(code, (s) => ($('#home-error').textContent = s));
    const a = parseAddr(t.addr);
    const info = await fetch(`http://${a.text}/api/info`).then((r) => r.json());
    if (info.needsPassword && !password) { Tun.guestClose(); $('#home-error').textContent = 'Essa sala tem senha.'; $('#join-pass').focus(); $('#btn-join').disabled = false; return; }
    S.isHost = false; S.hostKey = null; S.viaCode = code; S.code = code; S.joinedAt = Date.now(); S.forceGuest = false;
    addRecent(code, info.name);
    connect(a, password, true);
  } catch (e) {
    Tun.guestClose();
    const msg = {
      notfound: `Não achei a sala ${code}.\nConfere o código e se o anfitrião está com a sala aberta.`,
      nobroker: 'Sem internet, ou algo está bloqueando o app (antivírus/firewall).',
      p2p: 'Achei a sala, mas não consegui ligar os dois PCs.\nA rede de um de vocês bloqueia conexão direta (comum em rede de faculdade/empresa ou 4G). Tente trocar quem abre a sala.',
    }[e.message] || 'Erro: ' + e.message;
    $('#home-error').textContent = msg;
  }
  $('#btn-join').disabled = false;
}
// Tun é declarado como const em tunnel.js (script clássico): fica no escopo global léxico
window.Tun = typeof Tun !== 'undefined' ? Tun : null; // eslint-disable-line no-undef

// ---------------- Conexão com a sala ----------------
function connect(addr, password, first) {
  S.addr = addr; S.password = password; S.closing = false;
  S.base = `http://${addr.text}`;
  const ws = new WebSocket(`ws://${addr.text}`);
  S.ws = ws;
  ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', cid: CID, joinedAt: S.joinedAt, name: me.name.trim(), color: me.color, avatar: me.avatar, password, hostKey: S.hostKey }));
  ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } handle(m); };
  ws.onclose = (ev) => {
    if (S.ws !== ws || S.closing) return;
    if (ev.code === 4001) { leaveRoom(); $('#home-error').textContent = 'Senha incorreta.'; return; }
    if (ev.code === 4002) { leaveRoom(); $('#home-error').textContent = 'O anfitrião encerrou a sala.'; return; }
    if (!S.myId && first && ev.code !== 4004) { leaveRoom(); $('#home-error').textContent = 'A conexão caiu antes de entrar.'; return; }
    // Sala com código: se o anfitrião cair, outro amigo assume e todo mundo reconecta sozinho
    if (S.code && window.Tun && native) { failover(ev.code); return; }
    const wasIn = V.joined ? V.channel : null;
    teardownVoice();
    S.myId = null;
    setConnStatus('bad', 'Reconectando...');
    if (S.reconnectTries++ > 30) { leaveRoom(); $('#home-error').textContent = 'Perdi a conexão com a sala.'; return; }
    setTimeout(async () => {
      if (S.closing) return;
      S.rejoinVoice = S.rejoinVoice || wasIn;
      let a = addr;
      if (S.viaCode && !Tun.guestAlive()) {
        try { const t = await Tun.guestConnect(S.viaCode, () => {}); a = parseAddr(t.addr); } catch {}
      }
      connect(a, password, false);
    }, 2000);
  };
}
function wsSend(obj) { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(obj)); }

// ---------------- Troca automática de anfitrião ----------------
// Todo mundo guarda uma cópia da sala. Se o anfitrião cair, quem entrou primeiro (entre os que sobraram)
// abre a sala com o MESMO código e a cópia; os outros procuram o código e reconectam.
function successionOrder() {
  return [...S.users.values()]
    .filter((u) => u.id !== DJ_ID && u.joinedAt && !u.isHost)
    .sort((a, b) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : 1));
}
function snapshot() {
  return {
    channels: S.channels, history: S.history,
    dj: S.dj && S.dj.active ? { active: true, channelId: S.dj.channelId, textChannel: S.dj.textChannel, queue: S.dj.queue } : null,
  };
}
function showBanner(text, kind = 'warn') {
  let b = $('#conn-banner');
  if (!b) { b = document.createElement('div'); b.id = 'conn-banner'; $('#main').appendChild(b); }
  b.className = kind; b.innerHTML = `<span class="spinner"></span><span>${text}</span>`;
}
function hideBanner() { $('#conn-banner')?.remove(); }

async function failover(closeCode) {
  if (S.failing) return;
  S.failing = true;
  const code = S.code, myId = S.myId, epoch = (S.epoch || 0) + 1;
  const wasHost = S.isHost;
  S.quietUntil = Date.now() + 20000;
  const order = successionOrder().filter((u) => u.id !== (wasHost ? myId : null));
  const snap = snapshot();
  const mine = order.findIndex((u) => u.id === myId);
  S.myId = null; S.ws = null; S.token = S.token || '';
  setConnStatus('bad', 'Reconectando...');
  try {
    if (!wasHost && !S.forceGuest) {
      // Fila de sucessão: o 1º assume já; os outros esperam um pouco pra dar chance a quem vem antes.
      // 4004 = o anfitrião passou a sala pra outro que já existe: só procurar.
      const delay = closeCode === 4004 ? 20000 : mine < 0 ? 12000 : mine * 6000;
      showBanner(mine === 0 ? 'O anfitrião caiu. Você está assumindo a sala...' : 'O anfitrião caiu. Trocando de anfitrião...');
      if (delay) {
        // tenta achar o novo anfitrião enquanto espera a vez
        try {
          const t = await Tun.guestConnect(code, () => {}, { attempts: 1, timeoutMs: delay });
          return reconnectTo(parseAddr(t.addr));
        } catch {}
        if (S.closing) return;
      }
      if (S.closing) return;
      await becomeHost(code, epoch, snap);
      return;
    }
    // Eu era o anfitrião (ou fui mandado ser convidado): procuro a sala como convidado
    showBanner('Procurando a sala...');
    const t = await Tun.guestConnect(code, () => {}, { attempts: 4, timeoutMs: 15000 });
    return reconnectTo(parseAddr(t.addr));
  } catch (e) {
    if (S.closing) return;
    // Ninguém respondeu: tenta assumir (se não fui eu que desisti de hospedar)
    if (!S.forceGuest) { try { await becomeHost(code, epoch, snap); return; } catch {} }
    S.failing = false;
    if (S.reconnectTries++ > 8) { leaveRoom(); $('#home-error').textContent = 'Perdi a conexão com a sala.'; return; }
    setTimeout(() => failover(closeCode), 3000);
  } finally { S.failing = false; }
}
function reconnectTo(addr) {
  S.isHost = false; S.hostKey = null; S.viaCode = S.code;
  connect(addr, S.password, false);
}
async function becomeHost(code, epoch, snap) {
  showBanner('Você virou o anfitrião da sala. Os outros estão reconectando...', 'ok');
  const r = await native.startHost({ roomName: S.roomName, port: (S.addr && S.isHost ? S.addr.port : 7777), autoPort: true, password: S.password, code, epoch, restore: snap, rank: [epoch, S.joinedAt || Date.now(), CID] });
  if (!r.ok) throw new Error(r.error);
  S.isHost = true; S.hostKey = r.hostKey; S.viaCode = null;
  toast('Você agora é o anfitrião da sala.', 'ok', 5000);
  connect(parseAddr('127.0.0.1:' + r.port), S.password, false);
}
// Se aparecer outro anfitrião com prioridade maior pro mesmo código, eu passo a sala pra ele
if (window.Tun) Tun.onYield(async () => {
  if (!S.isHost || S.closing) return;
  S.forceGuest = true;
  await native.stopHost(4004);
});
// cópia dos anexos pequenos (até 50 MB) pra eles sobreviverem à troca de anfitrião
function cacheAttachments(msg) {
  if (!native || !S.code || S.isHost || !msg.attachments) return;
  for (const a of msg.attachments) if (a.size <= 50 * 1024 * 1024) native.cacheFile({ code: S.code, id: a.id, name: a.name, size: a.size, url: fileUrl(a) });
}
function sendProfile() { wsSend({ t: 'profile', name: me.name, color: me.color, avatar: me.avatar }); }

const textChannels = () => S.channels.filter((c) => c.type === 'text');
const voiceChannels = () => S.channels.filter((c) => c.type === 'voice');
const chanById = (id) => S.channels.find((c) => c.id === id);
const mentionsMe = (m) => m.userId !== S.myId && ((m.mentions || []).some((n) => n.toLowerCase() === me.name.toLowerCase() || n === 'todos') || (m.text || '').toLowerCase().includes('@' + me.name.toLowerCase()));

function handle(m) {
  switch (m.t) {
    case 'welcome': {
      S.myId = m.id; S.token = m.token; S.turn = m.turn; S.roomName = m.room.name; S.reconnectTries = 0;
      if (m.code) S.code = m.code;
      S.epoch = m.epoch || 0;
      hideBanner();
      S.serverOffset = m.serverTime - Date.now();
      S.users = new Map(m.users.map((u) => [u.id, u]));
      S.channels = m.channels; S.history = m.history || {};
      S.dj = m.dj; S.djAvailable = m.djAvailable;
      if (!chanById(S.textChannel)) S.textChannel = textChannels()[0]?.id;
      // ligações de voz com quem sumiu da sala: espera um pouco (na troca de anfitrião a galera volta aos poucos)
      clearTimeout(S.peerSweep);
      S.peerSweep = setTimeout(() => { for (const id of [...V.peers.keys()]) { const u = S.users.get(id); if (!u || u.voiceChannel !== V.channel) closePeer(id); } renderCall(); }, 20000);
      for (const list of Object.values(S.history)) for (const msg of list) cacheAttachments(msg);
      showMain();
      renderMessages();
      renderAll();
      syncDJ();
      if (V.joined) { // reconectou (troca de anfitrião): a voz continuou, só avisa o novo servidor
        if (!chanById(V.channel)) V.channel = voiceChannels()[0]?.id;
        wsSend({ t: 'state', voiceChannel: V.channel, muted: V.muted, deafened: V.deafened, sharing: !!V.screen, screenStreamId: V.screen ? V.screen.id : null });
        setConnStatus('good', 'Voz conectada');
      } else if (S.rejoinVoice) { const c = S.rejoinVoice; S.rejoinVoice = null; joinVoice(chanById(c) ? c : voiceChannels()[0]?.id); }
      else if (S.isHost && !S.invitedOnce) { S.invitedOnce = true; openInvite(); }
      break;
    }
    case 'error': toast(m.msg, 'err', 5000); break;
    case 'user-join': S.users.set(m.user.id, m.user); if (m.user.id === DJ_ID && V.joined && m.user.voiceChannel === V.channel) sfx('join'); renderAll(); break;
    case 'user-leave': {
      const u = S.users.get(m.id);
      if (u && V.joined && u.voiceChannel === V.channel && Date.now() > (S.quietUntil || 0)) sfx('leave');
      S.users.delete(m.id); closePeer(m.id); S.typing.delete(m.id); renderAll(); renderTyping();
      break;
    }
    case 'user-update': {
      const prev = S.users.get(m.user.id) || {};
      S.users.set(m.user.id, m.user);
      if (m.user.id !== S.myId && V.joined) {
        const wasHere = prev.voiceChannel === V.channel, isHere = m.user.voiceChannel === V.channel;
        const quiet = Date.now() < (S.quietUntil || 0);
        if (!wasHere && isHere && !quiet) sfx('join');
        if (wasHere && !isHere) { if (!quiet) sfx('leave'); closePeer(m.user.id); }
        if (prev.sharing && !m.user.sharing && V.focus === 'screen:' + m.user.id) V.focus = null;
      }
      reclassifyStreams(); applyUserVolume(m.user.id);
      renderAll();
      break;
    }
    case 'channels': {
      S.channels = m.channels;
      if (!chanById(S.textChannel)) { S.textChannel = textChannels()[0]?.id; renderMessages(); }
      for (const k of Object.keys(S.history)) if (!chanById(k)) delete S.history[k];
      if (V.joined && !chanById(V.channel)) leaveVoice();
      renderAll(); renderChatHeader();
      break;
    }
    case 'chat': {
      const msg = m.msg;
      const list = (S.history[msg.channelId] = S.history[msg.channelId] || []);
      list.push(msg); if (list.length > 1000) list.splice(0, 200);
      S.typing.delete(msg.userId); renderTyping();
      cacheAttachments(msg);
      if (msg.channelId === S.textChannel) appendMessage(msg);
      else if (msg.userId !== S.myId) { S.unread.add(msg.channelId); renderChannels(); }
      if (msg.userId !== S.myId) {
        const ment = mentionsMe(msg);
        if (ment) sfx('mention');
        if (!document.hasFocus() || document.hidden) { if (!ment) sfx('msg'); native && native.notify({ title: (ment ? '🔔 ' : '') + msg.name + ' em #' + (chanById(msg.channelId)?.name || ''), body: msg.text || '📎 Anexo' }); }
      }
      break;
    }
    case 'msg-edit': {
      const msg = (S.history[m.channelId] || []).find((x) => x.id === m.id);
      if (msg) { msg.text = m.text; msg.editedAt = m.editedAt; msg.mentions = m.mentions; }
      if (m.channelId === S.textChannel) rerenderMsg(m.id);
      break;
    }
    case 'msg-delete': {
      const list = S.history[m.channelId] || [];
      const i = list.findIndex((x) => x.id === m.id);
      if (i > -1) list.splice(i, 1);
      if (m.channelId === S.textChannel) renderMessages(true);
      break;
    }
    case 'typing': if (m.channelId === S.textChannel) { S.typing.set(m.id, Date.now()); renderTyping(); } break;
    case 'signal': onSignal(m.from, m.data); break;
    case 'room': S.roomName = m.room.name; renderHeader(); break;
    case 'pong': {
      const rtt = Date.now() - m.ts; S.lastPing = rtt;
      if (m.serverTime) { const off = m.serverTime + rtt / 2 - Date.now(); S.serverOffset = S.offsetInit ? S.serverOffset * 0.8 + off * 0.2 : off; S.offsetInit = true; }
      updatePing(); break;
    }
    case 'dj': S.dj = m.dj; syncDJ(); renderAll(); renderDJPanel(); break;
    case 'dj-busy': S.djBusy = m.busy; renderDJPanel(); break;
  }
}

function showMain() {
  $('#home').classList.add('hidden');
  $('#main').classList.remove('hidden');
  $('#home-error').textContent = '';
}

async function leaveRoom(endForAll) {
  S.closing = true;
  teardownVoice();
  hideBanner();
  try { if (S.ws) S.ws.close(); } catch {}
  const wasHost = S.isHost;
  S.ws = null; S.myId = null; S.users.clear(); S.history = {}; S.invitedOnce = false; S.rejoinVoice = null; S.dj = null;
  // 4003: a sala continua com outro anfitrião. 4002: encerra pra todo mundo.
  if (wasHost && native) await native.stopHost(endForAll ? 4002 : 4003);
  if (S.viaCode && window.Tun) Tun.guestClose();
  S.isHost = false; S.viaCode = null; S.code = null;
  syncDJ();
  $('#main').classList.add('hidden');
  $('#home').classList.remove('hidden');
  pushTray();
  renderRecent();
}

// ---------------- Render: barra lateral ----------------
const usersIn = (cid) => [...S.users.values()].filter((u) => u.voiceChannel === cid);
const myVoiceUsers = () => (V.joined ? usersIn(V.channel) : []);
function renderHeader() {
  $('#room-name').textContent = S.roomName;
  $('#tb-title').textContent = S.roomName + ' · Resenha';
  $('#rail-room').textContent = initials(S.roomName);
  $('#rail-room').title = S.roomName;
  document.title = S.roomName + ' · Resenha';
}
function statusIcons(u) {
  let h = '';
  if (u.sharing) h += '<span class="live">AO VIVO</span>';
  if (u.id === DJ_ID && S.dj && S.dj.current) h += `<span class="st-note">${icon('music', 14)}</span>`;
  if (u.deafened) h += icon('headphonesOff', 16, 'red');
  else if (u.muted) h += icon('micOff', 16, 'red');
  if (u.id !== S.myId && settings.userMuted[u.name]) h += icon('volume', 16, 'red');
  return h;
}
function renderChannels() {
  $('#text-channels').innerHTML = textChannels().map((c) =>
    `<div class="channel ${c.id === S.textChannel ? 'active' : ''} ${S.unread.has(c.id) ? 'unread' : ''}" draggable="true" data-ch="${c.id}">${icon('hash', 20)}<span class="cn">${esc(c.name)}</span><button class="ch-edit" data-edit="${c.id}" title="Editar canal">${icon('settings', 14)}</button></div>`).join('');
  $('#voice-channels').innerHTML = voiceChannels().map((c) => {
    const us = usersIn(c.id);
    const since = us.filter((u) => u.voiceSince).map((u) => u.voiceSince);
    return `<div class="channel voice ${V.joined && V.channel === c.id ? 'connected' : ''}" draggable="true" data-vch="${c.id}">${icon('volume', 20)}<span class="cn">${esc(c.name)}</span><span class="timer" data-since="${since.length ? Math.min(...since) : ''}"></span><button class="ch-edit" data-edit="${c.id}" title="Editar canal">${icon('settings', 14)}</button></div>
      <div class="voice-users">${us.map((u) => `<div class="vu ${isSpeaking(u.id) ? 'speaking' : ''} ${u.id === DJ_ID ? 'is-dj' : ''}" data-uid="${u.id}">${avatarHTML(u)}<span class="nm">${esc(u.name)}${u.isHost ? '<span class="tag">HOST</span>' : ''}${u.id === DJ_ID ? '<span class="tag bot">BOT</span>' : ''}</span><span class="st">${statusIcons(u)}</span></div>`).join('')}</div>`;
  }).join('');
  tickTimers();
}
function renderSidebar() {
  renderHeader();
  renderChannels();
  const others = [...S.users.values()].filter((u) => !u.voiceChannel);
  $('#online-cat').textContent = `Na sala (fora da call) · ${others.length}`;
  $('#online-cat').classList.toggle('hidden', !others.length);
  $('#online-users').innerHTML = others.map((u) =>
    `<div class="ou" data-uid="${u.id}">${avatarHTML(u)}<span>${esc(u.name)}${u.id === S.myId ? ' <span class="muted small">(você)</span>' : ''}${u.isHost ? '<span class="tag">HOST</span>' : ''}</span></div>`).join('');
  setAvatarEl($('#up-avatar'), me);
  $('#up-name').textContent = me.name;
  $('#up-sub').textContent = V.joined ? 'Em voz' : 'Online';
  const muteOff = V.muted || V.deafened;
  $('#btn-mute').innerHTML = icon(muteOff ? 'micOff' : 'mic');
  $('#btn-mute').classList.toggle('off', muteOff);
  $('#btn-deafen').innerHTML = icon(V.deafened ? 'headphonesOff' : 'headphones');
  $('#btn-deafen').classList.toggle('off', V.deafened);
  $('#voice-panel').classList.toggle('hidden', !V.joined);
  $('#vp-share').classList.toggle('on', !!V.screen);
  $('#vp-share').innerHTML = icon(V.screen ? 'screenOff' : 'screen');
  $('#vp-dj').classList.toggle('on', !!(S.dj && S.dj.active && S.dj.channelId === V.channel));
  $('#vp-sub').textContent = `${chanById(V.channel)?.name || ''} / ${S.roomName}`;
}
function tickTimers() {
  $$('#voice-channels .timer').forEach((t) => { const s = +t.dataset.since; t.textContent = s ? fmtDur(serverNow() - s) : ''; });
}
function isSpeaking(id) {
  if (id === S.myId) return V.joined && !V.muted && !V.deafened && (settings.aiNoise && V.rnReady ? V.vadOpen : V.gateOpen);
  return V.speaking.has(id);
}

// ---------------- Render: call ----------------
const tileCache = new Map();
function makeTile(key) {
  const t = document.createElement('div');
  t.className = 'tile'; t.dataset.key = key;
  if (key.startsWith('user:')) t.draggable = true;
  t.innerHTML = `<div class="tile-body"></div><div class="label"></div><div class="tile-tools"></div>`;
  t.onclick = (e) => {
    if (e.target.closest('.tile-tools')) return;
    if (key === 'user:' + DJ_ID) return openDJPanel();
    if (key.startsWith('screen:')) { V.focus = V.focus === key ? null : key; renderCall(); }
  };
  t.oncontextmenu = (e) => { const uid = key.split(':')[1]; if (uid !== S.myId) userMenu(e, uid); };
  tileCache.set(key, t);
  return t;
}
function updateTile(key, u, isScreen) {
  const t = tileCache.get(key) || makeTile(key);
  t.classList.toggle('is-screen', isScreen);
  t.classList.toggle('speaking', !isScreen && isSpeaking(u.id));
  const body = t.firstElementChild;
  if (isScreen) {
    const stream = u.id === S.myId ? V.screen : getRemoteScreen(u.id);
    let v = body.querySelector('video');
    if (!v) { body.innerHTML = '<video autoplay playsinline muted></video><span class="live">AO VIVO</span>'; v = body.querySelector('video'); }
    if (stream && v.srcObject !== stream) { v.srcObject = stream; v.play().catch(() => {}); }
    const tools = t.querySelector('.tile-tools');
    if (!tools.dataset.ok) {
      tools.dataset.ok = 1;
      tools.innerHTML = `<button title="Tela cheia">${icon('maximize', 18)}</button>`;
      tools.firstChild.onclick = () => { const vid = t.querySelector('video'); (document.fullscreenElement ? document.exitFullscreen() : vid.requestFullscreen()).catch(() => {}); };
    }
    t.querySelector('.label').innerHTML = `<span>${esc(u.name)}${u.id === S.myId ? ' (sua tela)' : ''}</span>`;
    t.title = V.focus === key ? 'Clique para diminuir' : 'Clique para ampliar';
  } else if (u.id === DJ_ID) {
    const cur = S.dj && S.dj.current;
    const sig = 'dj' + (cur ? cur.id : '') + (S.dj && S.dj.loading);
    if (body.dataset.sig !== sig) {
      body.dataset.sig = sig;
      body.innerHTML = `<div class="dj-tile">${avatarHTML(u)}<div class="dj-now">${cur ? esc(cur.title) : S.dj && S.dj.loading ? 'Carregando música...' : 'Fila vazia: clique pra adicionar'}</div></div>`;
    }
    t.querySelector('.label').innerHTML = `<span>${DJ_NAME}</span>`;
  } else {
    const sig = (u.avatar || '') + u.color + u.name;
    if (body.dataset.sig !== sig) { body.dataset.sig = sig; body.innerHTML = avatarHTML(u); }
    t.querySelector('.label').innerHTML = (u.deafened ? icon('headphonesOff', 14) : u.muted ? icon('micOff', 14) : '') + `<span>${esc(u.name)}</span>`;
  }
  return t;
}
function getRemoteScreen(uid) {
  const p = V.peers.get(uid); const u = S.users.get(uid);
  if (!p || !u || !u.screenStreamId) return null;
  return p.streams.get(u.screenStreamId) || null;
}
function renderCall() {
  const stage = $('#call-stage');
  const vcId = V.joined ? V.channel : voiceChannels()[0]?.id;
  const vc = chanById(vcId);
  $('#call-title').textContent = vc ? vc.name : 'Call';
  const vu = V.joined ? myVoiceUsers() : [];
  $('#call-count').textContent = vu.length ? `· ${vu.length} na call` : '';
  $('#call-controls').classList.toggle('hidden', !V.joined);
  const djHere = S.dj && S.dj.active && S.dj.channelId === V.channel;
  $('#btn-dj').classList.toggle('hidden', !V.joined || !S.djAvailable);
  $('#btn-dj').classList.toggle('on', !!djHere);
  $('#btn-dj').innerHTML = `${icon('music', 16)}<span>${djHere ? 'DJ Resenha' : 'Chamar DJ'}</span>`;
  if (!V.joined) {
    tileCache.clear(); $('#pips').innerHTML = '';
    const blocks = voiceChannels().map((c) => {
      const us = usersIn(c.id);
      return `<div class="vc-card" data-join="${c.id}"><div class="vc-name">${icon('volume', 18)} ${esc(c.name)}</div>
        <div class="avatars">${us.slice(0, 6).map((u) => avatarHTML(u)).join('')}</div>
        <div class="muted small">${us.length ? us.map((u) => esc(u.name)).join(', ') : 'Ninguém aqui ainda'}</div>
        <button class="btn green">Entrar</button></div>`;
    }).join('');
    stage.innerHTML = `<div class="call-empty"><h2>Canais de voz</h2><div class="vc-cards">${blocks}</div></div>`;
    $$('[data-join]', stage).forEach((el) => el.onclick = () => joinVoice(el.dataset.join));
    return;
  }
  // Pessoas (e o DJ) no grid; telas compartilhadas viram miniaturas no canto
  const people = sortByTileOrder(vu).map((u) => ({ key: 'user:' + u.id, u, screen: false }));
  const screens = vu.filter((u) => u.sharing || (u.id === S.myId && V.screen)).map((u) => ({ key: 'screen:' + u.id, u, screen: true }));
  const keys = new Set([...people, ...screens].map((t) => t.key));
  for (const k of [...tileCache.keys()]) if (!keys.has(k)) tileCache.delete(k);
  if (V.focus && !keys.has(V.focus)) V.focus = null;
  const pEls = people.map((x) => updateTile(x.key, x.u, false));
  const sEls = screens.map((x) => updateTile(x.key, x.u, true));
  stage.querySelector('.call-empty')?.remove();
  const pips = $('#pips');
  if (V.focus) {
    let wrap = stage.querySelector('.focus-wrap');
    if (!wrap) { stage.innerHTML = '<div class="focus-wrap"><div class="focus-main"></div><div class="focus-strip"></div></div>'; wrap = stage.firstChild; }
    const main = wrap.firstChild, strip = wrap.lastChild;
    const fEl = tileCache.get(V.focus);
    if (main.firstChild !== fEl) main.replaceChildren(fEl);
    pEls.forEach((e, i) => { if (strip.children[i] !== e) strip.insertBefore(e, strip.children[i] || null); });
    while (strip.children.length > pEls.length) strip.lastChild.remove();
    const rest = sEls.filter((e) => e !== fEl);
    rest.forEach((e, i) => { if (pips.children[i] !== e) pips.insertBefore(e, pips.children[i] || null); });
    while (pips.children.length > rest.length) pips.lastChild.remove();
  } else {
    let grid = stage.querySelector('.grid');
    if (!grid) { stage.innerHTML = '<div class="grid"></div>'; grid = stage.firstChild; }
    pEls.forEach((e, i) => { if (grid.children[i] !== e) grid.insertBefore(e, grid.children[i] || null); });
    while (grid.children.length > pEls.length) grid.lastChild.remove();
    sEls.forEach((e, i) => { if (pips.children[i] !== e) pips.insertBefore(e, pips.children[i] || null); });
    while (pips.children.length > sEls.length) pips.lastChild.remove();
    layoutGrid();
  }
  for (const e of sEls) e.title = V.focus === e.dataset.key ? 'Clique para diminuir' : 'Clique para ampliar';
  $('#cc-mute').innerHTML = icon(V.muted || V.deafened ? 'micOff' : 'mic', 24);
  $('#cc-mute').classList.toggle('off', V.muted || V.deafened);
  $('#cc-deafen').innerHTML = icon(V.deafened ? 'headphonesOff' : 'headphones', 24);
  $('#cc-deafen').classList.toggle('off', V.deafened);
  $('#cc-share').innerHTML = icon(V.screen ? 'screenOff' : 'screen', 24);
  $('#cc-share').classList.toggle('on', !!V.screen);
  $('#cc-share').title = V.screen ? 'Parar de compartilhar' : 'Compartilhar tela';
  $('#cc-leave').innerHTML = icon('phoneOff', 24);
}
function layoutGrid() {
  const grid = $('#call-stage .grid'); if (!grid) return;
  const n = grid.children.length || 1;
  const W = grid.clientWidth, H = grid.clientHeight, gap = 10;
  let best = { cols: 1, w: 0, h: 0, rows: 1 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    let w = (W - gap * (cols - 1)) / cols; let h = w * 9 / 16;
    if (h * rows + gap * (rows - 1) > H) { h = (H - gap * (rows - 1)) / rows; w = h * 16 / 9; }
    if (w > best.w) best = { cols, w, h, rows };
  }
  grid.style.gridTemplateColumns = `repeat(${best.cols}, ${Math.floor(best.w)}px)`;
  grid.style.gridTemplateRows = `repeat(${best.rows}, ${Math.floor(best.h)}px)`;
}
new ResizeObserver(() => layoutGrid()).observe(document.getElementById('call-stage'));

function renderAll() { renderSidebar(); renderCall(); pushTray(); }
function pushTray() { if (native) native.voiceState({ inVoice: V.joined, muted: V.muted || V.deafened, deafened: V.deafened }); }

function refreshSpeaking() {
  $$('#voice-channels .vu').forEach((el) => el.classList.toggle('speaking', isSpeaking(el.dataset.uid)));
  for (const [k, t] of tileCache) if (k.startsWith('user:')) t.classList.toggle('speaking', isSpeaking(k.slice(5)));
}

// ---------------- Voz: cadeia de áudio ----------------
// mic -> ganho -> RNNoise (IA: tira ruído e corta quando não é voz) -> filtro de voz (tom) -> portão/mute -> envio
function iceServers() {
  const list = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }, { urls: 'stun:stun.cloudflare.com:3478' }];
  if (S.turn && !S.isHost && !S.viaCode) {
    list.unshift({ urls: `stun:${S.addr.hf}:${S.turn.port}` });
    list.push({ urls: `turn:${S.addr.hf}:${S.turn.port}?transport=udp`, username: S.turn.username, credential: S.turn.credential });
  }
  return list;
}

let rnBinary = null;
async function ensureAudio() {
  if (!V.ctx) {
    V.ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
    V.master = V.ctx.createGain(); V.master.connect(V.ctx.destination);
    V.dest = V.ctx.createMediaStreamDestination();
    V.micGain = V.ctx.createGain();
    V.pre = V.ctx.createGain(); // entrada do filtro de voz
    V.analyser = V.ctx.createAnalyser(); V.analyser.fftSize = 512; V.analyser.smoothingTimeConstant = 0.2;
    V.gate = V.ctx.createGain(); V.gate.gain.value = 0;
    V.post = V.ctx.createGain();
    V.micGain.connect(V.analyser);
    try {
      await V.ctx.audioWorklet.addModule('worklets/voice-fx.js');
      V.fx = new AudioWorkletNode(V.ctx, 'resenha-pitch');
      V.pre.connect(V.fx).connect(V.post);
    } catch (e) { console.warn('fx', e); V.pre.connect(V.post); }
    V.post.connect(V.gate); V.gate.connect(V.dest);
    try {
      rnBinary = rnBinary || await fetch('vendor/ns/rnnoise_simd.wasm').then((r) => r.arrayBuffer()).catch(() => fetch('vendor/ns/rnnoise.wasm').then((r) => r.arrayBuffer()));
      await V.ctx.audioWorklet.addModule('vendor/ns/rnnoiseWorklet.js');
      V.rn = new RnnoiseWorkletNode(V.ctx, { wasmBinary: rnBinary, maxChannels: 1 });
      V.rn.port.onmessage = (e) => {
        const d = e.data; if (!d || typeof d !== 'object') return;
        V.vadLevel = d.vad;
        if (d.open !== V.vadOpen) { V.vadOpen = d.open; refreshSpeaking(); }
      };
      V.rnReady = true;
    } catch (e) { console.warn('rnnoise', e); V.rn = null; }
    applyNoiseMode();
    applyVoiceFx();
    applyOutputDevice();
  }
  if (V.ctx.state === 'suspended') await V.ctx.resume();
  V.master.gain.value = V.deafened ? 0 : 1;
  V.micGain.gain.value = settings.micGain / 100;
}
function applyNoiseMode() {
  if (!V.micGain) return;
  try { V.micGain.disconnect(V.pre); } catch {}
  try { V.micGain.disconnect(V.rn); } catch {}
  try { if (V.rn) V.rn.disconnect(); } catch {}
  if (settings.aiNoise && V.rn) {
    V.micGain.connect(V.rn); V.rn.connect(V.pre);
    V.rn.port.postMessage({ gate: true, thr: 1 - settings.vadSens / 100 * 0.9, holdMs: 350 });
  } else V.micGain.connect(V.pre);
}
function currentFx() {
  const f = FX[settings.voiceFx] || FX.normal;
  return { semis: f.semis == null ? settings.pitchSemis : f.semis, robot: f.robot };
}
function applyVoiceFx() {
  if (!V.fx) return;
  const f = currentFx();
  V.fx.parameters.get('pitch').setValueAtTime(clamp(semisToRatio(f.semis), 0.5, 2), V.ctx.currentTime);
  V.fx.parameters.get('robot').setValueAtTime(f.robot, V.ctx.currentTime);
}
async function openMic() {
  // A supressão do navegador fica ligada junto: ela tira ruído constante e o RNNoise cuida do resto
  const c = { echoCancellation: settings.echoCancellation, noiseSuppression: true, autoGainControl: settings.autoGain, channelCount: 1, sampleRate: 48000 };
  if (settings.inputDevice && settings.inputDevice !== 'default') c.deviceId = { exact: settings.inputDevice };
  let raw;
  try { raw = await navigator.mediaDevices.getUserMedia({ audio: c }); }
  catch (e) {
    if (c.deviceId) { delete c.deviceId; raw = await navigator.mediaDevices.getUserMedia({ audio: c }); toast('Microfone escolhido não encontrado, usando o padrão.'); }
    else throw e;
  }
  if (V.src) try { V.src.disconnect(); } catch {}
  if (V.raw) V.raw.getTracks().forEach((t) => t.stop());
  V.raw = raw;
  V.src = V.ctx.createMediaStreamSource(raw);
  V.src.connect(V.micGain);
}
function applyOutputDevice() {
  const id = settings.outputDevice === 'default' ? '' : settings.outputDevice;
  for (const c of [V.ctx, sfxCtx]) if (c && c.setSinkId) c.setSinkId(id).catch(() => c.setSinkId('').catch(() => {}));
}

async function joinVoice(channelId) {
  channelId = channelId || voiceChannels()[0]?.id;
  if (!channelId) return;
  if (V.joined && V.channel === channelId) return;
  if (V.joined) leaveVoice(true);
  try {
    await ensureAudio();
    await openMic();
  } catch (e) {
    toast('Não consegui acessar o microfone: ' + (e.message || e.name), 'err', 6000);
    return;
  }
  V.joined = true; V.channel = channelId;
  if (V.deafened) V.muted = true;
  wsSend({ t: 'state', voiceChannel: channelId, muted: V.muted, deafened: V.deafened });
  sfx('join');
  for (const u of usersIn(channelId)) if (u.id !== S.myId && u.id !== DJ_ID) getPeer(u.id);
  setConnStatus('good', 'Voz conectada');
  syncDJ();
  renderAll();
}
function leaveVoice(silentSwitch) {
  if (!V.joined) return;
  if (!silentSwitch) sfx('leave');
  teardownVoice();
  wsSend({ t: 'state', voiceChannel: null, sharing: false, screenStreamId: null });
  syncDJ();
  renderAll();
}
function teardownVoice() {
  stopShare(true);
  for (const id of [...V.peers.keys()]) closePeer(id);
  if (V.raw) V.raw.getTracks().forEach((t) => t.stop());
  if (V.src) try { V.src.disconnect(); } catch {}
  V.raw = null; V.src = null; V.joined = false; V.channel = null; V.speaking.clear(); V.focus = null; V.gateOpen = false; V.vadOpen = false;
  if (V.gate) V.gate.gain.value = 0;
  tileCache.clear();
  stopDJAudio();
}

function setMuted(m, silent) {
  if (V.deafened && !m) { setDeafened(false); return; }
  V.muted = m; LS.set('muted', m);
  if (!silent) sfx(m ? 'mute' : 'unmute');
  wsSend({ t: 'state', muted: V.muted, deafened: V.deafened });
  renderAll();
}
function setDeafened(d) {
  if (d) { V.mutedBeforeDeafen = V.muted; V.muted = true; }
  else { V.muted = V.mutedBeforeDeafen; }
  V.deafened = d; LS.set('deafened', d); LS.set('muted', V.muted);
  if (V.master) V.master.gain.value = d ? 0 : 1;
  if (V.screenMaster) V.screenMaster.gain.value = d ? 0 : 1;
  sfx(d ? 'mute' : 'unmute');
  wsSend({ t: 'state', muted: V.muted, deafened: V.deafened });
  renderAll();
}

// Laço: portão de voz, indicadores de fala, ping
let noiseFloor = -60;
const lvlBuf = new Float32Array(512);
const level = (an) => { an.getFloatTimeDomainData(lvlBuf); let s = 0; for (let i = 0; i < lvlBuf.length; i++) s += lvlBuf[i] * lvlBuf[i]; return 20 * Math.log10(Math.sqrt(s / lvlBuf.length) + 1e-9); };
setInterval(() => {
  if (!V.joined && !V.testing) return;
  const now = performance.now();
  if (V.analyser && V.src) {
    const db = level(V.analyser); V.selfLevel = db;
    let open;
    if (settings.aiNoise && V.rnReady) open = true; // RNNoise já corta quando não é voz
    else {
      let thr = settings.threshold;
      if (settings.autoSens) { noiseFloor = db < noiseFloor ? db : noiseFloor + 0.02; noiseFloor = clamp(noiseFloor, -80, -35); thr = Math.max(noiseFloor + 12, -60); V.autoThr = thr; }
      if (db > thr) V.gateHold = now + 300;
      open = now < V.gateHold;
      if (open !== V.gateOpen) { V.gateOpen = open; refreshSpeaking(); }
    }
    const send = open && !V.muted && !V.deafened && V.joined;
    if (V.gate.gain.value > 0.5 !== send) V.gate.gain.setTargetAtTime(send ? 1 : 0, V.ctx.currentTime, send ? 0.005 : 0.03);
  }
  let changed = false;
  for (const [id, p] of V.peers) {
    if (!p.analyser) continue;
    const on = level(p.analyser) > -58 && !settings.userMuted[S.users.get(id)?.name];
    if (on) p.speakUntil = now + 250;
    const sp = now < (p.speakUntil || 0);
    if (sp !== V.speaking.has(id)) { if (sp) V.speaking.add(id); else V.speaking.delete(id); changed = true; }
  }
  if (V.djAnalyser) {
    const sp = level(V.djAnalyser) > -50 && !settings.userMuted[DJ_NAME];
    if (sp !== V.speaking.has(DJ_ID)) { if (sp) V.speaking.add(DJ_ID); else V.speaking.delete(DJ_ID); changed = true; }
  }
  if (changed) refreshSpeaking();
}, 40);
setInterval(() => {
  tickTimers();
  wsSend({ t: 'ping', ts: Date.now() });
  let ch = false; for (const [id, t] of S.typing) if (Date.now() - t > 6000) { S.typing.delete(id); ch = true; }
  if (ch) renderTyping();
  updateDJProgress();
}, 1000);

function setConnStatus(kind, text) {
  $('#vp-title').className = kind; $('#vp-title').textContent = text;
  $('#vp-signal').className = kind === 'good' ? '' : kind;
}
function updatePing() {
  if (!V.joined) return;
  $('#vp-signal').title = `Ping até o anfitrião: ${S.lastPing} ms`;
  if (S.ws && S.ws.readyState === 1) setConnStatus(S.lastPing > 250 ? 'warn' : 'good', 'Voz conectada');
}

// ---------- WebRTC (malha) ----------
function sig(to, data) { wsSend({ t: 'signal', to, data }); }
function getPeer(uid) {
  let p = V.peers.get(uid);
  if (p) return p;
  const pc = new RTCPeerConnection({ iceServers: iceServers(), bundlePolicy: 'max-bundle', iceTransportPolicy: LS.get('forceRelay', false) && !S.isHost ? 'relay' : 'all' });
  p = { uid, pc, polite: S.myId > uid, makingOffer: false, ignoreOffer: false, streams: new Map(), queue: Promise.resolve(), audio: null };
  V.peers.set(uid, p);
  pc.onnegotiationneeded = async () => {
    try { p.makingOffer = true; await pc.setLocalDescription(); sig(uid, { desc: pc.localDescription }); }
    catch (e) { console.warn('negotiation', e); }
    finally { p.makingOffer = false; }
  };
  pc.onicecandidate = ({ candidate }) => { if (candidate) sig(uid, { cand: candidate }); };
  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'failed') { try { pc.restartIce(); } catch {} }
    if (pc.iceConnectionState === 'disconnected') setTimeout(() => { if (pc.iceConnectionState === 'disconnected') try { pc.restartIce(); } catch {} }, 3000);
  };
  pc.ontrack = (ev) => {
    const stream = ev.streams[0] || new MediaStream([ev.track]);
    p.streams.set(stream.id, stream);
    const u = S.users.get(uid);
    const isScreen = u && u.screenStreamId === stream.id;
    if (ev.track.kind === 'audio') attachRemoteAudio(p, stream, isScreen);
    ev.track.onunmute = () => renderCall();
    stream.onremovetrack = () => { if (!stream.getTracks().length) { p.streams.delete(stream.id); renderCall(); } };
    renderCall();
  };
  const voiceTrack = V.dest.stream.getAudioTracks()[0];
  const sender = pc.addTrack(voiceTrack, V.dest.stream);
  tuneSender(sender, { maxBitrate: 96000 });
  if (V.screen) addScreenTo(p);
  return p;
}
function closePeer(uid) {
  const p = V.peers.get(uid); if (!p) return;
  V.peers.delete(uid); V.speaking.delete(uid);
  try { p.pc.close(); } catch {}
  for (const a of [p.audio, p.screenAudio]) if (a) { try { a.src.disconnect(); a.gain.disconnect(); } catch {} a.el.srcObject = null; }
  V.screenSenders.delete(uid);
}
function onSignal(from, data) {
  if (!V.joined) return;
  const u = S.users.get(from); if (!u || u.voiceChannel !== V.channel) return;
  const p = getPeer(from);
  p.queue = p.queue.then(async () => {
    const pc = p.pc;
    try {
      if (data.desc) {
        const collision = data.desc.type === 'offer' && (p.makingOffer || pc.signalingState !== 'stable');
        p.ignoreOffer = !p.polite && collision;
        if (p.ignoreOffer) return;
        await pc.setRemoteDescription(data.desc);
        if (data.desc.type === 'offer') { await pc.setLocalDescription(); sig(from, { desc: pc.localDescription }); }
      } else if (data.cand) {
        try { await pc.addIceCandidate(data.cand); } catch (e) { if (!p.ignoreOffer) console.warn('ice', e); }
      }
    } catch (e) { console.warn('signal', e); }
  });
}
async function tuneSender(sender, enc) {
  try {
    const prm = sender.getParameters();
    if (!prm.encodings || !prm.encodings.length) prm.encodings = [{}];
    Object.assign(prm.encodings[0], enc);
    await sender.setParameters(prm);
  } catch {}
}
function attachRemoteAudio(p, stream, isScreen) {
  const key = isScreen ? 'screenAudio' : 'audio';
  if (p[key] && p[key].stream === stream) return;
  if (p[key]) { try { p[key].src.disconnect(); } catch {} }
  const el = new Audio(); el.srcObject = stream; el.muted = true; el.play().catch(() => {});
  const src = V.ctx.createMediaStreamSource(stream);
  const gain = V.ctx.createGain();
  src.connect(gain);
  if (isScreen) {
    if (!V.screenMaster) { V.screenMaster = V.ctx.createGain(); V.screenMaster.connect(V.ctx.destination); V.screenMaster.gain.value = V.deafened ? 0 : 1; }
    gain.connect(V.screenMaster);
  } else {
    const an = V.ctx.createAnalyser(); an.fftSize = 512; src.connect(an); p.analyser = an;
    gain.connect(V.master);
  }
  p[key] = { stream, el, src, gain };
  applyUserVolume(p.uid);
}
function volFor(name) { return settings.userMuted[name] ? 0 : (settings.userVolumes[name] ?? 100) / 100; }
function applyUserVolume(uid) {
  if (uid === DJ_ID) { if (V.djGain) V.djGain.gain.value = volFor(DJ_NAME) * 0.6; return; }
  const p = V.peers.get(uid); const u = S.users.get(uid);
  if (!p || !u) return;
  if (p.audio) p.audio.gain.gain.value = volFor(u.name);
  if (p.screenAudio) p.screenAudio.gain.gain.value = settings.userMuted[u.name] ? 0 : (settings.streamVolumes[u.name] ?? 100) / 100;
}
function reclassifyStreams() {
  for (const [uid, p] of V.peers) {
    const u = S.users.get(uid); if (!u) continue;
    for (const [sid, st] of p.streams) {
      if (!st.getAudioTracks().length) continue;
      if (u.screenStreamId === sid && (!p.screenAudio || p.screenAudio.stream !== st)) {
        if (p.audio && p.audio.stream === st) { try { p.audio.src.disconnect(); } catch {} p.audio = null; }
        attachRemoteAudio(p, st, true);
      }
    }
  }
}

// ---------- Compartilhar tela ----------
const QUALITY = {
  '720p30': { w: 1280, h: 720, fps: 30, br: 2500000 },
  '1080p30': { w: 1920, h: 1080, fps: 30, br: 4500000 },
  '1080p60': { w: 1920, h: 1080, fps: 60, br: 7000000 },
  '1440p60': { w: 2560, h: 1440, fps: 60, br: 10000000 },
};
async function toggleShare() {
  if (V.screen) return stopShare();
  if (!V.joined) return toast('Entre na call primeiro.');
  if (!native) {
    try { startShareWithStream(await navigator.mediaDevices.getDisplayMedia({ video: true, audio: { restrictOwnAudio: true } }), '1080p30'); } catch {}
    return;
  }
  const sources = await native.screenSources();
  let sel = sources.find((s) => s.screen) || sources[0];
  let tab = 'screen';
  const quality = LS.get('shareQuality', '1080p30');
  const m = openModal(`
    <header><div><h2>Compartilhar tela</h2><p>Escolha o que a galera vai ver</p></div><button class="icon-btn" data-close>${icon('x')}</button></header>
    <div class="body">
      <div class="tabs"><div class="tab active" data-tab="screen">Telas</div><div class="tab" data-tab="window">Janelas / jogos</div></div>
      <div class="sources"></div>
      <div class="opts">
        <div class="field"><label>Qualidade</label><select id="sh-q">${Object.keys(QUALITY).map((k) => `<option ${k === quality ? 'selected' : ''} value="${k}">${k.replace('p', 'p ').replace(/(\d+)$/, '$1 fps')}</option>`).join('')}</select></div>
        <label class="check"><input type="checkbox" id="sh-audio" ${LS.get('shareAudio', true) ? 'checked' : ''}> Transmitir som do PC</label>
      </div>
      <p class="muted small" style="margin:10px 0 0">Vai o som do jogo, música e vídeos. A voz dos amigos, o DJ e os sons do Resenha ficam de fora, então ninguém se escuta de volta.</p>
    </div>
    <footer><button class="btn" data-close>Cancelar</button><button class="btn primary" id="sh-go">Transmitir</button></footer>`, { wide: true });
  const renderSrc = () => {
    const list = sources.filter((s) => (tab === 'screen') === s.screen);
    if (!list.includes(sel)) sel = list[0];
    $('.sources', m.el).innerHTML = list.map((s) => `<div class="src ${s === sel ? 'sel' : ''}" data-id="${esc(s.id)}"><div class="th" style="${s.thumb ? `background-image:url(${s.thumb})` : ''}"></div><div class="nm">${s.icon ? `<img src="${s.icon}">` : ''}<span>${esc(s.name)}</span></div></div>`).join('') || '<div class="muted">Nada encontrado</div>';
    $$('.src', m.el).forEach((el) => { el.onclick = () => { sel = sources.find((s) => s.id === el.dataset.id); renderSrc(); }; el.ondblclick = () => $('#sh-go').click(); });
  };
  $$('.tab', m.el).forEach((t) => t.onclick = () => { tab = t.dataset.tab; $$('.tab', m.el).forEach((x) => x.classList.toggle('active', x === t)); renderSrc(); });
  renderSrc();
  $('#sh-go').onclick = async () => {
    if (!sel) return;
    const q = $('#sh-q').value, audio = $('#sh-audio').checked;
    LS.set('shareQuality', q); LS.set('shareAudio', audio);
    m.close();
    const Q = QUALITY[q];
    await native.selectScreen({ id: sel.id, audio });
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { ideal: Q.w }, height: { ideal: Q.h }, frameRate: { ideal: Q.fps, max: Q.fps } },
        // restrictOwnAudio: tira da captura tudo que o próprio Resenha toca (voz dos amigos, DJ, sons)
        audio: audio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false, restrictOwnAudio: true } : false,
      });
      const at = stream.getAudioTracks()[0];
      if (at) {
        try { await at.applyConstraints({ restrictOwnAudio: true }); } catch {}
        if (at.getSettings().restrictOwnAudio === false) toast('Aviso: seu Windows não deixou separar o som do Resenha. Use fone.', 'err', 6000);
      }
      startShareWithStream(stream, q);
    } catch (e) { toast('Não deu pra compartilhar: ' + e.message, 'err'); }
  };
}
function startShareWithStream(stream, q) {
  const Q = QUALITY[q] || QUALITY['1080p30'];
  V.screen = stream; V.screenQ = Q;
  const vt = stream.getVideoTracks()[0];
  if (vt) { vt.contentHint = Q.fps >= 60 ? 'motion' : 'detail'; vt.onended = () => stopShare(); }
  wsSend({ t: 'state', sharing: true, screenStreamId: stream.id });
  setTimeout(() => { for (const p of V.peers.values()) addScreenTo(p); }, 50);
  sfx('share');
  renderAll();
}
function addScreenTo(p) {
  if (!V.screen || V.screenSenders.has(p.uid)) return;
  const senders = V.screen.getTracks().map((t) => p.pc.addTrack(t, V.screen));
  V.screenSenders.set(p.uid, senders);
  for (const s of senders) {
    if (s.track.kind === 'video') tuneSender(s, { maxBitrate: V.screenQ.br, maxFramerate: V.screenQ.fps, degradationPreference: V.screenQ.fps >= 60 ? 'maintain-framerate' : 'maintain-resolution' });
    else tuneSender(s, { maxBitrate: 128000 });
  }
}
function stopShare(silent) {
  if (!V.screen) return;
  V.screen.getTracks().forEach((t) => t.stop());
  for (const [uid, senders] of V.screenSenders) { const p = V.peers.get(uid); if (p) for (const s of senders) try { p.pc.removeTrack(s); } catch {} }
  V.screenSenders.clear();
  V.screen = null;
  if (!silent) { wsSend({ t: 'state', sharing: false, screenStreamId: null }); sfx('leave'); }
  if (V.focus === 'screen:' + S.myId) V.focus = null;
  renderAll();
}

// ---------- Menu de volume do usuário (clique direito) ----------
function userMenu(e, uid) {
  const u = S.users.get(uid); if (!u || uid === S.myId) return;
  const isDJ = uid === DJ_ID;
  const vol = settings.userVolumes[u.name] ?? 100, svol = settings.streamVolumes[u.name] ?? 100;
  showMenu(e, `<div class="ctx-head">${avatarHTML(u)}<span>${esc(u.name)}</span></div>
    <div class="ctx-label"><span>${isDJ ? 'Volume do DJ' : 'Volume do usuário'}</span><span id="cv-v">${vol}%</span></div>
    <div class="ctx-row"><input type="range" min="0" max="200" step="1" value="${vol}" id="cv"></div>
    ${u.sharing ? `<div class="ctx-label"><span>Volume da transmissão</span><span id="cs-v">${svol}%</span></div><div class="ctx-row"><input type="range" min="0" max="200" value="${svol}" id="cs"></div>` : ''}
    <label class="ctx-item check"><span>Silenciar pra mim</span><input type="checkbox" id="cm" ${settings.userMuted[u.name] ? 'checked' : ''}></label>
    <div class="ctx-item" id="cr"><span>Voltar volume pra 100%</span></div>
    ${!isDJ ? `<div class="ctx-item" id="cmention"><span>Mencionar</span>${icon('at', 16)}</div>` : `<div class="ctx-item" id="cdj"><span>Abrir painel do DJ</span>${icon('music', 16)}</div>`}`, (menu) => {
    $('#cv', menu).oninput = (ev) => { settings.userVolumes[u.name] = +ev.target.value; $('#cv-v', menu).textContent = ev.target.value + '%'; applyUserVolume(uid); saveSettings(); };
    if ($('#cs', menu)) $('#cs', menu).oninput = (ev) => { settings.streamVolumes[u.name] = +ev.target.value; $('#cs-v', menu).textContent = ev.target.value + '%'; applyUserVolume(uid); saveSettings(); };
    $('#cm', menu).onchange = (ev) => { if (ev.target.checked) settings.userMuted[u.name] = true; else delete settings.userMuted[u.name]; applyUserVolume(uid); saveSettings(); renderAll(); };
    $('#cr', menu).onclick = () => { settings.userVolumes[u.name] = 100; $('#cv', menu).value = 100; $('#cv-v', menu).textContent = '100%'; applyUserVolume(uid); saveSettings(); };
    if ($('#cmention', menu)) $('#cmention', menu).onclick = () => { hideMenu(); insertMention(u.name); };
    if ($('#cdj', menu)) $('#cdj', menu).onclick = () => { hideMenu(); openDJPanel(); };
  });
}

// ---------- Escolher microfone / saída (clique direito nos botões) ----------
async function listDevices(kind) {
  let devs = [];
  try { devs = await navigator.mediaDevices.enumerateDevices(); } catch {}
  if (!devs.some((d) => d.label)) { try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach((t) => t.stop()); devs = await navigator.mediaDevices.enumerateDevices(); } catch {} }
  return devs.filter((d) => d.kind === kind && d.deviceId !== 'default' && d.deviceId !== 'communications');
}
async function deviceMenu(e, kind) {
  e.preventDefault();
  const pos = { clientX: e.clientX, clientY: e.clientY, preventDefault() {}, stopPropagation() {} };
  const devs = await listDevices(kind);
  const cur = kind === 'audioinput' ? settings.inputDevice : settings.outputDevice;
  const item = (id, label) => `<div class="ctx-item dev ${id === cur ? 'sel' : ''}" data-dev="${esc(id)}"><span>${esc(label)}</span>${id === cur ? icon('check', 16) : ''}</div>`;
  const extra = kind === 'audioinput'
    ? `<div class="ctx-sep"></div><div class="ctx-label"><span>Volume do microfone</span><span id="dm-v">${settings.micGain}%</span></div><div class="ctx-row"><input type="range" min="0" max="200" value="${settings.micGain}" id="dm-g"></div>`
    : '';
  showMenu(pos, `<div class="ctx-title">${kind === 'audioinput' ? 'Microfone' : 'Saída de áudio'}</div>
    ${item('default', 'Padrão do Windows')}${devs.map((d) => item(d.deviceId, d.label || 'Dispositivo')).join('')}${extra}
    <div class="ctx-sep"></div><div class="ctx-item" id="dm-set"><span>Configurações de voz</span>${icon('settings', 16)}</div>`, (menu) => {
    $$('.dev', menu).forEach((el) => el.onclick = async () => {
      hideMenu();
      if (kind === 'audioinput') { settings.inputDevice = el.dataset.dev; saveSettings(); if (V.src) { try { await openMic(); toast('Microfone trocado', 'ok', 1500); } catch (err) { toast('Microfone: ' + err.message, 'err'); } } }
      else { settings.outputDevice = el.dataset.dev; saveSettings(); applyOutputDevice(); toast('Saída trocada', 'ok', 1500); }
    });
    const g = $('#dm-g', menu);
    if (g) g.oninput = (ev) => { settings.micGain = +ev.target.value; $('#dm-v', menu).textContent = ev.target.value + '%'; if (V.micGain) V.micGain.gain.value = settings.micGain / 100; saveSettings(); };
    $('#dm-set', menu).onclick = () => { hideMenu(); openSettings(); };
  });
}

document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('#ctx-menu')) hideMenu();
  if (!e.target.closest('#room-menu, #room-header')) $('#room-menu').classList.add('hidden');
  if (!e.target.closest('#mention-pop, #input')) hideMentionPop();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { hideMenu(); $('.lightbox')?.remove(); } });

// ---------------- Canais ----------------
async function createChannel(type) {
  const r = await promptModal(type === 'text' ? 'Criar canal de texto' : 'Criar canal de voz', { placeholder: type === 'text' ? 'novo-canal' : 'Jogando', ok: 'Criar' });
  if (r && r.value) wsSend({ t: 'ch-create', type, name: r.value });
}
function channelMenu(e, id) {
  const c = chanById(id); if (!c) return;
  showMenu(e, `<div class="ctx-title">${c.type === 'text' ? '#' : ''}${esc(c.name)}</div>
    <div class="ctx-item" data-a="rename"><span>Editar nome</span>${icon('edit', 16)}</div>
    ${c.type === 'text' ? `<div class="ctx-item" data-a="read"><span>Marcar como lido</span>${icon('check', 16)}</div>` : `<div class="ctx-item" data-a="join"><span>Entrar</span>${icon('volume', 16)}</div>`}
    <div class="ctx-sep"></div><div class="ctx-item danger" data-a="del"><span>Excluir canal</span>${icon('trash', 16)}</div>`, (menu) => {
    $$('[data-a]', menu).forEach((el) => el.onclick = async () => {
      hideMenu();
      const a = el.dataset.a;
      if (a === 'rename') { const r = await promptModal('Editar canal', { value: c.name }); if (r && r.value && r.value !== c.name) wsSend({ t: 'ch-rename', id, name: r.value }); }
      if (a === 'read') { S.unread.delete(id); renderChannels(); }
      if (a === 'join') joinVoice(id);
      if (a === 'del' && await confirmModal('Excluir canal', `Excluir <b>${esc(c.name)}</b>?${c.type === 'text' ? ' As mensagens dele somem pra todo mundo.' : ''}`, 'Excluir')) wsSend({ t: 'ch-delete', id });
    });
  });
}
function selectTextChannel(id) {
  if (S.textChannel === id) return;
  S.textChannel = id; S.unread.delete(id); S.typing.clear();
  cancelReply(); S.editing = null;
  renderChannels(); renderMessages(); renderTyping();
  $('#input').focus();
}
function renderChatHeader() {
  const c = chanById(S.textChannel);
  $('#chat-title').textContent = c ? c.name : '';
  $('#input').placeholder = c ? `Conversar em #${c.name}` : '';
  $('#drop-ch').textContent = c ? '#' + c.name : '';
}

// ---------------- Chat ----------------
function linkify(text, mentions) {
  let h = esc(text);
  const blocks = [];
  h = h.replace(/```(?:\w+\n)?([\s\S]*?)```/g, (_, c) => { blocks.push(`<pre>${c.replace(/^\n/, '')}</pre>`); return `\u0000${blocks.length - 1}\u0000`; });
  h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  h = h.replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g, '<a href="#" data-href="$1">$1</a>');
  h = h.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  // Menções: nomes conhecidos (podem ter espaço) e @todos
  const names = [...new Set([...(mentions || []), ...[...S.users.values()].map((u) => u.name), 'todos'])].filter(Boolean).sort((a, b) => b.length - a.length);
  for (const n of names) {
    const re = new RegExp('@' + esc(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\p{L}\\p{N}_])', 'giu');
    h = h.replace(re, (mm) => `<span class="mention ${n.toLowerCase() === me.name.toLowerCase() || n === 'todos' ? 'me' : ''}">${mm}</span>`);
  }
  h = h.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[i]);
  return h;
}
const fileUrl = (a, dl) => `${S.base}${a.url}?t=${S.token}${dl ? '&dl=1' : ''}`;
function attHTML(a) {
  const url = fileUrl(a);
  const t = a.type || '';
  if (t.startsWith('image/')) return `<img class="att-img" src="${url}" data-full="${url}" data-name="${esc(a.name)}" data-dl="${fileUrl(a, 1)}" loading="lazy" alt="${esc(a.name)}">`;
  if (t.startsWith('video/')) return `<video class="att-video" src="${url}" controls preload="metadata"></video>`;
  const audio = t.startsWith('audio/') ? `<audio controls preload="none" src="${url}"></audio>` : '';
  return `<div class="att-file">${icon('file', 30)}<div class="fi"><div class="fn att-dl" data-dl="${fileUrl(a, 1)}" title="Baixar">${esc(a.name)}</div><div class="fs">${fmtSize(a.size)}</div>${audio}</div><span class="icon-btn att-dl" data-dl="${fileUrl(a, 1)}" title="Baixar">${icon('download', 20)}</span></div>`;
}
const curMessages = () => S.history[S.textChannel] || [];
function msgHTML(m, prev) {
  const grouped = !m.replyTo && prev && prev.userId === m.userId && prev.name === m.name && m.ts - prev.ts < 7 * 60000;
  const u = S.users.get(m.userId) || m;
  const mine = m.userId === S.myId;
  const canDel = mine || S.isHost;
  const tools = `<div class="msg-tools">
    <button data-mt="reply" title="Responder">${icon('reply', 18)}</button>
    ${!m.bot && !mine ? `<button data-mt="mention" title="Mencionar">${icon('at', 18)}</button>` : ''}
    ${mine ? `<button data-mt="edit" title="Editar">${icon('edit', 18)}</button>` : ''}
    ${canDel ? `<button data-mt="delete" class="danger" title="Excluir">${icon('trash', 18)}</button>` : ''}</div>`;
  const edited = m.editedAt ? '<span class="edited" title="' + esc(fmtTime(m.editedAt)) + '">(editado)</span>' : '';
  const body = `${m.text ? `<div class="text">${linkify(m.text, m.mentions)}${edited}</div>` : ''}${m.attachments && m.attachments.length ? `<div class="atts">${m.attachments.map(attHTML).join('')}</div>` : ''}`;
  const cls = `msg ${mentionsMe(m) ? 'mentioned' : ''} ${m.bot ? 'bot' : ''}`;
  const reply = m.replyTo ? `<div class="reply-ref" data-jump="${esc(m.replyTo.id)}">${icon('reply', 14)}<b style="color:${esc(m.replyTo.color)}">@${esc(m.replyTo.name)}</b><span>${esc(m.replyTo.text)}</span></div>` : '';
  if (grouped) return `<div class="${cls}" data-id="${m.id}"><span class="hover-time">${new Date(m.ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>${body}${tools}</div>`;
  return `<div class="${cls} head" data-id="${m.id}">${reply}${avatarHTML({ id: m.bot ? DJ_ID : m.userId, bot: m.bot, name: m.name, color: m.color, avatar: u.avatar })}<div class="meta"><span class="author" style="color:${esc(m.color)}">${esc(m.name)}</span>${m.bot ? '<span class="tag bot">BOT</span>' : ''}<span class="time">${fmtTime(m.ts)}</span></div>${body}${tools}</div>`;
}
function renderMessages(keepScroll) {
  renderChatHeader();
  const box = $('#messages');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  const prevTop = box.scrollTop;
  const c = chanById(S.textChannel);
  const list = curMessages();
  let h = `<div class="welcome"><div class="big-hash">${icon('hash', 40)}</div><h1>Bem-vindo(a) a #${esc(c ? c.name : '')}!</h1><div class="muted">Início do canal #${esc(c ? c.name : '')}.</div></div>`;
  list.forEach((m, i) => { h += msgHTML(m, list[i - 1]); });
  $('#msg-list').innerHTML = h;
  if (!keepScroll || atBottom) scrollBottom(true); else box.scrollTop = prevTop;
}
function rerenderMsg(id) {
  const list = curMessages();
  const i = list.findIndex((m) => m.id === id);
  const el = $(`#msg-list .msg[data-id="${CSS.escape(id)}"]`);
  if (i < 0 || !el) return;
  el.outerHTML = msgHTML(list[i], list[i - 1]);
}
function appendMessage(m) {
  const box = $('#messages');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  const list = curMessages();
  $('#msg-list').insertAdjacentHTML('beforeend', msgHTML(m, list[list.length - 2]));
  if (atBottom || m.userId === S.myId) scrollBottom(true);
}
function scrollBottom(force) {
  const box = $('#messages');
  box.scrollTop = box.scrollHeight;
  if (force) $$('img, video', $('#msg-list')).forEach((el) => { if (!el.dataset.sb) { el.dataset.sb = 1; el.addEventListener(el.tagName === 'IMG' ? 'load' : 'loadedmetadata', () => { if (box.scrollHeight - box.scrollTop - box.clientHeight < 500) box.scrollTop = box.scrollHeight; }, { once: true }); } });
}
function findMsg(id) { return curMessages().find((m) => m.id === id); }
function msgAction(action, id) {
  const m = findMsg(id); if (!m) return;
  if (action === 'reply') startReply(m);
  if (action === 'mention') insertMention(m.name);
  if (action === 'edit') startEdit(m);
  if (action === 'delete') deleteMsg(m);
  if (action === 'copy') copy(m.text || '');
}
async function deleteMsg(m) {
  if (await confirmModal('Excluir mensagem', 'Tem certeza? Ela some pra todo mundo.', 'Excluir')) wsSend({ t: 'delete', id: m.id });
}
function startReply(m) {
  S.replyTo = m;
  $('#reply-bar').innerHTML = `<span>Respondendo a <b style="color:${esc(m.color)}">${esc(m.name)}</b></span><button class="icon-btn small" id="reply-x">${icon('x', 16)}</button>`;
  $('#reply-bar').classList.remove('hidden');
  $('#reply-x').onclick = cancelReply;
  $('#input').focus();
}
function cancelReply() { S.replyTo = null; $('#reply-bar').classList.add('hidden'); }
function startEdit(m) {
  const el = $(`#msg-list .msg[data-id="${CSS.escape(m.id)}"]`); if (!el) return;
  S.editing = m.id;
  const textEl = el.querySelector('.text');
  const box = document.createElement('div'); box.className = 'edit-box';
  box.innerHTML = `<textarea rows="1">${esc(m.text || '')}</textarea><div class="muted small">Esc para <a data-e="cancel">cancelar</a> · Enter para <a data-e="save">salvar</a></div>`;
  if (textEl) textEl.replaceWith(box); else el.querySelector('.atts')?.before(box);
  const ta = box.querySelector('textarea');
  const size = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
  size(); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
  const finish = (save) => {
    const v = ta.value.trim();
    S.editing = null;
    if (save && v !== (m.text || '')) wsSend({ t: 'edit', id: m.id, text: v, mentions: extractMentions(v) });
    rerenderMsg(m.id);
  };
  ta.oninput = size;
  ta.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
  };
  box.onclick = (e) => { const a = e.target.closest('[data-e]'); if (a) finish(a.dataset.e === 'save'); };
}
function msgMenu(e, id) {
  const m = findMsg(id); if (!m) return;
  const mine = m.userId === S.myId;
  showMenu(e, `<div class="ctx-item" data-a="reply"><span>Responder</span>${icon('reply', 16)}</div>
    ${!m.bot && !mine ? `<div class="ctx-item" data-a="mention"><span>Mencionar ${esc(m.name)}</span>${icon('at', 16)}</div>` : ''}
    ${mine ? `<div class="ctx-item" data-a="edit"><span>Editar mensagem</span>${icon('edit', 16)}</div>` : ''}
    ${m.text ? `<div class="ctx-item" data-a="copy"><span>Copiar texto</span>${icon('copy', 16)}</div>` : ''}
    ${mine || S.isHost ? `<div class="ctx-sep"></div><div class="ctx-item danger" data-a="delete"><span>Excluir mensagem</span>${icon('trash', 16)}</div>` : ''}`, (menu) => {
    $$('[data-a]', menu).forEach((el) => el.onclick = () => { hideMenu(); msgAction(el.dataset.a, id); });
  });
}
$('#msg-list').addEventListener('click', (e) => {
  const mt = e.target.closest('[data-mt]');
  if (mt) { msgAction(mt.dataset.mt, mt.closest('.msg').dataset.id); return; }
  const jump = e.target.closest('[data-jump]');
  if (jump) { const el = $(`#msg-list .msg[data-id="${CSS.escape(jump.dataset.jump)}"]`); if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1500); } return; }
  const a = e.target.closest('a[data-href]');
  if (a) { e.preventDefault(); if (native) native.openExternal(a.dataset.href); else window.open(a.dataset.href); return; }
  const dl = e.target.closest('.att-dl');
  if (dl) { if (native) native.download(dl.dataset.dl); else window.open(dl.dataset.dl); return; }
  const img = e.target.closest('.att-img');
  if (img) {
    const lb = document.createElement('div'); lb.className = 'lightbox';
    lb.innerHTML = `<img src="${img.dataset.full}"><a>Baixar ${esc(img.dataset.name)}</a>`;
    lb.onclick = (ev) => { if (ev.target.tagName === 'A') { if (native) native.download(img.dataset.dl); else window.open(img.dataset.dl); } lb.remove(); };
    document.body.appendChild(lb);
    return;
  }
  const au = e.target.closest('.msg .avatar, .msg .author');
  if (au) { const m = findMsg(au.closest('.msg').dataset.id); if (m && m.bot) return openDJPanel(); if (m && S.users.has(m.userId)) userMenu(e, m.userId); }
});
$('#msg-list').addEventListener('error', (e) => {
  // anexo que falhou durante a troca de anfitrião: tenta de novo com o endereço atual
  const el = e.target; if (!el.matches || !el.matches('.att-img, .att-video')) return;
  const n = +(el.dataset.retry || 0); if (n >= 4) return;
  el.dataset.retry = n + 1;
  setTimeout(() => { const u = new URL(el.src); const cur = new URL(S.base || u.origin); u.host = cur.host; u.searchParams.set('t', S.token); u.searchParams.set('r', n + 1); el.src = u.toString(); }, 1500 * (n + 1));
}, true);
$('#msg-list').addEventListener('contextmenu', (e) => {
  const el = e.target.closest('.msg'); if (!el || e.target.closest('.edit-box')) return;
  if (e.target.closest('a, img, video, audio')) return;
  msgMenu(e, el.dataset.id);
});

function renderTyping() {
  const names = [...S.typing.keys()].map((id) => S.users.get(id)?.name).filter(Boolean);
  $('#typing').innerHTML = !names.length ? '' : names.length === 1 ? `<b>${esc(names[0])}</b> está digitando...` : names.length < 4 ? `<b>${names.map(esc).join(', ')}</b> estão digitando...` : 'Várias pessoas estão digitando...';
}

// ---------- Menções (@) ----------
const input = $('#input');
let mentionState = null; // { start, items, sel }
function mentionCandidates() {
  const names = [...new Set([...S.users.values()].filter((u) => u.id !== DJ_ID).map((u) => u.name))];
  return [...names.map((n) => ({ name: n, u: [...S.users.values()].find((x) => x.name === n) })), { name: 'todos', u: null }];
}
function updateMentionPop() {
  const pos = input.selectionStart;
  const before = input.value.slice(0, pos);
  const m = /(^|\s)@([^\s@]{0,32})$/.exec(before);
  if (!m) return hideMentionPop();
  const q = m[2].toLowerCase();
  const items = mentionCandidates().filter((c) => c.name.toLowerCase().includes(q)).slice(0, 8);
  if (!items.length) return hideMentionPop();
  mentionState = { start: pos - m[2].length - 1, items, sel: mentionState && mentionState.items.length === items.length ? Math.min(mentionState.sel, items.length - 1) : 0 };
  const pop = $('#mention-pop');
  pop.innerHTML = `<div class="mp-title">Membros</div>` + items.map((c, i) => `<div class="mp-item ${i === mentionState.sel ? 'sel' : ''}" data-i="${i}">${c.u ? avatarHTML(c.u) : `<div class="avatar at-all">${icon('at', 16)}</div>`}<span>${esc(c.name)}</span>${c.u ? '' : '<span class="muted small">avisa todo mundo</span>'}</div>`).join('');
  pop.classList.remove('hidden');
  $$('.mp-item', pop).forEach((el) => el.onmousedown = (e) => { e.preventDefault(); pickMention(+el.dataset.i); });
}
function hideMentionPop() { mentionState = null; $('#mention-pop').classList.add('hidden'); }
function pickMention(i) {
  const c = mentionState.items[i];
  const after = input.value.slice(input.selectionStart);
  input.value = input.value.slice(0, mentionState.start) + '@' + c.name + ' ' + after;
  const p = mentionState.start + c.name.length + 2;
  input.setSelectionRange(p, p);
  hideMentionPop(); autosize(); input.focus();
}
function insertMention(name) {
  const v = input.value;
  input.value = (v && !/\s$/.test(v) ? v + ' ' : v) + '@' + name + ' ';
  autosize(); input.focus(); input.setSelectionRange(input.value.length, input.value.length);
}
function extractMentions(text) {
  const out = [];
  for (const c of mentionCandidates()) if (new RegExp('@' + c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\p{L}\\p{N}_])', 'iu').test(text)) out.push(c.name);
  return out;
}

// ---------- Composer ----------
const pending = [];
let sending = false, lastTyping = 0;
function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, innerHeight * 0.4) + 'px'; }
input.addEventListener('input', () => {
  autosize();
  updateMentionPop();
  if (input.value && Date.now() - lastTyping > 3000) { lastTyping = Date.now(); wsSend({ t: 'typing', channelId: S.textChannel }); }
});
input.addEventListener('click', updateMentionPop);
input.addEventListener('keydown', (e) => {
  if (mentionState) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); mentionState.sel = (mentionState.sel + (e.key === 'ArrowDown' ? 1 : -1) + mentionState.items.length) % mentionState.items.length; updateMentionPop(); return; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMention(mentionState.sel); return; }
    if (e.key === 'Escape') { e.preventDefault(); hideMentionPop(); return; }
  }
  if (e.key === 'Escape' && S.replyTo) { cancelReply(); return; }
  if (e.key === 'ArrowUp' && !input.value) { // seta pra cima edita a última mensagem, igual Discord
    const last = [...curMessages()].reverse().find((m) => m.userId === S.myId && m.text);
    if (last) { e.preventDefault(); startEdit(last); }
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); }
});
input.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); files.forEach(addPending); }
});
$('#btn-attach').onclick = () => $('#file-input').click();
$('#file-input').onchange = () => { [...$('#file-input').files].forEach(addPending); $('#file-input').value = ''; input.focus(); };
function addPending(file) {
  if (pending.length >= 10) return toast('Máximo de 10 arquivos por mensagem.');
  if (file.size > 2 * 1024 ** 3) return toast(`${file.name} passa de 2 GB.`, 'err');
  const item = { file, url: null };
  if (file.type.startsWith('image/') || file.type.startsWith('video/')) item.url = URL.createObjectURL(file);
  const el = document.createElement('div'); el.className = 'pf';
  const thumb = file.type.startsWith('image/') ? `<div class="thumb" style="background-image:url(${item.url})"></div>` : file.type.startsWith('video/') ? `<div class="thumb"><video src="${item.url}" muted style="max-width:100%;max-height:100%"></video></div>` : `<div class="thumb">${icon('file', 36)}</div>`;
  el.innerHTML = `${thumb}<div class="nm" title="${esc(file.name)}">${esc(file.name)}</div><div class="muted">${fmtSize(file.size)}</div><div class="bar"><div></div></div><button class="rm" title="Remover">${icon('x', 16)}</button>`;
  el.querySelector('.rm').onclick = () => { if (sending) return; pending.splice(pending.indexOf(item), 1); el.remove(); if (item.url) URL.revokeObjectURL(item.url); };
  item.el = el;
  pending.push(item);
  $('#pending-files').appendChild(el);
}
function upload(item) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', `${S.base}/upload?t=${S.token}&name=${encodeURIComponent(item.file.name)}`);
    x.setRequestHeader('Content-Type', item.file.type || 'application/octet-stream');
    x.upload.onprogress = (e) => { if (e.lengthComputable) item.el.querySelector('.bar div').style.width = (e.loaded / e.total * 100) + '%'; };
    x.onload = () => { try { const r = JSON.parse(x.responseText); if (x.status === 200) resolve(r); else reject(new Error(r.error)); } catch (e) { reject(e); } };
    x.onerror = () => reject(new Error('falha de rede'));
    x.send(item.file);
  });
}
async function sendMessage() {
  if (sending) return;
  const text = input.value.trim();
  if (!text && !pending.length) return;
  if (!S.ws || S.ws.readyState !== 1) return toast('Sem conexão com a sala.', 'err');
  sending = true;
  const atts = [];
  try {
    for (const item of pending) atts.push(await upload(item));
  } catch (e) { sending = false; return toast('Falha no envio: ' + e.message, 'err'); }
  wsSend({ t: 'chat', channelId: S.textChannel, text, attachments: atts.map((a) => ({ id: a.id })), replyTo: S.replyTo ? S.replyTo.id : null, mentions: extractMentions(text) });
  pending.forEach((p) => p.url && URL.revokeObjectURL(p.url));
  pending.length = 0; $('#pending-files').innerHTML = '';
  input.value = ''; autosize(); cancelReply(); hideMentionPop();
  sending = false;
}
let dragDepth = 0;
const chatEl = $('#chat');
chatEl.addEventListener('dragenter', (e) => { if (e.dataTransfer.types.includes('Files')) { dragDepth++; $('#drop-overlay').classList.remove('hidden'); } });
chatEl.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop-overlay').classList.add('hidden'); } });
chatEl.addEventListener('dragover', (e) => e.preventDefault());
chatEl.addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; $('#drop-overlay').classList.add('hidden'); [...e.dataTransfer.files].forEach(addPending); input.focus(); });
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

// ---------------- DJ Resenha ----------------
function djHere() { return !!(S.dj && S.dj.active && V.joined && S.dj.channelId === V.channel); }
function ensureDJNodes() {
  if (V.djAudio || !V.ctx) return;
  const a = new Audio(); a.crossOrigin = 'anonymous'; a.preload = 'auto';
  V.djAudio = a;
  const src = V.ctx.createMediaElementSource(a);
  V.djGain = V.ctx.createGain();
  V.djAnalyser = V.ctx.createAnalyser(); V.djAnalyser.fftSize = 512;
  src.connect(V.djGain); V.djGain.connect(V.master); V.djGain.connect(V.djAnalyser);
  applyUserVolume(DJ_ID);
  a.onended = () => { if (S.dj && S.dj.current && !S.dj.current.duration) wsSend({ t: 'dj-ended', id: S.dj.current.id }); };
}
function stopDJAudio() {
  if (V.djAudio) { V.djAudio.pause(); V.djAudio.removeAttribute('src'); V.djAudio.load(); }
  V.djTrack = null; V.speaking.delete(DJ_ID);
}
function syncDJ() {
  const cur = S.dj && S.dj.current;
  if (!djHere() || !cur) { stopDJAudio(); return; }
  ensureDJNodes();
  const a = V.djAudio;
  const url = `${S.base}${cur.url}?t=${S.token}`;
  const pos = () => ((cur.pausedAt || serverNow()) - cur.startedAt) / 1000;
  if (V.djTrack !== cur.id) {
    V.djTrack = cur.id;
    a.src = url;
    const start = () => {
      const p = pos();
      if (p < 0) { a.currentTime = 0; setTimeout(() => { if (V.djTrack === cur.id && !cur.pausedAt) a.play().catch(() => {}); }, -p * 1000); return; }
      a.currentTime = p;
      if (!cur.pausedAt) a.play().catch(() => {});
    };
    if (a.readyState >= 1) start(); else a.addEventListener('loadedmetadata', start, { once: true });
    return;
  }
  if (cur.pausedAt) { a.pause(); return; }
  const p = pos();
  if (a.readyState >= 1 && p >= 0 && Math.abs(a.currentTime - p) > 1.5) a.currentTime = p;
  if (a.paused && p >= 0) a.play().catch(() => {});
}
function summonDJ() {
  if (!V.joined) return toast('Entre numa call primeiro.');
  wsSend({ t: 'dj-summon', textChannel: S.textChannel });
  setTimeout(openDJPanel, 300);
}
let djPanel = null;
function openDJPanel() {
  if (!S.dj || !S.dj.active) return summonDJ();
  if (djPanel) return;
  djPanel = openModal(`<header><div><h2>${icon('music', 20)} DJ Resenha</h2><p>Cole um link do YouTube ou Spotify (música, playlist ou álbum), ou o nome da música.</p></div><button class="icon-btn" data-close>${icon('x')}</button></header>
    <div class="body"><div class="dj-add"><input id="dj-in" placeholder="https://youtube.com/... ou https://open.spotify.com/... ou nome da música" autocomplete="off"><button class="btn primary" id="dj-go">Adicionar</button></div><div id="dj-body"></div></div>`, { wide: true, cls: 'dj-modal', onClose: () => { djPanel = null; } });
  const go = () => { const v = $('#dj-in', djPanel.el).value.trim(); if (!v) return; wsSend({ t: 'dj-add', input: v }); $('#dj-in', djPanel.el).value = ''; };
  $('#dj-go', djPanel.el).onclick = go;
  $('#dj-in', djPanel.el).onkeydown = (e) => { if (e.key === 'Enter') go(); };
  $('#dj-in', djPanel.el).focus();
  renderDJPanel();
}
function renderDJPanel() {
  if (!djPanel) return;
  const d = S.dj;
  if (!d || !d.active) { djPanel.close(); return; }
  const here = djHere();
  const cur = d.current;
  const inCh = V.joined && V.channel === d.channelId;
  const mySkip = d.skipVotes.includes(S.myId), myKick = d.kickVotes.includes(S.myId);
  const q = d.queue;
  $('#dj-body', djPanel.el).innerHTML = `
    ${!here ? `<div class="dj-warn">O DJ está em <b>${esc(chanById(d.channelId)?.name || '')}</b>. ${V.joined ? `<a data-dj="move">Trazer pra minha call</a>` : 'Entre na call pra ouvir.'}</div>` : ''}
    <div class="dj-now-card">
      <div class="dj-disc ${cur && !cur.pausedAt ? 'spin' : ''}">${icon('music', 26)}</div>
      <div class="dj-info">
        <div class="dj-t">${cur ? esc(cur.title) : d.loading ? 'Carregando música...' : 'Nada tocando'}</div>
        <div class="muted small">${cur ? `Adicionada por ${esc(cur.addedBy || '?')}` : q.length ? '' : 'Adicione uma música aí em cima'}</div>
        <div class="dj-prog"><div class="dj-bar"><div id="dj-fill"></div></div><span id="dj-time" class="small muted"></span></div>
      </div>
    </div>
    <div class="dj-actions">
      <button class="btn" data-dj="pause" ${!cur || !inCh ? 'disabled' : ''}>${icon(cur && cur.pausedAt ? 'play' : 'pause', 16)} ${cur && cur.pausedAt ? 'Continuar' : 'Pausar'}</button>
      <button class="btn ${mySkip ? 'primary' : ''}" data-dj="skip" ${!cur || !inCh ? 'disabled' : ''}>${icon('skip', 16)} Votar pra pular (${d.skipVotes.length}/${d.needed})</button>
      <button class="btn ${myKick ? 'danger' : ''}" data-dj="kick" ${!inCh ? 'disabled' : ''}>${icon('logout', 16)} Votar pra remover o DJ (${d.kickVotes.length}/${d.needed})</button>
    </div>
    <div class="dj-vol"><span class="small muted">Volume do DJ pra você</span><input type="range" min="0" max="200" value="${settings.userVolumes[DJ_NAME] ?? 100}" id="dj-vol"><span class="small" id="dj-vol-v">${settings.userVolumes[DJ_NAME] ?? 100}%</span></div>
    <div class="section-title">Fila (${q.length})</div>
    <div class="dj-queue">${q.length ? q.map((it, i) => `<div class="dj-item"><span class="n">${i + 1}</span><div class="dj-it"><div>${esc(it.title)}</div><div class="muted small">${it.duration ? fmtDur(it.duration * 1000) + ' · ' : ''}${esc(it.addedBy || '')}${it.source === 'spotify' ? ' · Spotify' : ''}</div></div>${it.addedBy === me.name || S.isHost ? `<button class="icon-btn small" data-rm="${it.id}" title="Tirar da fila">${icon('x', 14)}</button>` : ''}</div>`).join('') : '<div class="muted small">Fila vazia</div>'}</div>
    ${S.djBusy ? '<div class="muted small dj-busy">Buscando música...</div>' : ''}`;
  $$('[data-dj]', djPanel.el).forEach((b) => b.onclick = () => {
    const a = b.dataset.dj;
    if (a === 'pause') wsSend({ t: 'dj-pause' });
    if (a === 'skip') wsSend({ t: 'dj-vote-skip' });
    if (a === 'kick') wsSend({ t: 'dj-vote-kick' });
    if (a === 'move') wsSend({ t: 'dj-summon', textChannel: S.textChannel });
  });
  $$('[data-rm]', djPanel.el).forEach((b) => b.onclick = () => wsSend({ t: 'dj-remove', id: b.dataset.rm }));
  $('#dj-vol', djPanel.el).oninput = (e) => { settings.userVolumes[DJ_NAME] = +e.target.value; $('#dj-vol-v', djPanel.el).textContent = e.target.value + '%'; applyUserVolume(DJ_ID); saveSettings(); };
  updateDJProgress();
}
function updateDJProgress() {
  if (!djPanel || !S.dj || !S.dj.current) return;
  const c = S.dj.current;
  const el = serverNow() - c.startedAt, t = Math.max(0, ((c.pausedAt || serverNow()) - c.startedAt) / 1000);
  const f = $('#dj-fill', djPanel.el), tm = $('#dj-time', djPanel.el);
  if (f) f.style.width = c.duration ? clamp(t / c.duration * 100, 0, 100) + '%' : '0';
  if (tm) tm.textContent = el < 0 ? 'começando...' : fmtDur(t * 1000) + (c.duration ? ' / ' + fmtDur(c.duration * 1000) : '');
}

// ---------------- Convite ----------------
async function openInvite() {
  const m = openModal(`<header><div><h2>Convidar amigos para ${esc(S.roomName)}</h2><p>Mande o código pro seu amigo.</p></div><button class="icon-btn" data-close>${icon('x')}</button></header>
    <div class="body"><div class="addr-list" id="inv-list"><div class="muted">Verificando sua rede...</div></div></div>
    <footer><button class="btn primary" data-close>Pronto</button></footer>`, { wide: true });
  const codeHTML = S.code ? `<div class="code-box"><div class="muted small" style="font-weight:700;text-transform:uppercase;margin-bottom:6px">Código da sala</div><div class="code">${esc(S.code)}</div><button class="btn primary" data-copy="${esc(S.code)}">Copiar código</button><div class="note">Seu amigo abre o Resenha, cola esse código em <b>Entrar numa sala</b> e pronto. Funciona pela internet sem abrir porta e sem Radmin. O código é o mesmo sempre que você abrir a sala com esse nome.</div></div>` : '';
  if (!S.isHost) {
    $('#inv-list', m.el).innerHTML = codeHTML || addrBlock('Endereço da sala', S.addr.text, 'É o mesmo endereço que você usou. Só funciona enquanto o anfitrião estiver com a sala aberta.');
    bindCopy(m.el); return;
  }
  $('#inv-list', m.el).innerHTML = codeHTML + '<details class="more"><summary>Outras formas de entrar (IP)</summary><div class="addr-list" id="inv-ip"><div class="muted">Verificando sua rede...</div></div></details>';
  bindCopy(m.el);
  const n = await native.hostNetwork();
  if (!n || !document.body.contains(m.el)) return;
  const port = n.port;
  let h = '';
  if (n.publicV4) {
    let note, cls;
    if (n.cgnat) { cls = 'bad'; note = 'Sua internet usa CGNAT (IP compartilhado da operadora), então por IP não dá. Use o código.'; }
    else if (n.upnp.ok) { cls = 'ok'; note = 'Porta aberta automaticamente no roteador (UPnP). Deve funcionar direto.'; }
    else { cls = 'warn'; note = `Não consegui abrir a porta sozinho (${esc(n.upnp.error || 'UPnP indisponível')}). Entre no roteador e redirecione <b>TCP e UDP ${port}</b> para <b>${esc(n.lan[0] || 'este PC')}</b>.`; }
    h += addrBlock('Pela internet (IPv4)', `${n.publicV4}:${port}`, note, cls);
  }
  if (n.publicV6) h += addrBlock('Pela internet (IPv6)', `[${n.publicV6}]:${port}`, 'Funciona se o amigo também tiver IPv6. Alguns roteadores bloqueiam entrada IPv6 no firewall.', '');
  for (const ip of n.lan) h += addrBlock('Mesma rede / mesmo Wi-Fi', `${ip}:${port}`, 'Pra quem está na sua casa.', '');
  for (const v of n.vpn) h += addrBlock('Rede virtual (Radmin, ZeroTier, Hamachi...)', `${v.split(' ')[0]}:${port}`, `Se vocês ainda usam essa rede: ${esc(v)}.`, '');
  h += '<p class="muted small" style="margin:4px 0 0">Entrar por IP só é necessário se o código não funcionar.</p>';
  $('#inv-ip', m.el).innerHTML = h;
  bindCopy($('#inv-ip', m.el));
}
function addrBlock(title, value, note, cls = '') {
  return `<div class="addr"><div class="t">${esc(title)}</div><div class="v"><code>${esc(value)}</code><button class="btn primary" data-copy="${esc(value)}">Copiar</button></div>${note ? `<div class="note ${cls}">${note}</div>` : ''}</div>`;
}
function bindCopy(root) { $$('[data-copy]', root).forEach((b) => b.onclick = () => { copy(b.dataset.copy); b.textContent = 'Copiado'; setTimeout(() => (b.textContent = 'Copiar'), 1500); }); }

// ---------------- Configurações ----------------
async function openSettings(tab = 'voz') {
  const inDevs = await listDevices('audioinput');
  const outDevs = await listDevices('audiooutput');
  const opt = (list, cur) => `<option value="default">Padrão do Windows</option>` + list.map((d) => `<option value="${esc(d.deviceId)}" ${d.deviceId === cur ? 'selected' : ''}>${esc(d.label || 'Dispositivo')}</option>`).join('');
  const fxBtns = Object.entries(FX).map(([k, f]) => `<button class="fx-btn ${settings.voiceFx === k ? 'sel' : ''}" data-fx="${k}">${esc(f.name)}${f.semis ? `<span>${f.semis > 0 ? '+' : ''}${f.semis}</span>` : ''}</button>`).join('');
  const m = openModal(`<header><div><h2>Configurações</h2></div><button class="icon-btn" data-close>${icon('x')}</button></header>
    <div class="body">
      <div class="tabs"><div class="tab" data-t="voz">Voz</div><div class="tab" data-t="filtros">Filtros de voz</div><div class="tab" data-t="aparencia">Aparência</div><div class="tab" data-t="perfil">Perfil</div>${native ? '<div class="tab" data-t="atalhos">Atalhos</div>' : ''}</div>
      <div class="tp" data-p="aparencia">
        <div class="section-title" style="margin-top:0">Tema</div>
        <div class="theme-grid">${Object.entries(THEMES).map(([k, t]) => { const v = themePreview(k); return `<button class="theme-card ${settings.theme === k ? 'sel' : ''}" data-theme="${k}"><div class="tc-prev" style="background:${v['bg-rail']}"><i style="background:${v['bg-side']}"></i><i style="background:${v['bg-main']}"><b style="background:${v.blurple}"></b><s style="background:${v.muted}"></s><s style="background:${v.muted}"></s></i></div><span>${esc(t.name)}</span></button>`; }).join('')}</div>
        <div class="section-title">Layout</div>
        <div class="settings-grid">
          <div class="field"><label>Tamanho da interface <span id="st-fs-v">${settings.fontScale}%</span></label><input type="range" id="st-fs" min="85" max="125" step="5" value="${settings.fontScale}"></div>
          <div class="field"><label>Densidade</label><label class="check"><input type="checkbox" id="st-compact" ${settings.compact ? 'checked' : ''}> Modo compacto (mais coisa na tela)</label></div>
        </div>
        <p class="muted small" style="margin:4px 0 10px">Pra mudar as coisas de lugar é só <b>segurar e arrastar</b>: o topo de cada painel (Canais, Call, Chat), os canais da lista, os quadrados da call e a miniatura da tela. As bordas entre os painéis mudam a largura.</p>
        <button class="btn" id="st-reset-layout">Voltar layout ao padrão</button>
      </div>
      <div class="tp" data-p="perfil">
        <div class="home-profile" style="margin:0">
          <div class="avatar avatar-edit" id="st-av"></div>
          <div class="field grow"><label>Nome</label><input id="st-name" maxlength="32" value="${esc(me.name)}"></div>
          <div class="field"><label>Cor</label><input type="color" id="st-color" value="${esc(me.color)}"></div>
        </div>
      </div>
      <div class="tp" data-p="voz">
        <div class="settings-grid">
          <div class="field"><label>Microfone</label><select id="st-in">${opt(inDevs, settings.inputDevice)}</select></div>
          <div class="field"><label>Saída (fone/caixa)</label><select id="st-out">${opt(outDevs, settings.outputDevice)}</select></div>
          <div class="field"><label>Volume do microfone <span id="st-mg-v">${settings.micGain}%</span></label><input type="range" id="st-mg" min="0" max="200" value="${settings.micGain}"></div>
          <div class="field"><label>Seu microfone agora</label><div class="meter"><div class="lvl"></div><div class="thr"></div></div><div class="small muted" id="st-state"></div></div>
        </div>
        <div class="ns-box">
          <label class="check big"><input type="checkbox" id="st-ai" ${settings.aiNoise ? 'checked' : ''}> <span><b>Supressão de ruído com IA</b><br><span class="muted small">Tira teclado, ventilador, cachorro e barulho de fundo. Quando você não está falando, não sai som nenhum.</span></span></label>
          <div class="field" id="st-vad-box"><label>Exigência pra reconhecer voz <span id="st-vad-v">${settings.vadSens}%</span></label><input type="range" id="st-vad" min="10" max="95" value="${settings.vadSens}"><div class="small muted">Mais alto = só passa voz bem clara. Mais baixo = passa até sussurro.</div></div>
          <div id="st-sens-box">
            <label class="check"><input type="checkbox" id="st-auto" ${settings.autoSens ? 'checked' : ''}> Sensibilidade automática</label>
            <input type="range" id="st-thr" min="-80" max="-10" value="${settings.threshold}" ${settings.autoSens ? 'disabled' : ''}>
          </div>
        </div>
        <div style="display:flex;gap:18px;flex-wrap:wrap;margin-top:10px">
          <label class="check"><input type="checkbox" id="st-ec" ${settings.echoCancellation ? 'checked' : ''}> Cancelamento de eco</label>
          <label class="check"><input type="checkbox" id="st-ag" ${settings.autoGain ? 'checked' : ''}> Ganho automático</label>
          <label class="check"><input type="checkbox" id="st-snd" ${settings.sounds ? 'checked' : ''}> Sons de entrar/sair</label>
        </div>
      </div>
      <div class="tp" data-p="filtros">
        <p class="muted small" style="margin-top:0">Muda sua voz pra todo mundo da call. Use o botão de teste pra se ouvir (use fone).</p>
        <div class="fx-grid">${fxBtns}</div>
        <div class="field" id="st-semis-box"><label>Tom personalizado <span id="st-semis-v">${settings.pitchSemis > 0 ? '+' : ''}${settings.pitchSemis}</span> semitons</label><input type="range" id="st-semis" min="-12" max="12" step="1" value="${settings.pitchSemis}"></div>
        <button class="btn" id="st-monitor">${icon('headphones', 16)} Testar: ouvir minha voz</button>
      </div>
      <div class="tp" data-p="atalhos">
        <div class="settings-grid">
          <div class="field"><label>Mutar/desmutar microfone</label><div class="kbd" data-key="keyMute">${esc(settings.keyMute || 'Nenhum')}</div></div>
          <div class="field"><label>Mutar som e microfone</label><div class="kbd" data-key="keyDeafen">${esc(settings.keyDeafen || 'Nenhum')}</div></div>
        </div><p class="muted small" style="margin:0">Funcionam até dentro do jogo. Clique e aperte a combinação. Esc limpa.</p>
      </div>
    </div>
    <footer><span class="muted small" style="margin-right:auto" id="st-ver"></span><button class="btn primary" data-close>Pronto</button></footer>`, { onClose: () => { V.testing = false; setMonitor(false); if (!V.joined && V.src) { V.raw.getTracks().forEach((t) => t.stop()); V.src.disconnect(); V.src = null; V.raw = null; } } });
  const el = m.el;
  const showTab = (t) => { $$('.tab', el).forEach((x) => x.classList.toggle('active', x.dataset.t === t)); $$('.tp', el).forEach((x) => x.classList.toggle('hidden', x.dataset.p !== t)); };
  $$('.tab', el).forEach((x) => x.onclick = () => showTab(x.dataset.t));
  showTab(tab);
  if (native) native.version().then((v) => { $('#st-ver', el).textContent = 'Resenha v' + v; });
  setAvatarEl($('#st-av', el), me);
  $('#st-av', el).onclick = () => pickAvatar(() => { setAvatarEl($('#st-av', el), me); renderAll(); });
  $('#st-name', el).onchange = () => { const v = $('#st-name', el).value.trim(); if (v) { me.name = v; LS.set('profile', me); $('#home-name').value = v; sendProfile(); renderAll(); } };
  $('#st-color', el).oninput = () => { me.color = $('#st-color', el).value; LS.set('profile', me); sendProfile(); setAvatarEl($('#st-av', el), me); renderSidebar(); };
  const remic = async () => { saveSettings(); if (V.src) { try { await openMic(); } catch (e) { toast('Microfone: ' + e.message, 'err'); } } };
  $('#st-in', el).onchange = (e) => { settings.inputDevice = e.target.value; remic(); };
  $('#st-out', el).onchange = (e) => { settings.outputDevice = e.target.value; saveSettings(); applyOutputDevice(); };
  $('#st-mg', el).oninput = (e) => { settings.micGain = +e.target.value; $('#st-mg-v', el).textContent = e.target.value + '%'; if (V.micGain) V.micGain.gain.value = settings.micGain / 100; saveSettings(); };
  const nsUI = () => { $('#st-vad-box', el).classList.toggle('hidden', !settings.aiNoise); $('#st-sens-box', el).classList.toggle('hidden', settings.aiNoise); };
  nsUI();
  $('#st-ai', el).onchange = (e) => { settings.aiNoise = e.target.checked; saveSettings(); applyNoiseMode(); nsUI(); };
  $('#st-vad', el).oninput = (e) => { settings.vadSens = +e.target.value; $('#st-vad-v', el).textContent = e.target.value + '%'; saveSettings(); applyNoiseMode(); };
  $('#st-auto', el).onchange = (e) => { settings.autoSens = e.target.checked; $('#st-thr', el).disabled = e.target.checked; saveSettings(); };
  $('#st-thr', el).oninput = (e) => { settings.threshold = +e.target.value; saveSettings(); };
  for (const [id, k] of [['st-ec', 'echoCancellation'], ['st-ag', 'autoGain']]) $('#' + id, el).onchange = (e) => { settings[k] = e.target.checked; remic(); };
  $('#st-snd', el).onchange = (e) => { settings.sounds = e.target.checked; saveSettings(); };
  // Aparência
  $$('.theme-card', el).forEach((b) => b.onclick = () => { settings.theme = b.dataset.theme; saveSettings(); applyTheme(settings.theme); $$('.theme-card', el).forEach((x) => x.classList.toggle('sel', x === b)); });
  $('#st-fs', el).onchange = (e) => { settings.fontScale = +e.target.value; saveSettings(); applyLayout(); };
  $('#st-fs', el).oninput = (e) => { $('#st-fs-v', el).textContent = e.target.value + '%'; };
  $('#st-compact', el).onchange = (e) => { settings.compact = e.target.checked; saveSettings(); applyLayout(); };
  $('#st-reset-layout', el).onclick = () => { resetLayout(); toast('Layout padrão restaurado', 'ok', 1500); };
  // Filtros
  const fxUI = () => { $$('.fx-btn', el).forEach((b) => b.classList.toggle('sel', b.dataset.fx === settings.voiceFx)); $('#st-semis-box', el).classList.toggle('hidden', settings.voiceFx !== 'custom'); };
  fxUI();
  $$('.fx-btn', el).forEach((b) => b.onclick = () => { settings.voiceFx = b.dataset.fx; saveSettings(); applyVoiceFx(); fxUI(); });
  $('#st-semis', el).oninput = (e) => { settings.pitchSemis = +e.target.value; $('#st-semis-v', el).textContent = (settings.pitchSemis > 0 ? '+' : '') + settings.pitchSemis; saveSettings(); applyVoiceFx(); };
  $('#st-monitor', el).onclick = () => { setMonitor(!V.monitor); $('#st-monitor', el).classList.toggle('primary', !!V.monitor); $('#st-monitor', el).innerHTML = `${icon('headphones', 16)} ${V.monitor ? 'Parar teste' : 'Testar: ouvir minha voz'}`; };
  // Atalhos
  $$('.kbd', el).forEach((k) => k.onclick = () => {
    $$('.kbd', el).forEach((x) => x.classList.remove('rec'));
    k.classList.add('rec'); k.textContent = 'Aperte as teclas...';
    const onKey = (e) => {
      e.preventDefault(); e.stopPropagation();
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
      const parts = []; if (e.ctrlKey) parts.push('Control'); if (e.altKey) parts.push('Alt'); if (e.shiftKey) parts.push('Shift');
      let key = e.code.replace(/^Key/, '').replace(/^Digit/, '');
      if (!/^F\d+$/.test(key) && key.length > 1 && !/^(Numpad\d|Space|Insert|Home|End|PageUp|PageDown|Pause)$/.test(key)) key = e.key.length === 1 ? e.key.toUpperCase() : key;
      if (key.startsWith('Numpad') && /\d/.test(key)) key = 'num' + key.slice(6);
      const accel = e.key === 'Escape' ? '' : [...parts, key].join('+');
      settings[k.dataset.key] = accel; saveSettings();
      k.textContent = accel || 'Nenhum'; k.classList.remove('rec');
      document.removeEventListener('keydown', onKey, true);
      registerShortcuts();
    };
    document.addEventListener('keydown', onKey, true);
  });
  // Medidor
  try {
    await ensureAudio();
    if (!V.src) await openMic();
    V.testing = true;
    const lvl = $('.lvl', el), thr = $('.thr', el), st = $('#st-state', el);
    const pos = (db) => clamp((db + 80) / 70 * 100, 0, 100) + '%';
    const tick = () => {
      if (!document.body.contains(el)) return;
      const ai = settings.aiNoise && V.rnReady;
      const open = ai ? V.vadOpen : V.gateOpen;
      lvl.style.width = pos(V.selfLevel);
      lvl.style.background = open ? 'var(--green)' : '#4e5058';
      thr.style.display = ai ? 'none' : '';
      thr.style.left = pos(settings.autoSens ? (V.autoThr ?? -50) : settings.threshold);
      st.textContent = ai ? (open ? 'Voz detectada: enviando' : 'Sem voz: silêncio') : (open ? 'Enviando' : 'Abaixo da sensibilidade');
      requestAnimationFrame(tick);
    };
    tick();
  } catch {}
}
function setMonitor(on) {
  if (!V.ctx) return;
  if (on && !V.monitor) { V.monitor = V.ctx.createGain(); V.monitor.gain.value = 1; V.post.connect(V.monitor); V.monitor.connect(V.ctx.destination); }
  if (!on && V.monitor) { try { V.post.disconnect(V.monitor); V.monitor.disconnect(); } catch {} V.monitor = null; }
}
async function registerShortcuts() {
  if (!native) return;
  const r = await native.setShortcuts({ mute: settings.keyMute, deafen: settings.keyDeafen });
  for (const [k, ok] of Object.entries(r || {})) if (!ok) toast(`Não consegui registrar o atalho ${k === 'mute' ? settings.keyMute : settings.keyDeafen} (outro programa usa?)`, 'err');
}
if (native) native.onShortcut((a) => {
  if (a === 'mute') setMuted(!(V.muted || V.deafened));
  if (a === 'deafen') setDeafened(!V.deafened);
  if (a === 'leave') leaveVoice();
});

// ---------------- Menu da sala ----------------
function roomMenu() {
  const menu = $('#room-menu');
  if (!menu.classList.contains('hidden')) return menu.classList.add('hidden');
  menu.innerHTML = `<div class="dd-item" data-a="invite">Convidar pessoas ${icon('userPlus', 16)}</div>
    <div class="dd-item" data-a="copy">${S.code ? 'Copiar código da sala' : 'Copiar endereço'} ${icon('copy', 16)}</div>
    <div class="dd-item" data-a="newtext">Criar canal de texto ${icon('hash', 16)}</div>
    <div class="dd-item" data-a="newvoice">Criar canal de voz ${icon('volume', 16)}</div>
    <div class="dd-item" data-a="settings">Configurações ${icon('settings', 16)}</div>
    <div class="dd-item danger" data-a="leave">${S.isHost ? 'Fechar sala' : 'Sair da sala'} ${icon('logout', 16)}</div>`;
  menu.classList.remove('hidden');
  $$('.dd-item', menu).forEach((it) => it.onclick = async () => {
    menu.classList.add('hidden');
    const a = it.dataset.a;
    if (a === 'invite') openInvite();
    if (a === 'settings') openSettings();
    if (a === 'newtext') createChannel('text');
    if (a === 'newvoice') createChannel('voice');
    if (a === 'copy') {
      if (S.code) return copy(S.code);
      if (!S.isHost) return copy(S.addr.text);
      const n = await native.hostNetwork();
      copy(n.publicV4 && !n.cgnat ? `${n.publicV4}:${n.port}` : `${n.lan[0]}:${n.port}`);
    }
    if (a === 'leave') {
      if (S.isHost && S.users.size > 1 && !await confirmModal('Fechar a sala', 'Fechar a sala desconecta todo mundo. Continuar?', 'Fechar sala')) return;
      leaveRoom();
    }
  });
}

// ---------------- Atualização ----------------
async function checkUpdates() {
  if (!native) return;
  const r = await native.checkUpdate();
  if (!r || !r.update) return;
  const bar = $('#update-bar');
  bar.innerHTML = `${icon('sparkles', 16)}<span>Nova versão do Resenha: <b>v${esc(r.version)}</b> (você tem v${esc(r.current)})</span><button class="btn small-btn" id="up-notes">O que mudou</button><button class="btn primary small-btn" id="up-go">Atualizar</button><button class="icon-btn small" id="up-x">${icon('x', 14)}</button>`;
  bar.classList.remove('hidden');
  document.body.classList.add('has-update');
  $('#up-x').onclick = () => { bar.classList.add('hidden'); document.body.classList.remove('has-update'); };
  $('#up-notes').onclick = () => openModal(`<header><div><h2>Novidades da v${esc(r.version)}</h2></div><button class="icon-btn" data-close>${icon('x')}</button></header><div class="body"><div class="notes">${esc(r.notes || 'Sem descrição.').replace(/\n/g, '<br>')}</div></div>`);
  $('#up-go').onclick = async () => {
    if (V.joined && !await confirmModal('Atualizar agora?', 'O Resenha vai fechar e abrir de novo sozinho (leva uns segundos).', 'Atualizar', false)) return;
    bar.innerHTML = `${icon('download', 16)}<span>Baixando atualização... <b id="up-pct">0%</b></span><div class="up-bar"><div id="up-fill"></div></div>`;
    native.onUpdateProgress((p) => { const a = $('#up-pct'), f = $('#up-fill'); if (a) a.textContent = p + '%'; if (f) f.style.width = p + '%'; });
    const res = await native.installUpdate(r);
    if (!res.ok) { bar.innerHTML = `<span>Não deu pra atualizar: ${esc(res.error)}</span><button class="btn small-btn" id="up-page">Baixar pelo site</button><button class="icon-btn small" id="up-x2">${icon('x', 14)}</button>`; $('#up-page').onclick = () => native.openExternal(r.page); $('#up-x2').onclick = () => { bar.classList.add('hidden'); document.body.classList.remove('has-update'); }; }
    else bar.innerHTML = `<span>Reiniciando o Resenha...</span>`;
  };
}

// ---------------- Layout: mover painéis, redimensionar, ordem dos quadrados ----------------
const PANE_NAMES = { sidebar: 'Canais', call: 'Call', chat: 'Chat' };
function applyLayout() {
  const main = $('#main');
  const order = settings.layout.filter((p) => PANE_NAMES[p]);
  for (const p of Object.keys(PANE_NAMES)) if (!order.includes(p)) order.push(p);
  settings.layout = order;
  $$('.splitter', main).forEach((s) => s.remove());
  order.forEach((p, i) => {
    const el = $('#' + p);
    main.appendChild(el);
    el.classList.toggle('first-pane', i === 0);
    if (i < order.length - 1) {
      const sp = document.createElement('div'); sp.className = 'splitter'; sp.dataset.left = p; sp.dataset.right = order[i + 1];
      main.appendChild(sp);
    }
  });
  const r = document.documentElement.style;
  r.setProperty('--chat-w', settings.chatWidth + 'px');
  r.setProperty('--side-w', settings.sidebarWidth + 'px');
  if (native && native.setZoom) native.setZoom(settings.fontScale / 100);
  document.body.classList.toggle('compact', !!settings.compact);
  $('#pips').dataset.corner = settings.pipCorner;
  bindSplitters();
  layoutGrid();
}
function bindSplitters() {
  $$('.splitter').forEach((sp) => {
    sp.onmousedown = (e) => {
      e.preventDefault(); sp.classList.add('drag'); document.body.classList.add('resizing');
      const L = sp.dataset.left, Rr = sp.dataset.right;
      // redimensiona o painel de tamanho fixo (canais/chat) que está encostado nesse divisor
      const target = [L, Rr].find((p) => p !== 'call') || 'chat';
      const startX = e.clientX, startW = target === 'chat' ? settings.chatWidth : settings.sidebarWidth;
      const sign = target === L ? 1 : -1;
      const move = (ev) => {
        const w = startW + (ev.clientX - startX) * sign;
        if (target === 'chat') settings.chatWidth = clamp(w, 300, innerWidth * 0.6);
        else settings.sidebarWidth = clamp(w, 200, 420);
        document.documentElement.style.setProperty('--chat-w', settings.chatWidth + 'px');
        document.documentElement.style.setProperty('--side-w', settings.sidebarWidth + 'px');
        layoutGrid();
      };
      const up = () => { sp.classList.remove('drag'); document.body.classList.remove('resizing'); saveSettings(); removeEventListener('mousemove', move); removeEventListener('mouseup', up); };
      addEventListener('mousemove', move); addEventListener('mouseup', up);
    };
    sp.ondblclick = () => { settings.chatWidth = 440; settings.sidebarWidth = 240; saveSettings(); applyLayout(); };
  });
}
function initLayout() {
  applyLayout();
  // Arrastar painéis pelo "pegador" do cabeçalho
  let dragPane = null;
  $$('.drag-head').forEach((g) => {
    g.addEventListener('dragstart', (e) => { if (e.target.closest('button, input')) { e.preventDefault(); return; } dragPane = g.dataset.pane; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/resenha-pane', dragPane); document.body.classList.add('dragging-pane'); $('#' + dragPane).classList.add('pane-dragging'); });
    g.addEventListener('dragend', () => { document.body.classList.remove('dragging-pane'); $$('.pane-dragging, .drop-left, .drop-right').forEach((x) => x.classList.remove('pane-dragging', 'drop-left', 'drop-right')); dragPane = null; });
  });
  // Reordenar canais segurando e arrastando (vale pra todo mundo da sala)
  let dragCh = null;
  for (const box of [$('#text-channels'), $('#voice-channels')]) {
    box.addEventListener('dragstart', (e) => {
      const ch = e.target.closest('[data-ch], [data-vch]'); if (!ch) return;
      dragCh = ch.dataset.ch || ch.dataset.vch; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/resenha-ch', dragCh); ch.classList.add('ch-dragging');
    });
    box.addEventListener('dragend', () => { dragCh = null; $$('.ch-dragging, .ch-over-top, .ch-over-bottom').forEach((x) => x.classList.remove('ch-dragging', 'ch-over-top', 'ch-over-bottom')); });
    box.addEventListener('dragover', (e) => {
      const ch = e.target.closest('[data-ch], [data-vch]'); if (!dragCh || !ch) return;
      const id = ch.dataset.ch || ch.dataset.vch; if (id === dragCh || chanById(id)?.type !== chanById(dragCh)?.type) return;
      e.preventDefault();
      const r = ch.getBoundingClientRect(); const top = e.clientY < r.top + r.height / 2;
      $$('.ch-over-top, .ch-over-bottom').forEach((x) => x !== ch && x.classList.remove('ch-over-top', 'ch-over-bottom'));
      ch.classList.toggle('ch-over-top', top); ch.classList.toggle('ch-over-bottom', !top);
    });
    box.addEventListener('drop', (e) => {
      const ch = e.target.closest('[data-ch], [data-vch]'); if (!dragCh || !ch) return;
      const id = ch.dataset.ch || ch.dataset.vch; if (id === dragCh) return;
      e.preventDefault();
      const top = ch.classList.contains('ch-over-top');
      const ids = S.channels.map((c) => c.id).filter((x) => x !== dragCh);
      ids.splice(ids.indexOf(id) + (top ? 0 : 1), 0, dragCh);
      wsSend({ t: 'ch-order', ids });
    });
  }
  for (const p of Object.keys(PANE_NAMES)) {
    const el = $('#' + p);
    el.addEventListener('dragover', (e) => {
      if (!dragPane || dragPane === p) return;
      e.preventDefault();
      const r = el.getBoundingClientRect(); const left = e.clientX < r.left + r.width / 2;
      el.classList.toggle('drop-left', left); el.classList.toggle('drop-right', !left);
    });
    el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove('drop-left', 'drop-right'); });
    el.addEventListener('drop', (e) => {
      if (!dragPane || dragPane === p) return;
      e.preventDefault(); e.stopPropagation();
      const left = el.classList.contains('drop-left');
      const order = settings.layout.filter((x) => x !== dragPane);
      order.splice(order.indexOf(p) + (left ? 0 : 1), 0, dragPane);
      settings.layout = order; saveSettings();
      el.classList.remove('drop-left', 'drop-right');
      applyLayout();
      toast('Layout salvo. Pra voltar ao padrão: Configurações > Aparência.', 'ok', 2500);
    });
  }
  // Reordenar quadrados da call arrastando
  $('#call-stage').addEventListener('dragstart', (e) => {
    const t = e.target.closest('.grid > .tile, .focus-strip > .tile'); if (!t) return;
    e.dataTransfer.setData('text/resenha-tile', t.dataset.key); e.dataTransfer.effectAllowed = 'move'; t.classList.add('tile-dragging');
  });
  $('#call-stage').addEventListener('dragend', () => $$('.tile-dragging, .tile-over').forEach((x) => x.classList.remove('tile-dragging', 'tile-over')));
  $('#call-stage').addEventListener('dragover', (e) => { const t = e.target.closest('.tile'); if (t && e.dataTransfer.types.includes('text/resenha-tile')) { e.preventDefault(); $$('.tile-over').forEach((x) => x !== t && x.classList.remove('tile-over')); t.classList.add('tile-over'); } });
  $('#call-stage').addEventListener('drop', (e) => {
    const key = e.dataTransfer.getData('text/resenha-tile'); const t = e.target.closest('.tile');
    if (!key || !t || t.dataset.key === key) return;
    e.preventDefault();
    const keys = [...t.parentElement.children].map((x) => x.dataset.key);
    const order = keys.filter((k) => k !== key); order.splice(order.indexOf(t.dataset.key) + (keys.indexOf(key) < keys.indexOf(t.dataset.key) ? 1 : 0), 0, key);
    const uid = (k) => k.split(':')[1];
    const known = settings.tileOrder.filter((u) => !order.map(uid).includes(u));
    settings.tileOrder = [...order.map(uid), ...known].slice(0, 60); saveSettings();
    renderCall();
  });
  // Mover a miniatura da tela compartilhada pra qualquer canto
  const pips = $('#pips');
  pips.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('.tile-tools')) return;
    const t = e.target.closest('.tile'); if (!t) return;
    const sx = e.clientX, sy = e.clientY, r0 = pips.getBoundingClientRect(), box = $('#call').getBoundingClientRect();
    let moved = false;
    const move = (ev) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (!moved && Math.hypot(dx, dy) < 6) return;
      moved = true; pips.classList.add('moving');
      pips.style.left = clamp(r0.left - box.left + dx, 0, box.width - r0.width) + 'px';
      pips.style.top = clamp(r0.top - box.top + dy, 0, box.height - r0.height) + 'px';
      pips.style.right = pips.style.bottom = 'auto';
    };
    const up = (ev) => {
      removeEventListener('mousemove', move); removeEventListener('mouseup', up);
      if (!moved) return;
      pips.classList.remove('moving');
      const cx = ev.clientX - box.left, cy = ev.clientY - box.top;
      settings.pipCorner = (cy < box.height / 2 ? 't' : 'b') + (cx < box.width / 2 ? 'l' : 'r');
      pips.removeAttribute('style'); pips.dataset.corner = settings.pipCorner; saveSettings();
      pips.addEventListener('click', (ce) => ce.stopPropagation(), { capture: true, once: true });
    };
    addEventListener('mousemove', move); addEventListener('mouseup', up);
  });
}
function sortByTileOrder(list) {
  const pos = (u) => { const i = settings.tileOrder.indexOf(u.id); return i < 0 ? 1e6 + (u.joinedAt || 0) : i; };
  return [...list].sort((a, b) => pos(a) - pos(b));
}
function resetLayout() {
  Object.assign(settings, { layout: ['sidebar', 'call', 'chat'], chatWidth: 440, sidebarWidth: 240, tileOrder: [], pipCorner: 'br' });
  saveSettings(); applyLayout(); renderCall();
}

// ---------------- Ligações de UI ----------------
function bind() {
  $('#btn-invite').innerHTML = icon('userPlus', 18);
  $('#btn-attach').innerHTML = icon('plus', 22);
  $('#btn-settings').innerHTML = icon('settings');
  $('#vp-leave').innerHTML = icon('phoneOff');
  $('#vp-invite').innerHTML = icon('userPlus');
  $('#vp-dj').innerHTML = icon('music');
  $('#vp-signal').innerHTML = icon('signal', 20);
  $$('.cat-add').forEach((b) => { b.innerHTML = icon('plusSmall', 16); b.onclick = () => createChannel(b.dataset.add); });
  $$('.ico-hash').forEach((e) => (e.outerHTML = icon('hash', 20)));
  $$('.ico-vol').forEach((e) => (e.outerHTML = icon('volume', 20)));
  $('#btn-invite').onclick = (e) => { e.stopPropagation(); openInvite(); };
  $('#room-header').onclick = roomMenu;
  $('#btn-mute').onclick = $('#cc-mute').onclick = () => setMuted(!(V.muted || V.deafened));
  $('#btn-deafen').onclick = $('#cc-deafen').onclick = () => setDeafened(!V.deafened);
  $('#btn-mute').oncontextmenu = $('#cc-mute').oncontextmenu = (e) => deviceMenu(e, 'audioinput');
  $('#btn-deafen').oncontextmenu = $('#cc-deafen').oncontextmenu = (e) => deviceMenu(e, 'audiooutput');
  $('#btn-settings').onclick = () => openSettings();
  $('#up-user').onclick = () => openSettings('perfil');
  $('#vp-leave').onclick = $('#cc-leave').onclick = () => leaveVoice();
  $('#vp-share').onclick = $('#cc-share').onclick = toggleShare;
  $('#vp-invite').onclick = openInvite;
  $('#vp-dj').onclick = $('#btn-dj').onclick = openDJPanel;
  $('#rail-home').onclick = () => toast('Pra sair, use o menu da sala (clique no nome dela).');
  // Canais
  $('#text-channels').onclick = (e) => {
    const ed = e.target.closest('[data-edit]'); if (ed) { e.stopPropagation(); return channelMenu(e, ed.dataset.edit); }
    const ch = e.target.closest('[data-ch]'); if (ch) selectTextChannel(ch.dataset.ch);
  };
  $('#voice-channels').onclick = (e) => {
    const ed = e.target.closest('[data-edit]'); if (ed) { e.stopPropagation(); return channelMenu(e, ed.dataset.edit); }
    const u = e.target.closest('[data-uid]'); if (u) { if (u.dataset.uid === DJ_ID) return openDJPanel(); return userMenu(e, u.dataset.uid); }
    const ch = e.target.closest('[data-vch]'); if (ch) joinVoice(ch.dataset.vch);
  };
  const chCtx = (e) => {
    const u = e.target.closest('[data-uid]'); if (u) return userMenu(e, u.dataset.uid);
    const ch = e.target.closest('[data-ch], [data-vch]'); if (ch) channelMenu(e, ch.dataset.ch || ch.dataset.vch);
  };
  $('#text-channels').oncontextmenu = chCtx; $('#voice-channels').oncontextmenu = chCtx;
  $('#online-users').oncontextmenu = (e) => { const el = e.target.closest('[data-uid]'); if (el) userMenu(e, el.dataset.uid); };
  $('#online-users').onclick = (e) => { const el = e.target.closest('[data-uid]'); if (el) userMenu(e, el.dataset.uid); };
  initLayout();
  navigator.mediaDevices?.addEventListener?.('devicechange', () => { if (V.joined && settings.inputDevice === 'default') openMic().catch(() => {}); });
}

window.__resenha = { failover, successionOrder, applyLayout, resetLayout, joinByCode, S, V, settings, joinVoice, leaveVoice, setMuted, setDeafened, sendMessage, hostRoom, joinRoom, toggleShare, startShareWithStream, applyUserVolume, applyVoiceFx, applyNoiseMode, selectTextChannel, openDJPanel, summonDJ, startEdit, msgAction, deviceMenu, wsSend, openSettings };
applyTheme(settings.theme);
bind();
initHome();
registerShortcuts();
setTimeout(checkUpdates, 2500);
window.addEventListener('beforeunload', () => { try { if (S.ws) S.ws.close(); } catch {} });
