const LS_KEY = 'kbqa.llm.v1';

const PRESETS = {
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  dashscope: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  zhipu: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  moonshot: { baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' }
};

const state = {
  docs: [],
  stats: { docs: 0, chunks: 0, llmConfigured: false },
  llm: loadLlm(),
  busy: false,
  seq: 0
};

const el = {
  chat: document.getElementById('chat'),
  stage: document.getElementById('stage'),
  hero: document.getElementById('hero'),
  messages: document.getElementById('messages'),
  input: document.getElementById('input'),
  send: document.getElementById('send'),
  banner: document.getElementById('banner'),
  bannerText: document.getElementById('bannerText'),
  bannerAction: document.getElementById('bannerAction'),
  overlay: document.getElementById('overlay'),
  kbCount: document.getElementById('kbCount'),
  docDrawer: document.getElementById('docDrawer'),
  docTitle: document.getElementById('docTitle'),
  docMeta: document.getElementById('docMeta'),
  docBody: document.getElementById('docBody'),
  kbDrawer: document.getElementById('kbDrawer'),
  kbMeta: document.getElementById('kbMeta'),
  docList: document.getElementById('docList'),
  settingsDrawer: document.getElementById('settingsDrawer'),
  baseUrl: document.getElementById('baseUrl'),
  model: document.getElementById('model'),
  apiKey: document.getElementById('apiKey'),
  preset: document.getElementById('preset'),
  testResult: document.getElementById('testResult'),
  newName: document.getElementById('newName'),
  newContent: document.getElementById('newContent'),
  fileInput: document.getElementById('fileInput'),
  fileName: document.getElementById('fileName')
};

const msgStore = new Map();

/* ---------------- 工具 ---------------- */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

function renderRich(text) {
  const inline = (s) =>
    s
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[(\d{1,2})\]/g, '<span class="ref" data-idx="$1" role="button" tabindex="0">$1</span>');

  const lines = esc(text).split('\n');
  let html = '';
  let list = [];
  const flush = () => {
    if (!list.length) return;
    html += '<ul>' + list.map((i) => `<li>${inline(i)}</li>`).join('') + '</ul>';
    list = [];
  };
  for (const raw of lines) {
    const t = raw.trim();
    if (/^[-*]\s+/.test(t)) {
      list.push(t.replace(/^[-*]\s+/, ''));
      continue;
    }
    flush();
    if (!t) continue;
    html += `<p>${inline(t)}</p>`;
  }
  flush();
  return html || '<p></p>';
}

function loadLlm() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    return {
      baseUrl: raw.baseUrl || PRESETS.deepseek.baseUrl,
      model: raw.model || PRESETS.deepseek.model,
      apiKey: raw.apiKey || ''
    };
  } catch {
    return { baseUrl: PRESETS.deepseek.baseUrl, model: PRESETS.deepseek.model, apiKey: '' };
  }
}

function saveLlm() {
  localStorage.setItem(LS_KEY, JSON.stringify(state.llm));
}

/* ---------------- 抽屉 ---------------- */

function openDrawer(node) {
  node.hidden = false;
  el.overlay.hidden = false;
  requestAnimationFrame(() => {
    node.classList.add('open');
    el.overlay.classList.add('show');
  });
}

function closeDrawers() {
  const drawers = [el.docDrawer, el.kbDrawer, el.settingsDrawer];
  for (const d of drawers) {
    if (d.hidden) continue;
    d.classList.remove('open');
    setTimeout(() => {
      if (!d.classList.contains('open')) d.hidden = true;
    }, 270);
  }
  el.overlay.classList.remove('show');
  setTimeout(() => {
    el.overlay.hidden = true;
  }, 220);
}

el.overlay.addEventListener('click', closeDrawers);
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeDrawers));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDrawers();
});

/* ---------------- 状态 ---------------- */

async function refreshStats() {
  try {
    const s = await fetch('/api/stats').then((r) => r.json());
    state.stats = s;
    el.kbCount.textContent = s.docs;
    updateBanner();
  } catch {
    /* 静默 */
  }
}

function updateBanner() {
  const needKey = !state.stats.llmConfigured && !state.llm.apiKey;
  if (needKey) {
    el.banner.hidden = false;
    el.bannerAction.hidden = false;
    el.bannerText.textContent = '尚未配置大模型，当前只能用原文摘录方式作答。填入 API Key 后即可获得归纳回答。';
    el.banner.onclick = null;
  } else {
    el.banner.hidden = true;
  }
}

/* ---------------- 渲染消息 ---------------- */

function scrollToBottom() {
  el.chat.scrollTop = el.chat.scrollHeight;
}

function addUserMessage(text) {
  el.hero.hidden = true;
  const wrap = document.createElement('div');
  wrap.className = 'msg user';
  wrap.innerHTML = `<div class="bubble-user">${esc(text)}</div>`;
  el.messages.appendChild(wrap);
  scrollToBottom();
}

function addThinking() {
  const wrap = document.createElement('div');
  wrap.className = 'msg';
  wrap.innerHTML = `
    <div class="answer">
      <div class="answer-head"><span class="who">知识问答 Agent</span><span class="tag ai">检索中</span></div>
      <div class="thinking"><span class="dots"><i></i><i></i><i></i></span><span>正在知识库里找依据…</span></div>
    </div>`;
  el.messages.appendChild(wrap);
  scrollToBottom();
  return wrap;
}

const MODE_LABEL = {
  llm: { text: 'AI 作答', cls: 'ai' },
  excerpt: { text: '原文摘录', cls: 'excerpt' },
  insufficient: { text: '未查到', cls: 'miss' },
  error: { text: '调用失败', cls: 'err' }
};

function citationsHTML(citations) {
  if (!citations || !citations.length) return '';
  const items = citations
    .map((c) => {
      const snip = c.text.replace(/\s+/g, ' ').slice(0, 150);
      return `
        <button class="cite-item" type="button" data-idx="${c.index}">
          <span class="cite-num">${c.index}</span>
          <span class="cite-main">
            <span class="cite-top">
              <span class="cite-doc">${esc(c.docName)}</span>
              <span class="cite-loc">第 ${c.startLine}–${c.endLine} 行 · <span class="go">定位原文</span></span>
            </span>
            <span class="cite-snip">${esc(snip)}</span>
          </span>
        </button>`;
    })
    .join('');
  return `<div class="cites"><div class="cites-title">依据 ${citations.length} 条 · 点击可查看原文位置</div>${items}</div>`;
}

function renderAnswer(wrap, payload) {
  const id = `m${++state.seq}`;
  const mode = MODE_LABEL[payload.mode] || MODE_LABEL.error;
  msgStore.set(id, payload);

  const miss = payload.mode === 'insufficient';
  const body = renderRich(payload.answer);
  const foot = [];
  if (payload.mode === 'llm' || payload.mode === 'excerpt') {
    foot.push(`命中 ${payload.retrieved?.length || 0} 个片段`);
  }
  if (typeof payload.elapsedMs === 'number') foot.push(`${(payload.elapsedMs / 1000).toFixed(1)}s`);

  wrap.innerHTML = `
    <div class="answer" data-id="${id}">
      <div class="answer-head">
        <span class="who">知识问答 Agent</span>
        <span class="tag ${mode.cls}">${mode.text}</span>
        <span class="tag time">${foot.join(' · ')}</span>
      </div>
      <div class="answer-body${miss ? ' miss' : ''}">${body}</div>
      ${citationsHTML(payload.citations)}
      ${payload.notice ? `<div class="answer-foot">${esc(payload.notice)}</div>` : ''}
    </div>`;
  scrollToBottom();
}

/* ---------------- 提问 ---------------- */

async function ask(question) {
  if (state.busy) return;
  const q = String(question || '').trim();
  if (!q) return;

  state.busy = true;
  el.send.disabled = true;
  el.input.value = '';
  el.input.style.height = 'auto';

  addUserMessage(q);
  const placeholder = addThinking();

  try {
    const body = { question: q, topK: 5 };
    if (state.llm.apiKey) body.llm = state.llm;

    const res = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();

    if (!res.ok) {
      renderAnswer(placeholder, {
        mode: 'error',
        answer: data.error || '请求失败，请稍后重试。',
        citations: [],
        retrieved: []
      });
    } else {
      renderAnswer(placeholder, data);
      if (data.stats) {
        state.stats = { ...state.stats, ...data.stats };
        el.kbCount.textContent = data.stats.docs;
      }
    }
  } catch (err) {
    renderAnswer(placeholder, {
      mode: 'error',
      answer: `网络异常，无法连接服务：${err.message}`,
      citations: [],
      retrieved: []
    });
  } finally {
    state.busy = false;
    el.send.disabled = false;
    el.input.focus();
  }
}

/* ---------------- 原文定位 ---------------- */

async function openSource(docId, startLine, endLine) {
  openDrawer(el.docDrawer);
  el.docTitle.textContent = '加载中…';
  el.docMeta.textContent = '';
  el.docBody.innerHTML = '<p style="color:#98a2b3">正在读取原文…</p>';

  try {
    const doc = await fetch(`/api/docs/${docId}`).then((r) => {
      if (!r.ok) throw new Error('文档不存在或已被删除');
      return r.json();
    });

    el.docTitle.textContent = doc.name;
    el.docMeta.textContent = `共 ${doc.content.split('\n').length} 行 · 定位第 ${startLine}–${endLine} 行`;

    const lines = doc.content.split('\n');
    el.docBody.innerHTML = lines
      .map((line, i) => {
        const no = i + 1;
        const hl = no >= startLine && no <= endLine;
        const isHead = /^#{1,6}\s/.test(line);
        return `<div class="doc-line${hl ? ' hl' : ''}${isHead ? ' headline' : ''}" data-line="${no}">
          <span class="line-no">${no}</span>
          <span class="line-text">${esc(line) || '&nbsp;'}</span>
        </div>`;
      })
      .join('');

    const target = el.docBody.querySelector('.doc-line.hl');
    if (target) {
      el.docBody.scrollTop = Math.max(0, target.offsetTop - el.docBody.clientHeight / 3);
    } else {
      el.docBody.scrollTop = 0;
    }
  } catch (err) {
    el.docTitle.textContent = '打开失败';
    el.docBody.innerHTML = `<p style="color:#b42318">${esc(err.message)}</p>`;
  }
}

/* ---------------- 引用点击 ---------------- */

el.messages.addEventListener('click', (e) => {
  const answerEl = e.target.closest('.answer');
  if (!answerEl) return;
  const payload = msgStore.get(answerEl.dataset.id);
  if (!payload) return;

  const refEl = e.target.closest('.ref, .cite-item');
  if (!refEl) return;
  const idx = Number(refEl.dataset.idx);
  const cite = (payload.citations || []).find((c) => c.index === idx);
  if (!cite) return;
  openSource(cite.docId, cite.startLine, cite.endLine);
});

el.messages.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const refEl = e.target.closest('.ref');
  if (refEl) {
    e.preventDefault();
    refEl.click();
  }
});

/* ---------------- 知识库 ---------------- */

async function loadDocs() {
  try {
    const data = await fetch('/api/docs').then((r) => r.json());
    state.docs = data.docs || [];
    renderDocs();
  } catch {
    /* 静默 */
  }
}

function renderDocs() {
  el.kbCount.textContent = state.docs.length;
  el.kbMeta.textContent = `${state.docs.length} 篇文档 · ${state.stats.chunks || 0} 个可检索片段`;
  if (!state.docs.length) {
    el.docList.innerHTML = '<li class="empty-list">知识库还是空的，先添加一篇文档。</li>';
    return;
  }
  el.docList.innerHTML = state.docs
    .map(
      (d) => `<li class="doc-row">
        <span class="name" title="${esc(d.name)}">${esc(d.name)}</span>
        <span class="meta">${d.chunkCount} 段 · ${d.chars} 字</span>
        <button class="del" type="button" data-del="${d.id}" data-name="${esc(d.name)}">删除</button>
      </li>`
    )
    .join('');
}

el.docList.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-del]');
  if (!btn) return;
  const name = btn.dataset.name;
  if (!confirm(`确定从知识库删除《${name}》？删除后该文档的片段将无法被检索到。`)) return;
  btn.disabled = true;
  try {
    const res = await fetch(`/api/docs/${btn.dataset.del}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('删除失败');
    await loadDocs();
    await refreshStats();
  } catch (err) {
    alert(err.message);
    btn.disabled = false;
  }
});

el.fileInput.addEventListener('change', () => {
  const file = el.fileInput.files && el.fileInput.files[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) {
    alert('文件超过 2MB，请拆分后再添加。');
    el.fileInput.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    el.newContent.value = String(reader.result || '');
    el.newName.value = file.name.replace(/\.(md|markdown|txt)$/i, '');
    el.fileName.textContent = `${file.name} · ${(file.size / 1024).toFixed(1)} KB`;
  };
  reader.readAsText(file, 'utf-8');
});

document.getElementById('btnAdd').addEventListener('click', async (e) => {
  const name = el.newName.value.trim();
  const content = el.newContent.value.trim();
  if (!content) {
    alert('请先粘贴内容或选择文件。');
    return;
  }
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = '保存中…';
  try {
    const res = await fetch('/api/docs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, content })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '保存失败');
    el.newName.value = '';
    el.newContent.value = '';
    el.fileInput.value = '';
    el.fileName.textContent = '';
    document.getElementById('addBox').open = false;
    await loadDocs();
    await refreshStats();
    el.kbMeta.textContent = `已保存《${data.name}》，共 ${data.stats.docs} 篇文档`;
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '保存到知识库';
  }
});

/* ---------------- 设置 ---------------- */

function fillSettings() {
  el.baseUrl.value = state.llm.baseUrl;
  el.model.value = state.llm.model;
  el.apiKey.value = state.llm.apiKey;
}

el.preset.addEventListener('change', () => {
  const p = PRESETS[el.preset.value];
  if (!p) return;
  el.baseUrl.value = p.baseUrl;
  el.model.value = p.model;
});

document.getElementById('btnSaveCfg').addEventListener('click', () => {
  state.llm = {
    baseUrl: el.baseUrl.value.trim() || PRESETS.deepseek.baseUrl,
    model: el.model.value.trim() || PRESETS.deepseek.model,
    apiKey: el.apiKey.value.trim()
  };
  saveLlm();
  el.testResult.textContent = '已保存到本机浏览器。';
  el.testResult.className = 'test-result ok';
  updateBanner();
  closeDrawers();
});

document.getElementById('btnTest').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const cfg = {
    baseUrl: el.baseUrl.value.trim(),
    model: el.model.value.trim(),
    apiKey: el.apiKey.value.trim()
  };
  btn.disabled = true;
  el.testResult.textContent = '正在连接…';
  el.testResult.className = 'test-result';
  try {
    const res = await fetch('/api/config/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ llm: cfg })
    });
    const data = await res.json();
    if (data.ok) {
      el.testResult.textContent = `连接成功，模型 ${data.model} 返回：${data.reply}`;
      el.testResult.className = 'test-result ok';
    } else {
      el.testResult.textContent = `失败：${data.error}${data.detail ? `（${String(data.detail).slice(0, 120)}）` : ''}`;
      el.testResult.className = 'test-result bad';
    }
  } catch (err) {
    el.testResult.textContent = `请求失败：${err.message}`;
    el.testResult.className = 'test-result bad';
  } finally {
    btn.disabled = false;
  }
});

/* ---------------- 事件绑定 ---------------- */

document.getElementById('btnKb').addEventListener('click', async () => {
  openDrawer(el.kbDrawer);
  await loadDocs();
});

document.getElementById('btnSettings').addEventListener('click', () => {
  fillSettings();
  el.testResult.textContent = '';
  openDrawer(el.settingsDrawer);
});

el.bannerAction.addEventListener('click', () => {
  fillSettings();
  openDrawer(el.settingsDrawer);
});

document.getElementById('samples').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (chip) ask(chip.textContent);
});

el.send.addEventListener('click', () => ask(el.input.value));

el.input.addEventListener('input', () => {
  el.input.style.height = 'auto';
  el.input.style.height = `${Math.min(el.input.scrollHeight, 148)}px`;
});

el.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    ask(el.input.value);
  }
});

/* ---------------- 启动 ---------------- */

(async function init() {
  fillSettings();
  await refreshStats();
  await loadDocs();
})();
