// Temas do Resenha. Cada tema define as variáveis CSS; o resto do visual segue sozinho.
const BASE = {
  'bg-rail': '#1e1f22', 'bg-side': '#2b2d31', 'bg-main': '#313338', 'bg-panel': '#232428', 'bg-input': '#383a40', 'bg-float': '#111214',
  hover: '#35373c', active: '#404249', line: '#3f4147', line2: '#26272b', line3: '#1f2023', 'msg-hover': '#2e3035', scroll: '#1a1b1e',
  text: '#dbdee1', 'text-hi': '#f2f3f5', muted: '#949ba4', muted2: '#80848e', icon: '#b5bac1', link: '#00a8fc',
  btn: '#4e5058', 'btn-h': '#6d6f78', blurple: '#5865f2', 'blurple-h': '#4752c4', 'accent-soft': '#5865f233',
  green: '#23a55a', red: '#f23f43', yellow: '#f0b232', 'call-bg': '#000000',
};

window.THEMES = {
  discord: { name: 'Escuro (padrão)', vars: {} },
  meianoite: { name: 'Meia-noite', vars: {
    'bg-rail': '#000000', 'bg-side': '#0b0b0d', 'bg-main': '#111114', 'bg-panel': '#08080a', 'bg-input': '#1a1a1f', 'bg-float': '#000000',
    hover: '#18181c', active: '#222228', line: '#26262c', line2: '#1a1a1f', line3: '#101013', 'msg-hover': '#16161a', scroll: '#222228', 'call-bg': '#000000',
  } },
  claro: { name: 'Claro', light: true, vars: {
    'bg-rail': '#e3e5e8', 'bg-side': '#f2f3f5', 'bg-main': '#ffffff', 'bg-panel': '#ebedef', 'bg-input': '#ebedef', 'bg-float': '#ffffff',
    hover: '#e3e5e8', active: '#d4d7dc', line: '#d4d7dc', line2: '#e3e5e8', line3: '#dcdee1', 'msg-hover': '#f5f6f7', scroll: '#c4c9ce',
    text: '#313338', 'text-hi': '#060607', muted: '#5c5e66', muted2: '#6d6f78', icon: '#4e5058', link: '#006ce7',
    btn: '#6d6f78', 'btn-h': '#4e5058', 'call-bg': '#dfe1e5', 'accent-soft': '#5865f222',
  } },
  roxo: { name: 'Roxo Neon', vars: {
    'bg-rail': '#120a1f', 'bg-side': '#1b1030', 'bg-main': '#22143b', 'bg-panel': '#150c26', 'bg-input': '#2d1b4d', 'bg-float': '#0d0717',
    hover: '#2a1a47', active: '#3a2463', line: '#3a2463', line2: '#241540', line3: '#170d29', 'msg-hover': '#28183f', scroll: '#3a2463',
    text: '#e7dcff', 'text-hi': '#ffffff', muted: '#a592c9', muted2: '#8c79b3', icon: '#c7b5ec', link: '#6ee7ff',
    blurple: '#b24bf3', 'blurple-h': '#9333ea', 'accent-soft': '#b24bf333', btn: '#4a2f7a', 'btn-h': '#5d3b99', 'call-bg': '#0a0513',
  } },
  oceano: { name: 'Oceano', vars: {
    'bg-rail': '#0a1622', 'bg-side': '#0f1f2e', 'bg-main': '#13283a', 'bg-panel': '#0c1a27', 'bg-input': '#1a3449', 'bg-float': '#07111b',
    hover: '#173045', active: '#1f3f5a', line: '#21425e', line2: '#142a3c', line3: '#0e1d2b', 'msg-hover': '#162d41', scroll: '#21425e',
    text: '#d6e7f5', 'text-hi': '#f2f9ff', muted: '#8aa6bf', muted2: '#7792aa', icon: '#a9c4db', link: '#4fd1ff',
    blurple: '#1e9bd7', 'blurple-h': '#1680b3', 'accent-soft': '#1e9bd733', btn: '#2a4d6b', 'btn-h': '#355f84', 'call-bg': '#050d15',
  } },
  floresta: { name: 'Floresta', vars: {
    'bg-rail': '#0e1a12', 'bg-side': '#142319', 'bg-main': '#192c20', 'bg-panel': '#102015', 'bg-input': '#213829', 'bg-float': '#09130c',
    hover: '#1e3326', active: '#28452f', line: '#2a4632', line2: '#18291d', line3: '#101c14', 'msg-hover': '#1c3024', scroll: '#2a4632',
    text: '#dcebdd', 'text-hi': '#f3fbf3', muted: '#93ad97', muted2: '#7f9983', icon: '#b3cbb6', link: '#7ee0a0',
    blurple: '#3aa35b', 'blurple-h': '#2e8549', 'accent-soft': '#3aa35b33', btn: '#355440', 'btn-h': '#41674e', 'call-bg': '#060d08',
  } },
  sangue: { name: 'Vermelho Gamer', vars: {
    'bg-rail': '#140909', 'bg-side': '#1c0d0d', 'bg-main': '#231111', 'bg-panel': '#170b0b', 'bg-input': '#301818', 'bg-float': '#0e0606',
    hover: '#2b1515', active: '#3d1c1c', line: '#3d1c1c', line2: '#241212', line3: '#180a0a', 'msg-hover': '#291414', scroll: '#3d1c1c',
    text: '#f1dcdc', 'text-hi': '#fff5f5', muted: '#b99393', muted2: '#a17c7c', icon: '#d6b5b5', link: '#ff8a8a',
    blurple: '#e5383b', 'blurple-h': '#ba181b', 'accent-soft': '#e5383b33', btn: '#5a2828', 'btn-h': '#703333', 'call-bg': '#0a0303',
  } },
  pastel: { name: 'Pôr do sol', vars: {
    'bg-rail': '#1f1420', 'bg-side': '#2a1b2b', 'bg-main': '#332135', 'bg-panel': '#241725', 'bg-input': '#3f2a41', 'bg-float': '#170e18',
    hover: '#3a263c', active: '#4b3150', line: '#4b3150', line2: '#2e1f30', line3: '#1f1420', 'msg-hover': '#382539', scroll: '#4b3150',
    text: '#f5e2ec', 'text-hi': '#fff7fb', muted: '#c49db2', muted2: '#ab879b', icon: '#e0bfd0', link: '#ffb86b',
    blurple: '#ff7a59', 'blurple-h': '#e85d3c', 'accent-soft': '#ff7a5933', btn: '#5c3d5f', 'btn-h': '#704b74', 'call-bg': '#120a13',
  } },
  creme: { name: 'Café', vars: {
    'bg-rail': '#111010', 'bg-side': '#1a1817', 'bg-main': '#211e1c', 'bg-panel': '#161413', 'bg-input': '#2c2826', 'bg-float': '#0c0b0a',
    hover: '#28241f', active: '#352f29', line: '#383128', line2: '#221f1c', line3: '#171513', 'msg-hover': '#262220', scroll: '#383128',
    text: '#eadfcf', 'text-hi': '#fff8ec', muted: '#ab9d8a', muted2: '#948674', icon: '#cdbfa9', link: '#f0b86b',
    blurple: '#d4943c', 'blurple-h': '#b67a26', 'accent-soft': '#d4943c33', btn: '#4a4035', 'btn-h': '#5c5042', 'call-bg': '#080707',
  } },
};

window.applyTheme = function (key) {
  const t = window.THEMES[key] || window.THEMES.discord;
  const vars = { ...BASE, ...t.vars };
  const root = document.documentElement;
  for (const [k, v] of Object.entries(vars)) root.style.setProperty('--' + k, v);
  root.classList.toggle('light', !!t.light);
  return vars;
};
window.themePreview = (key) => ({ ...BASE, ...(window.THEMES[key] || {}).vars });
