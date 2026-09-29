// Testa servidor: canais, editar/excluir/responder, DJ com YouTube e Spotify.
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const { createServer } = require('../server');
const { DJTools } = require('../server/dj');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const data = path.join(__dirname, 'rs-data2');
  fs.rmSync(data, { recursive: true, force: true });
  const binDir = path.join(__dirname, '..', '..', 'resenha-bin-test');
  const djt = new DJTools({ binDir, cacheDir: path.join(data, 'dj'), nodePath: process.execPath, log: (...a) => console.log('[dj]', ...a) });
  const s = createServer({ port: 7792, roomName: 'T', dataDir: data, log: () => {}, dj: djt });
  await s.listen();
  const mk = (n) => new Promise((r) => { const w = new WebSocket('ws://127.0.0.1:7792'); w.msgs = []; w.on('message', (d) => { const m = JSON.parse(d); w.msgs.push(m); if (m.t === 'welcome') { w.id = m.id; w.token = m.token; w.welcome = m; r(w); } }); w.on('open', () => w.send(JSON.stringify({ t: 'hello', name: n }))); });
  const a = await mk('Ana'), b = await mk('Beto');
  const J = (w, o) => w.send(JSON.stringify(o));
  const last = (w, t) => [...w.msgs].reverse().find((m) => m.t === t);
  console.log('canais', a.welcome.channels.map((c) => c.type + ':' + c.name));
  J(a, { t: 'ch-create', type: 'text', name: 'Memes Bons' }); J(a, { t: 'ch-create', type: 'voice', name: 'Jogando CS' });
  await sleep(200);
  let ch = last(b, 'channels').channels; console.log('após criar', ch.map((c) => c.type + ':' + c.name));
  const memes = ch.find((c) => c.name === 'memes-bons');
  J(a, { t: 'ch-rename', id: memes.id, name: 'memes' }); await sleep(100);
  console.log('renomeado', last(b, 'channels').channels.map((c) => c.name));
  J(a, { t: 'chat', channelId: memes.id, text: 'oi @Beto', mentions: ['Beto'] }); await sleep(150);
  const m1 = last(b, 'chat').msg;
  J(b, { t: 'chat', channelId: memes.id, text: 'fala', replyTo: m1.id }); await sleep(150);
  console.log('resposta', JSON.stringify(last(a, 'chat').msg.replyTo), 'mentions', m1.mentions);
  J(b, { t: 'edit', id: m1.id, text: 'hack' }); J(a, { t: 'edit', id: m1.id, text: 'oi editado' }); await sleep(150);
  console.log('edit', JSON.stringify(b.msgs.filter((m) => m.t === 'msg-edit').map((m) => m.text)));
  J(b, { t: 'delete', id: m1.id }); await sleep(100); console.log('delete por outro (não pode):', b.msgs.filter((m) => m.t === 'msg-delete').length);
  J(a, { t: 'delete', id: m1.id }); await sleep(100); console.log('delete pelo autor:', b.msgs.filter((m) => m.t === 'msg-delete').length);
  // DJ
  const lobby = ch.find((c) => c.type === 'voice');
  J(a, { t: 'state', voiceChannel: lobby.id }); J(b, { t: 'state', voiceChannel: lobby.id }); await sleep(100);
  J(a, { t: 'dj-summon', textChannel: 'geral' }); await sleep(200);
  console.log('dj entrou', !!b.msgs.find((m) => m.t === 'user-join' && m.user.id === 'dj-resenha'));
  const t0 = Date.now();
  J(a, { t: 'dj-add', input: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
  J(b, { t: 'dj-add', input: 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT' });
  for (let i = 0; i < 120; i++) { const d = last(a, 'dj'); if (d && d.dj.current) break; await sleep(500); }
  const d = last(a, 'dj').dj;
  console.log('tocando em', ((Date.now() - t0) / 1000).toFixed(1) + 's:', d.current && d.current.title, d.current && d.current.duration + 's', 'fila:', d.queue.map((q) => q.title + ' (' + q.addedBy + ')'));
  const r = await fetch(`http://127.0.0.1:7792${d.current.url}?t=${a.token}`, { headers: { Range: 'bytes=0-99' } });
  console.log('stream', r.status, r.headers.get('content-type'), r.headers.get('content-range'));
  J(a, { t: 'dj-vote-skip' }); await sleep(200);
  console.log('1 voto de 2 (precisa', last(a, 'dj').dj.needed + '):', last(a, 'dj').dj.current && last(a, 'dj').dj.current.title);
  J(b, { t: 'dj-vote-skip' });
  for (let i = 0; i < 120; i++) { const x = last(a, 'dj').dj; if (x.current && x.current.title !== d.current.title) break; await sleep(500); }
  console.log('depois do skip:', last(a, 'dj').dj.current && last(a, 'dj').dj.current.title);
  J(a, { t: 'dj-vote-kick' }); J(b, { t: 'dj-vote-kick' }); await sleep(300);
  console.log('dj saiu', !last(a, 'dj').dj.active, !!a.msgs.find((m) => m.t === 'user-leave' && m.id === 'dj-resenha'));
  console.log('msgs do bot:', a.msgs.filter((m) => m.t === 'chat' && m.msg.bot).map((m) => m.msg.text));
  a.close(); b.close(); await s.close();
  fs.rmSync(data, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
