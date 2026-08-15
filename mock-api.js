#!/usr/bin/env node
/**
 * mock-api.js —— 本地模拟 OpenAI-compatible 视觉 API（仅用于测试 server.js）
 *
 * 启动：node mock-api.js   （监听 localhost:9876）
 * 校验：POST /v1/chat/completions，检查请求体包含 image_url(data URL) 与 prompt，
 *       返回一段模拟识别文本（内含收到图片的字节长度，用于验证图片真的被传了过去）。
 */
const http = require('http');

const PORT = 9876;

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', async () => {
    let body = {};
    try { body = JSON.parse(raw); } catch { /* keep empty */ }

    const userMsg = Array.isArray(body.messages) ? body.messages[0] : null;
    const content = userMsg && userMsg.content;
    const textPart = Array.isArray(content) ? content.find((c) => c.type === 'text') : null;
    const imgPart = Array.isArray(content) ? content.find((c) => c.type === 'image_url') : null;
    const dataUrl = imgPart && imgPart.image_url && imgPart.image_url.url;

    const base64Len = (dataUrl && typeof dataUrl === 'string' && dataUrl.includes(','))
      ? dataUrl.split(',')[1].length
      : -1;
    const mimeSeen = (dataUrl && typeof dataUrl === 'string' && dataUrl.includes(';'))
      ? dataUrl.split(';')[0].replace('data:', '')
      : '(none)';
    const prompt = textPart ? textPart.text : '(no text part)';

    // 模拟限流：model 名含 "limit" 时返回 429（DashScope 风格）
    const model = body.model || '(none)';
    if (String(model).includes('limit')) {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: '1305', message: '该模型当前访问量过大，请您稍后再试' } }));
      return;
    }
    // 模拟参数错误：model 名含 "400" 时返回 400
    if (String(model).includes('400')) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Upstream error: 400', type: 'invalid_request_error' } }));
      return;
    }
    // 模拟慢响应：model 名含 "slow" 时延迟 1 秒（用于并发/串行对比）
    const sleep = String(model).includes('slow') ? 1000 : 0;
    if (sleep > 0) await new Promise((r) => setTimeout(r, sleep));

    const reply =
      'MOCK_VISION_OK\n' +
      `- received_image_base64_chars=${base64Len}\n` +
      `- mime=${mimeSeen}\n` +
      `- model=${model}\n` +
      `- prompt=${prompt.slice(0, 60)}${prompt.length > 60 ? '...' : ''}\n` +
      `- max_tokens=${body.max_tokens}\n` +
      `- reasoning_effort=${body.reasoning_effort === undefined ? '(unset)' : body.reasoning_effort}\n` +
      `- temperature=${body.temperature === undefined ? '(unset)' : body.temperature}\n` +
      '- 这张测试图片的内容：一个红色 1x1 像素点（模拟视觉模型描述）。';

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply } }] }));
  });
});

server.listen(PORT, 'localhost', () => {
  process.stderr.write(`[mock-api] listening on http://localhost:${PORT}/v1/chat/completions\n`);
});
