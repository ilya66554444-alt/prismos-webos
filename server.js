/* ============================================================
   PrismOS Server v3.2
   - REST API (аккаунты, файлы, настройки)
   - WebSocket (команды от админа)
   - HTTP-прокси (обход X-Frame-Options + перезапись CSS/JS)
   - Хранение: Postgres (Render) или файлы (локально)
   ============================================================ */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { URL } = require('url');
const { WebSocketServer } = require('ws');

/* ============================================================
   CONFIG
   ============================================================ */
const PORT = process.env.PORT || 3000;
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';
const DATABASE_URL = process.env.DATABASE_URL || '';
const USE_PG = !!DATABASE_URL;
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

console.log('[BOOT] Storage:', USE_PG ? 'Postgres' : 'files');

/* ============================================================
   POSTGRES STORAGE
   ============================================================ */
let pgPool = null;

async function initPg(){
  const { Pool } = require('pg');
  pgPool = new Pool({
    connectionString: DATABASE_URL,
    ssl: (DATABASE_URL.indexOf('localhost') >= 0 || DATABASE_URL.indexOf('127.0.0.1') >= 0)
      ? false
      : { rejectUnauthorized: false }
  });
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS users (
      login TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      created_at BIGINT NOT NULL
    );
  `);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS tokens (
      token TEXT PRIMARY KEY,
      login TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );
  `);
  await pgPool.query(`CREATE INDEX IF NOT EXISTS tokens_login_idx ON tokens(login);`);
  console.log('[PG] tables ready');
}

async function pgGetUser(login){
  try {
    const r = await pgPool.query('SELECT data FROM users WHERE login = $1', [login]);
    return r.rows[0] ? r.rows[0].data : null;
  } catch(e){ console.error('[pgGetUser]', e.message); return null; }
}
async function pgSaveUser(login, data){
  try {
    await pgPool.query(
      `INSERT INTO users (login, data, created_at) VALUES ($1, $2, $3)
       ON CONFLICT (login) DO UPDATE SET data = EXCLUDED.data`,
      [login, data, data.created || Date.now()]
    );
    return true;
  } catch(e){ console.error('[pgSaveUser]', e.message); return false; }
}
async function pgDeleteUser(login){
  try {
    await pgPool.query('DELETE FROM users WHERE login = $1', [login]);
    await pgPool.query('DELETE FROM tokens WHERE login = $1', [login]);
    return true;
  } catch(e){ return false; }
}
async function pgAllUsers(){
  try {
    const r = await pgPool.query('SELECT data FROM users ORDER BY created_at DESC');
    return r.rows.map(function(row){ return row.data; });
  } catch(e){ console.error('[pgAllUsers]', e.message); return []; }
}
async function pgSaveToken(token, login){
  try {
    await pgPool.query(
      'INSERT INTO tokens (token, login, created_at) VALUES ($1, $2, $3)',
      [token, login, Date.now()]
    );
    return true;
  } catch(e){ return false; }
}
async function pgGetToken(token){
  try {
    const r = await pgPool.query('SELECT login FROM tokens WHERE token = $1', [token]);
    return r.rows[0] ? r.rows[0].login : null;
  } catch(e){ return null; }
}
async function pgDeleteToken(token){
  try { await pgPool.query('DELETE FROM tokens WHERE token = $1', [token]); return true; }
  catch(e){ return false; }
}

/* ============================================================
   FILES STORAGE (fallback)
   ============================================================ */
let usersFS = {};
let tokensFS = {};
let saveTimer = null;

function loadUsersFS(){
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(USERS_FILE)) usersFS = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch(e){ console.error('[loadFS]', e.message); usersFS = {}; }
}
function saveUsersFS(){
  clearTimeout(saveTimer);
  saveTimer = setTimeout(function(){
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(USERS_FILE, JSON.stringify(usersFS, null, 2));
    } catch(e){ console.error('[saveFS]', e.message); }
  }, 400);
}

/* ============================================================
   STORAGE INTERFACE
   ============================================================ */
const Storage = {
  async getUser(login){
    if (USE_PG) return await pgGetUser(login);
    return usersFS[login] || null;
  },
  async saveUser(login, data){
    if (USE_PG) return await pgSaveUser(login, data);
    usersFS[login] = data;
    saveUsersFS();
    return true;
  },
  async deleteUser(login){
    if (USE_PG) return await pgDeleteUser(login);
    delete usersFS[login];
    saveUsersFS();
    return true;
  },
  async allUsers(){
    if (USE_PG) return await pgAllUsers();
    var arr = [];
    for (var k in usersFS) if (usersFS.hasOwnProperty(k)) arr.push(usersFS[k]);
    return arr;
  },
  async saveToken(token, login){
    if (USE_PG) return await pgSaveToken(token, login);
    tokensFS[token] = { login: login, createdAt: Date.now() };
    return true;
  },
  async getTokenLogin(token){
    if (USE_PG) return await pgGetToken(token);
    return tokensFS[token] ? tokensFS[token].login : null;
  },
  async deleteToken(token){
    if (USE_PG) return await pgDeleteToken(token);
    delete tokensFS[token];
    return true;
  }
};

/* ============================================================
   HELPERS
   ============================================================ */
function hash(s){ return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function newToken(){ return crypto.randomBytes(24).toString('hex'); }

function newFS(){
  var now = Date.now();
  function file(c){ c = c || ''; return { type:'file', content:c, created:now, modified:now, size:c.length }; }
  function folder(ch){ return { type:'folder', children: ch || {}, created:now, modified:now }; }
  return folder({
    'Рабочий стол': folder({}),
    'Документы': folder({
      'welcome.txt': file('Добро пожаловать в PrismOS 3.0!\n\nВсё хранится на сервере.'),
      'todo.txt': file('Задачи:\n[x] Зайти в PrismOS\n[ ] Осмотреться')
    }),
    'Изображения': folder({}),
    'Загрузки': folder({}),
    'Проекты': folder({})
  });
}
function newUser(login, pass, display, avatar, wallpaper, accent, theme){
  return {
    name: login,
    display: display || login,
    avatar: avatar || '👤',
    pass: hash(pass),
    created: Date.now(),
    settings: {
      wallpaper: wallpaper == null ? 0 : wallpaper,
      accent: accent || '#7c6cf5',
      theme: theme || 'dark',
      sound: true, animations: true, blur: true,
      clock24: true, seconds: false,
      recent: [], desktopIcons: {}, stickyNotes: [], todos: [],
      customWallpaper: null
    },
    fs: newFS()
  };
}

function readBody(req, max){
  max = max || 8 * 1024 * 1024;
  return new Promise(function(resolve){
    var d = '';
    var killed = false;
    req.on('data', function(c){
      d += c;
      if (d.length > max){ killed = true; req.destroy(); }
    });
    req.on('end', function(){
      if (killed) return resolve(null);
      try { resolve(d ? JSON.parse(d) : {}); }
      catch(e){ resolve(null); }
    });
    req.on('error', function(){ resolve(null); });
  });
}
function send(res, code, obj){
  res.writeHead(code, {
    'Content-Type':'application/json; charset=utf-8',
    'Access-Control-Allow-Origin':'*',
    'Access-Control-Allow-Headers':'Content-Type,Authorization',
    'Access-Control-Allow-Methods':'GET,POST,OPTIONS'
  });
  res.end(JSON.stringify(obj));
}
function sendFile(res, fp){
  fs.readFile(fp, function(err, data){
    if (err){ res.writeHead(404); res.end('Not found'); return; }
    var ext = path.extname(fp).toLowerCase();
    var mime = {
      '.html':'text/html; charset=utf-8', '.js':'application/javascript; charset=utf-8',
      '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8',
      '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif',
      '.svg':'image/svg+xml', '.ico':'image/x-icon', '.woff':'font/woff', '.woff2':'font/woff2'
    }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

/* ============================================================
   AUTH
   ============================================================ */
async function getUserFromReq(req){
  var h = req.headers['authorization'] || '';
  var m = h.match(/^Bearer (.+)$/);
  if (!m) return null;
  var login = await Storage.getTokenLogin(m[1]);
  if (!login) return null;
  return await Storage.getUser(login);
}

/* ============================================================
   FS операций
   ============================================================ */
function fsParse(p){
  if (Array.isArray(p)) return p.filter(Boolean);
  return String(p || '/').split('/').filter(Boolean);
}
function fsGetParent(user, path){
  var parts = fsParse(path);
  var name = parts.pop();
  var n = user.fs;
  for (var i = 0; i < parts.length; i++){
    if (!n.children || !n.children[parts[i]]) return null;
    n = n.children[parts[i]];
  }
  return { parent: n, name: name };
}
function fsWrite(user, path, content){
  var info = fsGetParent(user, path);
  if (!info) return false;
  info.parent.children[info.name] = {
    type:'file', content:content,
    created:Date.now(), modified:Date.now(),
    size:(content || '').length
  };
  return true;
}
function fsMkdir(user, path){
  var info = fsGetParent(user, path);
  if (!info) return false;
  info.parent.children[info.name] = { type:'folder', children:{}, created:Date.now(), modified:Date.now() };
  return true;
}
function fsRemove(user, path){
  var info = fsGetParent(user, path);
  if (!info) return false;
  delete info.parent.children[info.name];
  return true;
}
function fsRename(user, path, newName){
  var info = fsGetParent(user, path);
  if (!info || !info.parent.children[info.name]) return false;
  if (info.parent.children[newName]) return false;
  var node = info.parent.children[info.name];
  delete info.parent.children[info.name];
  info.parent.children[newName] = node;
  node.modified = Date.now();
  return true;
}

/* ============================================================
   PROXY
   ============================================================ */
const PROXY_PATH = '/__proxy__';

const DROP = new Set([
  'x-frame-options','content-security-policy','content-security-policy-report-only',
  'transfer-encoding','connection','keep-alive','content-encoding',
  'strict-transport-security','content-length','set-cookie','cookie',
  'content-disposition','x-content-type-options',
  'cross-origin-resource-policy','cross-origin-embedder-policy',
  'cross-origin-opener-policy','permissions-policy',
  'report-to','nel','origin-trial','expect-ct','alt-svc'
]);

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });

function fetchTarget(targetUrl, method, reqHeaders, depth){
  return new Promise(function(resolve, reject){
    if (depth > 8) return reject(new Error('Too many redirects'));
    var u;
    try { u = new URL(targetUrl); } catch(e){ return reject(e); }
    var isHttps = u.protocol === 'https:';
    var lib = isHttps ? https : http;
    var req = lib.request({
      method: method || 'GET',
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      agent: isHttps ? httpsAgent : httpAgent,
      headers: {
        'User-Agent': reqHeaders['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': reqHeaders['accept'] || 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'max-age=300',
        'Referer': u.origin + '/'
      }
    }, function(res){
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location){
        try {
          var next = new URL(res.headers.location, targetUrl).href;
          return resolve(fetchTarget(next, 'GET', reqHeaders, depth + 1));
        } catch(e){ return reject(e); }
      }
      var stream = res;
      var enc = (res.headers['content-encoding'] || '').toLowerCase();
      if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());

      var chunks = [];
      stream.on('data', function(c){ chunks.push(c); });
      stream.on('end', function(){
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
      });
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(25000, function(){ req.destroy(new Error('Timeout')); });
    req.end();
  });
}

function rewriteProxyHtml(html, base){
  function proxify(u){
    if (!u || u.indexOf('data:') === 0 || u.indexOf('javascript:') === 0 ||
        u.indexOf('#') === 0 || u.indexOf('mailto:') === 0 || u.indexOf('tel:') === 0 ||
        u.indexOf('blob:') === 0) return u;
    try { return PROXY_PATH + '?url=' + encodeURIComponent(new URL(u, base).href); }
    catch(e){ return u; }
  }

  // Удаляем meta-CSP
  html = html.replace(/<meta\b[^>]*http-equiv\s*=\s*["']Content-Security-Policy["'][^>]*>/gi, '');

  // Убираем integrity / crossorigin
  html = html.replace(/\bintegrity\s*=\s*["'][^"']*["']/gi, '');
  html = html.replace(/\bcrossorigin\s*=\s*["'][^"']*["']/gi, '');

  // preload as=style → stylesheet
  html = html.replace(/<link\b([^>]*?)\/?>/gi, function(m, attrs){
    if (/\brel\s*=\s*["']preload["']/i.test(attrs) && /\bas\s*=\s*["']style["']/i.test(attrs)){
      var na = attrs
        .replace(/\brel\s*=\s*["']preload["']/i, 'rel="stylesheet"')
        .replace(/\bonload\s*=\s*["'][^"']*["']/i, '')
        .replace(/\bas\s*=\s*["']style["']/i, '');
      return '<link' + na + '>';
    }
    return m;
  });

  // Переписываем URL в атрибутах
  html = html.replace(/\b(href|src|action|poster)=(["'])([^"']*?)\2/gi, function(m, a, q, u){
    return a + '=' + q + proxify(u) + q;
  });

  // srcset
  html = html.replace(/\bsrcset=(["'])([^"']*?)\1/gi, function(m, q, set){
    var fixed = set.split(',').map(function(item){
      var parts = item.trim().split(/\s+/);
      parts[0] = proxify(parts[0]);
      return parts.join(' ');
    }).join(', ');
    return 'srcset=' + q + fixed + q;
  });

  var inject = '<base href="' + base + '"><script>(function(){' +
    'var P="' + PROXY_PATH + '";' +
    'function px(u){if(!u||u.indexOf("data:")===0||u.indexOf("javascript:")===0||u.indexOf("#")===0)return u;' +
    'try{return P+"?url="+encodeURIComponent(new URL(u,document.baseURI).href);}catch(e){return u;}}' +
    'document.addEventListener("click",function(e){' +
    'var a=e.target.closest&&e.target.closest("a[href]");' +
    'if(a&&a.href&&a.href.indexOf("javascript:")!==0&&a.getAttribute("href").indexOf("#")!==0){' +
    'e.preventDefault();location.href=px(a.href);}},true);' +
    'var ps=history.pushState;history.pushState=function(s,t,u){return ps.call(this,s,t,u?px(u):u)};' +
    'var rs=history.replaceState;history.replaceState=function(s,t,u){return rs.call(this,s,t,u?px(u):u)};' +
    '})();<\/script>';

  if (/<head([^>]*)>/i.test(html)) return html.replace(/<head([^>]*)>/i, '<head$1>' + inject);
  return inject + html;
}

function rewriteProxyCss(css, base){
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, function(m, q, u){
    if (!u) return m;
    if (u.indexOf('data:') === 0) return m;
    if (u.indexOf(PROXY_PATH) === 0) return m;
    try {
      var abs = new URL(u, base).href;
      return 'url(' + q + PROXY_PATH + '?url=' + encodeURIComponent(abs) + q + ')';
    } catch(e){ return m; }
  });
}

/* ============================================================
   HTTP SERVER
   ============================================================ */
const server = http.createServer(async function(req, res){
  var url;
  try { url = new URL(req.url, 'http://x'); }
  catch(e){ res.writeHead(400); return res.end('Bad URL'); }
  var p = url.pathname;
  var method = req.method;

  if (method === 'OPTIONS'){
    res.writeHead(204, {
      'Access-Control-Allow-Origin':'*',
      'Access-Control-Allow-Methods':'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers':'Content-Type,Authorization'
    });
    return res.end();
  }

  try {

    /* === HEALTH === */
    if (p === '/api/health'){
      return send(res, 200, { ok:true, time:Date.now(), storage: USE_PG ? 'postgres' : 'files' });
    }

    /* === REGISTER === */
    if (p === '/api/register' && method === 'POST'){
      var b = await readBody(req);
      if (!b) return send(res, 400, { error:'Неверный запрос' });
      var login = String(b.login || '').toLowerCase().trim();
      if (!/^[a-z0-9_-]{3,24}$/.test(login)) return send(res, 400, { error:'Логин: 3-24 симв., латиница/цифры/_/-' });
      if (!b.pass || b.pass.length < 4) return send(res, 400, { error:'Пароль минимум 4 символа' });
      var exist = await Storage.getUser(login);
      if (exist) return send(res, 409, { error:'Логин занят' });
      var newU = newUser(login, b.pass, b.display, b.avatar, b.wallpaper, b.accent, b.theme);
      await Storage.saveUser(login, newU);
      var token = newToken();
      await Storage.saveToken(token, login);
      return send(res, 200, { token: token, user: newU });
    }

    /* === LOGIN === */
    if (p === '/api/login' && method === 'POST'){
      var b2 = await readBody(req);
      if (!b2) return send(res, 400, { error:'Неверный запрос' });
      var login2 = String(b2.login || '').toLowerCase().trim();
      var u = await Storage.getUser(login2);
      if (!u) return send(res, 404, { error:'Пользователь не найден' });
      if (u.pass !== hash(b2.pass || '')) return send(res, 401, { error:'Неверный пароль' });
      var t2 = newToken();
      await Storage.saveToken(t2, login2);
      return send(res, 200, { token: t2, user: u });
    }

    /* === ME === */
    if (p === '/api/me' && method === 'GET'){
      var u2 = await getUserFromReq(req);
      if (!u2) return send(res, 401, { error:'Не авторизован' });
      return send(res, 200, { user: u2 });
    }

    /* === PROFILE === */
    if (p === '/api/user/profile' && method === 'POST'){
      var u3 = await getUserFromReq(req);
      if (!u3) return send(res, 401, { error:'Не авторизован' });
      var b3 = await readBody(req);
      if (!b3) return send(res, 400, { error:'Неверный запрос' });
      if (typeof b3.display === 'string') u3.display = b3.display.slice(0, 40);
      if (typeof b3.avatar === 'string') u3.avatar = b3.avatar.slice(0, 8);
      await Storage.saveUser(u3.name, u3);
      return send(res, 200, { user: u3 });
    }

    /* === SETTINGS === */
    if (p === '/api/user/settings' && method === 'POST'){
      var u4 = await getUserFromReq(req);
      if (!u4) return send(res, 401, { error:'Не авторизован' });
      var b4 = await readBody(req);
      if (!b4) return send(res, 400, { error:'Неверный запрос' });
      for (var k in b4){
        if (b4.hasOwnProperty(k)) u4.settings[k] = b4[k];
      }
      await Storage.saveUser(u4.name, u4);
      return send(res, 200, { settings: u4.settings });
    }

    /* === PASSWORD === */
    if (p === '/api/user/password' && method === 'POST'){
      var u5 = await getUserFromReq(req);
      if (!u5) return send(res, 401, { error:'Не авторизован' });
      var b5 = await readBody(req);
      if (!b5) return send(res, 400, { error:'Неверный запрос' });
      if (b5.oldPass && hash(b5.oldPass) !== u5.pass){
        return send(res, 401, { error:'Неверный текущий пароль' });
      }
      if (!b5.pass || b5.pass.length < 4) return send(res, 400, { error:'Пароль минимум 4 символа' });
      u5.pass = hash(b5.pass);
      await Storage.saveUser(u5.name, u5);
      return send(res, 200, { ok:true });
    }

    /* === FS === */
    if (p === '/api/user/fs/write' && method === 'POST'){
      var u6 = await getUserFromReq(req);
      if (!u6) return send(res, 401, { error:'Не авторизован' });
      var b6 = await readBody(req);
      if (!b6 || !b6.path) return send(res, 400, { error:'Неверный запрос' });
      if (!fsWrite(u6, b6.path, b6.content || '')) return send(res, 400, { error:'Путь не найден' });
      await Storage.saveUser(u6.name, u6);
      return send(res, 200, { fs: u6.fs });
    }
    if (p === '/api/user/fs/mkdir' && method === 'POST'){
      var u7 = await getUserFromReq(req);
      if (!u7) return send(res, 401, { error:'Не авторизован' });
      var b7 = await readBody(req);
      if (!b7 || !b7.path) return send(res, 400, { error:'Неверный запрос' });
      if (!fsMkdir(u7, b7.path)) return send(res, 400, { error:'Не удалось создать' });
      await Storage.saveUser(u7.name, u7);
      return send(res, 200, { fs: u7.fs });
    }
    if (p === '/api/user/fs/remove' && method === 'POST'){
      var u8 = await getUserFromReq(req);
      if (!u8) return send(res, 401, { error:'Не авторизован' });
      var b8 = await readBody(req);
      if (!b8 || !b8.path) return send(res, 400, { error:'Неверный запрос' });
      if (!fsRemove(u8, b8.path)) return send(res, 400, { error:'Не удалось удалить' });
      await Storage.saveUser(u8.name, u8);
      return send(res, 200, { fs: u8.fs });
    }
    if (p === '/api/user/fs/rename' && method === 'POST'){
      var u9 = await getUserFromReq(req);
      if (!u9) return send(res, 401, { error:'Не авторизован' });
      var b9 = await readBody(req);
      if (!b9 || !b9.path || !b9.newName) return send(res, 400, { error:'Неверный запрос' });
      if (!fsRename(u9, b9.path, b9.newName)) return send(res, 400, { error:'Не удалось переименовать' });
      await Storage.saveUser(u9.name, u9);
      return send(res, 200, { fs: u9.fs });
    }

    /* === ADMIN === */
    if (p.indexOf('/api/admin/') === 0){
      var ba = await readBody(req);
      if (!ba || ba.pass !== ADMIN_PASS) return send(res, 401, { error:'Неверный пароль админа' });

      if (p === '/api/admin/users'){
        var all = await Storage.allUsers();
        var list = all.map(function(u){
          return {
            name: u.name, display: u.display, avatar: u.avatar,
            created: u.created, settings: u.settings,
            fsSize: JSON.stringify(u.fs || {}).length
          };
        });
        return send(res, 200, { users: list });
      }
      if (p === '/api/admin/user'){
        var uu = await Storage.getUser(ba.login);
        if (!uu) return send(res, 404, { error:'Не найден' });
        return send(res, 200, { user: uu });
      }
      if (p === '/api/admin/user/save'){
        if (!ba.user || !ba.login) return send(res, 400, { error:'Неверные данные' });
        await Storage.saveUser(ba.login, ba.user);
        return send(res, 200, { ok:true });
      }
      if (p === '/api/admin/user/delete'){
        await Storage.deleteUser(ba.login);
        return send(res, 200, { ok:true });
      }
      if (p === '/api/admin/send'){
        broadcastToUser(ba.login, ba.message);
        return send(res, 200, { ok:true });
      }
      return send(res, 404, { error:'Не найдено' });
    }

    /* === PROXY === */
    if (p === PROXY_PATH){
      var target = url.searchParams.get('url');
      if (!target){ res.writeHead(400); return res.end('Missing url'); }
      try {
        var upstream = await fetchTarget(target, method, req.headers, 0);
        var outHeaders = {};
        for (var hk in upstream.headers){
          if (!DROP.has(hk.toLowerCase())) outHeaders[hk] = upstream.headers[hk];
        }
        outHeaders['access-control-allow-origin'] = '*';
        var ct = upstream.headers['content-type'] || '';

        if (ct.indexOf('text/html') >= 0){
          outHeaders['content-type'] = 'text/html; charset=utf-8';
          delete outHeaders['content-length'];
          res.writeHead(upstream.status, outHeaders);
          res.end(rewriteProxyHtml(upstream.body.toString('utf8'), target));
        } else if (ct.indexOf('text/css') >= 0){
          outHeaders['content-type'] = 'text/css; charset=utf-8';
          delete outHeaders['content-length'];
          res.writeHead(upstream.status, outHeaders);
          res.end(rewriteProxyCss(upstream.body.toString('utf8'), target));
        } else {
          res.writeHead(upstream.status, outHeaders);
          res.end(upstream.body);
        }
      } catch(e){
        res.writeHead(502, { 'Content-Type':'text/plain; charset=utf-8' });
        res.end('Proxy error: ' + e.message);
      }
      return;
    }

    /* === STATIC === */
    var filePath = p === '/' ? '/index.html' : p;
    var fp = path.join(PUBLIC_DIR, filePath);
    if (fp.indexOf(PUBLIC_DIR) !== 0){ res.writeHead(403); return res.end('Forbidden'); }
    if (fs.existsSync(fp) && fs.statSync(fp).isFile()) return sendFile(res, fp);
    if (p.indexOf('.') === -1) return sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
    res.writeHead(404); res.end('Not found');

  } catch(e){
    console.error('[REQ]', p, e && e.message);
    send(res, 500, { error: 'Internal error: ' + (e && e.message) });
  }
});

/* ============================================================
   WEBSOCKET
   ============================================================ */
const wss = new WebSocketServer({ noServer: true });
var userSockets = {};
var socketUser = new WeakMap();
var adminSockets = new Set();

function broadcastToUser(login, msg){
  var set = userSockets[login];
  if (!set) return;
  var data = JSON.stringify(msg);
  set.forEach(function(ws){
    if (ws.readyState === 1){ try { ws.send(data); } catch(e){} }
  });
}
function broadcastToAdmins(msg){
  var data = JSON.stringify(msg);
  adminSockets.forEach(function(ws){
    if (ws.readyState === 1){ try { ws.send(data); } catch(e){} }
  });
}

server.on('upgrade', async function(req, socket, head){
  var url;
  try { url = new URL(req.url, 'http://x'); } catch(e){ socket.destroy(); return; }
  if (url.pathname !== '/ws'){ socket.destroy(); return; }
  var token = url.searchParams.get('token') || '';
  var isAdmin = url.searchParams.get('admin') === '1';
  var login = null;

  if (isAdmin){
    if (token !== ADMIN_PASS){ socket.destroy(); return; }
  } else {
    var l = await Storage.getTokenLogin(token);
    if (!l){ socket.destroy(); return; }
    login = l;
  }

  wss.handleUpgrade(req, socket, head, function(ws){
    wss.emit('connection', ws, req, { login: login, isAdmin: isAdmin });
  });
});

wss.on('connection', function(ws, req, meta){
  if (meta.isAdmin){
    adminSockets.add(ws);
    ws.on('close', function(){ adminSockets.delete(ws); });
    ws.on('message', function(raw){
      var m;
      try { m = JSON.parse(raw); } catch(e){ return; }
      if (!m || !m.type) return;
      if (m.user) broadcastToUser(m.user, m);
    });
    try { ws.send(JSON.stringify({ type:'admin-ready' })); } catch(e){}
    return;
  }

  var login = meta.login;
  if (!userSockets[login]) userSockets[login] = new Set();
  userSockets[login].add(ws);
  socketUser.set(ws, login);

  ws.on('message', function(raw){
    var m;
    try { m = JSON.parse(raw); } catch(e){ return; }
    if (m && (m.type === 'state' || m.type === 'hello' || m.type === 'bye')){
      m.user = login;
      broadcastToAdmins(m);
    }
  });

  ws.on('close', function(){
    var set = userSockets[login];
    if (set){ set.delete(ws); if (!set.size) delete userSockets[login]; }
    broadcastToAdmins({ type:'user-offline', user: login });
  });

  broadcastToAdmins({ type:'user-online', user: login });
});

/* ============================================================
   START
   ============================================================ */
async function start(){
  try {
    if (USE_PG){
      await initPg();
    } else {
      loadUsersFS();
      console.log('[FS] users loaded:', Object.keys(usersFS).length);
    }
  } catch(e){
    console.error('[BOOT] storage init failed:', e.message);
    console.error('Fallback to files...');
  }

  server.listen(PORT, function(){
    console.log('');
    console.log('  ╔══════════════════════════════════════════╗');
    console.log('  ║       PrismOS Server v3.2                ║');
    console.log('  ║       Порт: ' + String(PORT).padEnd(29) + '║');
    console.log('  ║       Storage: ' + (USE_PG ? 'Postgres' : 'files').padEnd(24) + '║');
    console.log('  ╚══════════════════════════════════════════╝');
    console.log('');
  });
}

process.on('unhandledRejection', function(e){
  console.error('[Unhandled]', e && e.message ? e.message : e);
});
process.on('uncaughtException', function(e){
  console.error('[Uncaught]', e && e.message ? e.message : e);
});

start();
