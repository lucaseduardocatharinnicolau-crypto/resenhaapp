// Teste v1.2 visual: temas, arrastar painéis/canais/quadrados, alinhamento das configurações.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const ROOT = path.join(__dirname, '..');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOTS = path.join(__dirname, 'shots'); fs.mkdirSync(SHOTS, { recursive: true });

async function cdp(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const pg = list.find((x) => x.type === 'page' && x.url.includes('index.html'));
      if (pg) {
        const ws = new WebSocket(pg.webSocketDebuggerUrl); await new Promise((r) => ws.on('open', r));
        let id = 0; const pend = new Map(); const logs = [];
        ws.on('message', (d) => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 300)); });
        const send = (method, params = {}) => new Promise((r) => { const i2 = ++id; pend.set(i2, r); ws.send(JSON.stringify({ id: i2, method, params })); });
        const ev = async (expr) => {
          const r = await send('Runtime.evaluate', { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true });
          if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || JSON.stringify(r.result.exceptionDetails));
          return r.result.result.value;
        };
        const shot = async (name) => { const s = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(s.result.data, 'base64')); };
        await send('Runtime.enable');
        return { ev, send, shot, logs };
      }
    } catch {}
    await sleep(500);
  }
  throw new Error('cdp timeout');
}
// arrastar HTML5 simulado (mesmos eventos que o mouse gera)
const DRAG = `window.__drag = (src, dst, opts={}) => { const dt = new DataTransfer(); const r = dst.getBoundingClientRect();
  const x = opts.x ?? (r.left + r.width * (opts.fx ?? 0.25)), y = opts.y ?? (r.top + r.height * (opts.fy ?? 0.5));
  src.dispatchEvent(new DragEvent('dragstart', {bubbles:true, dataTransfer:dt}));
  dst.dispatchEvent(new DragEvent('dragover', {bubbles:true, cancelable:true, dataTransfer:dt, clientX:x, clientY:y}));
  dst.dispatchEvent(new DragEvent('drop', {bubbles:true, cancelable:true, dataTransfer:dt, clientX:x, clientY:y}));
  src.dispatchEvent(new DragEvent('dragend', {bubbles:true, dataTransfer:dt})); };`;

(async () => {
  fs.rmSync(path.join(process.env.APPDATA, 'Resenha-testeV'), { recursive: true, force: true });
  const p = spawn(ELECTRON, [ROOT, '--profile=testeV', '--remote-debugging-port=9331', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'], { stdio: 'ignore' });
  const out = {};
  try {
    let A = await cdp(9331); await sleep(1000);
    await A.ev(`localStorage.setItem('resenha.profile', JSON.stringify({name:'Lucas',color:'#eb459e'})); localStorage.setItem('resenha.lastHost', JSON.stringify({name:'visual',port:7850})); location.reload();`).catch(() => {});
    await sleep(2000); A = await cdp(9331);
    await A.ev(DRAG);
    await A.ev(`document.querySelector('#btn-host').click()`); await sleep(2500);
    await A.ev(`document.querySelectorAll('[data-close]').forEach(b=>b.click())`);
    await A.ev(`__resenha.wsSend({t:'ch-create',type:'text',name:'memes'}); __resenha.wsSend({t:'ch-create',type:'text',name:'clips'}); __resenha.wsSend({t:'ch-create',type:'voice',name:'Jogando CS'})`);
    await A.ev(`document.querySelector('#input').value='mensagem de teste @Lucas'; await __resenha.sendMessage(); await __resenha.joinVoice('lobby')`);
    await sleep(1000);

    // 1) Bug do print: select com nome de microfone gigante não pode estourar a largura
    await A.ev(`await __resenha.openSettings('voz'); await new Promise(r=>setTimeout(r,500)); const s=document.querySelector('#st-in'); const o=document.createElement('option'); o.textContent='Microfone (PRO X 2 LIGHTSPEED) (046d:0af7) com um nome bem comprido pra testar'; s.appendChild(o); s.value=o.value;`);
    await sleep(300);
    out.settingsOverflow = await A.ev(`const b=document.querySelector('.modal .body'); const m=document.querySelector('.modal'); const outs=[...document.querySelectorAll('.modal .body *')].filter(e=>{const r=e.getBoundingClientRect(); const mr=b.getBoundingClientRect(); return r.width>0 && r.right>mr.right+1}).map(e=>e.id||e.className||e.tagName).slice(0,5); return {scrollW:b.scrollWidth, clientW:b.clientWidth, estouram:outs}`);
    await A.shot('20-config-voz');
    await A.ev(`document.querySelector('.tab[data-t=aparencia]').click()`); await sleep(300);
    await A.shot('21-config-aparencia');

    // 2) Temas
    out.themes = [];
    for (const t of ['claro', 'roxo', 'oceano', 'creme']) {
      await A.ev(`document.querySelector('.theme-card[data-theme=${t}]').click()`); await sleep(250);
      out.themes.push(await A.ev(`return {tema:'${t}', fundo:getComputedStyle(document.querySelector('#chat')).backgroundColor, salvo:JSON.parse(localStorage.getItem('resenha.settings')).theme}`));
    }
    await A.ev(`document.querySelectorAll('[data-close]').forEach(b=>b.click())`); await sleep(300);
    await A.shot('22-tema-cafe');
    await A.ev(`document.querySelector('.theme-card') || 0; __resenha.settings.theme='claro'; applyTheme('claro')`); await sleep(200);
    await A.shot('23-tema-claro');
    await A.ev(`__resenha.settings.theme='discord'; applyTheme('discord')`);

    // 3) Arrastar o painel do chat pra esquerda da call
    await A.ev(`__drag(document.querySelector('#chat .drag-head'), document.querySelector('#call'), {fx:0.1})`); await sleep(400);
    out.layoutAposArrastar = await A.ev(`return [...document.querySelectorAll('#main > aside, #main > section')].map(e=>e.id)`);
    out.layoutSalvo = await A.ev(`return JSON.parse(localStorage.getItem('resenha.settings')).layout`);
    await A.shot('24-chat-no-meio');
    // canais pra direita da call
    await A.ev(`__drag(document.querySelector('#room-header'), document.querySelector('#call'), {fx:0.9})`); await sleep(400);
    out.layout2 = await A.ev(`return [...document.querySelectorAll('#main > aside, #main > section')].map(e=>e.id)`);
    await A.shot('25-canais-na-direita');
    // redimensionar: divisor
    const before = await A.ev(`return Math.round(document.querySelector('#chat').getBoundingClientRect().width)`);
    await A.ev(`const sp=document.querySelector('.splitter[data-left=chat], .splitter[data-right=chat]'); const r=sp.getBoundingClientRect(); sp.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:r.left,clientY:300})); window.dispatchEvent(new MouseEvent('mousemove',{clientX:r.left+(sp.dataset.left==='chat'?120:-120),clientY:300})); window.dispatchEvent(new MouseEvent('mouseup',{}));`);
    await sleep(200);
    out.largChat = { antes: before, depois: await A.ev(`return Math.round(document.querySelector('#chat').getBoundingClientRect().width)`) };
    // voltar padrão
    await A.ev(`__resenha.resetLayout()`); await sleep(300);
    out.layoutPadrao = await A.ev(`return [...document.querySelectorAll('#main > aside, #main > section')].map(e=>e.id)`);

    // 4) Reordenar canais arrastando
    out.canaisAntes = await A.ev(`return [...document.querySelectorAll('#text-channels .cn')].map(e=>e.textContent)`);
    await A.ev(`const cs=document.querySelectorAll('#text-channels .channel'); __drag(cs[2], cs[0], {fy:0.2})`); await sleep(500);
    out.canaisDepois = await A.ev(`return [...document.querySelectorAll('#text-channels .cn')].map(e=>e.textContent)`);

    // 5) Miniatura da tela: arrastar pro canto superior esquerdo
    await A.ev(`const c=document.createElement('canvas');c.width=640;c.height=360;const g=c.getContext('2d');setInterval(()=>{g.fillStyle='#e5383b';g.fillRect(0,0,640,360)},50); __resenha.startShareWithStream(c.captureStream(20),'720p30')`);
    await sleep(800);
    await A.ev(`const t=document.querySelector('#pips .tile'); const r=t.getBoundingClientRect(); const cr=document.querySelector('#call').getBoundingClientRect(); t.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0,clientX:r.left+50,clientY:r.top+50})); window.dispatchEvent(new MouseEvent('mousemove',{clientX:cr.left+120,clientY:cr.top+120})); window.dispatchEvent(new MouseEvent('mouseup',{clientX:cr.left+120,clientY:cr.top+120}));`);
    await sleep(300);
    out.pipCanto = await A.ev(`return {canto:document.querySelector('#pips').dataset.corner, salvo:JSON.parse(localStorage.getItem('resenha.settings')).pipCorner}`);
    await A.shot('26-miniatura-canto');
    out.logs = A.logs;
  } catch (e) { out.error = e.stack; }
  console.log(JSON.stringify(out, null, 1));
  p.kill(); process.exit(0);
})();
