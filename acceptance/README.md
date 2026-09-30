# acceptance/：验收运行产物

这个目录**只放运行产物**，不放可运行的检查脚本——需要执行的都在 `scripts/`：

| 位置 | 内容 |
| --- | --- |
| `scripts/acceptance-suite.mjs` | 一键验收编排（`npm run accept`）：typecheck → 全量单测 → 起干净实例 → 走查 → 断言 |
| `scripts/single-instance-acceptance.mjs` | 单实例 MVP 断言（一个 Lead 跑完整条闭环） |
| `scripts/sales-day-walkthrough.mjs` | 「销售一天」21 事件走查 |
| `scripts/ttl-anchor-check.mjs` | 动作有效期锚点回归（事件时间早于 TTL） |
| `scripts/clock-coupling-proof.mjs` | 时钟稳健性 A/B 对照 |

本目录由 `.gitignore` 忽略（仅保留本 README），产物包括：

| 产物 | 生成方式 |
| --- | --- |
| `report-<时间戳>.json` | `npm run accept`（含每个步骤退出码与单实例断言结果） |
| `walkthrough-run*.txt` | `node scripts/sales-day-walkthrough.mjs > acceptance/xxx.txt` |
| `acceptance-live*.txt` | `node scripts/single-instance-acceptance.mjs > acceptance/xxx.txt` |
| `tests-*.txt` / `typecheck-*.txt` | `npm run test:run` / `npm run typecheck` 的输出留档 |
| `*.db` | 验收用临时库（默认建在系统临时目录，本目录仅手工跑时出现） |

## 一键复跑

```bash
npm run accept                 # 全流程（CI 入口）
npm run accept -- --skip-tests # 只验实例行为，跳过 typecheck/test
npm run accept -- --base http://127.0.0.1:3000 --token <token>   # 验已有实例
npm run accept -- --keep-db    # 保留临时库便于排查
```

CI（`.github/workflows/ci.yml`）在 ubuntu-latest 与 windows-latest 上跑 `npm ci && npm run accept`，
并上传本目录下的 `report-*.json` 作为构建产物。

判据与断言清单见 `docs/acceptance-single-instance.md`，
历史走查记录与两轮修复见 `docs/sales-daily-feedback.md`。
