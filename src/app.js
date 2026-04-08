import express from 'express';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import compression from 'compression';
import cors from 'cors';
import winston from 'winston';
import rateLimit from 'express-rate-limit';

// ================= 加载环境变量 =================
process.env.DOTENV_CONFIG_DEBUG = 'false';
process.env.DOTENV_CONFIG_SILENT = 'true';
process.env.DOTENV_CONFIG_QUIET = 'true';

dotenv.config({ 
  silent: true,
  debug: false
});

// ================= 基础 =================
const app = express();
app.set('trust proxy', false);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.set('json spaces', 2);

// 从环境变量中读取配置
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);
const RESOURCES = process.env.RESOURCES || './resources';
const STORAGE_NAME = process.env.STORAGE_NAME;
const ALLOW_EMPTY_REFERER = process.env.ALLOW_EMPTY_REFERER === 'true';
const REFERERS = process.env.REFERERS || '';
const ALLOWED_REFERERS = REFERERS.split(',').filter(Boolean);
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:3000';
const RATE_LIMIT_WINDOW = Number(process.env.RATE_LIMIT_WINDOW || 15) * 60 * 1000;
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 100);
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

// 统一资源目录
const RES_ROOT = path.resolve(__dirname, '..', RESOURCES);
const PIXIV_ROOT = path.join(RES_ROOT, 'pixiv');
const PLUS_ROOT = path.join(RES_ROOT, 'plus');

// DB
const DB_PATH = path.resolve(__dirname, '..', './data/cache.db');

// 日志目录
const LOG_DIR = path.resolve(__dirname, '..', 'data', 'logs');
if (!fsSync.existsSync(LOG_DIR)) {
  fsSync.mkdirSync(LOG_DIR, { recursive: true });
}

// ================= 日志系统 =================
// 创建两个logger：一个用于控制台输出，一个用于文件日志
const consoleLogger = winston.createLogger({
  level: LOG_LEVEL,
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.simple()
  ),
  transports: [
    new winston.transports.Console()
  ]
});

// 文件日志（不输出到控制台）
const fileLogger = winston.createLogger({
  level: LOG_LEVEL,
  format: winston.format.combine(
    winston.format.timestamp({
      format: 'YYYY-MM-DD HH:mm:ss'
    }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json()
  ),
  defaultMeta: { service: 'pixhub' },
  transports: [
    new winston.transports.File({ 
      filename: path.join(LOG_DIR, 'error.log'), 
      level: 'error',
      maxsize: 5242880,
      maxFiles: 5
    }),
    new winston.transports.File({ 
      filename: path.join(LOG_DIR, 'combined.log'),
      maxsize: 5242880,
      maxFiles: 5
    })
  ]
});

// 保存原始控制台方法
const originalConsole = {
  log: console.log,
  error: console.error,
  warn: console.warn,
  info: console.info
};

// 重写控制台方法 - 只输出到控制台，不记录到文件
console.log = (...args) => {
  consoleLogger.info(args.join(' '));
};

console.error = (...args) => {
  if (args.length === 1 && args[0] instanceof Error) {
    consoleLogger.error(args[0].message);
  } else {
    consoleLogger.error(args.join(' '));
  }
};

console.warn = (...args) => {
  consoleLogger.warn(args.join(' '));
};

console.info = (...args) => {
  consoleLogger.info(args.join(' '));
};

// ================= 中间件 =================
app.use(compression());

app.use(cors({
  origin: CORS_ORIGIN,
  credentials: true
}));

// 请求日志中间件 - 只记录到文件，不输出到控制台
app.use((req, res, next) => {
  const startTime = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    fileLogger.info(`${req.method} ${req.url} ${res.statusCode} ${duration}ms`, {
      ip: req.ip,
      userAgent: req.get('user-agent'),
      referer: req.get('referer')
    });
  });
  
  next();
});

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
    const logData = {
      url: req.url,
      method: req.method,
      ip: req.ip,
      details: err.details
    };
    consoleLogger.error(`错误 ${err.statusCode} ${err.errorCode}: ${err.message}`);
    fileLogger.error(`AppError ${err.statusCode} ${err.errorCode}: ${err.message}`, logData);
    
    const response = {
      error: true,
      code: err.errorCode,
      message: err.message,
      timestamp: new Date().toLocaleString('zh-CN').replace(',', ''),
      details: err.details
    };
    
    if (STORAGE_NAME) {
      response.storage = STORAGE_NAME;
    }
    
    return res.status(err.statusCode).json(response);
  }
  
  const logData = {
    error: err.message,
    stack: err.stack,
    url: req.url,
    method: req.method,
    ip: req.ip
  };
  consoleLogger.error('服务器内部错误');
  fileLogger.error('服务器内部错误', logData);
  
  const response = {
    error: true,
    code: 'INTERNAL_SERVER_ERROR',
    message: '服务器内部错误',
    timestamp: new Date().toLocaleString('zh-CN').replace(',', ''),
    details: { error: err.message }
  };
  
  if (STORAGE_NAME) {
    response.storage = STORAGE_NAME;
  }
  
  res.status(500).json(response);
}

// ================= 数据库 =================
let db;
try {
  const dbDir = path.dirname(DB_PATH);
  if (!fsSync.existsSync(dbDir)) {
    fsSync.mkdirSync(dbDir, { recursive: true });
  }
  
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
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_files_type ON files(type);
    CREATE INDEX IF NOT EXISTS idx_files_filename ON files(filename);
    CREATE INDEX IF NOT EXISTS idx_files_author ON files(authorName, authorId);
    CREATE INDEX IF NOT EXISTS idx_files_dir ON files(dir);
  `);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = 1000000');
  db.pragma('temp_store = MEMORY');
} catch (error) {
  console.error('数据库初始化失败:', error.message);
  process.exit(1);
}

// ================= 工具函数 =================
function apiResponse(res, data) {
  const response = {
    error: false,
    message: 'success',
    ...data
  };
  
  if (STORAGE_NAME) {
    response.storage = STORAGE_NAME;
  }
  
  return res.status(200).json(response);
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

function verifyResourceExists(filePath) {
  const relative = path.relative(RES_ROOT, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new AppError(403, 'PATH_TRAVERSAL', '路径访问被拒绝', {
      requestedPath: filePath
    });
  }
  
  if (!fsSync.existsSync(filePath)) {
    throw new AppError(404, 'RESOURCE_NOT_FOUND', '请求的资源不存在', {
      filePath: path.relative(process.cwd(), filePath)
    });
  }
}

function sanitizeSearchTerm(term) {
  if (!term) return '';
  return term.replace(/[%_]/g, '');
}

// ================= 会话管理 =================
const sessionStore = new Map();
let lastCleanup = Date.now();
const CLEANUP_INTERVAL = 3600000;

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
  
  if (Date.now() - lastCleanup > CLEANUP_INTERVAL) {
    const oneHourAgo = Date.now() - 3600000;
    let cleaned = 0;
    
    for (const [id, sess] of sessionStore.entries()) {
      if (sess.lastAccessed < oneHourAgo) {
        sessionStore.delete(id);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      fileLogger.debug(`清理了 ${cleaned} 个过期会话`);
    }
    
    lastCleanup = Date.now();
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
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp'
  }[ext] || 'image/jpeg';
  
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(filename)}"`);
  res.sendFile(filePath);
}

function serveVideoView(res, filePath, filename, range) {
  const stat = fsSync.statSync(filePath);
  
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(filename)}"`);
  
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

function serveMediaFile(type, rootDir) {
  return (req, res, next) => {
    try {
      const filename = decodeURIComponent(req.params.filename);
      
      if (!filename) {
        throw new AppError(400, 'MISSING_FILENAME', '缺少文件名参数');
      }
      
      if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
        throw new AppError(400, 'INVALID_FILENAME', '文件名包含非法字符');
      }
      
      const row = db.prepare(`
        SELECT dir FROM files WHERE type=? AND filename=?
      `).get(type, filename);
      
      if (!row) {
        throw new AppError(404, 'FILE_NOT_IN_DB', '文件不在数据库中', {
          filename: filename
        });
      }
      
      const filePath = path.join(rootDir, row.dir, filename);
      verifyResourceExists(filePath);
      
      const ext = path.extname(filename).toLowerCase();
      
      if (type === 'pixiv') {
        servePixivView(res, filePath, filename);
      } else if (type === 'plus') {
        const stat = fsSync.statSync(filePath);
        const range = req.headers.range;
        
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(filename)}"`);
        
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
      }
    } catch (error) {
      next(error);
    }
  };
}

// ================= 缓存管理 =================
async function initCache() {
  try {
    const count = db.prepare(`SELECT COUNT(*) as c FROM files`).get().c;
    if (count > 0) {
      // 静默处理，不输出到控制台
      fileLogger.info('缓存已存在，跳过初始化');
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
        fileLogger.warn(`资源目录不存在: ${root}`);
        return;
      }
      
      const dirs = await fs.readdir(root, { withFileTypes: true });
      
      for (const d of dirs) {
        if (!d.isDirectory() || !/^\d+$/.test(d.name)) continue;
        const files = await fs.readdir(path.join(root, d.name));
        
        for (const f of files) {
          if (type === 'pixiv' && !/\.(jpg|png|jpeg|gif|webp)$/i.test(f)) continue;
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
      fileLogger.info(`缓存 ${rows.length} 条记录`);
    } else {
      console.warn('没有找到任何资源文件');
      fileLogger.warn('没有找到任何资源文件');
    }
  } catch (error) {
    console.error('缓存初始化失败:', error.message);
    fileLogger.error('缓存初始化失败:', error.message);
    throw error;
  }
}

// ================= 文件监听 =================
const watchDebounce = new Map();

function watchFolder(root, type) {
  if (!fsSync.existsSync(root)) {
    console.warn(`监听目录不存在: ${root}`);
    fileLogger.warn(`监听目录不存在: ${root}`);
    return;
  }
  
  if (watchDebounce.has(root)) {
    return;
  }
  
  const watcher = fsSync.watch(root, { recursive: true });
  const debounceData = { watcher, lastEvent: 0, timer: null };
  watchDebounce.set(root, debounceData);
  
  watcher.on('change', (eventType, filename) => {
    if (!filename) return;
    
    const now = Date.now();
    const data = watchDebounce.get(root);
    
    if (data.timer) {
      clearTimeout(data.timer);
    }
    
    data.timer = setTimeout(() => {
      try {
        const parts = filename.split(path.sep);
        if (parts.length < 2) return;
        
        const [dir, file] = parts;
        if (!/^\d+$/.test(dir)) return;
        
        const fullPath = path.join(root, dir, file);
        
        if (!fsSync.existsSync(fullPath)) {
          db.prepare(`DELETE FROM files WHERE type=? AND dir=? AND filename=?`)
            .run(type, dir, file);
          fileLogger.info(`文件删除: ${filename} (${type})`);
          return;
        }
        
        if (type === 'pixiv' && !/\.(jpg|png|jpeg|gif|webp)$/i.test(file)) return;
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
        
        fileLogger.info(`文件新增: ${filename} (${type})`);
      } catch (error) {
        fileLogger.error(`文件监听错误 (${type}):`, error.message);
      }
      
      data.timer = null;
    }, 1000);
    
    data.lastEvent = now;
  });
  
  watcher.on('error', (error) => {
    fileLogger.error(`文件监听器错误 (${root}):`, error.message);
    watchDebounce.delete(root);
  });
  
  fileLogger.info(`开始监听目录: ${root} (${type})`);
}

function stopFileWatching() {
  for (const [root, data] of watchDebounce.entries()) {
    try {
      data.watcher.close();
      if (data.timer) {
        clearTimeout(data.timer);
      }
      fileLogger.info(`停止监听目录: ${root}`);
    } catch (error) {
      fileLogger.error(`停止监听目录错误 (${root}):`, error.message);
    }
  }
  watchDebounce.clear();
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

const limiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  validate: {
    trustProxy: false
  },
  message: {
    error: true,
    code: 'RATE_LIMIT_EXCEEDED',
    message: '请求过于频繁，请稍后再试',
    timestamp: new Date().toLocaleString('zh-CN').replace(',', '')
  },
  handler: (req, res) => {
    fileLogger.warn(`速率限制触发: ${req.ip} - ${req.url}`);
    res.status(429).json({
      error: true,
      code: 'RATE_LIMIT_EXCEEDED',
      message: '请求过于频繁，请稍后再试',
      timestamp: new Date().toLocaleString('zh-CN').replace(',', '')
    });
  }
});

// ================= 首页 =================
app.get('/', (req, res) => {
  const host = getHost(req);
  const baseUrl = `${host}`;
  
  const apiInfo = {
    data: {
      message: "API接口调用方式",
      endpoints: {
        pixiv: {
          random: {
            url: `${baseUrl}/pixiv/artworks/random`,
            description: "随机获取一张pixiv图片信息"
          },
          info: {
            url: `${baseUrl}/pixiv/artworks/info?list=文件名`,
            description: "根据文件名查询pixiv图片信息"
          },
          view: {
            url: `${baseUrl}/pixiv/artworks/view`,
            description: "直接查看随机pixiv图片"
          },
          file: {
            url: `${baseUrl}/pixiv/artworks/file/文件名`,
            description: "获取pixiv图片文件"
          }
        },
        plus: {
          random: {
            url: `${baseUrl}/plus/artworks/random`,
            description: "随机获取一个视频信息"
          },
          info: {
            url: `${baseUrl}/plus/artworks/info?list=作者名或作者ID`,
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
            url: `${baseUrl}/plus/artworks/file/文件名`,
            description: "获取视频文件"
          }
        }
      }
    }
  };
  
  apiResponse(res, apiInfo);
});

// ================= Pixiv接口 =================
const pixivRouter = express.Router();
pixivRouter.use(limiter);

pixivRouter.get('/random', (req, res, next) => {
  try {
    const { sessionId, session } = getOrCreateSession(req);
    
    const row = getRandomPixivFile();
    if (!row) {
      throw new AppError(404, 'NO_PIXIV_FILES', '没有找到任何pixiv图片');
    }
    
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
        }
      }
    });
  } catch (error) {
    next(error);
  }
});

pixivRouter.get('/info', (req, res, next) => {
  try {
    const { list } = req.query;
    if (!list) {
      throw new AppError(400, 'MISSING_PARAMETER', '缺少必要参数', {
        parameter: 'list',
        description: '需要提供文件名关键字'
      });
    }
    
    const searchTerm = sanitizeSearchTerm(list);
    const row = db.prepare(`
      SELECT * FROM files
      WHERE type='pixiv' AND filename LIKE ?
      LIMIT 1
    `).get(`%${searchTerm}%`);
    
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

pixivRouter.get('/view', validateReferer, (req, res, next) => {
  try {
    const { sessionId, session } = getOrCreateSession(req);
    
    if (!session.pixiv) {
      session.pixiv = getRandomPixivFile();
    }
    
    if (!session.pixiv) {
      throw new AppError(404, 'NO_PIXIV_FILES', '没有找到任何pixiv图片');
    }
    
    const filePath = path.join(PIXIV_ROOT, session.pixiv.dir, session.pixiv.filename);
    verifyResourceExists(filePath);
    
    res.cookie('sessionId', sessionId, { 
      maxAge: 3600000,
      httpOnly: true,
      sameSite: 'strict'
    });
    
    servePixivView(res, filePath, session.pixiv.filename);
  } catch (error) {
    next(error);
  }
});

pixivRouter.get('/file/:filename', validateReferer, serveMediaFile('pixiv', PIXIV_ROOT));

pixivRouter.get('/file', validateReferer, (req, res, next) => {
  try {
    const { sessionId, session } = getOrCreateSession(req);
    
    if (!session.pixiv) {
      throw new AppError(400, 'MISSING_FILENAME', '缺少文件名参数，且会话中没有缓存文件');
    }
    
    const filename = session.pixiv.filename;
    
    if (!filename) {
      throw new AppError(400, 'MISSING_FILENAME', '缺少文件名参数');
    }
    
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
    
    res.cookie('sessionId', sessionId, { 
      maxAge: 3600000,
      httpOnly: true,
      sameSite: 'strict'
    });
    
    servePixivView(res, filePath, filename);
  } catch (error) {
    next(error);
  }
});

// ================= Plus接口 =================
const plusRouter = express.Router();
plusRouter.use(limiter);

plusRouter.get('/random', (req, res, next) => {
  try {
    const { sessionId, session } = getOrCreateSession(req);
    
    const row = getRandomPlusFile();
    if (!row) {
      throw new AppError(404, 'NO_PLUS_FILES', '没有找到任何视频文件');
    }
    
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
        }
      }
    });
  } catch (error) {
    next(error);
  }
});

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
    
    const searchTerm = sanitizeSearchTerm(list);
    const rows = db.prepare(`
      SELECT * FROM files
      WHERE type='plus'
      AND (authorName LIKE ? OR authorId LIKE ?)
    `).all(`%${searchTerm}%`, `%${searchTerm}%`);
    
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

plusRouter.get('/view', validateReferer, (req, res, next) => {
  try {
    const { sessionId, session } = getOrCreateSession(req);
    
    if (!session.plus) {
      session.plus = getRandomPlusFile();
    }
    
    if (!session.plus) {
      throw new AppError(404, 'NO_PLUS_FILES', '没有找到任何视频文件');
    }
    
    const filePath = path.join(PLUS_ROOT, session.plus.dir, session.plus.filename);
    verifyResourceExists(filePath);
    
    res.cookie('sessionId', sessionId, { 
      maxAge: 3600000,
      httpOnly: true,
      sameSite: 'strict'
    });
    
    serveVideoView(res, filePath, session.plus.filename, req.headers.range);
  } catch (error) {
    next(error);
  }
});

plusRouter.get('/file/:filename', validateReferer, serveMediaFile('plus', PLUS_ROOT));

plusRouter.get('/file', validateReferer, (req, res, next) => {
  try {
    const { sessionId, session } = getOrCreateSession(req);
    
    if (!session.plus) {
      throw new AppError(400, 'MISSING_FILENAME', '缺少文件名参数，且会话中没有缓存文件');
    }
    
    const filename = session.plus.filename;
    
    if (!filename) {
      throw new AppError(400, 'MISSING_FILENAME', '缺少文件名参数');
    }
    
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
    
    res.cookie('sessionId', sessionId, { 
      maxAge: 3600000,
      httpOnly: true,
      sameSite: 'strict'
    });
    
    serveVideoView(res, filePath, filename, req.headers.range);
  } catch (error) {
    next(error);
  }
});

// ================= 注册路由 =================
app.use('/pixiv/artworks', pixivRouter);
app.use('/plus/artworks', plusRouter);

// 404 处理
app.use((req, res, next) => {
  const error = new AppError(404, 'ENDPOINT_NOT_FOUND', '接口不存在', {
    path: req.path,
    method: req.method
  });
  next(error);
});

// 全局错误处理中间件
app.use(errorHandler);

// ================= 优雅关闭 =================
function gracefulShutdown(signal) {
  // 只输出一次到控制台
  console.log(`收到 ${signal} 信号，正在优雅关闭...`);
  // 只记录一次到文件
  fileLogger.info(`收到 ${signal} 信号，正在优雅关闭...`);
  
  stopFileWatching();
  
  if (db) {
    try {
      db.close();
      fileLogger.info('数据库连接已关闭');
    } catch (error) {
      fileLogger.error('关闭数据库连接时出错:', error.message);
    }
  }
  
  if (server) {
    server.close(() => {
      fileLogger.info('HTTP服务器已关闭');
      process.exit(0);
    });
    
    setTimeout(() => {
      fileLogger.error('强制关闭服务器');
      process.exit(1);
    }, 10000);
  } else {
    process.exit(0);
  }
}

// 注册信号处理
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGUSR2', () => gracefulShutdown('SIGUSR2'));

process.on('uncaughtException', (error) => {
  fileLogger.error('未捕获的异常:', error);
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
  fileLogger.error('未处理的Promise拒绝:', { reason, promise });
});

// ================= 启动 =================
let server;

async function startServer() {
  try {
    if (!fsSync.existsSync(RES_ROOT)) {
      console.warn(`⚠️ 资源目录不存在: ${RES_ROOT}`);
    }
    
    // 静默初始化缓存
    await initCache();
    
    // 静默启动文件监听
    watchFolder(PIXIV_ROOT, 'pixiv');
    watchFolder(PLUS_ROOT, 'plus');
    
    server = app.listen(PORT, HOST, () => {
      // 简化启动输出
      console.log('='.repeat(40));
      console.log('🚀 PixHub服务器启动成功');
      console.log(`📍 访问地址: http://${HOST}:${PORT}`);
      console.log(`📦 存储地: ${STORAGE_NAME || '未设置'}`);
      console.log(`🔒 速率限制: ${RATE_LIMIT_MAX} 请求/${RATE_LIMIT_WINDOW/60000}分钟`);
      console.log('='.repeat(40));
    });
    
    server.on('listening', () => {
      // 静默处理，不输出到控制台
      fileLogger.info(`服务器已在端口 ${PORT} 上就绪`);
    });
    
    server.on('error', (error) => {
      console.error('服务器启动失败:', error.message);
      fileLogger.error('服务器启动失败:', error.message);
      process.exit(1);
    });
    
  } catch (error) {
    console.error('服务器启动失败:', error.message);
    fileLogger.error('服务器启动失败:', error.message);
    process.exit(1);
  }
}

startServer();