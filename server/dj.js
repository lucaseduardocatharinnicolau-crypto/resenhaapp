// DJ Resenha: resolve links (YouTube, Spotify, busca) e baixa o áudio com yt-dlp.
// Roda no PC do anfitrião. O yt-dlp é baixado sozinho na primeira vez.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const IS_WIN = process.platform === 'win32';
const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/' + (IS_WIN ? 'yt-dlp.exe' : process.platform === 'darwin' ? 'yt-dlp_macos' : 'yt-dlp_linux');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36';
const rid = () => crypto.randomBytes(6).toString('hex');

function get(url, { redirects = 8, timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' }, timeout }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).toString(), { redirects: redirects - 1, timeout }));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      resolve(res);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}
async function getText(url) {
  const res = await get(url);
  return new Promise((resolve, reject) => { let d = ''; res.setEncoding('utf8'); res.on('data', (c) => (d += c)); res.on('end', () => resolve(d)); res.on('error', reject); });
}
async function downloadTo(url, dest) {
  const res = await get(url, { timeout: 60000 });
  const tmp = dest + '.part';
  await new Promise((resolve, reject) => { const out = fs.createWriteStream(tmp); res.pipe(out); out.on('finish', resolve); out.on('error', reject); res.on('error', reject); });
  fs.renameSync(tmp, dest);
  if (process.platform !== 'win32') fs.chmodSync(dest, 0o755);
}

class DJTools {
  constructor({ binDir, cacheDir, nodePath, log }) {
    this.binDir = binDir; this.cacheDir = cacheDir; this.nodePath = nodePath; this.log = log || (() => {});
    this.bin = path.join(binDir, IS_WIN ? 'yt-dlp.exe' : 'yt-dlp');
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(cacheDir, { recursive: true });
    // limpa sobras de sessões anteriores
    try { for (const f of fs.readdirSync(cacheDir)) fs.rmSync(path.join(cacheDir, f), { force: true, recursive: true }); } catch {}
    this._ensure = null;
  }

  ensure() {
    if (!this._ensure) {
      this._ensure = (async () => {
        let ok = false;
        try { ok = fs.statSync(this.bin).size > 5e6; } catch {}
        if (!ok) { this.log('baixando yt-dlp...'); await downloadTo(YTDLP_URL, this.bin); }
        else if (Date.now() - fs.statSync(this.bin).mtimeMs > 7 * 864e5) {
          // atualiza em segundo plano uma vez por semana (o YouTube muda direto)
          this.run(['-U'], 120000).then(() => { try { fs.utimesSync(this.bin, new Date(), new Date()); } catch {} }).catch(() => {});
        }
      })().catch((e) => { this._ensure = null; throw e; });
    }
    return this._ensure;
  }

  run(args, timeoutMs = 90000) {
    return new Promise((resolve, reject) => {
      const extra = this.nodePath ? ['--js-runtimes', 'node:' + this.nodePath] : [];
      const p = spawn(this.bin, [...extra, '--no-warnings', '--encoding', 'utf-8', ...args], {
        windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PYTHONIOENCODING: 'utf-8' },
      });
      let out = '', err = '';
      p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8');
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      const t = setTimeout(() => { p.kill(); reject(new Error('demorou demais')); }, timeoutMs);
      p.on('error', (e) => { clearTimeout(t); reject(e); });
      p.on('close', (code) => {
        clearTimeout(t);
        if (code === 0) resolve(out);
        else reject(new Error((err.match(/ERROR: (.*)/) || [])[1] || err.trim().split('\n').pop() || 'yt-dlp falhou (' + code + ')'));
      });
    });
  }

  // Retorna lista de itens: { id, title, duration, url?, query?, source }
  async resolve(input) {
    const s = String(input || '').trim();
    if (!s) throw new Error('Link vazio');
    let u = null; try { u = new URL(s); } catch {}
    if (!u) return [{ id: rid(), title: s, query: 'ytsearch1:' + s, duration: 0, source: 'busca' }];
    const host = u.hostname.replace(/^www\./, '');

    if (/spotify\.com$/.test(host)) {
      const m = u.pathname.match(/\/(track|playlist|album)\/([A-Za-z0-9]+)/);
      if (!m) throw new Error('Link do Spotify não reconhecido (use música, álbum ou playlist)');
      const html = await getText(`https://open.spotify.com/embed/${m[1]}/${m[2]}`);
      const j = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
      if (!j) throw new Error('Não consegui ler o Spotify');
      const e = JSON.parse(j[1]).props.pageProps.state.data.entity;
      if (m[1] === 'track') {
        const artists = (e.artists || []).map((a) => a.name).join(', ');
        const title = artists ? `${artists} - ${e.name}` : e.name;
        return [{ id: rid(), title, query: `ytsearch1:${title} audio`, duration: Math.round((e.duration || 0) / 1000), source: 'spotify' }];
      }
      return (e.trackList || []).slice(0, 200).map((t) => {
        const title = t.subtitle ? `${t.subtitle} - ${t.title}` : t.title;
        return { id: rid(), title, query: `ytsearch1:${title} audio`, duration: Math.round((t.duration || 0) / 1000), source: 'spotify' };
      });
    }

    await this.ensure();
    const isYT = /(^|\.)youtube\.com$|^youtu\.be$/.test(host);
    const list = u.searchParams.get('list');
    if (isYT && list && (!u.searchParams.get('v') || u.pathname.startsWith('/playlist')) && !list.startsWith('RD')) {
      const out = await this.run(['--flat-playlist', '--playlist-end', '200', '--print', '%(id)s\t%(duration)s\t%(title)s', `https://www.youtube.com/playlist?list=${list}`], 120000);
      const items = out.trim().split('\n').filter(Boolean).map((l) => {
        const [id, dur, ...t] = l.split('\t');
        return { id: rid(), title: t.join('\t'), url: `https://www.youtube.com/watch?v=${id}`, duration: Number(dur) || 0, source: 'youtube' };
      }).filter((x) => x.title && !/^\[(Private|Deleted)/.test(x.title));
      if (!items.length) throw new Error('Playlist vazia ou privada');
      return items;
    }
    const out = await this.run(['--no-playlist', '--skip-download', '--print', '%(webpage_url)s\t%(duration)s\t%(title)s', s]);
    const [url, dur, ...t] = out.trim().split('\n').pop().split('\t');
    return [{ id: rid(), title: t.join('\t') || s, url: url || s, duration: Number(dur) || 0, source: isYT ? 'youtube' : host }];
  }

  // Baixa o áudio do item; resolve com o caminho do arquivo
  fetchAudio(item) {
    if (item._file) return Promise.resolve(item._file);
    if (!item._dl) {
      item._dl = (async () => {
        await this.ensure();
        const tpl = path.join(this.cacheDir, item.id + '.%(ext)s');
        const out = await this.run(['-f', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best', '--no-playlist', '--no-part', '--max-filesize', '300M',
          '-o', tpl, '--print', 'after_move:%(filepath)s\t%(duration)s\t%(title)s', item.url || item.query], 180000);
        const [file, dur, ...t] = out.trim().split('\n').pop().split('\t');
        if (!file || !fs.existsSync(file)) throw new Error('Download falhou');
        if (!item.duration) item.duration = Number(dur) || 0;
        if (item.source === 'busca' && t.length) item.title = t.join('\t');
        item._file = file;
        return file;
      })().catch((e) => { item._dl = null; throw e; });
    }
    return item._dl;
  }

  forget(item) {
    if (item && item._file) { fs.rm(item._file, { force: true }, () => {}); item._file = null; }
  }
}

module.exports = { DJTools };
