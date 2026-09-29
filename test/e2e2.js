// Teste ponta a ponta v1.1: 2 instâncias (anfitrião + convidado por código).
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const ROOT = path.join(__dirname, '..');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOTS = path.join(__dirname, 'shots'); fs.mkdirSync(SHOTS, { recursive: true });

// yt-dlp já baixado pro perfil de teste (pula o download de 17MB)
const binSrc = path.join(ROOT, '..', 'resenha-bin-test', 'yt-dlp.exe');
for (const p of ['testeA']) { const d = path.join(process.env.APPDATA, 'Resenha-' + p, 'bin'); fs.mkdirSync(d, { recursive: true }); if (fs.existsSync(binSrc) && !fs.existsSync(path.join(d, 'yt-dlp.exe'))) fs.copyFileSync(binSrc, path.join(d, 'yt-dlp.exe')); }

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
        ws.on('message', (d) => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 300)); if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) logs.push(m.params.type + ' ' + JSON.stringify(m.params.args.map((a) => a.value || a.description)).slice(0, 300)); });
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
const waitFor = async (X, cond, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await X.ev(`return !!(${cond})`)) return true; await sleep(300); } return false; };

(async () => {
  const pa = launch('testeA', 9311), pb = launch('testeB', 9312);
  const out = {};
  try {
    let A = await cdp(9311), B = await cdp(9312);
    await sleep(1200);
    await A.ev(`localStorage.clear(); localStorage.setItem('resenha.profile', JSON.stringify({name:'Lucas',color:'#eb459e'})); localStorage.setItem('resenha.lastHost', JSON.stringify({name:'gameplay de Deus',port:7801})); location.reload();`).catch(() => {});
    await B.ev(`localStorage.clear(); localStorage.setItem('resenha.profile', JSON.stringify({name:'Palhaço Oculto',color:'#57f287'})); location.reload();`).catch(() => {});
    await sleep(2500);
    A = await cdp(9311); B = await cdp(9312);
    out.home = await A.ev(`return {ok: !!document.querySelector('#btn-host'), mod: typeof window.__resenha}`);
    await A.ev(`document.querySelector('#btn-host').click()`);
    await waitFor(A, `!document.querySelector('#main').classList.contains('hidden') && window.__resenha.S.myId`);
    await sleep(800);
    await A.ev(`document.querySelectorAll('[data-close]').forEach(b=>b.click())`);
    const code = await A.ev(`return __resenha.S.code`);
    await B.ev(`document.querySelector('#join-addr').value='${code}'; document.querySelector('#btn-join').click()`);
    out.joined = await waitFor(B, `window.__resenha.S.myId`, 40000);

    // Canais
    await A.ev(`__resenha.wsSend({t:'ch-create',type:'text',name:'Memes'}); __resenha.wsSend({t:'ch-create',type:'voice',name:'Jogando CS'});`);
    await sleep(600);
    out.channelsB = await B.ev(`return [...document.querySelectorAll('#text-channels .cn, #voice-channels .cn')].map(e=>e.textContent)`);

    // Voz no Lobby, ruído, filtro
    await A.ev(`await __resenha.joinVoice('lobby')`);
    await B.ev(`await __resenha.joinVoice('lobby')`);
    await sleep(5000);
    out.voice = await A.ev(`const r={}; for (const [id,p] of __resenha.V.peers){ const st=await p.pc.getStats(); let inb=0; st.forEach(s=>{ if(s.type==='inbound-rtp'&&s.kind==='audio') inb+=s.bytesReceived }); r[id]={ice:p.pc.iceConnectionState,inb}; } return {peers:r, rn:__resenha.V.rnReady, fx:!!__resenha.V.fx}`);
    await B.ev(`__resenha.settings.voiceFx='esquilo'; __resenha.applyVoiceFx()`);
    out.fxParam = await B.ev(`return __resenha.V.fx.parameters.get('pitch').value.toFixed(3)`);

    // Chat: mensagem com menção, resposta, edição, exclusão
    await B.ev(`document.querySelector('#input').value='oi @Lucas, bora?'; await __resenha.sendMessage()`);
    await sleep(500);
    out.mentionA = await A.ev(`const m=document.querySelector('#msg-list .msg:last-child'); return {cls:m.className, mention: m.querySelector('.mention')?.className}`);
    await A.ev(`const id=[...document.querySelectorAll('#msg-list .msg')].pop().dataset.id; __resenha.msgAction('reply', id); document.querySelector('#input').value='bora!'; await __resenha.sendMessage()`);
    await sleep(500);
    out.replyB = await B.ev(`return document.querySelector('#msg-list .msg:last-child .reply-ref')?.innerText`);
    await A.ev(`const last=[...__resenha.S.history[__resenha.S.textChannel]].pop(); __resenha.startEdit(last); const ta=document.querySelector('.edit-box textarea'); ta.value='bora, já tô entrando!'; ta.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
    await sleep(500);
    out.editB = await B.ev(`return document.querySelector('#msg-list .msg:last-child .text')?.innerText`);
    // Menu de ações (hover) visível
    await A.ev(`const m=[...document.querySelectorAll('#msg-list .msg')].pop(); m.scrollIntoView(); const r=m.getBoundingClientRect(); window.__hoverY=r.top+10;`);
    await A.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1200, y: await A.ev('return window.__hoverY') });
    await sleep(300); await A.shot('01-chat-hover');
    // Popup de @
    await B.ev(`const i=document.querySelector('#input'); i.focus(); i.value='@Lu'; i.setSelectionRange(3,3); i.dispatchEvent(new Event('input'))`);
    await sleep(200);
    out.mentionPop = await B.ev(`return document.querySelector('#mention-pop').innerText.replace(/\\s+/g,' ')`);
    await B.shot('02-mention-pop');
    await B.ev(`document.querySelector('#input').value=''; document.querySelector('#input').dispatchEvent(new Event('input'))`);
    // Excluir (B apaga a própria)
    await B.ev(`document.querySelector('#input').value='msg pra apagar'; await __resenha.sendMessage()`);
    await sleep(400);
    const nBefore = await A.ev(`return __resenha.S.history[__resenha.S.textChannel].length`);
    await B.ev(`const last=[...__resenha.S.history[__resenha.S.textChannel]].pop(); __resenha.wsSend({t:'delete',id:last.id})`);
    await sleep(400);
    out.deleted = nBefore - await A.ev(`return __resenha.S.history[__resenha.S.textChannel].length`);
    // Canal Memes
    await A.ev(`const c=__resenha.S.channels.find(c=>c.name==='memes'); __resenha.selectTextChannel(c.id); document.querySelector('#input').value='meme aqui'; await __resenha.sendMessage()`);
    await sleep(400);
    out.unreadB = await B.ev(`return [...document.querySelectorAll('#text-channels .channel.unread .cn')].map(e=>e.textContent)`);

    // Tela: pip pequeno no canto; clique amplia
    await A.ev(`const c=document.createElement('canvas');c.width=640;c.height=360;const g=c.getContext('2d');let f=0;setInterval(()=>{g.fillStyle='hsl('+(f++%360)+',70%,50%)';g.fillRect(0,0,640,360)},33); __resenha.startShareWithStream(c.captureStream(30),'720p30')`);
    await sleep(4000);
    out.pipB = await B.ev(`const p=document.querySelector('#pips .tile'); const v=p&&p.querySelector('video'); const r=p&&p.getBoundingClientRect(); return p && {w:Math.round(r.width),h:Math.round(r.height),vw:v.videoWidth, focus:__resenha.V.focus}`);
    await B.shot('03-pip-pequeno');
    await B.ev(`document.querySelector('#pips .tile').click()`); await sleep(500);
    out.pipClick = await B.ev(`const m=document.querySelector('.focus-main .tile'); const r=m&&m.getBoundingClientRect(); return m && {w:Math.round(r.width), key:m.dataset.key}`);
    await B.shot('04-tela-ampliada');
    await B.ev(`document.querySelector('.focus-main .tile').click()`); await sleep(300);
    out.pipBack = await B.ev(`return {focus:__resenha.V.focus, pip:!!document.querySelector('#pips .tile')}`);

    // Menu de microfone (clique direito)
    await A.ev(`const b=document.querySelector('#btn-mute'); const r=b.getBoundingClientRect(); await __resenha.deviceMenu({preventDefault(){},clientX:r.left,clientY:r.top-10}, 'audioinput')`);
    await sleep(300);
    out.micMenu = await A.ev(`return document.querySelector('#ctx-menu').innerText.split('\\n').filter(Boolean).slice(0,6)`);
    await A.shot('05-menu-microfone');
    await A.ev(`document.querySelector('#ctx-menu').classList.add('hidden')`);
    await A.ev(`const b=document.querySelector('#btn-deafen'); const r=b.getBoundingClientRect(); await __resenha.deviceMenu({preventDefault(){},clientX:r.left,clientY:r.top-10}, 'audiooutput')`);
    await sleep(300);
    out.outMenu = await A.ev(`return document.querySelector('#ctx-menu').innerText.split('\\n').filter(Boolean).slice(0,6)`);
    await A.ev(`document.querySelector('#ctx-menu').classList.add('hidden')`);

    // DJ
    await A.ev(`const c=__resenha.S.channels.find(c=>c.name==='geral'); __resenha.selectTextChannel(c.id); __resenha.summonDJ()`);
    await sleep(800);
    out.djUser = await B.ev(`return !!__resenha.S.users.get('dj-resenha') && __resenha.S.users.get('dj-resenha').voiceChannel`);
    await A.ev(`__resenha.wsSend({t:'dj-add', input:'https://www.youtube.com/watch?v=dQw4w9WgXcQ'}); __resenha.wsSend({t:'dj-add', input:'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT'})`);
    out.djPlaying = await waitFor(B, `__resenha.S.dj && __resenha.S.dj.current && __resenha.V.djAudio && !__resenha.V.djAudio.paused && __resenha.V.djAudio.currentTime > 0.5`, 90000);
    await sleep(1500);
    out.djState = await B.ev(`const d=__resenha.S.dj, a=__resenha.V.djAudio; return {title:d.current&&d.current.title, queue:d.queue.map(q=>q.title), t:a.currentTime.toFixed(1), speaking:__resenha.V.speaking.has('dj-resenha')}`);
    out.djSyncA = await A.ev(`const a=__resenha.V.djAudio; return a && a.currentTime.toFixed(1)`);
    await A.shot('06-dj-painel');
    await A.ev(`document.querySelectorAll('[data-close]').forEach(b=>b.click())`);
    await sleep(300);
    await B.shot('07-call-com-dj');
    // Volume do DJ (cada um no seu)
    await B.ev(`__resenha.settings.userVolumes['DJ Resenha']=30; __resenha.applyUserVolume('dj-resenha')`);
    out.djVolB = await B.ev(`return __resenha.V.djGain.gain.value.toFixed(2)`);
    // Votar pra pular (precisa de 2 de 2)
    const t1 = await A.ev(`return __resenha.S.dj.current.title`);
    await A.ev(`__resenha.wsSend({t:'dj-vote-skip'})`); await sleep(500);
    out.skip1 = await A.ev(`return {votes:__resenha.S.dj.skipVotes.length, needed:__resenha.S.dj.needed, same: __resenha.S.dj.current && __resenha.S.dj.current.title === ${JSON.stringify(t1)}}`);
    await B.ev(`__resenha.wsSend({t:'dj-vote-skip'})`);
    await waitFor(A, `__resenha.S.dj.current && __resenha.S.dj.current.title !== ${JSON.stringify(t1)}`, 60000);
    out.skip2 = await A.ev(`return __resenha.S.dj.current && __resenha.S.dj.current.title`);
    // Votar pra remover
    await A.ev(`__resenha.wsSend({t:'dj-vote-kick'})`); await B.ev(`__resenha.wsSend({t:'dj-vote-kick'})`); await sleep(700);
    out.kicked = await B.ev(`return {active:__resenha.S.dj.active, user:__resenha.S.users.has('dj-resenha'), audio: !__resenha.V.djAudio || __resenha.V.djAudio.paused}`);

    // Configurações: aba de filtros
    await B.ev(`__resenha.openSettings('filtros')`); await sleep(600); await B.shot('08-filtros'); await B.ev(`document.querySelectorAll('[data-close]').forEach(b=>b.click())`);
    await B.ev(`__resenha.openSettings('voz')`); await sleep(600); await B.shot('09-voz'); await B.ev(`document.querySelectorAll('[data-close]').forEach(b=>b.click())`);
    out.logsA = A.logs.slice(0, 8); out.logsB = B.logs.slice(0, 8);
  } catch (e) { out.error = e.stack; }
  console.log(JSON.stringify(out, null, 1));
  pa.kill(); pb.kill();
  process.exit(0);
})();
