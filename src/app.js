import express from 'express';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';

// ================= 基础 =================
const app = express();
app.set('trust proxy', true);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.set('json spaces', 2);

// ================= 读取配置 =================
function loadConfig() {
  const configPath = path.resolve(__dirname, '../data/config.conf');
  try {
    const text = fsSync.readFileSync(configPath, 'utf-8');
    const cfg = {};
    
    text.split('\n').forEach(line => {
      line = line.trim();
      if (!line || line.startsWith('#')) return;
      const [k, v] = line.split('=');
      if (k && v) cfg[k.trim()] = v.trim();
    });
    
    return cfg;
  } catch (error) {
    console.error('加载配置文件失败:', error.message);
    return {};
  }
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
const ALLOWED_REFERERS = (CONFIG.referers || '').split(',').filter(Boolean);

// ================= 错误处理 =================
class AppError extends Error {
  constructor(statusCode, errorCode, message, details = {}) {
    super(message);
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.details = details;
  }
}

function errorHandler(err, req, res, next) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      error: true,
      code: err.errorCode,
      message: err.message,
      details: err.details,
      timestamp: new Date().toISOString()
    });
  }
  
  console.error('服务器内部错误:', err);
  res.status(500).json({
    error: true,
    code: 'INTERNAL_SERVER_ERROR',
    message: '服务器内部错误',
    details: { error: err.message },
    timestamp: new Date().toISOString()
  });
}

// ================= 数据库 =================
let db;
try {
  db = new Database(DB_PATH);
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
} catch (error) {
  console.error('数据库初始化失败:', error.message);
  process.exit(1);
}

// ================= 工具函数 =================
function apiResponse(res, data) {
  return res.status(200).json({
    error: false,
    message: 'success',
    ...data
  });
}

function getHost(req) {
  let proto = req.headers['x-forwarded-proto'];
  if (proto) proto = proto.split(',')[0].trim();
  if (!proto) proto = req.secure ? 'https' : 'http';
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}`;
}

function checkReferer(req) {
  const ref = req.headers.referer;
  if (!ref) return ALLOW_EMPTY_REFERER;
  if (ALLOWED_REFERERS.length === 0) return true;
  return ALLOWED_REFERERS.some(r => ref.startsWith(r));
}

function getFilenameWithoutExt(filename) {
  return path.parse(filename).name;
}

function verifyResourceExists(filePath) {
  if (!fsSync.existsSync(filePath)) {
    throw new AppError(404, 'RESOURCE_NOT_FOUND', '请求的资源不存在', {
      filePath: path.relative(process.cwd(), filePath)
    });
  }
}

// ================= 会话管理 =================
// 存储最后一次随机选择的文件，确保视图和下载一致
const sessionStore = new Map();

function generateSessionId() {
  return Math.random().toString(36).substring(2, 15) + 
         Math.random().toString(36).substring(2, 15);
}

function getOrCreateSession(req) {
  let sessionId = req.cookies?.sessionId || req.query.sessionId || req.headers['x-session-id'];
  if (!sessionId || !sessionStore.has(sessionId)) {
    sessionId = generateSessionId();
    sessionStore.set(sessionId, {
      pixiv: null,
      plus: null,
      createdAt: Date.now(),
      lastAccessed: Date.now()
    });
  }
  
  const session = sessionStore.get(sessionId);
  session.lastAccessed = Date.now();
  
  // 清理过期会话（1小时）
  const oneHourAgo = Date.now() - 3600000;
  for (const [id, sess] of sessionStore.entries()) {
    if (sess.lastAccessed < oneHourAgo) {
      sessionStore.delete(id);
    }
  }
  
  return { sessionId, session };
}

function getRandomPixivFile() {
  return db.prepare(`
    SELECT * FROM files WHERE type='pixiv'
    ORDER BY RANDOM() LIMIT 1
  `).get();
}

function getRandomPlusFile() {
  return db.prepare(`
    SELECT * FROM files WHERE type='plus'
    ORDER BY RANDOM() LIMIT 1
  `).get();
}

// ================= 文件解析 =================
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

// ================= 文件服务 =================
function servePixivView(res, filePath, filename) {
  const ext = path.extname(filename).toLowerCase();
  const contentType = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png'
  }[ext] || 'image/jpeg';
  
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(getFilenameWithoutExt(filename))}"`);
  res.sendFile(filePath);
}

function serveVideoView(res, filePath, filename, range) {
  const stat = fsSync.statSync(filePath);
  
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(getFilenameWithoutExt(filename))}"`);
  
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
    
    if (isNaN(start) || start >= stat.size) {
      throw new AppError(416, 'RANGE_NOT_SATISFIABLE', '请求的Range不可满足', {
        range,
        fileSize: stat.size
      });
    }
    
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Content-Length': end - start + 1
    });
    
    fsSync.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': stat.size
    });
    fsSync.createReadStream(filePath).pipe(res);
  }
}

// ================= 缓存管理 =================
async function initCache() {
  try {
    const count = db.prepare(`SELECT COUNT(*) as c FROM files`).get().c;
    if (count > 0) {
      console.log('缓存已存在，跳过初始化');
      return;
    }
    
    console.log('初始化缓存...');
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
      if (!fsSync.existsSync(root)) {
        console.warn(`资源目录不存在: ${root}`);
        return;
      }
      
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
    
    if (rows.length > 0) {
      insertMany(rows);
      console.log(`缓存 ${rows.length} 条记录`);
    } else {
      console.warn('没有找到任何资源文件');
    }
  } catch (error) {
    console.error('缓存初始化失败:', error.message);
    throw error;
  }
}

function watchFolder(root, type) {
  if (!fsSync.existsSync(root)) {
    console.warn(`监听目录不存在: ${root}`);
    return;
  }
  
  fsSync.watch(root, { recursive: true }, (_, filename) => {
    if (!filename) return;
    const parts = filename.split(path.sep);
    if (parts.length < 2) return;
    
    const [dir, file] = parts;
    if (!/^\d+$/.test(dir)) return;
    const full = path.join(root, dir, file);
    
    try {
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
    } catch (error) {
      console.error(`文件监听错误 (${type}):`, error.message);
    }
  });
}

// ================= 中间件 =================
function validateReferer(req, res, next) {
  if (!checkReferer(req)) {
    throw new AppError(403, 'REFERER_FORBIDDEN', '访问被拒绝，请检查referer设置', {
      referer: req.headers.referer || '空',
      allowedReferers: ALLOWED_REFERERS,
      allowEmpty: ALLOW_EMPTY_REFERER
    });
  }
  next();
}

// ================= 首页 =================
app.get('/', (req, res) => {
  const host = getHost(req);
  const baseUrl = `${host}`;
  
  apiResponse(res, {
    data: {
      message: "API 接口调用方式",
      endpoints: {
        pixiv: {
          random: {
            url: `${baseUrl}/pixiv/artworks/random`,
            description: "随机获取一张pixiv图片信息"
          },
          info: {
            url: `${baseUrl}/pixiv/artworks/info?list={filename}`,
            description: "根据文件名查询pixiv图片信息"
          },
          view: {
            url: `${baseUrl}/pixiv/artworks/view`,
            description: "直接查看随机pixiv图片"
          },
          file: {
            url: `${baseUrl}/pixiv/artworks/file/{filename}`,
            description: "获取pixiv图片文件"
          }
        },
        plus: {
          random: {
            url: `${baseUrl}/plus/artworks/random`,
            description: "随机获取一个视频信息"
          },
          info: {
            url: `${baseUrl}/plus/artworks/info?list={authorName_or_authorId}`,
            description: "根据作者名或作者ID查询视频信息"
          },
          all: {
            url: `${baseUrl}/plus/artworks/info?list=all`,
            description: "获取所有作者列表"
          },
          view: {
            url: `${baseUrl}/plus/artworks/view`,
            description: "直接查看随机视频"
          },
          file: {
            url: `${baseUrl}/plus/artworks/file/{filename}`,
            description: "获取视频文件"
          }
        }
      }
    }
  });
});

// ================= Pixiv接口 =================
const pixivRouter = express.Router();

// pixiv random (保存到会话，确保视图和文件下载一致)
pixivRouter.get('/random', (req, res, next) => {
  try {
    const { sessionId, session } = getOrCreateSession(req);
    
    // 获取随机图片
    const row = getRandomPixivFile();
    if (!row) {
      throw new AppError(404, 'NO_PIXIV_FILES', '没有找到任何pixiv图片');
    }
    
    // 保存到会话
    session.pixiv = row;
    
    const parsed = parsePixiv(row.filename);
    if (!parsed) {
      throw new AppError(400, 'FILENAME_PARSE_ERROR', '文件名解析失败', {
        filename: row.filename,
        expectedFormat: 'base_pid[_p页码]'
      });
    }
    
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
      data: {
        illustId: parsed.pid,
        title: parsed.base,
        pageCount: pages.length,
        urls: pages.map(p =>
          `${host}/pixiv/artworks/file/${encodeURIComponent(p.filename)}`
        ),
        fileInfo: {
          dir: row.dir,
          filename: row.filename
        },
        session: {
          id: sessionId,
          currentFile: row.filename
        }
      }
    });
  } catch (error) {
    next(error);
  }
});

// pixiv info
pixivRouter.get('/info', (req, res, next) => {
  try {
    const { list } = req.query;
    if (!list) {
      throw new AppError(400, 'MISSING_PARAMETER', '缺少必要参数', {
        parameter: 'list',
        description: '需要提供文件名关键字'
      });
    }
    
    const row = db.prepare(`
      SELECT * FROM files
      WHERE type='pixiv' AND filename LIKE ?
      LIMIT 1
    `).get(`%${list}%`);
    
    if (!row) {
      throw new AppError(404, 'FILE_NOT_FOUND', '未找到匹配的图片', {
        query: list
      });
    }
    
    const parsed = parsePixiv(row.filename);
    if (!parsed) {
      throw new AppError(400, 'FILENAME_PARSE_ERROR', '文件名解析失败', {
        filename: row.filename,
        expectedFormat: 'base_pid[_p页码]'
      });
    }
    
    const prefix = `${parsed.base}_${parsed.pid}`;
    let pages = db.prepare(`
      SELECT filename FROM files
      WHERE type='pixiv' AND dir=? AND filename LIKE ?
    `).all(row.dir, `${prefix}%`);
    
    if (pages.length === 0) {
      throw new AppError(404, 'PAGES_NOT_FOUND', '未找到相关页面', {
        illustId: parsed.pid
      });
    }
    
    pages.sort((a, b) => {
      const pa = a.filename.match(/_p(\d+)/)?.[1] || 0;
      const pb = b.filename.match(/_p(\d+)/)?.[1] || 0;
      return Number(pa) - Number(pb);
    });
    
    const host = getHost(req);
    apiResponse(res, {
      data: {
        illustId: parsed.pid,
        title: parsed.base,
        pageCount: pages.length,
        urls: pages.map(p =>
          `${host}/pixiv/artworks/file/${encodeURIComponent(p.filename)}`
        ),
        fileInfo: {
          dir: row.dir,
          filename: row.filename
        }
      }
    });
  } catch (error) {
    next(error);
  }
});

// pixiv view (使用会话中的随机图片，确保和random接口一致)
pixivRouter.get('/view', validateReferer, (req, res, next) => {
  try {
    const { sessionId, session } = getOrCreateSession(req);
    
    // 如果会话中没有图片，先获取一个随机图片
    if (!session.pixiv) {
      session.pixiv = getRandomPixivFile();
    }
    
    if (!session.pixiv) {
      throw new AppError(404, 'NO_PIXIV_FILES', '没有找到任何pixiv图片');
    }
    
    const filePath = path.join(PIXIV_ROOT, session.pixiv.dir, session.pixiv.filename);
    verifyResourceExists(filePath);
    
    // 设置会话cookie
    res.cookie('sessionId', sessionId, { 
      maxAge: 3600000, // 1小时
      httpOnly: true 
    });
    
    servePixivView(res, filePath, session.pixiv.filename);
  } catch (error) {
    next(error);
  }
});

// pixiv file (有文件名参数)
pixivRouter.get('/file/:filename', validateReferer, (req, res, next) => {
  try {
    const { sessionId, session } = getOrCreateSession(req);
    const filename = decodeURIComponent(req.params.filename);
    
    if (!filename) {
      throw new AppError(400, 'MISSING_FILENAME', '缺少文件名参数');
    }
    
    // 从数据库查询文件位置
    const row = db.prepare(`
      SELECT dir FROM files WHERE type='pixiv' AND filename=?
    `).get(filename);
    
    if (!row) {
      throw new AppError(404, 'FILE_NOT_IN_DB', '文件不在数据库中', {
        filename: filename
      });
    }
    
    const filePath = path.join(PIXIV_ROOT, row.dir, filename);
    verifyResourceExists(filePath);
    
    // 设置会话cookie
    res.cookie('sessionId', sessionId, { 
      maxAge: 3600000, // 1小时
      httpOnly: true 
    });
    
    res.sendFile(filePath);
  } catch (error) {
    next(error);
  }
});

// pixiv file (从会话获取文件，确保和view一致)
pixivRouter.get('/file', validateReferer, (req, res, next) => {
  try {
    const { sessionId, session } = getOrCreateSession(req);
    
    // 从会话中获取文件名
    if (!session.pixiv) {
      throw new AppError(400, 'MISSING_FILENAME', '缺少文件名参数，且会话中没有缓存文件');
    }
    
    const filename = session.pixiv.filename;
    
    if (!filename) {
      throw new AppError(400, 'MISSING_FILENAME', '缺少文件名参数');
    }
    
    // 从数据库查询文件位置
    const row = db.prepare(`
      SELECT dir FROM files WHERE type='pixiv' AND filename=?
    `).get(filename);
    
    if (!row) {
      throw new AppError(404, 'FILE_NOT_IN_DB', '文件不在数据库中', {
        filename: filename
      });
    }
    
    const filePath = path.join(PIXIV_ROOT, row.dir, filename);
    verifyResourceExists(filePath);
    
    // 设置会话cookie
    res.cookie('sessionId', sessionId, { 
      maxAge: 3600000, // 1小时
      httpOnly: true 
    });
    
    res.sendFile(filePath);
  } catch (error) {
    next(error);
  }
});

// ================= Plus接口 =================
const plusRouter = express.Router();

// plus random (保存到会话，确保视图和文件下载一致)
plusRouter.get('/random', (req, res, next) => {
  try {
    const { sessionId, session } = getOrCreateSession(req);
    
    // 获取随机视频
    const row = getRandomPlusFile();
    if (!row) {
      throw new AppError(404, 'NO_PLUS_FILES', '没有找到任何视频文件');
    }
    
    // 保存到会话
    session.plus = row;
    
    const host = getHost(req);
    
    apiResponse(res, {
      data: {
        authorName: row.authorName,
        authorId: row.authorId,
        title: row.title,
        urls: [
          `${host}/plus/artworks/file/${encodeURIComponent(row.filename)}`
        ],
        fileInfo: {
          dir: row.dir,
          filename: row.filename
        },
        session: {
          id: sessionId,
          currentFile: row.filename
        }
      }
    });
  } catch (error) {
    next(error);
  }
});

// plus info
plusRouter.get('/info', (req, res, next) => {
  try {
    const { list } = req.query;
    if (!list) {
      throw new AppError(400, 'MISSING_PARAMETER', '缺少必要参数', {
        parameter: 'list',
        description: "需要提供作者名或作者ID，或使用'all'获取所有作者"
      });
    }
    
    if (list === 'all') {
      const rows = db.prepare(`
        SELECT DISTINCT authorName, authorId FROM files WHERE type='plus'
      `).all();
      
      if (rows.length === 0) {
        throw new AppError(404, 'NO_AUTHORS_FOUND', '没有找到任何作者');
      }
      
      return apiResponse(res, {
        data: {
          authors: rows,
          count: rows.length
        }
      });
    }
    
    const rows = db.prepare(`
      SELECT * FROM files
      WHERE type='plus'
      AND (authorName LIKE ? OR authorId LIKE ?)
    `).all(`%${list}%`, `%${list}%`);
    
    if (!rows.length) {
      throw new AppError(404, 'AUTHOR_NOT_FOUND', '未找到匹配的作者', {
        query: list
      });
    }
    
    const host = getHost(req);
    apiResponse(res, {
      data: {
        count: rows.length,
        files: rows.map(r => ({
          authorName: r.authorName,
          authorId: r.authorId,
          title: r.title,
          urls: [
            `${host}/plus/artworks/file/${encodeURIComponent(r.filename)}`
          ],
          fileInfo: {
            dir: r.dir,
            filename: r.filename
          }
        }))
      }
    });
  } catch (error) {
    next(error);
  }
});

// plus view (使用会话中的随机视频，确保和random接口一致)
plusRouter.get('/view', validateReferer, (req, res, next) => {
  try {
    const { sessionId, session } = getOrCreateSession(req);
    
    // 如果会话中没有视频，先获取一个随机视频
    if (!session.plus) {
      session.plus = getRandomPlusFile();
    }
    
    if (!session.plus) {
      throw new AppError(404, 'NO_PLUS_FILES', '没有找到任何视频文件');
    }
    
    const filePath = path.join(PLUS_ROOT, session.plus.dir, session.plus.filename);
    verifyResourceExists(filePath);
    
    // 设置会话cookie
    res.cookie('sessionId', sessionId, { 
      maxAge: 3600000, // 1小时
      httpOnly: true 
    });
    
    serveVideoView(res, filePath, session.plus.filename, req.headers.range);
  } catch (error) {
    next(error);
  }
});

// plus file (有文件名参数)
plusRouter.get('/file/:filename', validateReferer, (req, res, next) => {
  try {
    const { sessionId, session } = getOrCreateSession(req);
    const filename = decodeURIComponent(req.params.filename);
    
    if (!filename) {
      throw new AppError(400, 'MISSING_FILENAME', '缺少文件名参数');
    }
    
    // 从数据库查询文件位置
    const row = db.prepare(`
      SELECT dir FROM files WHERE type='plus' AND filename=?
    `).get(filename);
    
    if (!row) {
      throw new AppError(404, 'FILE_NOT_IN_DB', '文件不在数据库中', {
        filename: filename
      });
    }
    
    const filePath = path.join(PLUS_ROOT, row.dir, filename);
    verifyResourceExists(filePath);
    
    const stat = fsSync.statSync(filePath);
    const range = req.headers.range;
    
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', 'video/mp4');
    
    // 设置会话cookie
    res.cookie('sessionId', sessionId, { 
      maxAge: 3600000, // 1小时
      httpOnly: true 
    });
    
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      
      if (isNaN(start) || start >= stat.size) {
        throw new AppError(416, 'RANGE_NOT_SATISFIABLE', '请求的Range不可满足', {
          range: range,
          fileSize: stat.size
        });
      }
      
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Content-Length': end - start + 1
      });
      
      fsSync.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': stat.size
      });
      fsSync.createReadStream(filePath).pipe(res);
    }
  } catch (error) {
    next(error);
  }
});

// plus file (从会话获取文件，确保和view一致)
plusRouter.get('/file', validateReferer, (req, res, next) => {
  try {
    const { sessionId, session } = getOrCreateSession(req);
    
    // 从会话中获取文件名
    if (!session.plus) {
      throw new AppError(400, 'MISSING_FILENAME', '缺少文件名参数，且会话中没有缓存文件');
    }
    
    const filename = session.plus.filename;
    
    if (!filename) {
      throw new AppError(400, 'MISSING_FILENAME', '缺少文件名参数');
    }
    
    // 从数据库查询文件位置
    const row = db.prepare(`
      SELECT dir FROM files WHERE type='plus' AND filename=?
    `).get(filename);
    
    if (!row) {
      throw new AppError(404, 'FILE_NOT_IN_DB', '文件不在数据库中', {
        filename: filename
      });
    }
    
    const filePath = path.join(PLUS_ROOT, row.dir, filename);
    verifyResourceExists(filePath);
    
    const stat = fsSync.statSync(filePath);
    const range = req.headers.range;
    
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', 'video/mp4');
    
    // 设置会话cookie
    res.cookie('sessionId', sessionId, { 
      maxAge: 3600000, // 1小时
      httpOnly: true 
    });
    
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      
      if (isNaN(start) || start >= stat.size) {
        throw new AppError(416, 'RANGE_NOT_SATISFIABLE', '请求的Range不可满足', {
          range: range,
          fileSize: stat.size
        });
      }
      
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Content-Length': end - start + 1
      });
      
      fsSync.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': stat.size
      });
      fsSync.createReadStream(filePath).pipe(res);
    }
  } catch (error) {
    next(error);
  }
});

// ================= 注册路由 =================
app.use('/pixiv/artworks', pixivRouter);
app.use('/plus/artworks', plusRouter);

// 404 处理
app.use((req, res, next) => {
  throw new AppError(404, 'ENDPOINT_NOT_FOUND', '接口不存在', {
    path: req.path,
    method: req.method
  });
});

// 全局错误处理中间件
app.use(errorHandler);

// ================= 启动 =================
app.listen(PORT, HOST, async () => {
  try {
    await initCache();
    watchFolder(PIXIV_ROOT, 'pixiv');
    watchFolder(PLUS_ROOT, 'plus');
    
    console.log('='.repeat(50));
    console.log(`服务器启动成功!`);
    console.log(`访问地址: http://${HOST}:${PORT}`);
    console.log('='.repeat(50));
  } catch (error) {
    console.error('服务器启动失败:', error.message);
    process.exit(1);
  }
});
