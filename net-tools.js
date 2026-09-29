// Ferramentas de rede: IPs locais, IP público, detecção de CGNAT e abertura automática de porta via UPnP.
const os = require('os');
const dgram = require('dgram');
const http = require('http');
const https = require('https');

function localIPs() {
  const out = { v4: [], v6: [] };
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.internal) continue;
      const virtual = /vEthernet|VirtualBox|VMware|WSL|Hyper-V|Loopback|Radmin|ZeroTier|Tailscale|Hamachi/i.test(name);
      if (a.family === 'IPv4' || a.family === 4) out.v4.push({ ip: a.address, iface: name, virtual });
      else if ((a.family === 'IPv6' || a.family === 6) && !a.address.startsWith('fe80') && !a.address.startsWith('fd') && !a.address.startsWith('fc')) {
        out.v6.push({ ip: a.address, iface: name, virtual });
      }
    }
  }
  const score = (x) => (x.virtual ? 10 : 0) + (x.ip.startsWith('192.168.') ? 0 : x.ip.startsWith('10.') ? 1 : 2);
  out.v4.sort((a, b) => score(a) - score(b));
  return out;
}

function getText(url, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout }, (res) => {
      let d = ''; res.setEncoding('utf8');
      res.on('data', (c) => { d += c; if (d.length > 2e6) req.destroy(); });
      res.on('end', () => resolve(d));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function publicIPs() {
  const [v4, v6] = await Promise.all([
    getText('https://api.ipify.org').then((s) => s.trim()).catch(() => null),
    getText('https://api6.ipify.org').then((s) => s.trim()).catch(() => null),
  ]);
  return { v4: /^\d+\.\d+\.\d+\.\d+$/.test(v4 || '') ? v4 : null, v6: v6 && v6.includes(':') ? v6 : null };
}

const isPrivateV4 = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|127\.|169\.254\.)/.test(ip || '');

// ---------- UPnP (IGD) ----------
function ssdpDiscover(timeout = 3000) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const found = new Set();
    const targets = ['urn:schemas-upnp-org:device:InternetGatewayDevice:1', 'urn:schemas-upnp-org:device:InternetGatewayDevice:2', 'urn:schemas-upnp-org:service:WANIPConnection:1', 'urn:schemas-upnp-org:service:WANPPPConnection:1'];
    sock.on('message', (msg) => {
      const m = /^location:\s*(.+)$/im.exec(msg.toString());
      if (m) found.add(m[1].trim());
    });
    sock.on('error', () => {});
    sock.bind(() => {
      for (const st of targets) {
        const q = Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`);
        sock.send(q, 1900, '239.255.255.250', () => {});
      }
    });
    setTimeout(() => { try { sock.close(); } catch {} resolve([...found]); }, timeout);
  });
}

async function findControl(location) {
  const xml = await getText(location, 4000);
  const services = xml.split(/<service>/i).slice(1);
  for (const s of services) {
    const type = /<serviceType>([^<]+)<\/serviceType>/i.exec(s);
    const ctrl = /<controlURL>([^<]+)<\/controlURL>/i.exec(s);
    if (type && ctrl && /WAN(IP|PPP)Connection/i.test(type[1])) {
      return { type: type[1].trim(), url: new URL(ctrl[1].trim(), location).toString() };
    }
  }
  return null;
}

function soap(ctrl, action, args = {}) {
  const body = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${ctrl.type}">${Object.entries(args).map(([k, v]) => `<${k}>${v}</${k}>`).join('')}</u:${action}></s:Body></s:Envelope>`;
  return new Promise((resolve, reject) => {
    const u = new URL(ctrl.url);
    const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: 'POST', timeout: 5000,
      headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${ctrl.type}#${action}"`, 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => (res.statusCode === 200 ? resolve(d) : reject(new Error((/<errorDescription>([^<]+)/i.exec(d) || [])[1] || `HTTP ${res.statusCode}`))));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

function internalIPFor(gatewayUrl) {
  const gw = new URL(gatewayUrl).hostname.split('.').slice(0, 3).join('.');
  const ips = localIPs().v4;
  return (ips.find((x) => x.ip.startsWith(gw + '.')) || ips[0] || {}).ip;
}

class PortMapper {
  constructor(log) { this.log = log || (() => {}); this.ctrl = null; this.mapped = []; this.timer = null; }
  // port = TCP (chat/sinalização/anexos); udpPorts = portas UDP da voz/tela (WebRTC)
  async open(port, udpPorts = []) {
    const result = { ok: false, externalIP: null, error: null };
    try {
      const locations = await ssdpDiscover();
      for (const loc of locations) { try { this.ctrl = await findControl(loc); if (this.ctrl) break; } catch {} }
      if (!this.ctrl) throw new Error('Roteador sem UPnP (ou UPnP desligado)');
      const client = internalIPFor(this.ctrl.url);
      this.client = client;
      this.wanted = [{ port, proto: 'TCP' }, ...udpPorts.map((p) => ({ port: p, proto: 'UDP' }))];
      await this.mapOne(this.wanted[0], true); // se o TCP falhar, é erro
      let udpOk = 0;
      for (const m of this.wanted.slice(1)) { try { await this.mapOne(m); udpOk++; } catch {} }
      result.udp = `${udpOk}/${udpPorts.length}`;
      try { const x = await soap(this.ctrl, 'GetExternalIPAddress'); result.externalIP = (/<NewExternalIPAddress>([^<]*)</i.exec(x) || [])[1] || null; } catch {}
      result.ok = true;
      clearInterval(this.timer);
      this.timer = setInterval(() => this.refresh(), 60 * 60 * 1000);
    } catch (e) { result.error = e.message; }
    return result;
  }
  async mapOne(m, record = true) {
    const args = { NewRemoteHost: '', NewExternalPort: m.port, NewProtocol: m.proto, NewInternalPort: m.port, NewInternalClient: this.client, NewEnabled: 1, NewPortMappingDescription: 'Resenha', NewLeaseDuration: 7200 };
    try { await soap(this.ctrl, 'AddPortMapping', args); } catch (e) {
      if (/lease|OnlyPermanent/i.test(e.message)) await soap(this.ctrl, 'AddPortMapping', { ...args, NewLeaseDuration: 0 });
      else throw e;
    }
    if (record && !this.mapped.some((x) => x.port === m.port && x.proto === m.proto)) this.mapped.push(m);
  }
  async refresh() {
    for (const m of this.mapped) { try { await this.mapOne(m, false); } catch {} }
  }
  async close() {
    clearInterval(this.timer);
    if (!this.ctrl) return;
    for (const m of this.mapped) { try { await soap(this.ctrl, 'DeletePortMapping', { NewRemoteHost: '', NewExternalPort: m.port, NewProtocol: m.proto }); } catch {} }
    this.mapped = [];
  }
}

module.exports = { localIPs, publicIPs, isPrivateV4, PortMapper };
