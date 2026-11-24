/**
 * 问答 Agent 的核心：检索 → 判定有无依据 → 受约束生成 → 引用校验。
 *
 * 设计原则（对应产品要求）：
 * 1. 先判定再生成。检索不到依据时直接返回「没查到」，不调用模型，杜绝靠记忆作答。
 * 2. 生成时只喂片段，并要求每句都带 [n] 引用。
 * 3. 生成后强制校验：答案里没有任何有效引用 → 视为没查到，丢弃该答案。
 */
import { search } from './retrieval.js';
import { chatCompletion } from './llm.js';

const SYSTEM_PROMPT = `你是「知识库问答助手」。你只能依据用户提供的【资料片段】作答，绝对不得使用资料之外的知识、常识、记忆或推测。

硬性规则：
1. 每一个事实性陈述后必须紧跟引用标记，格式如 [1] 或 [1][3]；编号必须是资料中真实存在的编号。
2. 不允许输出任何没有引用标记的事实性陈述。
3. 如果资料完全没有回答问题所需的信息，只输出一行：INSUFFICIENT
4. 如果资料只覆盖问题的一部分，先说明「资料只覆盖了……」，再只针对有资料的部分作答并标注引用。
5. 严禁编造文档名、数字、日期、链接、接口名、人名。
6. 用简体中文作答，条理清晰，控制在 200 字以内。
7. 不要在结尾罗列参考资料清单，也不要解释你的作答过程。`;

const INSUFFICIENT_TEXT = '知识库里没有查到能支撑这个问题的内容，因此不作答。你可以换一种问法，或先把相关文档补充进知识库。';

function buildContext(results) {
  return results
    .map((r, i) => `[${i + 1}] 文档《${r.docName}》第 ${r.startLine}-${r.endLine} 行\n${r.text}`)
    .join('\n\n');
}

function toCitation(r, index) {
  return {
    index,
    chunkId: r.chunkId,
    docId: r.docId,
    docName: r.docName,
    startLine: r.startLine,
    endLine: r.endLine,
    charStart: r.charStart,
    charEnd: r.charEnd,
    text: r.text,
    score: r.score
  };
}

/**
 * 校验模型输出：解析引用编号、剔除越界编号、判断是否真的用到了依据。
 */
export function validateAnswer(raw, candidates) {
  const text = String(raw || '').trim();

  if (/INSUFFICIENT/i.test(text)) {
    return { ok: false, reason: 'model-said-insufficient' };
  }

  const used = new Set();
  let dropped = 0;
  const cleaned = text.replace(/\[(\d{1,2})\]/g, (m, n) => {
    const i = Number(n);
    if (i >= 1 && i <= candidates.length) {
      used.add(i);
      return m;
    }
    dropped++;
    return '';
  });

  if (!used.size) {
    return { ok: false, reason: 'no-valid-citation', dropped };
  }

  const citations = [...used]
    .sort((a, b) => a - b)
    .map((i) => toCitation(candidates[i - 1], i));

  return { ok: true, answer: cleaned.trim(), citations, dropped };
}

/**
 * @param {object} params
 * @param {string} params.question
 * @param {object} params.index 检索索引
 * @param {object} params.llm   resolveConfig() 的结果
 * @param {number} [params.topK]
 * @returns {Promise<object>}
 */
export async function ask({ question, index, llm, topK = 5 }) {
  const q = String(question || '').trim();
  if (!q) {
    const err = new Error('问题不能为空');
    err.status = 400;
    throw err;
  }

  const { results, hasEvidence, coverage, terms } = search(index, q, { topK });

  // —— 第一道闸：检索层面就没有依据 ——
  if (!hasEvidence || !results.length) {
    return {
      mode: 'insufficient',
      reason: 'retrieval-empty',
      answer: INSUFFICIENT_TEXT,
      citations: [],
      retrieved: results,
      debug: { coverage, terms }
    };
  }

  const candidates = results.map((r, i) => ({ ...r, chunkId: r.id, index: i + 1 }));

  // —— 未配置模型：诚实降级为「原文摘录」，仍然给出可定位引用 ——
  if (!llm.configured) {
    // 摘录只取覆盖度够高的片段，避免把「勉强沾边」的内容当成答案展示
    const strong = candidates.filter((c) => c.coverage >= 0.5);
    const picked = (strong.length ? strong : candidates).slice(0, 3);
    return {
      mode: 'excerpt',
      answer:
        '当前没有配置大模型，下面直接给出知识库里最相关的原文片段（未经模型改写，因此不会编造内容）。配置模型后即可得到归纳后的回答。',
      citations: picked.map((c, i) => toCitation(c, i + 1)),
      retrieved: results,
      notice: '未配置大模型，当前为原文摘录模式。点击右上角「模型设置」填入 API Key 后即可启用 AI 作答。',
      debug: { coverage, terms }
    };
  }

  // —— 生成 ——
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `【资料片段】\n${buildContext(candidates)}\n\n【问题】\n${q}`
    }
  ];

  let raw;
  try {
    const out = await chatCompletion({ ...llm, messages });
    raw = out.content;
  } catch (err) {
    return {
      mode: 'error',
      answer: `调用大模型失败：${err.message}。知识库检索本身正常，可在「模型设置」里检查接口地址、模型名与 API Key。`,
      citations: [],
      retrieved: results,
      errorCode: err.code || 'LLM_ERROR',
      debug: { coverage, terms }
    };
  }

  const checked = validateAnswer(raw, candidates);

  // —— 第二道闸：模型没给出任何有效引用 → 判定为没查到，丢弃答案 ——
  if (!checked.ok) {
    return {
      mode: 'insufficient',
      reason: checked.reason === 'no-valid-citation' ? 'no-citation-from-model' : 'model-said-insufficient',
      answer: INSUFFICIENT_TEXT,
      citations: [],
      retrieved: results,
      debug: { coverage, terms, droppedCitations: checked.dropped || 0 }
    };
  }

  return {
    mode: 'llm',
    answer: checked.answer,
    citations: checked.citations,
    retrieved: results,
    debug: { coverage, terms, droppedCitations: checked.dropped || 0 }
  };
}

export { INSUFFICIENT_TEXT };
