#!/usr/bin/env node
/**
 * dsh-vision-mcp —— 零依赖 MCP 识图服务器（stdio 传输）
 *
 * 作用：让本身不支持图片的模型（纯文本模型）获得"看图"能力。
 * 流程：主模型调用工具 img2text(image, prompt?) ->
 *       server 读取图片（本地路径 / URL / data URL / base64）->
 *       按顺序尝试配置的视觉模型（OpenAI 兼容 /chat/completions）->
 *       把视觉模型返回的文字描述作为工具结果交回主模型继续推理。
 *
 * 支持多供应商 fallback：一个模型限流/报错自动换下一个，全部失败才返回错误。
 *
 * 环境变量：
 *   VISION_PROVIDERS   【推荐】JSON 数组，每个元素一个模型：
 *     [{"name":"qwen","base":"https://dashscope.aliyuncs.com/compatible-mode/v1",
 *       "model":"qwen3-vl-flash","apiKey":"sk-xxx"},
 *      {"name":"glm","base":"https://open.bigmodel.cn/api/paas/v4",
 *       "model":"glm-4v-flash","apiKey":"sk-yyy"}]
 *     name 可选（用于标注结果）；base/model/apiKey 均可省略，省略时用下面的单套默认值。
 *   VISION_API_KEY      单套模式密钥（本地 Ollama 等可省略）
 *   VISION_API_BASE     单套模式 API 地址，默认 https://api.openai.com/v1
 *   VISION_MODEL        单套模式模型名，默认 gpt-4o-mini
 *   VISION_MAX_TOKENS   最大输出 token，默认 4096
 *   VISION_TEMPERATURE  采样温度，默认 0.2
 *   VISION_TIMEOUT_MS   单次请求超时（毫秒），默认 120000
 *
 * 运行：node server.js   （由 MCP 客户端以 stdio 方式拉起）
 */

const fs = require('fs');
const path = require('path');

const defaults = {
  apiKey: process.env.VISION_API_KEY || '',
  baseUrl: (process.env.VISION_API_BASE || 'https://api.openai.com/v1').replace(/\/+$/, ''),
  model: process.env.VISION_MODEL || 'gpt-4o-mini',
  maxTokens: parseInt(process.env.VISION_MAX_TOKENS || '4096', 10),
  temperature: parseFloat(process.env.VISION_TEMPERATURE || '0.2'),
  timeoutMs: parseInt(process.env.VISION_TIMEOUT_MS || '120000', 10),
};

/** 解析模型列表：VISION_PROVIDERS(JSON) 优先，否则回退单套环境变量。 */
function parseProviders() {
  const raw = (process.env.VISION_PROVIDERS || '').trim();
  if (raw) {
    try {
      const list = JSON.parse(raw);
      if (Array.isArray(list) && list.length > 0) {
        return list.map((p, i) => ({
          name: String(p.name || p.model || `provider${i + 1}`),
          base: String(p.base || defaults.baseUrl).replace(/\/+$/, ''),
          model: String(p.model || defaults.model),
          apiKey: String(p.apiKey ?? ''),
          reasoning: p.reasoning === undefined || p.reasoning === null ? undefined : String(p.reasoning),
        }));
      }
    } catch (e) {
      process.stderr.write(`[dsh-vision-mcp] VISION_PROVIDERS 不是合法 JSON，回退单套配置：${e.message}\n`);
    }
  }
  return [{ name: defaults.model, base: defaults.baseUrl, model: defaults.model, apiKey: defaults.apiKey, reasoning: undefined }];
}

/** 全局思考控制（provider 未单独配置时生效）：none / low / medium / high，留空按模型默认。 */
const defaultReasoning = process.env.VISION_REASONING && String(process.env.VISION_REASONING).trim()
  ? String(process.env.VISION_REASONING).trim()
  : undefined;

const providers = parseProviders();
const TOOL_NAME = 'img2text';

const DEFAULT_PROMPT = '详细描述这张图片的内容，逐字提取图中所有可见文字，并说明主要对象、空间布局、颜色与元素之间的关系以及值得注意的细节。';

const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
  '.avif': 'image/avif', '.svg': 'image/svg+xml', '.tiff': 'image/tiff',
  '.tif': 'image/tiff', '.heic': 'image/heic', '.ico': 'image/x-icon',
};

/** 按文件头魔数嗅探 MIME；未知时回退扩展名推断，再回退 image/png。 */
function sniffMime(data, fallback) {
  if (!data || data.length < 12) return fallback;
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46) return 'image/webp'; // RIFF....WEBP
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return 'image/gif';
  if (data[0] === 0x42 && data[1] === 0x4d) return 'image/bmp';
  if (data[0] === 0x00 && data[1] === 0x00 && data[2] === 0x00 && (data[3] === 0x1c || data[3] === 0x18)) return 'image/heic';
  return fallback;
}

function mimeOf(p) {
  return MIME_BY_EXT[(path.extname(p) || '').toLowerCase()] || 'image/png';
}

/** 加载图片 -> { mime, data(Buffer) }。支持 path / http(s) URL / data URL / 纯 base64。 */
async function loadImage(image) {
  if (typeof image !== 'string' || !image.trim()) {
    throw new Error('image 参数缺失：请传本地路径 / http(s) URL / data URL 或 base64');
  }
  image = image.trim();

  if (image.startsWith('data:')) {
    const m = image.match(/^data:([^;,]+)[^,]*,(.+)$/s);
    if (!m) throw new Error('data URL 格式无效');
    return { mime: m[1] || 'image/png', data: Buffer.from(m[2], 'base64') };
  }

  if (/^https?:\/\//i.test(image)) {
    const res = await fetch(image, { redirect: 'follow' });
    if (!res.ok) throw new Error(`下载图片失败：HTTP ${res.status}`);
    const data = Buffer.from(await res.arrayBuffer());
    return { mime: res.headers.get('content-type') || 'image/png', data };
  }

  // 纯 base64（无 data: 前缀的较长字符串）
  if (/^[A-Za-z0-9+/=]{100,}$/.test(image) && !image.includes(' ')) {
    return { mime: 'image/png', data: Buffer.from(image, 'base64') };
  }

  const p = path.resolve(image);
  if (!fs.existsSync(p)) throw new Error(`文件不存在：${p}`);
  const data = fs.readFileSync(p);
  return { mime: sniffMime(data, mimeOf(p)), data };
}

/** 调用单个 OpenAI-compatible /chat/completions 视觉接口，返回文本。 */
async function analyze(provider, image, prompt, maxTokens) {
  const { mime, data } = await loadImage(image);
  const reasoning = provider.reasoning ?? defaultReasoning;
  const body = {
    model: provider.model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt || DEFAULT_PROMPT },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${data.toString('base64')}` } },
      ],
    }],
    max_tokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : defaults.maxTokens,
    // 显式控制思考时下发 reasoning_effort（none=关闭，不发该参数以免部分模型 400）；其余情况发 temperature
    ...(reasoning && reasoning !== 'none' ? { reasoning_effort: reasoning } : { temperature: defaults.temperature }),
  };

  const headers = { 'content-type': 'application/json' };
  if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), defaults.timeoutMs);
  try {
    const res = await fetch(`${provider.base}/chat/completions`, {
      method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}：${errText.slice(0, 300)}`);
    }
    const json = await res.json();
    const content = json.choices?.[0]?.message?.content;
    if (typeof content === 'string' && content.trim()) return content.trim();
    if (Array.isArray(content)) {
      const txt = content
        .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text).join('\n').trim();
      if (txt) return txt;
    }
    throw new Error('空内容');
  } finally {
    clearTimeout(timer);
  }
}

/** 是否需要换下一个模型：限流/服务端错误/网络错误/超时/空内容。 */
function isRetryable(err) {
  const m = String(err.message || '');
  if (/HTTP 429|HTTP 5\d\d|HTTP 400/.test(m)) return true;
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|超时|abort|AbortError|空内容|getaddrinfo|ETIMEDOUT/.test(m)) return true;
  return false;
}

/** 按顺序尝试所有模型，限流/报错自动切换下一个；全部失败返回汇总错误。 */
async function analyzeWithFallback(image, prompt, maxTokens) {
  const errors = [];
  for (const p of providers) {
    try {
      const text = await analyze(p, image, prompt, maxTokens);
      return providers.length > 1 ? `[provider: ${p.name}] ${text}` : text;
    } catch (e) {
      errors.push(`${p.name}(${p.model})：${e.message}`);
      if (!isRetryable(e)) break; // 认证/参数类错误（401/403 等），换下一个大概率也没用，直接终止
    }
  }
  throw new Error(`全部 ${providers.length} 个视觉模型均失败：\n${errors.join('\n')}`);
}

/* ---------------- MCP stdio：JSON-RPC 2.0 over stdin/stdout ---------------- */

const readline = require('readline');

const tools = [{
  name: TOOL_NAME,
  description:
    '读取图片并把内容转换为文字描述。接受本地文件路径、http(s) URL、data URL 或 base64。' +
    '由外部视觉模型（VISION_PROVIDERS 配置的一组 OpenAI 兼容模型，自动 fallback）完成识别，' +
    '返回纯文本，供本身不支持图片输入的模型理解图片。' +
    '使用时机：① 你能直接查看图片时（原生多模态输入），无需调用本工具；② 用户提供图片路径/URL/图片附件引用（形如 "[图片附件：名称] 图片文件：<绝对路径>"）且你无法直接看到图片内容时，' +
    '立即调用本工具读取并转述内容，不要回复"无法查看图片"；③ 用户要求分析/读取某张图片时。' +
    'prompt 参数：用户有具体问题时传用户的问题；没有问题时不要传（server 使用默认提示词）。' +
    '转述时保持简洁：先一句话概括图片是什么，再列关键信息（主要文字、重点元素），不要输出大段分析。',
  inputSchema: {
    type: 'object',
    properties: {
      image: {
        type: 'string',
        description: '图片来源：本地绝对路径 / http(s) URL / data URL / base64 字符串；图片附件引用中的 "图片文件：" 后即为绝对路径',
      },
      prompt: {
        type: 'string',
        description: '可选分析指令。用户有具体问题时传用户的问题；没有问题时不要传此参数（server 使用默认提示词）',
      },
      max_tokens: {
        type: 'number',
        description: '可选，覆盖视觉模型最大输出 token 数',
      },
    },
    required: ['image'],
  },
}];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handle(msg) {
  const { id, method, params = {} } = msg;

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'dsh-vision-mcp', version: '1.1.0' },
      },
    });
    return;
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'ping') { send({ jsonrpc: '2.0', id, result: {} }); return; }
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools } });
    return;
  }
  if (method === 'tools/call') {
    const { name, arguments: args = {} } = params;
    try {
      if (name !== TOOL_NAME) throw new Error(`未知工具：${name}`);
      const text = await analyzeWithFallback(args.image, args.prompt, args.max_tokens);
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: false } });
    } catch (e) {
      send({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: `识图失败：${e.message}` }], isError: true },
      });
    }
    return;
  }
  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  handle(msg).catch((e) => {
    if (msg && msg.id !== undefined) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(e.message || e) } });
    }
  });
});

process.stderr.write(
  `[dsh-vision-mcp] ready: ${providers.map((p) => `${p.name}(${p.model}@${p.base})`).join(' , ')}\n`,
);
