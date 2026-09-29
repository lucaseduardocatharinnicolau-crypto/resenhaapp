const { app, BrowserWindow, ipcMain, desktopCapturer, session, shell, globalShortcut, Notification, nativeImage, Menu, Tray } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { createServer } = require('./server');
const { DJTools } = require('./server/dj');
const net = require('./net-tools');
const Turn = require('node-turn');
const { Tunnel } = require('./tunnel-main');
const updater = require('./updater');
let tunnel = null;

// Perfil separado (útil para testar 2 instâncias no mesmo PC): Resenha.exe --profile=teste
const profileArg = process.argv.find((a) => a.startsWith('--profile='));
if (profileArg) app.setPath('userData', path.join(app.getPath('appData'), 'Resenha-' + profileArg.split('=')[1]));
const TEST_MODE = !!profileArg;

// Só uma janela do Resenha por vez (abrir de novo traz a que está na bandeja)
if (!TEST_MODE && !app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

app.commandLine.appendSwitch('enable-features', 'WebRtcAllowInputVolumeAdjustment');
// Mostra os IPs reais nos candidatos WebRTC (senão o Chrome esconde atrás de nomes .local e LAN/Radmin falha)
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.setAppUserModelId('com.lucas.resenha');

let win = null;
let tray = null;
let quitting = false;
let host = null; // { server, mapper, port, hostKey, turn }
let pendingShare = null; // { id, audio }
let djTools = null;
const ICON = path.join(__dirname, 'app', 'icon.png');

function showWindow() { if (!win) return; if (win.isMinimized()) win.restore(); win.show(); win.focus(); }

function createWindow() {
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1400, height: 860, minWidth: 980, minHeight: 600,
    backgroundColor: '#313338', title: 'Resenha', icon: ICON,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#1e1f22', symbolColor: '#b5bac1', height: 30 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false },
  });
  win.loadFile(path.join(__dirname, 'app', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) win.webContents.toggleDevTools();
    if (input.type === 'keyDown' && input.control && input.key.toLowerCase() === 'r') { e.preventDefault(); }
  });
  win.on('focus', () => win.flashFrame(false));
  // X = vai pra bandeja (segundo plano). Sair de verdade: menu da bandeja.
  win.on('close', (e) => {
    if (quitting || TEST_MODE) return;
    e.preventDefault();
    win.hide();
    if (!app._trayHintShown && Notification.isSupported()) {
      app._trayHintShown = true;
      new Notification({ title: 'Resenha continua aberto', body: 'Ele está na bandeja, perto do relógio. Clique direito no ícone pra sair.', silent: true, icon: ICON }).show();
    }
  });
  tunnel = new Tunnel(win);
}

function createTray() {
  if (TEST_MODE) return;
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip('Resenha');
  tray.on('click', showWindow);
  updateTrayMenu({});
}
function updateTrayMenu(st) {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: 'Abrir Resenha', click: showWindow },
    { type: 'separator' },
    { label: st.muted ? 'Desmutar microfone' : 'Mutar microfone', enabled: !!st.inVoice, click: () => win.webContents.send('shortcut', 'mute') },
    { label: st.deafened ? 'Ativar som' : 'Mutar som e microfone', enabled: !!st.inVoice, click: () => win.webContents.send('shortcut', 'deafen') },
    { label: 'Sair da call', enabled: !!st.inVoice, click: () => win.webContents.send('shortcut', 'leave') },
    { type: 'separator' },
    { label: 'Sair do Resenha', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(st.inVoice ? `Resenha: na call${st.muted ? ' (mutado)' : ''}` : 'Resenha');
}

app.on('second-instance', showWindow);

app.whenReady().then(() => {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, perm, cb) => cb(['media', 'display-capture', 'notifications', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'speaker-selection'].includes(perm)));
  ses.setPermissionCheckHandler(() => true);

  // Compartilhar tela: o app escolhe a tela/janela no seletor próprio e aqui entrega pro getDisplayMedia
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      const chosen = pendingShare && sources.find((s) => s.id === pendingShare.id);
      if (!chosen) return callback({});
      const res = { video: chosen };
      // Som do PC. O renderer pede restrictOwnAudio=true, que tira o áudio do próprio Resenha (voz dos amigos, DJ, sons)
      if (pendingShare.audio && process.platform === 'win32') res.audio = 'loopback';
      pendingShare = null;
      callback(res);
    } catch (e) { callback({}); }
  }, { useSystemPicker: false });

  // Downloads de anexos: pergunta onde salvar
  ses.on('will-download', (e, item) => { item.setSaveDialogOptions({ title: 'Salvar arquivo', defaultPath: path.join(app.getPath('downloads'), item.getFilename()) }); });

  djTools = new DJTools({
    binDir: path.join(app.getPath('userData'), 'bin'),
    cacheDir: path.join(app.getPath('temp'), 'resenha-dj'),
    nodePath: process.execPath, // o próprio Resenha roda como Node (ELECTRON_RUN_AS_NODE) pro yt-dlp
    log: (...a) => console.log('[dj]', ...a),
  });

  createWindow();
  createTray();
});

app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', async () => { await stopHost(4003); app.quit(); });
let quitStopped = false;
app.on('before-quit', (e) => {
  // fechar pela bandeja: a sala passa pra outro amigo em vez de acabar
  if (host && !quitStopped) { e.preventDefault(); quitStopped = true; stopHost(4003).finally(() => app.quit()); }
});
app.on('will-quit', () => globalShortcut.unregisterAll());

const RELAY_RANGE = 300; // portas UDP locais dos relays TURN (não precisam abrir no roteador)
async function stopHost(code = 4002) {
  if (!host) return;
  const h = host; host = null;
  try { if (tunnel && tunnel.role === 'host') tunnel.stop(); } catch {}
  try { if (h.turn) h.turn.stop(); } catch {}
  try { await h.mapper.close(); } catch {}
  try { await h.server.close(code); } catch {}
}

// ---------- IPC ----------
ipcMain.handle('host:start', async (e, opts) => {
  await stopHost();
  const hostKey = crypto.randomBytes(16).toString('hex');
  const safeRoom = String(opts.roomName || 'sala').replace(/[^\w\- ]/g, '_').slice(0, 40) || 'sala';
  const dataDir = path.join(app.getPath('userData'), 'salas', safeRoom);
  const turnPass = crypto.randomBytes(12).toString('hex');
  if (opts.restore) restoreCachedFiles(opts.code, opts.restore, dataDir);
  let port = Math.max(1024, Math.min(65000, Number(opts.port) || 7777));
  let server = null;
  for (let tries = 0; ; tries++) {
    server = createServer({ port, password: opts.password || '', roomName: opts.roomName, hostKey, dj: djTools, code: opts.code, epoch: opts.epoch,
      restore: opts.restore, turn: { port, username: 'resenha', credential: turnPass }, dataDir, log: (...a) => console.log('[sala]', ...a) });
    try { await server.listen(); break; } catch (err) {
      try { await server.close(); } catch {}
      if (err.code === 'EADDRINUSE' && opts.autoPort && tries < 10) { port += 400; continue; }
      return { ok: false, error: err.code === 'EADDRINUSE' ? `A porta ${port} já está em uso. Escolha outra.` : err.message };
    }
  }
  // Relay TURN embutido: quando dois amigos não conseguem falar direto, a voz/tela passa pelo PC do anfitrião
  let turn = null;
  try {
    const lan = net.localIPs().v4.filter((x) => !x.virtual).map((x) => x.ip);
    turn = new Turn({ relayIps: lan.length ? [lan[0]] : undefined, listeningPort: port, minPort: port + 1, maxPort: port + RELAY_RANGE, authMech: 'long-term',
      realm: 'resenha', credentials: { resenha: turnPass }, debugLevel: 'OFF', log: () => {}, debug: () => {} });
    turn.start();
  } catch (err) { console.log('[turn] falhou', err.message); turn = null; }
  const mapper = new net.PortMapper();
  host = { server, mapper, port, hostKey, udpPorts: [port], turn };
  if (opts.code) tunnel.hostStart(opts.code, port, opts.rank, () => server.clientCount());
  return { ok: true, port, hostKey };
});

// ---------- Túnel (código da sala) ----------
ipcMain.handle('tun:guest-start', (e, code) => tunnel.guestStart(code));
ipcMain.handle('tun:guest-offer', (e, sdp, ms) => tunnel.guestOffer(sdp, Math.max(3000, Math.min(60000, Number(ms) || 20000))));
ipcMain.handle('tun:host-answer', (e, a) => tunnel.hostAnswer(a.peerId, a.nonce, a.sdp));
ipcMain.handle('tun:stop', () => { if (tunnel.role === 'guest') tunnel.stop(); });
ipcMain.on('tun:ready', (e, v) => tunnel.setReady(!!v));
ipcMain.on('tun:open', (e, key) => tunnel.hostOpen(key));
ipcMain.on('tun:data', (e, key, buf) => tunnel.data(key, buf));
ipcMain.on('tun:close', (e, key) => tunnel.close(key));
ipcMain.on('tun:close-peer', (e, prefix) => tunnel.closePeer(prefix));
ipcMain.on('tun:pause', (e, key) => tunnel.pause(key));
ipcMain.on('tun:resume', (e, key) => tunnel.resume(key));

// ---------- Cópia dos anexos (pra sala sobreviver à troca de anfitrião) ----------
const CACHE_MAX = 50 * 1024 * 1024;
const cacheRoot = () => path.join(app.getPath('userData'), 'anexos-cache');
const codeKey = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '') || 'sem-codigo';
const safeName = (s) => String(s || 'arquivo').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 180) || 'arquivo';
const cacheQueue = []; let cacheBusy = 0;
function pumpCache() {
  while (cacheBusy < 2 && cacheQueue.length) {
    const job = cacheQueue.shift(); cacheBusy++;
    downloadToFile(job.url, job.dest).catch(() => {}).finally(() => { cacheBusy--; pumpCache(); });
  }
}
function downloadToFile(url, dest) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? require('https') : require('http');
    mod.get(url, { timeout: 60000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = dest + '.part';
      const out = fs.createWriteStream(tmp);
      res.pipe(out);
      out.on('finish', () => { try { fs.renameSync(tmp, dest); resolve(); } catch (e) { reject(e); } });
      out.on('error', reject); res.on('error', reject);
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}
ipcMain.handle('cache:file', (e, f) => {
  if (!f || !f.url || !f.id || !/^http:\/\//.test(f.url) || !(f.size > 0) || f.size > CACHE_MAX) return false;
  const dest = path.join(cacheRoot(), codeKey(f.code), safeName(f.id), safeName(f.name));
  if (fs.existsSync(dest) || cacheQueue.some((j) => j.dest === dest)) return true;
  cacheQueue.push({ url: f.url, dest }); pumpCache();
  return true;
});
function restoreCachedFiles(code, restore, dataDir) {
  try {
    for (const list of Object.values(restore.history || {})) for (const m of list || []) for (const a of m.attachments || []) {
      if (!a || !a.id || !a.name) continue;
      const src = path.join(cacheRoot(), codeKey(code), safeName(a.id), safeName(a.name));
      const dst = path.join(dataDir, 'files', safeName(a.id), safeName(a.name));
      if (fs.existsSync(src) && !fs.existsSync(dst)) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); }
    }
  } catch (err) { console.log('[cache] restaurar falhou', err.message); }
}

ipcMain.handle('host:stop', async (e, code) => { await stopHost(code); return true; });

// Descobre endereços para convidar (pode demorar alguns segundos)
ipcMain.handle('host:network', async () => {
  if (!host) return null;
  const local = net.localIPs();
  const [pub, upnp] = await Promise.all([net.publicIPs(), host.upnp || (host.upnp = host.mapper.open(host.port, host.udpPorts))]);
  let cgnat = false;
  if (upnp.ok && upnp.externalIP && pub.v4 && upnp.externalIP !== pub.v4) cgnat = true;
  if (upnp.ok && upnp.externalIP && net.isPrivateV4(upnp.externalIP)) cgnat = true;
  const v6 = local.v6.find((x) => !x.virtual && pub.v6 && x.ip === pub.v6) || local.v6.find((x) => !x.virtual);
  return { port: host.port, turn: !!host.turn, lan: local.v4.filter((x) => !x.virtual).map((x) => x.ip), vpn: local.v4.filter((x) => x.virtual).map((x) => `${x.ip} (${x.iface})`), publicV4: pub.v4, publicV6: pub.v6 || (v6 && v6.ip) || null, upnp, cgnat };
});

ipcMain.handle('screen:sources', async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: true });
  return sources
    .filter((s) => s.id.startsWith('screen') || !/Resenha$/.test(s.name))
    .map((s) => ({ id: s.id, name: s.name, screen: s.id.startsWith('screen'), thumb: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(), icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null }));
});
ipcMain.handle('screen:select', (e, sel) => { pendingShare = sel; return true; });

ipcMain.handle('shortcuts:set', (e, map) => {
  globalShortcut.unregisterAll();
  const res = {};
  for (const [action, accel] of Object.entries(map || {})) {
    if (!accel) continue;
    try { res[action] = globalShortcut.register(accel, () => win && win.webContents.send('shortcut', action)); } catch { res[action] = false; }
  }
  return res;
});

ipcMain.on('voice-state', (e, st) => updateTrayMenu(st || {}));

ipcMain.handle('notify', (e, { title, body }) => {
  if (!win || (win.isFocused() && win.isVisible())) return;
  win.flashFrame(true);
  if (Notification.isSupported()) {
    const n = new Notification({ title, body, silent: true, icon: nativeImage.createFromPath(ICON) });
    n.on('click', showWindow);
    n.show();
  }
});
ipcMain.handle('download', (e, url) => { if (/^https?:/.test(url)) win.webContents.downloadURL(url); });
ipcMain.handle('open-external', (e, url) => { if (/^https?:/.test(url)) shell.openExternal(url); });
ipcMain.handle('app:version', () => app.getVersion());

// ---------- Atualização pelo GitHub ----------
ipcMain.handle('update:check', async () => {
  if (TEST_MODE && !process.env.RESENHA_TEST_UPDATE) return { update: false };
  try { return await updater.check(app.getVersion()); } catch (e) { return { update: false, error: e.message }; }
});
ipcMain.handle('update:install', async (e, info) => {
  try {
    await updater.install(info, (p) => win && win.webContents.send('update:progress', p), () => { quitting = true; app.quit(); });
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});
