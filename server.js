import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './lib/store.js';
import { buildIndex } from './lib/retrieval.js';
import { ask } from './lib/agent.js';
import { resolveConfig, testConnection } from './lib/llm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const SEED_DIR = path.join(DATA_DIR, 'seed');

// 手写读取 .env（零依赖）。已存在的环境变量优先，不被覆盖。
function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadEnvFile();

const store = createStore({ dataDir: DATA_DIR, seedDir: SEED_DIR });
const boot = store.load();
let index = buildIndex(store.getChunks());

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2'
};

function sendJSON(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }));
        req.destroy();
        return;
      }
      parts.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(parts).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.join(PUBLIC_DIR, rel);
  // 防目录穿越
  if (!target.startsWith(PUBLIC_DIR + path.sep) && target !== path.join(PUBLIC_DIR, 'index.html')) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.stat(target, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300'
    });
    fs.createReadStream(target).pipe(res);
  });
}

function refreshIndex() {
  index = buildIndex(store.getChunks());
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  try {
    if (pathname === '/api/health') {
      return sendJSON(res, 200, {
        ok: true,
        llmConfigured: resolveConfig().configured,
        stats: store.stats()
      });
    }

    if (pathname === '/api/stats' && req.method === 'GET') {
      const cfg = resolveConfig();
      return sendJSON(res, 200, {
        ...store.stats(),
        llmConfigured: cfg.configured,
        llmModel: cfg.configured ? cfg.model : null
      });
    }

    if (pathname === '/api/docs' && req.method === 'GET') {
      return sendJSON(res, 200, { docs: store.listDocs() });
    }

    if (pathname === '/api/docs' && req.method === 'POST') {
      const body = await readBody(req);
      const result = store.addDoc({ name: body.name, content: body.content });
      refreshIndex();
      return sendJSON(res, 200, { ok: true, ...result, stats: store.stats() });
    }

    const docMatch = /^\/api\/docs\/([\w-]+)$/.exec(pathname);
    if (docMatch) {
      const id = docMatch[1];
      if (req.method === 'GET') {
        const doc = store.getDoc(id);
        if (!doc) return sendJSON(res, 404, { error: '文档不存在' });
        return sendJSON(res, 200, doc);
      }
      if (req.method === 'DELETE') {
        const ok = store.deleteDoc(id);
        if (!ok) return sendJSON(res, 404, { error: '文档不存在' });
        refreshIndex();
        return sendJSON(res, 200, { ok: true, stats: store.stats() });
      }
    }

    if (pathname === '/api/ask' && req.method === 'POST') {
      const body = await readBody(req);
      const llm = resolveConfig(body.llm || {});
      const startedAt = Date.now();
      const result = await ask({
        question: body.question,
        index,
        llm,
        topK: Math.min(Math.max(Number(body.topK) || 5, 1), 8)
      });
      return sendJSON(res, 200, {
        ...result,
        elapsedMs: Date.now() - startedAt,
        stats: store.stats()
      });
    }

    if (pathname === '/api/config/test' && req.method === 'POST') {
      const body = await readBody(req);
      const cfg = resolveConfig(body.llm || {});
      if (!cfg.configured) return sendJSON(res, 400, { ok: false, error: '未填写 API Key' });
      try {
        const reply = await testConnection(cfg);
        return sendJSON(res, 200, { ok: true, reply, model: cfg.model });
      } catch (err) {
        return sendJSON(res, 200, { ok: false, error: err.message, detail: err.detail || '' });
      }
    }

    if (pathname.startsWith('/api/')) {
      return sendJSON(res, 404, { error: '接口不存在' });
    }

    return serveStatic(req, res, pathname);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('[api]', pathname, err);
    if (!res.headersSent) sendJSON(res, status, { error: err.message || '服务器内部错误' });
  }
});

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`知识问答 Agent 已启动 → http://localhost:${PORT}`);
  console.log(`知识库：${boot.docs} 篇文档 / ${boot.chunks} 个片段`);
  console.log(`大模型：${resolveConfig().configured ? '已配置' : '未配置（将使用原文摘录模式）'}`);
});
