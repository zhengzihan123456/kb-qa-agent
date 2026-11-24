import fs from 'node:fs';
import path from 'node:path';
import { chunkDocument } from './chunker.js';
import { tokenize } from './tokenize.js';

const MAX_DOC_BYTES = 2 * 1024 * 1024; // 单篇 2MB

function newId(prefix = 'd') {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * 知识库存储。
 * 落盘为一个 JSON 文件（data/kb.json），启动时全量载入内存并建索引。
 * 之所以不用数据库：这是单实例小应用，JSON 足够，且不引入任何原生依赖。
 */
export function createStore({ dataDir, seedDir }) {
  const file = path.join(dataDir, 'kb.json');
  let state = { version: 1, docs: [] };
  let chunks = [];

  function persist() {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }

  function rebuild() {
    chunks = [];
    for (const doc of state.docs) {
      chunks.push(...chunkDocument(doc.content, doc.id, doc.name));
    }
    // 预分词，检索时不用重复切
    for (const c of chunks) {
      c.tokens = tokenize(`${c.docName}\n${c.text}`);
    }
    return chunks;
  }

  function seedIfEmpty() {
    if (state.docs.length) return;
    if (!fs.existsSync(seedDir)) return;
    const files = fs
      .readdirSync(seedDir)
      .filter((f) => /\.(md|txt|markdown)$/i.test(f))
      .sort();
    for (const f of files) {
      const content = fs.readFileSync(path.join(seedDir, f), 'utf8');
      const name = f.replace(/\.(md|txt|markdown)$/i, '');
      state.docs.push({
        id: newId(),
        name,
        content,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        seeded: true
      });
    }
    if (state.docs.length) persist();
  }

  function load() {
    fs.mkdirSync(dataDir, { recursive: true });
    if (fs.existsSync(file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (raw && Array.isArray(raw.docs)) state = { version: 1, docs: raw.docs };
      } catch (err) {
        console.error('[store] kb.json 解析失败，将以空库启动：', err.message);
      }
    }
    seedIfEmpty();
    rebuild();
    return { docs: state.docs.length, chunks: chunks.length };
  }

  function listDocs() {
    return state.docs.map((d) => ({
      id: d.id,
      name: d.name,
      chars: d.content.length,
      lines: d.content.split('\n').length,
      createdAt: d.createdAt,
      seeded: !!d.seeded,
      chunkCount: chunks.filter((c) => c.docId === d.id).length
    }));
  }

  function getDoc(id) {
    const doc = state.docs.find((d) => d.id === id);
    if (!doc) return null;
    return {
      ...doc,
      chunks: chunks
        .filter((c) => c.docId === id)
        .map((c) => ({
          id: c.id,
          startLine: c.startLine,
          endLine: c.endLine,
          charStart: c.charStart,
          charEnd: c.charEnd
        }))
    };
  }

  function addDoc({ name, content }) {
    const cleanName = String(name || '').trim() || '未命名文档';
    const text = String(content || '');
    if (!text.trim()) throw Object.assign(new Error('文档内容为空'), { status: 400 });
    if (Buffer.byteLength(text, 'utf8') > MAX_DOC_BYTES) {
      throw Object.assign(new Error('文档过大，单篇上限 2MB'), { status: 413 });
    }
    const dup = state.docs.find((d) => d.name === cleanName);
    if (dup) {
      dup.content = text;
      dup.updatedAt = Date.now();
      dup.seeded = false;
      persist();
      rebuild();
      return { id: dup.id, name: dup.name, replaced: true };
    }
    const doc = {
      id: newId(),
      name: cleanName,
      content: text,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      seeded: false
    };
    state.docs.push(doc);
    persist();
    rebuild();
    return { id: doc.id, name: doc.name, replaced: false };
  }

  function deleteDoc(id) {
    const before = state.docs.length;
    state.docs = state.docs.filter((d) => d.id !== id);
    if (state.docs.length === before) return false;
    persist();
    rebuild();
    return true;
  }

  function stats() {
    const withTokens = chunks.reduce((n, c) => n + c.tokens.length, 0);
    return {
      docs: state.docs.length,
      chunks: chunks.length,
      chars: state.docs.reduce((n, d) => n + d.content.length, 0),
      avgChunkTokens: chunks.length ? Math.round(withTokens / chunks.length) : 0
    };
  }

  return { load, listDocs, getDoc, addDoc, deleteDoc, stats, getChunks: () => chunks };
}
