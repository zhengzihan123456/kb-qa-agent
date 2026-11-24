/**
 * 大模型调用（OpenAI 兼容协议）。
 * 支持 DeepSeek / 通义 / 智谱 / Moonshot / OpenAI 等任何兼容 /chat/completions 的服务。
 */

const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';
const DEFAULT_MODEL = 'deepseek-chat';

export function resolveConfig(override = {}) {
  const envBase = process.env.LLM_BASE_URL || '';
  const envKey = process.env.LLM_API_KEY || '';
  const envModel = process.env.LLM_MODEL || '';

  // 服务端环境变量优先（部署者统一配置），否则用请求里带上来的用户配置
  const baseUrl = (envKey ? envBase : override.baseUrl || envBase) || DEFAULT_BASE_URL;
  const apiKey = envKey || override.apiKey || '';
  const model = (envKey ? envModel : override.model || envModel) || DEFAULT_MODEL;

  return {
    baseUrl: String(baseUrl).replace(/\/+$/, ''),
    apiKey: String(apiKey),
    model: String(model),
    configured: Boolean(apiKey)
  };
}

export async function chatCompletion({ baseUrl, apiKey, model, messages, temperature = 0.1, maxTokens = 900 }) {
  if (!apiKey) {
    const err = new Error('未配置大模型 API Key');
    err.code = 'NO_API_KEY';
    throw err;
  }

  const url = `${baseUrl}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: false
      }),
      signal: controller.signal
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const err = new Error(`模型接口返回 ${res.status}`);
      err.code = 'LLM_HTTP_ERROR';
      err.status = res.status;
      err.detail = detail.slice(0, 500);
      throw err;
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      const err = new Error('模型返回内容为空');
      err.code = 'LLM_EMPTY';
      throw err;
    }
    return { content: content.trim(), usage: data?.usage || null };
  } catch (err) {
    if (err.name === 'AbortError') {
      const e = new Error('模型响应超时（60 秒）');
      e.code = 'LLM_TIMEOUT';
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function testConnection(config) {
  const { content } = await chatCompletion({
    ...config,
    messages: [{ role: 'user', content: '只回复两个字：可用' }],
    maxTokens: 16
  });
  return content.slice(0, 40);
}
