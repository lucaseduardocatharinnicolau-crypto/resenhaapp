// Servidor da sala: WebSocket (chat, canais, presença, sinalização WebRTC, DJ) + HTTP (anexos e músicas do DJ).
// Roda embutido no app de quem cria a sala, ou sozinho com: node server/index.js --port 7777
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.avif': 'image/avif',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.m4v': 'video/mp4',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.opus': 'audio/ogg',
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.zip': 'application/zip',
};
const mimeOf = (name) => MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';
const rid = (n = 8) => crypto.randomBytes(n).toString('hex');
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
const cleanText = (s, max) => String(s ?? '').replace(/\r/g, '').replace(/[\u0000-\u0009\u000b-\u001f]/g, '').slice(0, max).trim();
const validAvatar = (a) => (typeof a === 'string' && /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(a) && a.length < 120000 ? a : null);
const safeFileName = (s) => (clean(s, 180).replace(/[\\/:*?"<>|]/g, '_') || 'arquivo');
const chanName = (s, type) => {
  let n = clean(s, 32);
  if (type === 'text') n = n.toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '');
  return n;
};
const DJ_ID = 'dj-resenha';

function createServer(opts = {}) {
  const port = Number(opts.port) || 7777;
  const password = opts.password || '';
  let roomName = clean(opts.roomName, 40) || 'Minha sala';
  const dataDir = opts.dataDir || path.join(process.cwd(), 'resenha-data');
  const maxUpload = opts.maxUpload || 2 * 1024 * 1024 * 1024; // 2 GB por arquivo
  const log = opts.log || ((...a) => console.log('[sala]', ...a));
  const djTools = opts.dj || null;

  const filesDir = path.join(dataDir, 'files');
  fs.mkdirSync(filesDir, { recursive: true });
  const historyFile = path.join(dataDir, 'history.json');
  const filesIndex = path.join(dataDir, 'files.json');
  const channelsFile = path.join(dataDir, 'channels.json');
  let channels = null;
  let history = {}; // channelId -> [msg]
  let files = {};
  try { channels = JSON.parse(fs.readFileSync(channelsFile, 'utf8')); } catch {}
  if (!Array.isArray(channels) || !channels.length) channels = [{ id: 'geral', type: 'text', name: 'geral' }, { id: 'lobby', type: 'voice', name: 'Lobby' }];
  try {
    const h = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
    history = Array.isArray(h) ? { [channels.find((c) => c.type === 'text').id]: h } : h; // migra formato antigo
  } catch {}
  try { files = JSON.parse(fs.readFileSync(filesIndex, 'utf8')); } catch {}
  const textIds = () => channels.filter((c) => c.type === 'text').map((c) => c.id);
  const findMsg = (id) => { for (const [cid, list] of Object.entries(history)) { const i = list.findIndex((m) => m.id === id); if (i > -1) return { cid, list, i, msg: list[i] }; } return null; };

  const token = rid(16); // token de acesso aos anexos (muda a cada vez que a sala abre)
  let saveTimer = null;
  const saveNow = () => {
    try {
      for (const k of Object.keys(history)) if (history[k].length > 2000) history[k] = history[k].slice(-2000);
      fs.writeFileSync(historyFile, JSON.stringify(history));
      fs.writeFileSync(filesIndex, JSON.stringify(files));
      fs.writeFileSync(channelsFile, JSON.stringify(channels));
    } catch (e) { log('erro salvando', e.message); }
  };
  const saveSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 500); };

  const clients = new Map(); // id -> { ws, user }
  const send = (ws, obj) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };
  const broadcast = (obj, exceptId) => {
    const data = JSON.stringify(obj);
    for (const [id, c] of clients) if (id !== exceptId && c.ws.readyState === 1) c.ws.send(data);
  };
  const systemMsg = (channelId, text) => {
    const cid = channelId && textIds().includes(channelId) ? channelId : textIds()[0];
    const msg = { id: rid(8), channelId: cid, userId: DJ_ID, name: 'DJ Resenha', color: '#f47b67', bot: true, text, attachments: [], ts: Date.now() };
    (history[cid] = history[cid] || []).push(msg); saveSoon();
    broadcast({ t: 'chat', msg });
  };

  // ---------------- DJ Resenha ----------------
  const dj = { active: false, channelId: null, queue: [], current: null, loading: false, skipVotes: new Set(), kickVotes: new Set(), timer: null, idleTimer: null, textChannel: null, since: null };
  const djUser = () => ({ id: DJ_ID, name: 'DJ Resenha', color: '#f47b67', bot: true, avatar: null, voiceChannel: dj.channelId, muted: false, deafened: false, sharing: false, voiceSince: dj.since });
  const publicUsers = () => { const l = [...clients.values()].map((c) => c.user); if (dj.active) l.push(djUser()); return l; };
  const listeners = () => [...clients.values()].filter((c) => c.user.voiceChannel && c.user.voiceChannel === dj.channelId).map((c) => c.user.id);
  const needed = () => Math.floor(listeners().length / 2) + 1; // maioria (mais da metade)
  const pubItem = (it) => it && ({ id: it.id, title: it.title, duration: it.duration || 0, addedBy: it.addedBy, source: it.source, ready: !!it._file });
  const djState = () => ({
    active: dj.active, channelId: dj.channelId, loading: dj.loading,
    current: dj.current && { ...pubItem(dj.current.item), url: `/dj/${dj.current.item.id}`, startedAt: dj.current.startedAt, pausedAt: dj.current.pausedAt || null },
    queue: dj.queue.map(pubItem), skipVotes: [...dj.skipVotes], kickVotes: [...dj.kickVotes], needed: needed(),
  });
  const djBroadcast = () => broadcast({ t: 'dj', dj: djState() });

  function djPrefetch() {
    if (!djTools) return;
    for (const it of dj.queue.slice(0, 2)) djTools.fetchAudio(it).then(() => djBroadcast()).catch(() => {});
  }
  async function djNext() {
    clearTimeout(dj.timer);
    if (dj.current) { const old = dj.current.item; setTimeout(() => djTools && djTools.forget(old), 30000); }
    dj.current = null; dj.skipVotes.clear();
    if (!dj.active) return djBroadcast();
    const item = dj.queue.shift();
    if (!item) { dj.loading = false; djBroadcast(); return; }
    dj.loading = true; djBroadcast();
    try {
      await djTools.fetchAudio(item);
    } catch (e) {
      dj.loading = false;
      systemMsg(dj.textChannel, `Não consegui tocar **${item.title}**: ${e.message}`);
      return djNext();
    }
    if (!dj.active) return;
    dj.loading = false;
    dj.current = { item, startedAt: Date.now() + 1200, pausedAt: null };
    scheduleEnd();
    djPrefetch();
    djBroadcast();
  }
  function scheduleEnd() {
    clearTimeout(dj.timer);
    const c = dj.current; if (!c || c.pausedAt || !c.item.duration) return;
    const left = c.startedAt + c.item.duration * 1000 - Date.now() + 1500;
    dj.timer = setTimeout(() => { if (dj.current === c) djNext(); }, Math.max(1000, left));
  }
  function djLeave(reason) {
    if (!dj.active) return;
    clearTimeout(dj.timer); clearTimeout(dj.idleTimer);
    if (dj.current && djTools) djTools.forget(dj.current.item);
    for (const it of dj.queue) if (djTools) djTools.forget(it);
    Object.assign(dj, { active: false, channelId: null, queue: [], current: null, loading: false, since: null });
    dj.skipVotes.clear(); dj.kickVotes.clear();
    broadcast({ t: 'user-leave', id: DJ_ID });
    djBroadcast();
    if (reason) systemMsg(dj.textChannel, reason);
  }
  function djCheckIdle() {
    clearTimeout(dj.idleTimer);
    if (dj.active && !listeners().length) dj.idleTimer = setTimeout(() => { if (!listeners().length) djLeave('Saí da call porque ficou vazia. 👋'); }, 120000);
  }
  function djVoteCheck() {
    const L = new Set(listeners());
    for (const v of [...dj.skipVotes]) if (!L.has(v)) dj.skipVotes.delete(v);
    for (const v of [...dj.kickVotes]) if (!L.has(v)) dj.kickVotes.delete(v);
    if (dj.current && dj.skipVotes.size && dj.skipVotes.size >= needed()) { systemMsg(dj.textChannel, `⏭️ Votação aprovada: pulei **${dj.current.item.title}**.`); djNext(); return; }
    if (dj.kickVotes.size && dj.kickVotes.size >= needed()) { djLeave('Fui removido da call por votação. Até a próxima! 🎧'); return; }
    djBroadcast();
  }

  async function handleDJ(u, m) {
    const ws = clients.get(u.id) && clients.get(u.id).ws;
    const inDJChan = !!u.voiceChannel && u.voiceChannel === dj.channelId;
    switch (m.t) {
      case 'dj-summon': {
        if (!djTools) return send(ws, { t: 'error', msg: 'O DJ não está disponível nesta sala.' });
        if (!u.voiceChannel) return send(ws, { t: 'error', msg: 'Entre numa call primeiro.' });
        if (dj.active) {
          if (dj.channelId !== u.voiceChannel) { dj.channelId = u.voiceChannel; dj.skipVotes.clear(); dj.kickVotes.clear(); broadcast({ t: 'user-update', user: djUser() }); djBroadcast(); djCheckIdle(); }
          return;
        }
        Object.assign(dj, { active: true, channelId: u.voiceChannel, since: Date.now(), textChannel: m.textChannel || null });
        broadcast({ t: 'user-join', user: djUser() });
        djBroadcast();
        systemMsg(dj.textChannel, `🎧 Cheguei! Cola um link do YouTube ou Spotify (ou o nome da música) no meu painel. Chamado por **${u.name}**.`);
        djTools.ensure().catch((e) => systemMsg(dj.textChannel, 'Não consegui preparar o player: ' + e.message));
        break;
      }
      case 'dj-add': {
        if (!dj.active) return;
        send(ws, { t: 'dj-busy', busy: true });
        try {
          const items = await djTools.resolve(clean(m.input, 500));
          for (const it of items) it.addedBy = u.name;
          dj.queue.push(...items);
          if (dj.queue.length > 500) dj.queue.length = 500;
          systemMsg(dj.textChannel, items.length === 1 ? `➕ **${u.name}** adicionou **${items[0].title}**` : `➕ **${u.name}** adicionou ${items.length} músicas`);
          if (!dj.current && !dj.loading) djNext(); else { djPrefetch(); djBroadcast(); }
        } catch (e) { send(ws, { t: 'error', msg: 'DJ: ' + e.message }); }
        send(ws, { t: 'dj-busy', busy: false });
        break;
      }
      case 'dj-vote-skip': if (inDJChan && dj.current) { if (dj.skipVotes.has(u.id)) dj.skipVotes.delete(u.id); else dj.skipVotes.add(u.id); djVoteCheck(); } break;
      case 'dj-vote-kick': if (inDJChan) { if (dj.kickVotes.has(u.id)) dj.kickVotes.delete(u.id); else dj.kickVotes.add(u.id); djVoteCheck(); } break;
      case 'dj-remove': {
        const i = dj.queue.findIndex((x) => x.id === m.id);
        if (i > -1 && (dj.queue[i].addedBy === u.name || u.isHost)) { djTools.forget(dj.queue[i]); dj.queue.splice(i, 1); djBroadcast(); }
        break;
      }
      case 'dj-pause': {
        const c = dj.current; if (!c || !inDJChan) return;
        if (c.pausedAt) { c.startedAt += Date.now() - c.pausedAt; c.pausedAt = null; scheduleEnd(); }
        else { c.pausedAt = Date.now(); clearTimeout(dj.timer); }
        djBroadcast();
        break;
      }
      case 'dj-ended': { // aviso do cliente quando a duração era desconhecida
        const c = dj.current;
        if (c && c.item.id === m.id && !c.pausedAt && Date.now() - c.startedAt > 5000) djNext();
        break;
      }
    }
  }

  // ---------------- HTTP ----------------
  const cors = (res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-File-Name, Range');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  };
  const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

  function handleUpload(req, res, url) {
    if (url.searchParams.get('t') !== token) return json(res, 403, { error: 'Sem permissão' });
    const len = Number(req.headers['content-length'] || 0);
    if (len > maxUpload) return json(res, 413, { error: 'Arquivo grande demais' });
    const name = safeFileName(decodeURIComponent(url.searchParams.get('name') || 'arquivo'));
    const id = rid(8);
    const dir = path.join(filesDir, id);
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, name);
    const out = fs.createWriteStream(dest);
    let size = 0; let aborted = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxUpload && !aborted) { aborted = true; req.destroy(); out.destroy(); fs.rm(dir, { recursive: true, force: true }, () => {}); json(res, 413, { error: 'Arquivo grande demais' }); }
    });
    req.pipe(out);
    out.on('finish', () => {
      if (aborted) return;
      const type = (req.headers['content-type'] && req.headers['content-type'] !== 'application/octet-stream') ? req.headers['content-type'] : mimeOf(name);
      const meta = { id, name, size, type, url: `/files/${id}/${encodeURIComponent(name)}` };
      files[id] = meta; saveSoon();
      json(res, 200, meta);
    });
    out.on('error', (e) => { if (!aborted) json(res, 500, { error: e.message }); });
    req.on('aborted', () => { aborted = true; out.destroy(); fs.rm(dir, { recursive: true, force: true }, () => {}); });
  }

  function serveFile(req, res, filePath, type, download, name) {
    fs.stat(filePath, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404); return res.end('não encontrado'); }
      const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=86400' };
      if (download) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
      const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
      if (range) {
        let start = range[1] === '' ? st.size - Number(range[2]) : Number(range[1]);
        let end = range[1] !== '' && range[2] !== '' ? Number(range[2]) : st.size - 1;
        if (start < 0) start = 0; if (end >= st.size) end = st.size - 1;
        if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
        res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
        if (req.method === 'HEAD') return res.end();
        return fs.createReadStream(filePath, { start, end }).pipe(res);
      }
      res.writeHead(200, { ...headers, 'Content-Length': st.size });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(filePath).pipe(res);
    });
  }

  const httpServer = http.createServer((req, res) => {
    cors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400); return res.end(); }
    const p = url.pathname;

    if (p === '/api/info') return json(res, 200, { app: 'resenha', name: roomName, needsPassword: !!password, users: clients.size });
    if (p === '/upload' && req.method === 'POST') return handleUpload(req, res, url);
    if (p.startsWith('/files/')) {
      if (url.searchParams.get('t') !== token) { res.writeHead(403); return res.end('sem permissão'); }
      const [, , id] = p.split('/');
      const meta = files[id];
      if (!meta) { res.writeHead(404); return res.end('não encontrado'); }
      return serveFile(req, res, path.join(filesDir, id, meta.name), meta.type || mimeOf(meta.name), url.searchParams.has('dl'), meta.name);
    }
    if (p.startsWith('/dj/')) {
      if (url.searchParams.get('t') !== token) { res.writeHead(403); return res.end(); }
      const id = p.split('/')[2];
      const it = (dj.current && dj.current.item.id === id && dj.current.item) || dj.queue.find((x) => x.id === id);
      if (!it || !it._file) { res.writeHead(404); return res.end(); }
      return serveFile(req, res, it._file, mimeOf(it._file), false, '');
    }
    if (p === '/') { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end(`Sala "${roomName}" do Resenha. Abra o app Resenha e entre por este endereço.`); }
    res.writeHead(404); res.end();
  });

  // ---------------- WebSocket ----------------
  const wss = new WebSocketServer({ server: httpServer, maxPayload: 256 * 1024 });

  wss.on('connection', (ws) => {
    let id = null;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    const helloTimer = setTimeout(() => { if (!id) ws.close(4000, 'sem hello'); }, 15000);

    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (!id) {
        if (m.t !== 'hello') return;
        if (password && m.password !== password) { send(ws, { t: 'error', code: 'password', msg: 'Senha incorreta' }); return ws.close(4001, 'senha'); }
        clearTimeout(helloTimer);
        id = rid(6);
        const user = {
          id, name: clean(m.name, 32) || 'Anônimo', color: /^#[0-9a-f]{6}$/i.test(m.color) ? m.color : '#5865f2',
          avatar: validAvatar(m.avatar), voiceChannel: null, muted: false, deafened: false, sharing: false, screenStreamId: null, voiceSince: null,
          isHost: !!m.hostKey && m.hostKey === opts.hostKey,
        };
        clients.set(id, { ws, user });
        const hist = {};
        for (const cid of textIds()) hist[cid] = (history[cid] || []).slice(-250);
        send(ws, { t: 'welcome', id, token, turn: opts.turn || null, room: { name: roomName }, serverTime: Date.now(), users: publicUsers(), channels, history: hist, dj: djState(), djAvailable: !!djTools });
        broadcast({ t: 'user-join', user }, id);
        log(`${user.name} entrou (${clients.size} na sala)`);
        return;
      }
      const c = clients.get(id); if (!c) return;
      const u = c.user;
      if (typeof m.t === 'string' && m.t.startsWith('dj-')) { handleDJ(u, m); return; }
      switch (m.t) {
        case 'state': {
          if ('voiceChannel' in m) {
            const vc = m.voiceChannel && channels.some((x) => x.id === m.voiceChannel && x.type === 'voice') ? m.voiceChannel : null;
            if (vc !== u.voiceChannel) {
              u.voiceSince = vc ? Date.now() : null;
              if (!vc) { u.sharing = false; u.screenStreamId = null; }
              u.voiceChannel = vc;
              setTimeout(() => { djCheckIdle(); if (dj.active) djVoteCheck(); }, 0);
            }
          }
          if (typeof m.muted === 'boolean') u.muted = m.muted;
          if (typeof m.deafened === 'boolean') u.deafened = m.deafened;
          if (typeof m.sharing === 'boolean') u.sharing = m.sharing && !!u.voiceChannel;
          if ('screenStreamId' in m) u.screenStreamId = u.sharing ? clean(m.screenStreamId, 80) : null;
          broadcast({ t: 'user-update', user: u });
          break;
        }
        case 'profile': {
          if (m.name) u.name = clean(m.name, 32) || u.name;
          if (/^#[0-9a-f]{6}$/i.test(m.color || '')) u.color = m.color;
          if ('avatar' in m) u.avatar = validAvatar(m.avatar);
          broadcast({ t: 'user-update', user: u });
          break;
        }
        case 'chat': {
          const cid = textIds().includes(m.channelId) ? m.channelId : textIds()[0];
          const text = cleanText(m.text, 4000);
          const atts = (Array.isArray(m.attachments) ? m.attachments : []).slice(0, 10).map((a) => files[a && a.id]).filter(Boolean);
          if (!text && !atts.length) return;
          let replyTo = null;
          if (m.replyTo) { const f = findMsg(String(m.replyTo)); if (f) replyTo = { id: f.msg.id, name: f.msg.name, color: f.msg.color, text: (f.msg.text || (f.msg.attachments.length ? '📎 Anexo' : '')).slice(0, 140) }; }
          const mentions = (Array.isArray(m.mentions) ? m.mentions : []).slice(0, 20).map((x) => clean(x, 32)).filter(Boolean);
          const msg = { id: rid(8), channelId: cid, userId: id, name: u.name, color: u.color, text, attachments: atts, ts: Date.now(), replyTo, mentions };
          (history[cid] = history[cid] || []).push(msg);
          saveSoon();
          broadcast({ t: 'chat', msg });
          break;
        }
        case 'edit': {
          const f = findMsg(String(m.id)); if (!f || f.msg.userId !== id) return;
          const text = cleanText(m.text, 4000);
          if (!text && !f.msg.attachments.length) return;
          f.msg.text = text; f.msg.editedAt = Date.now();
          if (Array.isArray(m.mentions)) f.msg.mentions = m.mentions.slice(0, 20).map((x) => clean(x, 32)).filter(Boolean);
          saveSoon();
          broadcast({ t: 'msg-edit', id: f.msg.id, channelId: f.cid, text, editedAt: f.msg.editedAt, mentions: f.msg.mentions });
          break;
        }
        case 'delete': {
          const f = findMsg(String(m.id)); if (!f || (f.msg.userId !== id && !u.isHost)) return;
          f.list.splice(f.i, 1); saveSoon();
          broadcast({ t: 'msg-delete', id: f.msg.id, channelId: f.cid });
          break;
        }
        case 'ch-create': {
          const type = m.type === 'voice' ? 'voice' : 'text';
          const name = chanName(m.name, type);
          if (!name || channels.length >= 60) return;
          channels.push({ id: rid(5), type, name }); saveSoon();
          broadcast({ t: 'channels', channels });
          break;
        }
        case 'ch-rename': {
          const ch = channels.find((x) => x.id === m.id); if (!ch) return;
          const name = chanName(m.name, ch.type); if (!name) return;
          ch.name = name; saveSoon();
          broadcast({ t: 'channels', channels });
          break;
        }
        case 'ch-delete': {
          const ch = channels.find((x) => x.id === m.id); if (!ch) return;
          if (channels.filter((x) => x.type === ch.type).length <= 1) return send(ws, { t: 'error', msg: `Precisa ter pelo menos um canal de ${ch.type === 'text' ? 'texto' : 'voz'}.` });
          channels = channels.filter((x) => x.id !== ch.id);
          if (ch.type === 'text') delete history[ch.id];
          else {
            for (const cl of clients.values()) if (cl.user.voiceChannel === ch.id) { cl.user.voiceChannel = null; cl.user.sharing = false; cl.user.voiceSince = null; broadcast({ t: 'user-update', user: cl.user }); }
            if (dj.channelId === ch.id) djLeave();
          }
          saveSoon();
          broadcast({ t: 'channels', channels });
          break;
        }
        case 'typing': broadcast({ t: 'typing', id, channelId: m.channelId }, id); break;
        case 'signal': {
          const target = clients.get(m.to);
          if (target) send(target.ws, { t: 'signal', from: id, data: m.data });
          break;
        }
        case 'room': if (u.isHost && m.name) { roomName = clean(m.name, 40) || roomName; broadcast({ t: 'room', room: { name: roomName } }); } break;
        case 'ping': send(ws, { t: 'pong', ts: m.ts, serverTime: Date.now() }); break;
      }
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (id && clients.has(id)) {
        const name = clients.get(id).user.name;
        clients.delete(id);
        broadcast({ t: 'user-leave', id });
        log(`${name} saiu (${clients.size} na sala)`);
        djCheckIdle(); if (dj.active) djVoteCheck();
      }
    });
    ws.on('error', () => {});
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false; try { ws.ping(); } catch {}
    }
  }, 20000);

  return {
    port,
    listen() {
      return new Promise((resolve, reject) => {
        // '::' escuta IPv4 e IPv6 ao mesmo tempo
        const done = () => { log(`sala "${roomName}" aberta na porta ${port}`); resolve(port); };
        const onErr = (e) => {
          if (e.code === 'EAFNOSUPPORT' || e.code === 'EADDRNOTAVAIL') { httpServer.once('error', reject); httpServer.listen(port, '0.0.0.0', done); }
          else reject(e);
        };
        httpServer.once('error', onErr);
        httpServer.listen({ port, host: '::', ipv6Only: false }, done);
      });
    },
    close() {
      clearInterval(heartbeat);
      clearTimeout(saveTimer);
      if (dj.active) djLeave();
      saveNow();
      for (const ws of wss.clients) { try { ws.close(4002, 'sala encerrada'); } catch {} }
      return new Promise((r) => { wss.close(); httpServer.close(() => r()); setTimeout(r, 1500); });
    },
  };
}

module.exports = { createServer, DJ_ID };

if (require.main === module) {
  const { DJTools } = require('./dj');
  const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : d; };
  const dataDir = arg('data', path.join(process.cwd(), 'resenha-data'));
  const dj = new DJTools({ binDir: path.join(dataDir, 'bin'), cacheDir: path.join(dataDir, 'dj-cache'), nodePath: process.execPath });
  const s = createServer({ port: arg('port', 7777), password: arg('password', ''), roomName: arg('name', 'Sala'), dataDir, dj });
  s.listen().catch((e) => { console.error(e.message); process.exit(1); });
}
