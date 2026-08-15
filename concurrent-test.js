#!/usr/bin/env node
/**
 * concurrent-test.js —— 验证 server.js 对多个 img2text 请求的并发处理
 *
 * 做法：spawn server -> initialize -> 同时发出 N 个 tools/call（不等待前一个），
 * 统计全部返回的总耗时。如果 server 并发处理，N 个各耗时 1s 的请求总耗时 ≈ 1-2s；
 * 如果串行处理，总耗时 ≈ N 秒。
 */
const { spawn } = require('node:child_process');
const path = require('path');
const readline = require('readline');

const SERVER = path.join(__dirname, 'server.js');
const IMAGE = path.join(__dirname, 'test.png');
const N = 5; // 并发请求数

(async () => {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const rl = readline.createInterface({ input: child.stdout });

  const pending = new Map();
  const send = (msg) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`超时：${msg.method}#${msg.id}`)), 30000);
    pending.set(msg.id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify(msg) + '\n');
  });
  rl.on('line', (line) => {
    let parsed;
    try { parsed = JSON.parse(line); } catch { return; }
    const p = pending.get(parsed.id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(parsed.id);
    p.resolve(parsed);
  });

  try {
    await send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'concurrent-test', version: '0.0.1' } } });

    console.log(`发送 ${N} 个并行 img2text 请求（每个 mock 响应耗时 1s）...`);
    const t0 = Date.now();
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => send({
        jsonrpc: '2.0', id: 100 + i, method: 'tools/call',
        params: { name: 'img2text', arguments: { image: IMAGE } },
      }))
    );
    const elapsed = Date.now() - t0;

    const ok = results.filter((r) => r.result && r.result.isError === false).length;
    console.log(`总耗时: ${elapsed}ms；成功 ${ok}/${N}`);
    console.log(elapsed < 3000 ? '== 并发处理确认（约 1s 级，非 N 倍串行）==' : '== 疑似串行 ==');
  } catch (e) {
    console.error('测试失败：', e.message);
  } finally {
    child.kill();
    process.exit(0);
  }
})();
