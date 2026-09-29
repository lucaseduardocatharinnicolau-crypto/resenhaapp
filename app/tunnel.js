'use strict';
// Túnel P2P (WebRTC DataChannel) que leva o TCP da sala entre convidado e anfitrião, igual ao Radmin.
// STUN público serve para "furar" o NAT dos dois lados; nada de porta aberta no roteador.
const TUN_ICE = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
];
const CHUNK = 16 * 1024;
const HIGH = 4 * 1024 * 1024;

const Tun = (() => {
  const T = window.resenhaNative && window.resenhaNative.tun;
  if (!T) return null;
  const hostPeers = new Map(); // peerId -> { pc, chans: Map(key->dc) }
  let guest = null; // { pc, chans, ctl }
  const log = (...a) => console.log('[tunel]', ...a);

  function gatherDone(pc, ms = 4000) {
    return new Promise((r) => {
      if (pc.iceGatheringState === 'complete') return r();
      const t = setTimeout(r, ms);
      pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); r(); } });
    });
  }
  function sendChunked(dc, key, buf) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    for (let i = 0; i < u8.length; i += CHUNK) dc.send(u8.subarray(i, i + CHUNK));
    if (dc.bufferedAmount > HIGH && !dc._paused) { dc._paused = true; T.pause(key); }
  }
  function bindChannel(dc, key, chans) {
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = 512 * 1024;
    dc.onbufferedamountlow = () => { if (dc._paused) { dc._paused = false; T.resume(key); } };
    dc.onmessage = (e) => T.data(key, new Uint8Array(e.data));
    dc.onclose = () => { chans.delete(key); T.close(key); };
    chans.set(key, dc);
  }

  // ---------- Eventos do processo principal ----------
  const listeners = [];
  T.onEvent(async (ev) => {
    if (ev.type === 'join') return hostAccept(ev);
    if (ev.type === 'yield') { for (const f of listeners) f(ev); return; }
    if (ev.type === 'conn') { // convidado: nova conexão TCP local -> abre canal
      if (!guest) return T.close(ev.key);
      const dc = guest.pc.createDataChannel(ev.key, { ordered: true });
      dc.queue = [];
      bindChannel(dc, ev.key, guest.chans);
      dc.onopen = () => { for (const b of dc.queue) sendChunked(dc, ev.key, b); dc.queue = null; T.resume(ev.key); };
      return;
    }
    if (ev.type === 'data') {
      const dc = findChan(ev.key);
      if (!dc) return;
      if (dc.readyState !== 'open') { dc.queue && dc.queue.push(ev.data); return; }
      sendChunked(dc, ev.key, ev.data);
      return;
    }
    if (ev.type === 'close') { const dc = findChan(ev.key); if (dc) try { dc.close(); } catch {} }
  });
  function findChan(key) {
    if (guest && guest.chans.has(key)) return guest.chans.get(key);
    const i = key.indexOf(':');
    if (i > 0) { const p = hostPeers.get(key.slice(0, i)); return p && p.chans.get(key); }
    return null;
  }

  // ---------- Anfitrião ----------
  async function hostAccept({ peerId, nonce, sdp }) {
    const old = hostPeers.get(peerId);
    if (old) { try { old.pc.close(); } catch {} T.closePeer(peerId + ':'); }
    const pc = new RTCPeerConnection({ iceServers: TUN_ICE });
    const p = { pc, chans: new Map() };
    pc.addEventListener('connectionstatechange', () => { if (pc.connectionState === 'connected') log('convidado conectado'); });
    hostPeers.set(peerId, p);
    pc.ondatachannel = ({ channel }) => {
      if (channel.label === 'ctl') { channel.onmessage = (e) => { if (e.data === 'ping') try { channel.send('pong'); } catch {} }; return; }
      const key = peerId + ':' + channel.label;
      bindChannel(channel, key, p.chans);
      T.open(key);
    };
    pc.onconnectionstatechange = () => {
      log('anfitrião <-> ' + peerId, pc.connectionState);
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        if (hostPeers.get(peerId) === p) hostPeers.delete(peerId);
        T.closePeer(peerId + ':');
      }
    };
    try {
      await pc.setRemoteDescription(sdp);
      await pc.setLocalDescription(await pc.createAnswer());
      await gatherDone(pc);
      T.hostAnswer({ peerId, nonce, sdp: { type: 'answer', sdp: pc.localDescription.sdp } });
    } catch (e) { log('erro aceitando', e); }
  }

  // ---------- Convidado ----------
  // Resolve com o endereço local (127.0.0.1:porta) que já leva até a sala do anfitrião
  async function guestConnect(code, onStatus = () => {}, { attempts = 3, timeoutMs = 20000 } = {}) {
    guestClose(true);
    const port = await T.guestStart(code);
    for (let attempt = 1; attempt <= attempts; attempt++) {
      onStatus(attempt === 1 ? 'Procurando a sala...' : `Tentando de novo (${attempt}/${attempts})...`);
      const pc = new RTCPeerConnection({ iceServers: TUN_ICE });
      const g = { pc, chans: new Map(), ctl: pc.createDataChannel('ctl') };
      guest = g;
      await pc.setLocalDescription(await pc.createOffer());
      await gatherDone(pc);
      const r = await T.guestOffer({ type: 'offer', sdp: pc.localDescription.sdp }, timeoutMs);
      if (guest !== g) { pc.close(); throw new Error('cancelado'); }
      if (!r || !r.ok || !r.sdp) {
        pc.close(); guest = null;
        if (r && r.error === 'nobroker') throw new Error('nobroker');
        if (attempt === attempts) throw new Error('notfound');
        continue;
      }
      onStatus('Sala encontrada, conectando...');
      await pc.setRemoteDescription(r.sdp);
      const ok = await new Promise((res) => {
        const t = setTimeout(() => res(false), 15000);
        const chk = () => {
          if (g.ctl.readyState === 'open') { clearTimeout(t); res(true); }
          else if (pc.connectionState === 'failed') { clearTimeout(t); res(false); }
        };
        g.ctl.onopen = chk; pc.onconnectionstatechange = chk; chk();
      });
      if (!ok) { pc.close(); guest = null; if (attempt === attempts) throw new Error('p2p'); continue; }
      pc.onconnectionstatechange = () => {
        log('convidado', pc.connectionState);
        if (['failed', 'closed', 'disconnected'].includes(pc.connectionState) && guest === g) {
          if (pc.connectionState === 'disconnected') { setTimeout(() => { if (pc.connectionState === 'disconnected' && guest === g) guestClose(); }, 2500); return; }
          guestClose();
        }
      };
      const stats = await pc.getStats(); let kind = '';
      stats.forEach((s) => { if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') { const l = stats.get(s.localCandidateId); kind = l && l.candidateType; } });
      log('túnel pronto via', kind);
      T.ready(true);
      return { addr: '127.0.0.1:' + port, kind };
    }
  }
  function guestClose(keepServer) {
    if (guest) { try { guest.pc.close(); } catch {} guest = null; }
    T.ready(false);
    if (!keepServer) T.stop();
  }
  const guestAlive = () => !!guest && guest.ctl.readyState === 'open';

  return { guestConnect, guestClose, guestAlive, onYield: (f) => listeners.push(f) };
})();
