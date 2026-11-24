/**
 * 轻量分词：中文按 bigram 切分，英文/数字按词切分。
 * 零依赖，够用于 BM25 检索，避免引入 jieba 之类的原生依赖。
 */

const CJK = /[\u4e00-\u9fff]/;
const CJK_RUN = /[\u4e00-\u9fff]+/g;
const WORD = /[a-z0-9][a-z0-9_.#+\-/]*/g;

// 疑问词 / 虚词 bigram，检索前剔除，避免「什么」「怎么」把不相干片段拉进结果
const STOP_TOKENS = new Set([
  '什么', '怎么', '如何', '为什', '么是', '是什', '哪些', '哪个', '哪里', '多少', '是否',
  '可以', '能不', '不能', '有没', '没有', '这个', '那个', '这些', '那些', '我们', '他们',
  '你们', '以及', '但是', '因为', '所以', '如果', '就是', '还是', '不是', '这样', '那样',
  '怎样', '么样', '请问', '一下', '帮我', '告诉', '介绍', '说明', '关于', '相关', '具体',
  '需要', '应该', '的话', '的话', '吗', '呢', '吧', '啊', '请', '的', '了', '是', '在',
  '和', '与', '或', '及', '对', '把', '被', '就', '都', '也', '很', '我', '你', '他',
  '她', '它', '这', '那', '个', '些', '有', '会', '要', '能', '用', '做', '么'
]);

function tokenize(text) {
  if (!text) return [];
  const lower = String(text).toLowerCase();
  const tokens = [];

  for (const m of lower.matchAll(WORD)) {
    const w = m[0];
    if (w.length >= 2 || /[0-9]/.test(w)) tokens.push(w);
  }

  for (const m of lower.matchAll(CJK_RUN)) {
    const run = m[0];
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
  }

  return tokens;
}

/** 查询用分词：去停用词 + 去重 */
function queryTokens(text) {
  const seen = new Set();
  const out = [];
  for (const t of tokenize(text)) {
    if (STOP_TOKENS.has(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  // 全部被停用词吃掉时（例如只问「怎么样」），退回原始分词，避免检索直接空转
  if (!out.length) return [...new Set(tokenize(text))];
  return out;
}

export { tokenize, queryTokens, STOP_TOKENS, CJK };
