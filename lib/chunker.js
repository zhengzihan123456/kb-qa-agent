/**
 * 文档切片。
 *
 * 关键要求：每个片段必须能定位回原文——因此切片同时记录
 *   charStart / charEnd（原文字符偏移，end 不含）
 *   startLine / endLine（1 起的行号，含两端）
 * 前端据此在原文视图里精确高亮。
 */

const TARGET_SIZE = 460; // 目标片段长度（字符）
const MAX_SIZE = 900; // 单个片段上限，超过就按句子切开
const MIN_SIZE = 90; // 过短的片段尝试并入相邻片段

/** 把字符偏移换算成 1 起行号 */
function lineAt(text, offset) {
  let line = 1;
  const limit = Math.min(offset, text.length);
  for (let i = 0; i < limit; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

/** 按空行切出段落块，保留字符偏移 */
function splitBlocks(content) {
  const blocks = [];
  const re = /[^\n]+(?:\n[^\n]+)*/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const raw = m[0];
    const start = m.index;
    const end = m.index + raw.length;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    // 段落内如果包含标题行，也拆开，避免标题被埋进大段正文
    const lines = raw.split('\n');
    let cursor = start;
    let buf = [];
    let bufStart = start;
    const pushBuf = () => {
      if (!buf.length) return;
      const text = buf.join('\n');
      const s = bufStart;
      const e = bufStart + text.length;
      if (text.trim()) blocks.push({ text, start: s, end: e });
      buf = [];
    };
    for (const line of lines) {
      const isHeading = /^#{1,6}\s/.test(line);
      const lineStart = cursor;
      cursor += line.length + 1;
      if (isHeading && buf.length) {
        pushBuf();
        bufStart = lineStart;
      }
      if (!buf.length) bufStart = lineStart;
      buf.push(line);
      if (isHeading) pushBuf();
    }
    pushBuf();
  }
  return blocks;
}

/** 段落本身超长时按句子切开 */
function splitLongBlock(block) {
  if (block.text.length <= MAX_SIZE) return [block];
  const parts = [];
  const sentences = block.text.split(/(?<=[。！？；\n])/);
  let buf = '';
  let bufStart = block.start;
  for (const s of sentences) {
    if (!s) continue;
    if (buf.length + s.length > TARGET_SIZE && buf.length) {
      parts.push({ text: buf, start: bufStart, end: bufStart + buf.length });
      bufStart = bufStart + buf.length;
      buf = '';
    }
    buf += s;
  }
  if (buf.trim()) parts.push({ text: buf, start: bufStart, end: bufStart + buf.length });
  return parts.length ? parts : [block];
}

/**
 * @param {string} content 原文
 * @param {string} docId
 * @param {string} docName
 * @returns {Array<object>} 片段列表
 */
function chunkDocument(content, docId, docName) {
  const blocks = splitBlocks(content).flatMap(splitLongBlock);

  // 聚合到目标长度
  const merged = [];
  let cur = null;
  for (const b of blocks) {
    if (!cur) {
      cur = { ...b };
      continue;
    }
    const gap = b.start - cur.end;
    const canMerge = cur.text.length < MIN_SIZE || cur.text.length + b.text.length <= TARGET_SIZE;
    if (canMerge && gap <= 2) {
      cur.text = content.slice(cur.start, b.end);
      cur.end = b.end;
    } else {
      merged.push(cur);
      cur = { ...b };
    }
  }
  if (cur) merged.push(cur);

  return merged.map((b, i) => {
    const text = content.slice(b.start, b.end);
    return {
      id: `${docId}#${i}`,
      docId,
      docName,
      index: i,
      text: text.trim(),
      charStart: b.start,
      charEnd: b.end,
      startLine: lineAt(content, b.start),
      endLine: lineAt(content, Math.max(b.start, b.end - 1))
    };
  });
}

export { chunkDocument };
