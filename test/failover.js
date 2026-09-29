// Teste v1.2: 3 instâncias. A abre a sala, B e C entram pelo código, conversam, A é derrubado (processo morto).
// Esperado: B (entrou primeiro) vira anfitrião com o mesmo código e o histórico; C reconecta sozinho; voz B<->C segue.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const ROOT = path.join(__dirname, '..');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOTS = path.join(__dirname, 'shots'); fs.mkdirSync(SHOTS, { recursive: true });

function launch(profile, port) {
  const p = spawn(ELECTRON, [ROOT, `--profile=${profile}`, `--remote-debugging-port=${port}`, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'], { stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => process.env.V && process.stdout.write(`[${profile}] ${d}`));
  p.stderr.on('data', () => {});
  return p;
}
async function cdp(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const pg = list.find((x) => x.type === 'page' && x.url.includes('index.html'));
      if (pg) {
        const ws = new WebSocket(pg.webSocketDebuggerUrl); await new Promise((r) => ws.on('open', r));
        let id = 0; const pend = new Map(); const logs = [];
        ws.on('message', (d) => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 300)); if (m.method === 'Runtime.consoleAPICalled' && (['error'].includes(m.params.type) || process.env.ALL)) logs.push(m.params.type + ' ' + JSON.stringify(m.params.args.map((a) => a.value || a.description)).slice(0, 300)); });
        ws.on('error', () => {});
        const send = (method, params = {}) => new Promise((r) => { const i2 = ++id; pend.set(i2, r); ws.send(JSON.stringify({ id: i2, method, params })); });
        const ev = async (expr) => {
          const r = await send('Runtime.evaluate', { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true });
          if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || JSON.stringify(r.result.exceptionDetails));
          return r.result.result.value;
        };
        const shot = async (name) => { const s = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(s.result.data, 'base64')); };
        await send('Runtime.enable');
        return { ev, send, ws, shot, logs };
      }
    } catch {}
    await sleep(500);
  }
  throw new Error('cdp timeout ' + port);
}
const waitFor = async (X, cond, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await X.ev(`return !!(${cond})`)) return true; } catch {} await sleep(400); } return false; };
const voiceStats = `const r={}; for (const [id,p] of __resenha.V.peers){ const st=await p.pc.getStats(); let inb=0; st.forEach(s=>{ if(s.type==='inbound-rtp'&&s.kind==='audio') inb+=s.bytesReceived }); r[__resenha.S.users.get(id)?.name||id]={ice:p.pc.iceConnectionState,inb}; } return r`;

(async () => {
  for (const p of ['testeA', 'testeB', 'testeC']) fs.rmSync(path.join(process.env.APPDATA, 'Resenha-' + p), { recursive: true, force: true });
  const pa = launch('testeA', 9311), pb = launch('testeB', 9312), pc = launch('testeC', 9313);
  const out = {};
  try {
    let A = await cdp(9311), B = await cdp(9312), C = await cdp(9313);
    await sleep(1200);
    const prof = (X, n, c) => X.ev(`localStorage.setItem('resenha.profile', JSON.stringify({name:'${n}',color:'${c}'})); localStorage.setItem('resenha.lastHost', JSON.stringify({name:'sala teste',port:7801})); location.reload();`).catch(() => {});
    await prof(A, 'Lucas', '#eb459e'); await prof(B, 'Beto', '#57f287'); await prof(C, 'Carla', '#faa61a');
    await sleep(2500);
    A = await cdp(9311); B = await cdp(9312); C = await cdp(9313);
    await A.ev(`document.querySelector('#btn-host').click()`);
    await waitFor(A, `window.__resenha.S.myId`);
    await A.ev(`document.querySelectorAll('[data-close]').forEach(b=>b.click())`);
    const code = await A.ev(`return __resenha.S.code`); out.code = code;
    await B.ev(`document.querySelector('#join-addr').value='${code}'; document.querySelector('#btn-join').click()`);
    out.bJoined = await waitFor(B, `window.__resenha.S.myId`, 40000);
    await sleep(500);
    await C.ev(`document.querySelector('#join-addr').value='${code}'; document.querySelector('#btn-join').click()`);
    out.cJoined = await waitFor(C, `window.__resenha.S.myId`, 40000);
    // conversa + anexo + canal novo
    await A.ev(`__resenha.wsSend({t:'ch-create',type:'text',name:'memes'})`);
    await B.ev(`document.querySelector('#input').value='mensagem antes da queda'; await __resenha.sendMessage()`);
    await C.ev(`const c=document.createElement('canvas');c.width=160;c.height=90;c.getContext('2d').fillRect(0,0,160,90);const blob=await new Promise(r=>c.toBlob(r,'image/png'));const dt=new DataTransfer();dt.items.add(new File([blob],'print.png',{type:'image/png'}));const inp=document.querySelector('#file-input');inp.files=dt.files;inp.dispatchEvent(new Event('change'));await __resenha.sendMessage()`);
    for (const X of [A, B, C]) await X.ev(`await __resenha.joinVoice('lobby')`);
    await sleep(5000);
    out.order = await C.ev(`return __resenha.successionOrder().map(u=>u.name)`);
    out.voiceBefore = await B.ev(voiceStats);
    await sleep(2500); // tempo pro cache de anexos
    // DERRUBA O ANFITRIÃO (como se a luz dele caísse)
    const t0 = Date.now();
    pa.kill('SIGKILL');
    out.bHost = await waitFor(B, `__resenha.S.isHost && __resenha.S.myId`, 60000);
    out.bHostSecs = (Date.now() - t0) / 1000;
    out.bHostSecs = (Date.now() - t0) / 1000;
    out.cBack = await waitFor(C, `__resenha.S.myId && [...__resenha.S.users.values()].find(u=>u.isHost)?.name==="Beto"`, 60000);
    out.cBackSecs = (Date.now() - t0) / 1000;
    await sleep(3000);
    out.after = await C.ev(`return {code:__resenha.S.code, host:[...__resenha.S.users.values()].find(u=>u.isHost)?.name, users:[...__resenha.S.users.values()].map(u=>u.name), channels:__resenha.S.channels.map(c=>c.name), msgs:Object.values(__resenha.S.history).flat().map(m=>m.text||('[anexo '+m.attachments.length+']')), voice:__resenha.V.joined}`);
    out.imgDbg = await C.ev(`const img=document.querySelector('#msg-list .att-img'); const r = img ? await fetch(img.src).then(r=>r.status+' '+r.headers.get('content-type')).catch(e=>'ERR '+e.message) : null; return {src: img && img.src, base: __resenha.S.base, r}`);
    out.imgOk = await C.ev(`const img=document.querySelector('#msg-list .att-img'); if(!img) return 'sem img'; await new Promise(r=>{ if(img.complete) r(); else { img.onload=r; img.onerror=r; } setTimeout(r,4000) }); return img.naturalWidth+'x'+img.naturalHeight`);
    const b1 = await B.ev(voiceStats); await sleep(3000); const b2 = await B.ev(voiceStats);
    out.voiceAfterB = { antes: b1, depois: b2 };
    await C.ev(`document.querySelector('#input').value='mensagem depois da troca'; await __resenha.sendMessage()`);
    await sleep(600);
    out.chatAfterB = await B.ev(`return Object.values(__resenha.S.history).flat().map(m=>m.text).filter(Boolean).slice(-2)`);
    await C.shot('10-apos-troca');
    out.logsB = B.logs.slice(0, 6); out.logsC = C.logs.slice(0, 6);
  } catch (e) { out.error = e.stack; }
  console.log(JSON.stringify(out, null, 1));
  for (const p of [pa, pb, pc]) { try { p.kill(); } catch {} }
  process.exit(0);
})();
