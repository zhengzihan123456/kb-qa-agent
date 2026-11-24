/**
 * 检索 + 「有没有依据」的判定。
 *
 * 排序用 BM25（中文走 bigram），但判定不能只看 BM25：
 * 问句里会切出「费后」「久可」这类跨词的假 bigram，它们在任何文档里都不存在，
 * 会把覆盖率压低，导致明明有依据也判成「没查到」。
 *
 * 所以判定改用「字符级覆盖」：把查询去掉停用词后，统计有多少字符
 * 出现在片段里的连续公共子串中。跨词的假 bigram 不会造成误判，因为
 * 「付费」「退款」这些真实词各自都能在原文里找到连续出现。
 */
import { queryTokens } from './tokenize.js';

const K1 = 1.5;
const B = 0.75;

// 词级停用词（用于字符覆盖前的归一化），长词在前，避免被短词拆碎
const STOP_WORDS = [
  '为什么', '是什么', '有什么', '有没有', '怎么样', '怎么办', '什么样', '是什么',
  '请问', '帮我', '告诉', '介绍', '说明', '一下', '哪些', '哪个', '哪里', '多少',
  '是否', '可以', '能不能', '需要', '应该', '关于', '相关', '具体', '一般', '通常',
  '我们', '你们', '他们', '这个', '那个', '这些', '那些', '这样', '那样', '怎样',
  '以及', '但是', '因为', '所以', '如果', '就是', '还是', '不是', '什么', '怎么',
  '如何', '吗', '呢', '吧', '啊', '呀', '的', '了', '是', '在', '和', '与', '或',
  '及', '对', '把', '被', '就', '都', '也', '很', '我', '你', '他', '她', '它',
  '这', '那', '个', '些', '有', '会', '要', '能', '用', '做', '么'
].sort((a, b) => b.length - a.length);

// 少量同义词归一，解决「关键词检索对不上口语问法」的问题
const SYNONYMS = [
  ['多少钱', '价格'],
  ['什么价格', '价格'],
  ['费用', '价格'],
  ['收费', '价格'],
  ['价钱', '价格'],
  ['资费', '价格'],
  ['登陆', '登录'],
  ['同步不了', '不同步'],
  ['用不了', '失败'],
  ['打不开', '白屏']
];

function normalize(text) {
  let t = String(text || '').toLowerCase();
  for (const [from, to] of SYNONYMS) t = t.split(from).join(to);
  for (const w of STOP_WORDS) t = t.split(w).join('');
  return t.replace(/[^\u4e00-\u9fffa-z0-9]/g, '');
}

/** 查询字符被片段覆盖的比例（0~1） */
function charCoverage(normQuery, text) {
  if (!normQuery) return 0;
  const target = normalize(text);
  if (!target) return 0;

  const covered = new Uint8Array(normQuery.length);
  const maxLen = Math.min(normQuery.length, 10);

  // 贪心：先找长的公共子串，再找短的
  for (let len = maxLen; len >= 2; len--) {
    for (let i = 0; i + len <= normQuery.length; i++) {
      let already = true;
      for (let k = i; k < i + len; k++) {
        if (!covered[k]) {
          already = false;
          break;
        }
      }
      if (already) continue;
      if (target.includes(normQuery.slice(i, i + len))) {
        for (let k = i; k < i + len; k++) covered[k] = 1;
      }
    }
  }

  let hit = 0;
  for (let i = 0; i < normQuery.length; i++) hit += covered[i];
  return hit / normQuery.length;
}

export function buildIndex(chunks) {
  const df = new Map();
  let totalLen = 0;
  for (const c of chunks) {
    totalLen += c.tokens.length;
    for (const t of new Set(c.tokens)) df.set(t, (df.get(t) || 0) + 1);
  }
  const N = chunks.length;

  const idf = (term) => {
    const d = df.get(term) || 0;
    return Math.log(1 + (N - d + 0.5) / (d + 0.5));
  };

  return { chunks, df, N, avgdl: N ? totalLen / N : 0, idf };
}

/**
 * @returns {{results: Array, hasEvidence: boolean, coverage: number, terms: string[]}}
 */
export function search(index, query, { topK = 5 } = {}) {
  const terms = queryTokens(query);
  const normQuery = normalize(query);

  if (!index.N || (!terms.length && !normQuery)) {
    return { results: [], hasEvidence: false, coverage: 0, terms };
  }

  const { chunks, avgdl, idf } = index;
  const termIdf = new Map(terms.map((t) => [t, idf(t)]));

  // —— 第一轮：BM25 粗排 ——
  const rough = [];
  for (const c of chunks) {
    const tf = new Map();
    for (const t of c.tokens) tf.set(t, (tf.get(t) || 0) + 1);
    const dl = c.tokens.length || 1;

    let score = 0;
    for (const t of terms) {
      const f = tf.get(t) || 0;
      if (!f) continue;
      score += (termIdf.get(t) * (f * (K1 + 1))) / (f + K1 * (1 - B + (B * dl) / (avgdl || 1)));
    }
    if (score > 0) rough.push({ chunk: c, score });
  }
  rough.sort((a, b) => b.score - a.score);

  // —— 第二轮：字符覆盖复核 ——
  const scored = [];
  const seen = new Set();
  const nameNormCache = new Map();

  function nameBoostOf(docName) {
    if (!normQuery) return 0;
    let nameNorm = nameNormCache.get(docName);
    if (nameNorm === undefined) {
      nameNorm = normalize(docName);
      nameNormCache.set(docName, nameNorm);
    }
    for (let len = Math.min(normQuery.length, 8); len >= 2; len--) {
      for (let i = 0; i + len <= normQuery.length; i++) {
        if (nameNorm.includes(normQuery.slice(i, i + len))) return 0.3 + len * 0.15;
      }
    }
    return 0;
  }

  function scoreChunk(chunk, bm25) {
    const coverage = charCoverage(normQuery, `${chunk.docName}\n${chunk.text}`);
    if (!coverage) return 0;
    scored.push({
      chunk,
      bm25,
      coverage,
      score: bm25 * (0.45 + 0.55 * coverage) + nameBoostOf(chunk.docName)
    });
    seen.add(chunk.id);
    return coverage;
  }

  for (const r of rough.slice(0, 60)) scoreChunk(r.chunk, r.score);

  // 关键补扫：BM25 的命中集可能完全不含真正相关的文档
  // （口语问法切出的 bigram 在原文里根本不存在，例如「多少钱」vs 原文「价格」）。
  // 一旦粗排结果里没有足够覆盖的片段，就退回全量字符覆盖，避免把有依据的问题判成「没查到」。
  let bestCoverage = scored.reduce((m, s) => Math.max(m, s.coverage), 0);
  if (bestCoverage < 0.5) {
    const limit = Math.min(chunks.length, 800);
    for (let i = 0; i < limit; i++) {
      const c = chunks[i];
      if (seen.has(c.id)) continue;
      scoreChunk(c, 0);
    }
  }

  scored.sort((a, b) => b.score - a.score);

  const top = scored[0];
  const coverage = top ? top.coverage : 0;

  // 依据判定：查询字符至少三成能在原文里连续找到；
  // 若 BM25 没有任何信号（纯口语问法），则要求覆盖率更高，避免个别字巧合命中。
  const strongByCoverage = Boolean(top && top.coverage >= 0.5 && normQuery.length >= 3);
  const hasEvidence = Boolean(top && top.coverage >= 0.34 && (top.bm25 > 0 || strongByCoverage));

  return {
    results: scored.slice(0, topK).map((r) => ({
      ...r.chunk,
      score: Number(r.score.toFixed(3)),
      bm25: Number(r.bm25.toFixed(3)),
      coverage: Number(r.coverage.toFixed(3))
    })),
    hasEvidence,
    coverage: Number(coverage.toFixed(3)),
    terms
  };
}

export { charCoverage, normalize };
