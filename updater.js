// Atualização automática pelo GitHub Releases.
// Publique uma release com a tag vX.Y.Z e anexe o Resenha.exe. O app compara a versão, baixa e troca o .exe.
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const REPO = 'lucaseduardocatharinnicolau-crypto/resenhaapp';
const UA = 'Resenha-Updater';

function request(url, redirects = 8) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' }, timeout: 30000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume(); return resolve(request(new URL(res.headers.location, url).toString(), redirects - 1));
      }
      resolve(res);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

const parse = (v) => String(v || '').replace(/^v/i, '').split(/[.-]/).slice(0, 3).map((x) => parseInt(x, 10) || 0);
function newer(a, b) { // a > b ?
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] > y[i]; }
  return false;
}

async function check(current) {
  const res = await request(`https://api.github.com/repos/${REPO}/releases/latest`);
  if (res.statusCode === 404) { res.resume(); return { update: false, reason: 'sem releases' }; }
  if (res.statusCode !== 200) { res.resume(); throw new Error('GitHub respondeu ' + res.statusCode); }
  const body = await new Promise((r, j) => { let d = ''; res.setEncoding('utf8'); res.on('data', (c) => (d += c)); res.on('end', () => r(d)); res.on('error', j); });
  const rel = JSON.parse(body);
  const version = String(rel.tag_name || '').replace(/^v/i, '');
  const asset = (rel.assets || []).find((a) => /\.exe$/i.test(a.name));
  if (!asset || !newer(version, current)) return { update: false, latest: version };
  return { update: true, version, current, notes: String(rel.body || '').slice(0, 2000), url: asset.browser_download_url, size: asset.size, name: asset.name, page: rel.html_url };
}

// Onde o .exe de verdade está (no portable o app roda de uma pasta temporária)
function targetExe() {
  if (process.env.PORTABLE_EXECUTABLE_FILE) return process.env.PORTABLE_EXECUTABLE_FILE;
  return process.execPath;
}

async function install(info, onProgress, quit) {
  const target = targetExe();
  if (/electron\.exe$/i.test(target)) throw new Error('Rodando em modo desenvolvimento: atualize pelo código.');
  const dir = path.dirname(target);
  const tmp = path.join(dir, path.basename(target, '.exe') + '.update.exe');
  try { fs.accessSync(dir, fs.constants.W_OK); } catch { throw new Error('Sem permissão pra gravar em ' + dir + '. Mova o Resenha.exe pra Área de Trabalho ou Documentos.'); }

  const res = await request(info.url);
  if (res.statusCode !== 200) { res.resume(); throw new Error('Download falhou (HTTP ' + res.statusCode + ')'); }
  const total = Number(res.headers['content-length']) || info.size || 0;
  let got = 0, lastPct = -1;
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmp);
    res.on('data', (c) => { got += c.length; const p = total ? Math.floor(got / total * 100) : 0; if (p !== lastPct) { lastPct = p; onProgress(p); } });
    res.pipe(out);
    out.on('finish', resolve); out.on('error', reject); res.on('error', reject);
  });
  if (total && got !== total) { fs.rmSync(tmp, { force: true }); throw new Error('Download incompleto'); }
  if (fs.statSync(tmp).size < 10e6) { fs.rmSync(tmp, { force: true }); throw new Error('Arquivo baixado inválido'); }

  // Script que espera o Resenha fechar, troca o .exe e abre de novo
  const bat = path.join(dir, 'resenha-update.cmd');
  const exeName = path.basename(target);
  fs.writeFileSync(bat, [
    '@echo off',
    'chcp 65001 >nul',
    'set tries=0',
    ':wait',
    'timeout /t 1 /nobreak >nul',
    `move /y "${tmp}" "${target}" >nul 2>&1`,
    'if errorlevel 1 (',
    '  set /a tries+=1',
    '  if %tries% lss 60 goto wait',
    '  exit /b 1',
    ')',
    `start "" "${target}"`,
    '(goto) 2>nul & del "%~f0"',
  ].join('\r\n'));
  spawn('cmd.exe', ['/c', bat], { detached: true, stdio: 'ignore', windowsHide: true, cwd: dir }).unref();
  console.log('[update] trocando', exeName);
  setTimeout(quit, 300);
}

module.exports = { check, install, newer, REPO };
