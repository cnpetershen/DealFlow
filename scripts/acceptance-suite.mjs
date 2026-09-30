// DealFlow 一键验收：类型检查 → 全量单测 → 起一个干净实例 → 21 事件走查 → 单实例断言，
// 最后汇总并通过退出码给出结论（0 = 全绿，1 = 有失败）。
//
// 用法：
//   npm run accept                       # 全流程（CI 用这个）
//   npm run accept -- --skip-tests       # 跳过 typecheck/test，只验实例行为
//   npm run accept -- --base http://127.0.0.1:3123 --token dev-token   # 验已有实例，不自己起
//   npm run accept -- --keep-db          # 保留临时库便于排查
//
// 端口默认 3199，库默认建在系统临时目录（不进仓库）；产物报告写到 acceptance/report-<时间戳>.json。
//
// 注意：所有子进程都用 stdio: 'inherit'，不用管道——受限沙箱下管道会 EPERM，
// 结构化结果改由「报告文件」传递（ACCEPTANCE_REPORT）。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(name);
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
};

/**
 * 拿到「能被执行」的 npm 调用方式。
 * Windows 上 `spawn('npm.cmd')` 会被 Node 拒绝（.cmd 需要 shell），
 * 所以优先用 npm_execpath（由 npm run 注入）或 node 自带的 npm-cli.js，用 node 直接启动。
 */
const NPM_INVOCATION = (() => {
  const cli = process.env.npm_execpath;
  if (cli !== undefined && existsSync(cli)) return { command: process.execPath, args: [cli], shell: false };
  const guessed = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (existsSync(guessed)) return { command: process.execPath, args: [guessed], shell: false };
  return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: [], shell: process.platform === 'win32' };
})();
const PORT = option('--port', process.env.DEALFLOW_ACCEPT_PORT ?? '3199');
const TOKEN = option('--token', 'dev-token');
const EXTERNAL_BASE = option('--base', null);
const BASE = EXTERNAL_BASE ?? `http://127.0.0.1:${PORT}`;

const RUN_DIR = path.join(tmpdir(), 'dealflow-acceptance');
const DB_PATH = option('--db', path.join(RUN_DIR, `run-${Date.now()}.db`));
const REPORT_DIR = path.join(ROOT, 'acceptance');
const REPORT_PATH = path.join(REPORT_DIR, `report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
const ACCEPTANCE_JSON = path.join(RUN_DIR, `single-instance-${Date.now()}.json`);

const steps = [];

/** 跑一个子进程并把输出直接透传（不用管道，避免受限沙箱 EPERM）。 */
function runStep(label, invocation, extraEnv = {}) {
  console.log(`\n══════ ${label} ══════`);
  return new Promise((resolve) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: ROOT,
      stdio: 'inherit',
      shell: invocation.shell ?? false,
      env: { ...process.env, ...extraEnv },
    });
    child.on('error', (error) => {
      console.error(`无法启动 ${invocation.command}: ${error.message}`);
      steps.push({ label, code: 1, detail: `无法启动 ${invocation.command}: ${error.message}` });
      resolve(1);
    });
    child.on('close', (code) => {
      steps.push({ label, code: code ?? 1 });
      console.log(`${label} → 退出码 ${code}`);
      resolve(code ?? 1);
    });
  });
}

async function waitForHealth(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/healthz`);
      const body = await res.json();
      if (body?.status === 'ok') return true;
    } catch {
      // 还没起来，继续等
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

async function stopServer(child) {
  if (child === null || child.exitCode !== null) return;
  child.kill('SIGTERM');
  const closed = new Promise((resolve) => child.once('close', resolve));
  const timedOut = await Promise.race([
    closed.then(() => false),
    new Promise((resolve) => setTimeout(() => resolve(true), 10_000)),
  ]);
  if (timedOut) {
    console.error('实例未在 10s 内退出，强制结束');
    child.kill('SIGKILL');
    await closed;
  }
}

console.log(`DealFlow 一键验收\n  实例: ${BASE}${EXTERNAL_BASE ? '（外部，不自起）' : `（由本脚本启动，库=${DB_PATH}）`}`);
mkdirSync(RUN_DIR, { recursive: true });
mkdirSync(REPORT_DIR, { recursive: true });

// ---- 1) 静态与单测 -------------------------------------------------------
if (hasFlag('--skip-tests')) {
  console.log('\n跳过 typecheck / test:run（--skip-tests）');
} else {
  await runStep('1. 类型检查 (npm run typecheck)', { ...NPM_INVOCATION, args: [...NPM_INVOCATION.args, 'run', 'typecheck'] });
  await runStep('2. 全量单测 (npm run test:run)', { ...NPM_INVOCATION, args: [...NPM_INVOCATION.args, 'run', 'test:run'] });
}

// ---- 2) 干净实例 ---------------------------------------------------------
let server = null;
if (EXTERNAL_BASE === null) {
  console.log('\n══════ 3. 启动干净实例 ══════');
  rmSync(DB_PATH, { force: true });
  rmSync(`${DB_PATH}-wal`, { force: true });
  rmSync(`${DB_PATH}-shm`, { force: true });
  server = spawn(
    process.execPath,
    [
      '--disable-warning=ExperimentalWarning',
      '--experimental-transform-types',
      '--import',
      './scripts/register.mjs',
      'src/main.ts',
    ],
    {
      cwd: ROOT,
      stdio: 'inherit',
      env: {
        ...process.env,
        DEALFLOW_HOST: '127.0.0.1',
        DEALFLOW_PORT: PORT,
        DEALFLOW_DB_PATH: DB_PATH,
        DEALFLOW_CONTROL_PLANE_ENABLED: 'true',
        DEALFLOW_CONTROL_PLANE_TOKEN: TOKEN,
        DEALFLOW_OBSERVABILITY_ENABLED: 'true',
        DEALFLOW_RETRY_ENABLED: 'true',
      },
    },
  );
  const ready = await waitForHealth(BASE);
  steps.push({ label: '3. 启动干净实例', code: ready ? 0 : 1, detail: `GET /healthz ${ready ? 'ok' : '超时'}` });
  console.log(`GET ${BASE}/healthz → ${ready ? '{"status":"ok"}' : '超时未就绪'}`);
} else {
  const ready = await waitForHealth(BASE, 5_000);
  steps.push({ label: '3. 检查外部实例', code: ready ? 0 : 1, detail: `GET /healthz ${ready ? 'ok' : '超时'}` });
}

let exitCode = steps.some((step) => step.code !== 0) ? 1 : 0;

// ---- 3) 走查 + 单实例验收 ------------------------------------------------
if (exitCode === 0) {
  const baseEnv = { WALKTHROUGH_BASE: BASE, WALKTHROUGH_TOKEN: TOKEN, ACCEPTANCE_BASE: BASE, ACCEPTANCE_TOKEN: TOKEN };

  const walkthroughCode = await runStep(
    '4. 销售一天走查 (21 个事件)',
    { command: process.execPath, args: ['scripts/sales-day-walkthrough.mjs'] },
    baseEnv,
  );
  if (walkthroughCode !== 0) exitCode = 1;

  const acceptanceCode = await runStep(
    '5. 单实例验收 (MVP 断言)',
    { command: process.execPath, args: ['scripts/single-instance-acceptance.mjs'] },
    { ...baseEnv, ACCEPTANCE_REPORT: ACCEPTANCE_JSON },
  );
  if (acceptanceCode !== 0) exitCode = 1;
} else {
  console.log('\n前置步骤失败，跳过实例走查与断言。');
}

// ---- 4) 收尾 -------------------------------------------------------------
if (server !== null) {
  console.log('\n══════ 6. 停止实例 ══════');
  await stopServer(server);
  steps.push({ label: '6. 停止实例', code: 0 });
  if (!hasFlag('--keep-db')) {
    rmSync(DB_PATH, { force: true });
    rmSync(`${DB_PATH}-wal`, { force: true });
    rmSync(`${DB_PATH}-shm`, { force: true });
  } else {
    console.log(`保留临时库: ${DB_PATH}`);
  }
}

// ---- 5) 汇总 -------------------------------------------------------------
let acceptanceReport = null;
if (existsSync(ACCEPTANCE_JSON)) {
  acceptanceReport = JSON.parse(readFileSync(ACCEPTANCE_JSON, 'utf8'));
}

console.log('\n══════ 汇总 ══════');
for (const step of steps) {
  const tag = step.code === 0 ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${step.label}${step.code === 0 ? '' : `（退出码 ${step.code}）`}${step.detail ? ` — ${step.detail}` : ''}`);
}
if (acceptanceReport !== null) {
  console.log(`  单实例断言: PASS ${acceptanceReport.passed} / FAIL ${acceptanceReport.failed}`
    + (acceptanceReport.failed > 0 ? ` → ${acceptanceReport.results.filter((r) => r.passed === false).map((r) => r.id).join(', ')}` : ''));
}

// 清理中间产物（报告已并入总报告）
rmSync(ACCEPTANCE_JSON, { force: true });
try {
  rmSync(RUN_DIR);
} catch {
  // 目录非空（--keep-db 或另有并发运行）时保留
}
console.log(`\n结论: ${exitCode === 0 ? '✅ 全部通过' : '❌ 有失败项'}`);

writeFileSync(
  REPORT_PATH,
  `${JSON.stringify({ base: BASE, external: EXTERNAL_BASE !== null, generated_at: new Date().toISOString(), exit_code: exitCode, steps, acceptance: acceptanceReport }, null, 2)}\n`,
  'utf8',
);
console.log(`报告: ${REPORT_PATH}`);
process.exitCode = exitCode;
