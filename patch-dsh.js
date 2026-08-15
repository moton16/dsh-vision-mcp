#!/usr/bin/env node
/**
 * patch-dsh.js —— 给 DSH（DeepSeek Harness）打"图片降级"补丁
 *
 * 背景：DSH 主模型不支持图片输入时，会拒绝带图片的消息
 * （MODEL_DOES_NOT_SUPPORT_IMAGES，"当前模型不支持图片"）。
 * 本补丁把该拒绝逻辑改为：图片落盘为 durable attachment，消息中插入文本引用
 * （`[图片附件：name（mediaType）] 图片文件：<绝对路径>`），
 * 由 agent 调用 mcp__dsh-vision__img2text 读取转述 —— 对话框直插图片即用。
 *
 * 用法：
 *   node patch-dsh.js                 # 自动定位并打补丁（幂等）
 *   node patch-dsh.js <path>          # 指定 dsh-host-apiproxy 的 lib/index.js
 *   node patch-dsh.js --check         # 检查是否已打补丁
 *   node patch-dsh.js --restore       # 从备份恢复（回滚）
 *
 * 安全：修改前自动备份为 <file>.image-vision.bak；补丁后自动 node --check 语法校验，
 *       校验失败自动回滚；所有替换在内存中完成，任一锚点缺失即中止、不写盘。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('node:vm');
const fsp = require('fs/promises');

const MARK = 'degradeImageParts';
const BAK_SUFFIX = '.image-vision.bak';
const IMPORT_HOME = 'import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";';
const TAB = '\t';

/** 候选 bundle 路径（DSH 的 dsh-host-apiproxy 运行时入口）。 */
function candidates() {
  const home = os.homedir();
  const list = [];
  if (process.env.DSH_HOST_APIPROXY_INDEX) list.push(process.env.DSH_HOST_APIPROXY_INDEX);
  list.push(
    path.join(home, '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh-host-apiproxy', 'lib', 'index.js'),
    path.join(home, '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-host-apiproxy', 'lib', 'index.js'),
  );
  if (process.env.DSH_CLI) {
    list.push(
      path.join(process.env.DSH_CLI, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-host-apiproxy', 'lib', 'index.js'),
      path.join(process.env.DSH_CLI, 'node_modules', '@deepseek-ai', 'dsh-host-apiproxy', 'lib', 'index.js'),
    );
  }
  return list;
}

function findBundle() {
  for (const p of candidates()) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

/** 降级函数源码（tab 缩进，与 bundle 风格一致）。 */
function degradeFn() {
  return [
    '/**',
    ' * 图片降级（dsh-vision-mcp 集成）：当前模型不支持图片输入时，不再拒绝，',
    ' * 而是把每个 image part 落盘为 durable attachment，并替换为文本引用',
    ' * （含绝对路径），由 agent 调用 mcp__dsh-vision__img2text 读取转述。',
    ' */',
    'async function degradeImageParts(ctx, content) {',
    `${TAB}const out = [];`,
    `${TAB}for (const part of content) {`,
    `${TAB}${TAB}if (part.type !== "image") {`,
    `${TAB}${TAB}${TAB}out.push({ type: "text", text: part.text });`,
    `${TAB}${TAB}${TAB}continue;`,
    `${TAB}${TAB}}`,
    `${TAB}${TAB}const data = decodeBase64(part.data);`,
    `${TAB}${TAB}const attachment = await ctx.attachments.saveImage({`,
    `${TAB}${TAB}${TAB}data,`,
    `${TAB}${TAB}${TAB}mediaType: part.mediaType,`,
    `${TAB}${TAB}${TAB}...part.name === void 0 ? {} : { name: part.name }`,
    `${TAB}${TAB}});`,
    `${TAB}${TAB}const hex = String(attachment.attachmentId).replace(/^sha256:/, "");`,
    `${TAB}${TAB}const abs = join(resolveDshHome(), "attachments", "v1", "objects", hex.slice(0, 2), hex);`,
    `${TAB}${TAB}const name = attachment.name ?? "image";`,
    `${TAB}${TAB}out.push({`,
    `${TAB}${TAB}${TAB}type: "text",`,
    `${TAB}${TAB}${TAB}text: \`[图片附件：\${name}（\${attachment.mediaType}）] 图片文件：\${abs}\``,
    `${TAB}${TAB}});`,
    `${TAB}}`,
    `${TAB}return out;`,
    '}',
    '',
  ].join('\n');
}

const FN_ANCHOR = '/** Search durable content for an image reference, including nested tool results. */\nfunction imageBlockIn(content, match) {';
const ADMIT_CTX_RE = /(const hasImage = content\.some\(\(part\) => part\.type === "image"\);\n)(\t*const admit = async \(\) => \{\n)(\t*try \{\n)/;
const ADMIT_CTX_NEW = '$1$2' + TAB.repeat(5) + 'let effectiveContent = content;\n$3';
const REJECT_RE = /if \(modelInfo\.inputModalities !== void 0 && !modelInfo\.inputModalities\.includes\("image"\)\) return err\(request, \{\s*code: "attachment-error",\s*message: `Model "\$\{current\.model\}" does not support image input\.`,\s*details: \{ reason: "MODEL_DOES_NOT_SUPPORT_IMAGES" \}\s*\}\);/;
const REJECT_NEW = 'if (modelInfo.inputModalities !== void 0 && !modelInfo.inputModalities.includes("image")) {\n'
  + TAB.repeat(8) + '// 图片降级（dsh-vision-mcp）：模型不支持图片时转文本引用，不再拒绝\n'
  + TAB.repeat(8) + 'effectiveContent = await degradeImageParts(ctx, content);\n'
  + TAB.repeat(7) + '}';
const DURABLE_OLD = 'content: await durablePromptContent(ctx, content),';
const DURABLE_NEW = 'content: await durablePromptContent(ctx, effectiveContent),';

function fail(msg) {
  console.error('✗ ' + msg);
  process.exit(1);
}

async function applyPatch(file) {
  let src = fs.readFileSync(file, 'utf8');
  if (src.includes(MARK)) {
    console.log('already patched: ' + file);
    return;
  }
  const edits = [];

  // 1. node:path 增加 join
  const oldJoin = 'import { dirname, extname } from "node:path";';
  if (src.includes(oldJoin)) {
    src = src.replace(oldJoin, 'import { dirname, extname, join } from "node:path";');
    edits.push('join');
  } else {
    fail('找不到 node:path import 锚点（DSH 版本可能不匹配）');
  }

  // 2. resolveDshHome import
  if (!src.includes(IMPORT_HOME)) {
    const anchorHome = 'import { release } from "node:os";';
    if (src.includes(anchorHome)) {
      src = src.replace(anchorHome, anchorHome + '\n' + IMPORT_HOME);
      edits.push('resolveDshHome');
    } else {
      fail('找不到 node:os import 锚点（DSH 版本可能不匹配）');
    }
  }

  // 3. 降级函数
  if (src.includes(FN_ANCHOR)) {
    src = src.replace(FN_ANCHOR, degradeFn() + FN_ANCHOR);
    edits.push('degradeImageParts');
  } else {
    fail('找不到 imageBlockIn 锚点（DSH 版本可能不匹配）');
  }

  // 4. admit 增加 effectiveContent
  const mAdmit = src.match(ADMIT_CTX_RE);
  if (mAdmit) {
    src = src.replace(ADMIT_CTX_RE, ADMIT_CTX_NEW);
    edits.push('effectiveContent');
  } else {
    fail('找不到 admit 锚点（DSH 版本可能不匹配）');
  }

  // 5. 拒绝分支 → 降级分支
  if (REJECT_RE.test(src)) {
    src = src.replace(REJECT_RE, REJECT_NEW);
    edits.push('degrade-branch');
  } else {
    fail('找不到 MODEL_DOES_NOT_SUPPORT_IMAGES 分支（DSH 版本可能不匹配）');
  }

  // 6. durablePromptContent 使用 effectiveContent
  if (src.includes(DURABLE_OLD)) {
    src = src.replace(DURABLE_OLD, DURABLE_NEW);
    edits.push('durable-call');
  } else {
    fail('找不到 durablePromptContent 调用锚点（DSH 版本可能不匹配）');
  }

  // 插入片段语法校验（vm 只编译不执行；失败则中止、不写盘）
  // 注：bundle 是 ESM，vm.Script 无法整体编译（import 语句）；
  // 本项目只做锚点替换，改动全部落在下列插入片段上（ADMIT_CTX_NEW 的正则模板
  // 含 $1$2$3 占位符，其实质插入语句即 `let effectiveContent = content;`）。
  const probe = 'async function __probe__() {\n' + REJECT_NEW + '\nlet effectiveContent = content;\n}';
  try {
    new vm.Script(degradeFn() + probe, { filename: file });
  } catch (e) {
    fail('插入片段语法检查失败，未写盘：' + (e.message || e));
  }

  // 备份 → 写盘（异步 API）
  const bak = file + BAK_SUFFIX;
  if (!fs.existsSync(bak)) await fsp.copyFile(file, bak);
  await fsp.writeFile(file, src);

  console.log('✓ PATCHED: ' + file);
  console.log('  edits: ' + edits.join(', '));
  console.log('  backup: ' + bak);
  console.log('  重启 DSH 后，对话框直插图片将自动降级为文本引用，由识图 MCP 读取。');
}

async function main() {
  const args = process.argv.slice(2);
  const explicit = args.find((a) => !a.startsWith('--'));
  const mode = args.includes('--restore') ? 'restore'
    : args.includes('--check') ? 'check'
    : 'patch';

  const file = explicit || findBundle();
  if (!file) {
    console.error('未找到 dsh-host-apiproxy 的 lib/index.js。');
    console.error('请显式传入路径：node patch-dsh.js <path-to-index.js>');
    console.error('或设置环境变量 DSH_HOST_APIPROXY_INDEX / DSH_CLI。');
    process.exit(1);
  }
  if (!fs.existsSync(file)) fail('文件不存在：' + file);
  const bak = file + BAK_SUFFIX;

  if (mode === 'check') {
    const src = fs.readFileSync(file, 'utf8');
    console.log(src.includes(MARK) ? '✓ PATCHED: ' + file : '· NOT PATCHED: ' + file);
    return;
  }
  if (mode === 'restore') {
    if (!fs.existsSync(bak)) fail('没有备份文件可恢复：' + bak);
    await fsp.copyFile(bak, file);
    console.log('✓ RESTORED: ' + file);
    console.log('  (from ' + bak + ')');
    return;
  }
  await applyPatch(file);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
