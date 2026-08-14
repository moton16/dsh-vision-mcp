#!/usr/bin/env node
/**
 * test-client.js —— 模拟 MCP 客户端，端到端验证 server.js
 *
 * 流程：spawn server.js -> initialize -> tools/list -> tools/call(img2text) -> 校验输出 -> 退出
 * 用法：node test-client.js <image-path-or-url-or-data-url> [prompt]
 * 环境变量：VISION_API_BASE / VISION_MODEL / VISION_API_KEY 会透传给 server
 */
const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

const SERVER = path.join(__dirname, 'server.js');
const imageArg = process.argv[2] || path.join(__dirname, 'test.png');
const promptArg = process.argv[3];

let failures = 0;

function check(cond, label, detail) {
  if (cond) {
    console.log(`  [PASS] ${label}`);
  } else {
    failures++;
    console.log(`  [FAIL] ${label}${detail ? ' -> ' + detail : ''}`);
  }
}

(async () => {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  if (child.stderr) child.stderr.on('data', (d) => process.stderr.write(`[server-stderr] ${d}`));
  const rl = readline.createInterface({ input: child.stdout });

  const call = (msg, timeoutMs = 15000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`超时等待响应：${msg.method}`)), timeoutMs);
    const onLine = (line) => {
      let parsed;
      try { parsed = JSON.parse(line); } catch { return; }
      if (parsed.id !== msg.id) return;
      clearTimeout(timer);
      rl.off('line', onLine);
      resolve(parsed);
    };
    rl.on('line', onLine);
    child.stdin.write(JSON.stringify(msg) + '\n');
  });

  try {
    console.log('== 1. initialize ==');
    const init = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test-client', version: '0.0.1' },
    }});
    check(init.result && init.result.serverInfo && init.result.serverInfo.name === 'dsh-vision-mcp',
      'initialize 返回 serverInfo', JSON.stringify(init.result));
    check(init.result && init.result.capabilities && init.result.capabilities.tools,
      'initialize 声明 tools 能力');

    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    console.log('== 2. tools/list ==');
    const list = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const tools = list.result && list.result.tools ? list.result.tools : [];
    const readImage = tools.find((t) => t.name === 'img2text');
    check(tools.length === 1 && !!readImage, 'tools/list 返回 img2text', JSON.stringify(tools.map((t) => t.name)));
    check(readImage && readImage.inputSchema && Array.isArray(readImage.inputSchema.required)
      && readImage.inputSchema.required.includes('image'), 'img2text 必填参数 image');

    console.log('== 3. tools/call img2text ==');
    const args = { image: imageArg };
    if (promptArg) args.prompt = promptArg;
    const callRes = await call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
      name: 'img2text', arguments: args,
    }}, 30000);

    const content = callRes.result && callRes.result.content ? callRes.result.content : [];
    const text = content.map((c) => c.text || '').join('\n');
    console.log('---- 工具返回 ----');
    console.log(text);
    console.log('------------------');
    check(callRes.result && callRes.result.isError === false, 'tools/call 无错误', JSON.stringify(callRes.result));
    check(text.includes('MOCK_VISION_OK'), '返回了视觉模型文本');
    check(/received_image_base64_chars=\d+/.test(text), '图片 base64 已随请求送达视觉 API');
  } catch (e) {
    failures++;
    console.error('测试执行异常：', e.message);
  } finally {
    child.kill();
  }

  console.log(failures === 0 ? '== 全部通过 ==' : `== ${failures} 项失败 ==`);
  process.exit(failures === 0 ? 0 : 1);
})();
