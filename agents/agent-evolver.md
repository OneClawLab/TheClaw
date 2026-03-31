# Evolver Agent 设计 — 自进化框架（草案，尚未同步更新相关方）

Evolver 是 TheClaw 的自进化 agent，负责观察系统运行数据、发现优化机会、提出改进提案。优先级最低，依赖其他三个 system agent 设计稳定后再细化。本文档为指导性框架。

---

## 定位

- 系统的"反思者"：从运行数据中发现可改进的模式
- 提案驱动：所有改进以提案形式提出，分级审批后执行
- 不直接接收外部 peer 消息，通过 inbox 接收 admin 转发的优化请求和定时触发

---

## 数据源

| 数据源 | 内容 | 获取方式 |
|--------|------|---------|
| agent thread 事件流 | 对话模式、toolcall 频率、error 分布 | `thread peek` 扫描各 agent thread |
| record/usage 事件 | token 消耗、模型选择、调用耗时 | `thread peek --filter "subtype = 'usage'"` |
| agent 日志 | LLM 调用详情、路由决策 | 读取 `~/.theclaw/agents/*/logs/agent.log` |
| cmds 运行时索引 | 系统可用命令变化 | `cmds list --json` |
| memory 文件 | 各 agent 的记忆积累情况 | 读取 `~/.theclaw/agents/*/memory/` |
| 健康检查历史 | 系统稳定性趋势 | 读取 maintainer 的 health thread |

---

## 触发机制

| 触发方式 | 场景 |
|---------|------|
| 定时（notifier timer） | 每日/每周定期分析，生成优化报告 |
| 被动（inbox 消息） | admin 转发 owner 的优化请求，或其他 agent 的 evolution-request |
| 主动（owner via admin） | owner 明确要求"优化 X" |

```json
// evolver config.json
{
  "agent_id": "evolver",
  "kind": "system",
  "pai": { "provider": "openai", "model": "gpt-4o" },
  "routing": { "default": "per-agent" },
  "run_on_empty_inbox": true,
  "evolution": {
    "analysis_cron": "0 3 * * *",
    "weekly_report_cron": "0 4 * * 1"
  }
}
```

---

## 提案分级

所有改进以提案形式管理，按风险分三级：

| 级别 | 风险 | 审批方式 | 示例 |
|------|------|---------|------|
| Level 0 | 无风险 | 自动执行，事后通知 owner | 清理冗余 memory 内容、优化 thread memory 压缩摘要 |
| Level 1 | 低风险 | 通知 owner，无反对则执行 | 调整 agent 的 model_params、优化 system prompt 措辞 |
| Level 2 | 有风险 | 需 owner 明确审批 | 修改 IDENTITY.md 核心职责、切换 LLM provider/model、修改 routing 配置 |

### 提案生命周期

```
draft → proposed → approved/rejected → executed/cancelled
                      ↑
                  owner 审批（Level 2）
                  或超时自动通过（Level 1，可配置）
```

### 提案存储

提案作为 `record/proposal` 事件存储在 evolver 自己的 thread 中：

```json
{
  "type": "record",
  "subtype": "proposal",
  "source": "self",
  "content": {
    "id": "prop-20260320-001",
    "level": 1,
    "status": "proposed",
    "title": "优化 admin agent 的 system prompt",
    "description": "分析发现 admin 在处理代码相关问题时经常转发给不存在的 agent，建议在 system prompt 中明确说明当前可用的 user agent 列表",
    "target": "admin",
    "changes": [
      { "file": "~/.theclaw/agents/admin/IDENTITY.md", "action": "append", "content": "..." }
    ],
    "evidence": "最近 7 天 admin 有 12 次转发失败，均为目标 agent 不存在",
    "created_at": "2026-03-20T03:00:00Z"
  }
}
```

Level 2 提案的审批通过 admin inbox 发送给 owner：

```bash
thread push \
  --thread ~/.theclaw/agents/admin/inbox \
  --source "internal:dm:default:evolver" \
  --type message \
  --content '{"text":"优化提案需要你的审批: [prop-20260320-001] 优化 admin 的 system prompt。详情: ...","notify_peer":"alice","action":"proposal_review"}'
```

---

## 优化方向（初步）

### Prompt 优化

- 分析 agent 的对话质量（error 率、用户满意度信号）
- 发现 system prompt 中的模糊或矛盾之处
- 建议措辞调整或补充

### 模型选择优化

- 分析各 agent 的 token 用量和响应质量
- 对于简单任务建议使用更轻量的模型
- 对于复杂任务建议使用更强的模型

### 工具使用优化

- 分析 toolcall 模式，发现重复或低效的命令序列
- 建议将常用命令序列封装为脚本
- 发现未被使用的系统能力（通过 cmds 索引对比）

### Memory 优化

- 检查 memory 文件的质量和大小
- 建议压缩过大的 memory
- 发现跨 agent 可共享的知识

---

## 回滚

暂不设计自动回滚机制。如果提案执行后出现问题：

1. warden 检测到异常 → 停止相关 agent
2. maintainer 通知 owner
3. owner 通过 admin 指示 evolver 撤回变更（或手动修复）

后续可考虑：提案执行前自动备份受影响文件，支持 `evolver rollback <proposal_id>`。

---

## Evolver 的 USAGE.md

```markdown
# Evolver — 使用说明

Evolver 是 TheClaw 的自进化 agent，负责观察系统运行并提出优化建议。

## 能力

- 分析系统运行数据，发现优化机会
- 提出分级改进提案（自动执行 / 通知 / 需审批）
- Prompt 优化、模型选择、工具使用优化、memory 优化

## 交互方式

Evolver 主要自主运行（定时分析），可以通过 admin 发送请求：
- "分析一下系统最近的运行情况" — 生成分析报告
- "优化 coder agent 的 prompt" — 针对性优化
- "查看待审批的提案" — 列出 Level 2 提案
```
