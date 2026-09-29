// Túnel estilo Radmin: acha a sala pelo CÓDIGO (via brokers MQTT públicos, mensagens criptografadas com o código)
// e depois leva o TCP da sala por dentro de uma conexão WebRTC P2P (que fura NAT sozinha).
// O renderer cuida do RTCPeerConnection; aqui ficam a sinalização e as pontes TCP.
const net = require('net');
const crypto = require('crypto');
const mqtt = require('mqtt');

const BROKERS = [
  'wss://broker.hivemq.com:8884/mqtt',
  'mqtts://broker.emqx.io:8883',
  'wss://test.mosquitto.org:8081',
];

const norm = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const keyOf = (code) => crypto.createHash('sha256').update('resenha-key:' + norm(code)).digest();
const topicOf = (code) => 'resenha/v1/' + crypto.createHash('sha256').update('resenha-topic:' + norm(code)).digest('hex').slice(0, 32);

function seal(key, obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}
function open(key, buf) {
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'));
  } catch { return null; }
}

// Conexões com os brokers ficam abertas e são reaproveitadas (trocar de papel convidado/anfitrião fica instantâneo)
const pool = new Map(); // url -> { c, subs: Map(topic -> Set(handler)) }
function brokerConn(url, log) {
  let b = pool.get(url);
  if (b) return b;
  const c = mqtt.connect(url, { connectTimeout: 8000, reconnectPeriod: 3000, keepalive: 30, clean: true, clientId: 'rs_' + crypto.randomBytes(6).toString('hex') });
  b = { c, subs: new Map() };
  c.on('connect', () => { log('broker ok', url); for (const t of b.subs.keys()) c.subscribe(t, { qos: 0 }); });
  c.on('error', (e) => log('broker erro', url, e.message));
  c.on('message', (t, payload) => { const hs = b.subs.get(t); if (hs) for (const h of hs) h(payload); });
  pool.set(url, b);
  return b;
}
class Signal {
  constructor(code, onMsg, log) {
    this.key = keyOf(code); this.topic = topicOf(code); this.onMsg = onMsg; this.log = log || (() => {});
    this.seen = new Set();
    this.handler = (payload) => {
      const m = open(this.key, payload);
      if (!m || !m.mid || this.seen.has(m.mid)) return;
      this.seen.add(m.mid); if (this.seen.size > 5000) this.seen = new Set([...this.seen].slice(-1000));
      this.onMsg(m);
    };
    this.brokers = BROKERS.map((url) => {
      const b = brokerConn(url, this.log);
      let hs = b.subs.get(this.topic);
      if (!hs) { hs = new Set(); b.subs.set(this.topic, hs); if (b.c.connected) b.c.subscribe(this.topic, { qos: 0 }); }
      hs.add(this.handler);
      return b;
    });
  }
  connected() { return this.brokers.some((b) => b.c.connected); }
  send(obj) {
    const buf = seal(this.key, { ...obj, mid: crypto.randomBytes(8).toString('hex') });
    for (const b of this.brokers) if (b.c.connected) b.c.publish(this.topic, buf, { qos: 0 });
  }
  close() {
    for (const b of this.brokers) {
      const hs = b.subs.get(this.topic); if (!hs) continue;
      hs.delete(this.handler);
      if (!hs.size) { b.subs.delete(this.topic); try { b.c.unsubscribe(this.topic); } catch {} }
    }
  }
}

class Tunnel {
  constructor(win, log) {
    this.win = win; this.log = log || ((...a) => console.log('[tunel]', ...a));
    this.role = null; this.signal = null; this.sockets = new Map(); this.server = null;
    this.localPort = null; this.ready = false; this.seq = 0; this.pendingAnswer = null;
  }
  emit(ev) { if (this.win && !this.win.isDestroyed()) this.win.webContents.send('tun:event', ev); }

  // ---------- Anfitrião ----------
  // Se aparecerem 2 anfitriões com o mesmo código, fica o que tem mais gente;
  // empate: troca mais recente (epoch maior); depois quem entrou antes na sala.
  hostStart(code, port, rank, getClients) {
    this.stop();
    this.role = 'host'; this.port = port;
    const r = Array.isArray(rank) ? rank : [0, Date.now(), crypto.randomBytes(6).toString('hex')];
    this.rankNow = () => ({ clients: getClients ? getClients() : 1, epoch: r[0], joinedAt: r[1], id: String(r[2]) });
    this.hostId = crypto.randomBytes(6).toString('hex');
    const nonces = new Map();
    const better = (a, b) => (a.clients !== b.clients ? a.clients > b.clients : a.epoch !== b.epoch ? a.epoch > b.epoch : a.joinedAt !== b.joinedAt ? a.joinedAt < b.joinedAt : a.id < b.id);
    this.signal = new Signal(code, (m) => {
      if (m.t === 'host' && m.hostId && m.hostId !== this.hostId && m.rank && typeof m.rank === 'object') {
        if (this.role === 'host' && better(m.rank, this.rankNow())) { this.log('outro anfitrião com prioridade maior, saindo'); this.emit({ type: 'yield' }); }
        return;
      }
      if (m.t !== 'join' || !m.from || !m.sdp) return;
      if (nonces.get(m.from) === m.nonce) return; // repetição do mesmo pedido
      nonces.set(m.from, m.nonce);
      this.emit({ type: 'join', peerId: m.from, nonce: m.nonce, sdp: m.sdp });
    }, this.log);
    const announce = () => { if (this.role === 'host' && this.signal) this.signal.send({ t: 'host', hostId: this.hostId, rank: this.rankNow() }); };
    this.announceTimer = setInterval(announce, 4000);
    setTimeout(announce, 1500);
  }
  hostAnswer(peerId, nonce, sdp) {
    if (!this.signal) return;
    // repete algumas vezes: o broker é "melhor esforço"
    let n = 0; const tick = () => { if (!this.signal || n++ > 4) return; this.signal.send({ t: 'answer', to: peerId, nonce, sdp }); setTimeout(tick, 1500); };
    tick();
  }
  hostOpen(key) {
    const s = net.connect(this.port, '127.0.0.1');
    this.wire(key, s);
  }

  // ---------- Convidado ----------
  async guestStart(code) {
    this.stop();
    this.role = 'guest';
    this.peerId = crypto.randomBytes(6).toString('hex');
    this.signal = new Signal(code, (m) => {
      if (m.t === 'answer' && m.to === this.peerId && this.pendingAnswer && m.nonce === this.pendingAnswer.nonce) {
        const p = this.pendingAnswer; this.pendingAnswer = null; p.resolve(m.sdp);
      }
    }, this.log);
    this.server = net.createServer((sock) => {
      if (!this.ready) return sock.destroy();
      const key = 'c' + (++this.seq);
      sock.pause();
      this.wire(key, sock);
      this.emit({ type: 'conn', key });
    });
    await new Promise((r, j) => { this.server.once('error', j); this.server.listen(0, '127.0.0.1', r); });
    this.localPort = this.server.address().port;
    return this.localPort;
  }
  // publica o pedido de entrada até o anfitrião responder
  guestOffer(sdp, timeoutMs = 20000) {
    const nonce = crypto.randomBytes(6).toString('hex');
    return new Promise((resolve) => {
      const t0 = Date.now();
      let timer;
      this.pendingAnswer = { nonce, resolve: (s) => { clearTimeout(timer); resolve({ ok: true, sdp: s }); } };
      const tick = () => {
        if (!this.pendingAnswer || this.pendingAnswer.nonce !== nonce) return;
        if (Date.now() - t0 > timeoutMs) { this.pendingAnswer = null; return resolve({ ok: false, error: this.signal && this.signal.connected() ? 'notfound' : 'nobroker' }); }
        if (this.signal) this.signal.send({ t: 'join', from: this.peerId, nonce, sdp });
        timer = setTimeout(tick, 1200);
      };
      // espera algum broker conectar antes de publicar
      const wait = () => { if (this.signal && this.signal.connected()) tick(); else if (Date.now() - t0 > timeoutMs) resolve({ ok: false, error: 'nobroker' }); else setTimeout(wait, 200); };
      wait();
    });
  }
  setReady(v) {
    this.ready = v;
    if (!v) for (const [k, s] of this.sockets) { s.destroy(); this.sockets.delete(k); }
  }

  // ---------- Pontes TCP <-> canal ----------
  wire(key, s) {
    this.sockets.set(key, s);
    s.setNoDelay(true);
    s.on('data', (d) => this.emit({ type: 'data', key, data: d }));
    const end = () => { if (this.sockets.get(key) === s) { this.sockets.delete(key); this.emit({ type: 'close', key }); } };
    s.on('close', end); s.on('error', end);
  }
  data(key, buf) { const s = this.sockets.get(key); if (s) s.write(Buffer.from(buf)); }
  close(key) { const s = this.sockets.get(key); if (s) { this.sockets.delete(key); s.end(); setTimeout(() => s.destroy(), 2000); } }
  closePeer(prefix) { for (const k of [...this.sockets.keys()]) if (k.startsWith(prefix)) this.close(k); }
  pause(key) { const s = this.sockets.get(key); if (s) s.pause(); }
  resume(key) { const s = this.sockets.get(key); if (s) s.resume(); }

  stop() {
    clearInterval(this.announceTimer);
    if (this.pendingAnswer) { this.pendingAnswer.resolve && this.pendingAnswer.resolve(null); this.pendingAnswer = null; }
    if (this.signal) { this.signal.close(); this.signal = null; }
    for (const s of this.sockets.values()) s.destroy();
    this.sockets.clear();
    if (this.server) { try { this.server.close(); } catch {} this.server = null; }
    this.role = null; this.ready = false;
  }
}

module.exports = { Tunnel, norm };
