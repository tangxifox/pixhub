import express from 'express';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';

// ================= 基础 =================
const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ================= 读取配置 =================
function loadConfig() {
  const configPath = path.resolve(__dirname, '../data/config.conf');

  const text = fsSync.readFileSync(configPath, 'utf-8');

  const cfg = {};
  text.split('\n').forEach(line => {
    line = line.trim();
    if (!line || line.startsWith('#')) return;

    const [k, v] = line.split('=');
    cfg[k.trim()] = v.trim();
  });

  return cfg;
}

const CONFIG = loadConfig();

const HOST = CONFIG.host || '0.0.0.0';
const PORT = Number(CONFIG.port || 3000);

// 统一资源目录
const RES_ROOT = path.resolve(__dirname, '..', CONFIG.resources || './resources');
const PIXIV_ROOT = path.join(RES_ROOT, 'pixiv');
const PLUS_ROOT = path.join(RES_ROOT, 'plus');

// DB
const DB_PATH = path.resolve(__dirname, '..', CONFIG.cache || './data/cache.db');

// 防盗链
const ALLOW_EMPTY_REFERER = CONFIG.allow_empty_referer === 'true';
const ALLOWED_REFERERS = (CONFIG.referers || '').split(',');

// ================= DB =================
const db = new Database(DB_PATH);

db.exec(`
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  type TEXT,
  dir TEXT,
  filename TEXT,
  authorName TEXT,
  authorId TEXT,
  title TEXT,
  UNIQUE(type, dir, filename)
)
`);

db.pragma('journal_mode = WAL');
db.pragma('synchronous = OFF');
db.pragma('cache_size = 1000000');

// ================= 工具 =================
const apiResponse = (res, data, code = 200) => res.status(code).json(data);

const getHost = (req) => `${req.protocol}://${req.get('host')}`;

function checkReferer(req) {
  const ref = req.headers.referer;
  if (!ref) return ALLOW_EMPTY_REFERER;
  return ALLOWED_REFERERS.some(r => ref.startsWith(r));
}

// ================= 解析 =================
function parsePixiv(file) {
  const match =
    file.match(/^(?<base>.+)_(?<pid>\d+)_(?<page>p\d+)/i) ||
    file.match(/^(?<base>.+)_(?<pid>\d+)/i);

  return match?.groups || null;
}

function parseVideo(file) {
  const parts = path.basename(file, path.extname(file)).split('_');
  if (parts.length < 3) return null;

  return {
    authorName: parts[0],
    authorId: parts[1],
    title: parts.slice(2).join('_')
  };
}

// ================= 初始化缓存 =================
async function initCache() {
  const count = db.prepare(`SELECT COUNT(*) as c FROM files`).get().c;
  if (count > 0) {
    console.log('✅ 使用缓存');
    return;
  }

  console.log('⚡ 初始化缓存...');

  const insert = db.prepare(`
    INSERT OR IGNORE INTO files
    (type, dir, filename, authorName, authorId, title)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction(rows => {
    for (const r of rows) {
      insert.run(r.type, r.dir, r.filename, r.authorName, r.authorId, r.title);
    }
  });

  let rows = [];

  async function scan(root, type) {
    if (!fsSync.existsSync(root)) return;

    const dirs = await fs.readdir(root, { withFileTypes: true });

    for (const d of dirs) {
      if (!d.isDirectory() || !/^\d+$/.test(d.name)) continue;

      const files = await fs.readdir(path.join(root, d.name));

      for (const f of files) {
        if (type === 'pixiv' && !/\.(jpg|png|jpeg)$/i.test(f)) continue;
        if (type === 'plus' && !/\.mp4$/i.test(f)) continue;

        const parsed = type === 'plus' ? parseVideo(f) : null;

        rows.push({
          type,
          dir: d.name,
          filename: f,
          ...(parsed || {})
        });
      }
    }
  }

  await scan(PIXIV_ROOT, 'pixiv');
  await scan(PLUS_ROOT, 'plus');

  insertMany(rows);

  console.log(`✅ 缓存 ${rows.length} 条`);
}

// ================= 监听 =================
function watchFolder(root, type) {
  if (!fsSync.existsSync(root)) return;

  fsSync.watch(root, { recursive: true }, (_, filename) => {
    if (!filename) return;

    const parts = filename.split(path.sep);
    if (parts.length < 2) return;

    const [dir, file] = parts;
    if (!/^\d+$/.test(dir)) return;

    const full = path.join(root, dir, file);

    // 删除
    if (!fsSync.existsSync(full)) {
      db.prepare(`DELETE FROM files WHERE type=? AND dir=? AND filename=?`)
        .run(type, dir, file);
      return;
    }

    // 类型过滤
    if (type === 'pixiv' && !/\.(jpg|png|jpeg)$/i.test(file)) return;
    if (type === 'plus' && !/\.mp4$/i.test(file)) return;

    const parsed = type === 'plus' ? parseVideo(file) : null;

    db.prepare(`
      INSERT OR IGNORE INTO files
      (type, dir, filename, authorName, authorId, title)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(type, dir, file,
      parsed?.authorName,
      parsed?.authorId,
      parsed?.title
    );
  });
}

// ================= API =================

// pixiv random
app.get('/pixiv/artworks/random', (req, res) => {
  const row = db.prepare(`
    SELECT * FROM files WHERE type='pixiv'
    ORDER BY RANDOM() LIMIT 1
  `).get();

  if (!row) return apiResponse(res, { error: true }, 404);

  const parsed = parsePixiv(row.filename);
  if (!parsed) return apiResponse(res, { error: true }, 400);

  const prefix = `${parsed.base}_${parsed.pid}`;

  let pages = db.prepare(`
    SELECT filename FROM files
    WHERE type='pixiv' AND dir=? AND filename LIKE ?
  `).all(row.dir, `${prefix}%`);

  pages.sort((a, b) => {
    const pa = a.filename.match(/_p(\d+)/)?.[1] || 0;
    const pb = b.filename.match(/_p(\d+)/)?.[1] || 0;
    return Number(pa) - Number(pb);
  });

  const host = getHost(req);

  apiResponse(res, {
    error: false,
    message: 'success',
    body: {
      illustId: parsed.pid,
      title: parsed.base,
      pageCount: pages.length,
      urls: pages.map(p =>
        `${host}/pixiv/artworks/file/${encodeURIComponent(p.filename)}`
      )
    }
  });
});

// ================= 文件接口（带防盗链） =================

// pixiv
app.get('/pixiv/artworks/file/:filename', (req, res) => {
  if (!checkReferer(req)) {
    return res.status(403).json({ error: true, message: 'forbidden' });
  }

  const filename = decodeURIComponent(req.params.filename);

  const row = db.prepare(`
    SELECT dir FROM files WHERE type='pixiv' AND filename=?
  `).get(filename);

  if (!row) return apiResponse(res, { error: true }, 404);

  res.sendFile(path.join(PIXIV_ROOT, row.dir, filename));
});

// plus
app.get('/plus/artworks/file/:filename', (req, res) => {
  if (!checkReferer(req)) {
    return res.status(403).json({ error: true, message: 'forbidden' });
  }

  const filename = decodeURIComponent(req.params.filename);

  const row = db.prepare(`
    SELECT dir FROM files WHERE type='plus' AND filename=?
  `).get(filename);

  if (!row) return apiResponse(res, { error: true }, 404);

  const filePath = path.join(PLUS_ROOT, row.dir, filename);

  const stat = fsSync.statSync(filePath);
  const range = req.headers.range;

  if (range) {
    const [start, end] = range.replace(/bytes=/, "").split("-");
    const s = parseInt(start);
    const e = end ? parseInt(end) : stat.size - 1;

    res.writeHead(206, {
      'Content-Range': `bytes ${s}-${e}/${stat.size}`,
      'Content-Length': e - s + 1,
      'Content-Type': 'video/mp4'
    });

    fsSync.createReadStream(filePath, { start: s, end: e }).pipe(res);
  } else {
    res.sendFile(filePath);
  }
});

// ================= 启动 =================
app.listen(PORT, async () => {
  await initCache();
  watchFolder(PIXIV_ROOT, 'pixiv');
  watchFolder(PLUS_ROOT, 'plus');

  console.log(`🚀 http://${HOST}:${PORT}`);
});