# OpenCode 的 LLM Context Management 分析

本文分析的是 `opencode/` 源码里的 **LLM 上下文管理**，不是应用层状态管理。结论先说：OpenCode 确实有一套和 Claude Code 类似的上下文治理机制，但它更偏向于 **会话摘要 + 自动压缩 + 工具输出裁剪 + 子代理隔离**，而不是一个统一的长期记忆系统。

## 1. 模型上下文是分层拼装的

OpenCode 在真正发给模型之前，会把上下文拆成几层：

- provider / agent 级 system prompt
- 本次调用传入的 system 片段
- 最后一条 user 消息自带的 system 片段
- 历史消息 messages

关键代码在 [session/llm.ts](/home/xm1994/Projects/claude-code/opencode/packages/opencode/src/session/llm.ts#L111)：

```ts
const system: string[] = []
system.push(
  [
    ...(input.agent.prompt ? [input.agent.prompt] : SystemPrompt.provider(input.model)),
    ...input.system,
    ...(input.user.system ? [input.user.system] : []),
  ]
    .filter((x) => x)
    .join("\n"),
)
```

它还刻意保留了缓存友好的结构：

```ts
// rejoin to maintain 2-part structure for caching if header unchanged
if (system.length > 2 && system[0] === header) {
  const rest = system.slice(1)
  system.length = 0
  system.push(header, rest.join("\n"))
}
```

这说明 OpenCode 不只是“拼 prompt”，而是在考虑 **prompt cache 命中率** 和 **系统提示稳定性**。

## 2. 环境上下文和项目指令是单独注入的

环境信息不是散落在对话里，而是集中生成后注入：

- [session/system.ts](/home/xm1994/Projects/claude-code/opencode/packages/opencode/src/session/system.ts#L34) 生成环境上下文
- [session/instruction.ts](/home/xm1994/Projects/claude-code/opencode/packages/opencode/src/session/instruction.ts#L72) 收集 `AGENTS.md` / `CLAUDE.md` / 自定义 instruction

环境上下文包含：

- 工作目录
- workspace root
- 是否 git 仓库
- 平台
- 当前日期

见 [session/system.ts](/home/xm1994/Projects/claude-code/opencode/packages/opencode/src/session/system.ts#L34)：

```ts
<env>
  Working directory: ...
  Workspace root folder: ...
  Is directory a git repo: ...
  Platform: ...
  Today's date: ...
</env>
```

系统指令则按文件和 URL 收集，见 [session/instruction.ts](/home/xm1994/Projects/claude-code/opencode/packages/opencode/src/session/instruction.ts#L117)：

```ts
return Promise.all([...files, ...fetches]).then((result) => result.filter(Boolean))
```

这类设计的目标很明确：把 **长期不变的工作约束** 从聊天历史中分离出来。

## 3. 有明确的自动压缩机制

OpenCode 不是把历史消息无限塞给模型，而是会在 token 接近上限时触发 compaction。

判断入口在 [session/overflow.ts](/home/xm1994/Projects/claude-code/opencode/packages/opencode/src/session/overflow.ts#L1)：

```ts
const reserved =
  input.cfg.compaction?.reserved ?? Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model))
const usable = input.model.limit.input
  ? input.model.limit.input - reserved
  : context - ProviderTransform.maxOutputTokens(input.model)
return count >= usable
```

真正触发 compaction 的逻辑在 [session/prompt.ts](/home/xm1994/Projects/claude-code/opencode/packages/opencode/src/session/prompt.ts#L1396)：

```ts
if (
  lastFinished &&
  lastFinished.summary !== true &&
  (yield* compaction.isOverflow({ tokens: lastFinished.tokens, model }))
) {
  yield* compaction.create({ sessionID, agent: lastUser.agent, model: lastUser.model, auto: true })
  continue
}
```

这和 Claude Code 的思路一致：**先预算，再压缩，再继续对话**。

## 4. compaction prompt 是“给下一个 agent 接力”的

OpenCode 的 compaction 不是简单摘要，而是面向“下一位代理接管工作”的总结。

核心实现见 [session/compaction.ts](/home/xm1994/Projects/claude-code/opencode/packages/opencode/src/session/compaction.ts#L183)：

```ts
const defaultPrompt = `Provide a detailed prompt for continuing our conversation above.
Focus on information that would be helpful for continuing the conversation, including what we did, what we're doing, which files we're working on, and what we're going to do next.
The summary that you construct will be used so that another agent can read it and continue the work.
Do not call any tools. Respond only with the summary text.
...`
```

配套的 agent prompt 在 [agent/prompt/compaction.txt](/home/xm1994/Projects/claude-code/opencode/packages/opencode/src/agent/prompt/compaction.txt#L1)：

```txt
Focus on information that would be helpful for continuing the conversation, including:
- What was done
- What is currently being worked on
- Which files are being modified
- What needs to be done next
- Key user requests, constraints, or preferences that should persist
- Important technical decisions and why they were made
```

这说明 compaction 的目标不是“压缩得越短越好”，而是 **保留可执行的工作记忆**。

## 5. 工具输出会被主动裁剪

OpenCode 很清楚上下文膨胀的最大来源往往是工具输出，而不是用户消息。

### 5.1 prune 旧工具结果

在 [session/compaction.ts](/home/xm1994/Projects/claude-code/opencode/packages/opencode/src/session/compaction.ts#L83) 中，`prune()` 会倒序扫描历史，把较老的 tool result 标记为 compacted：

```ts
// goes backwards through parts until there are PRUNE_PROTECT tokens worth of tool
// calls, then erases output of older tool calls to free context space
```

相关代码：

```ts
if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue
if (part.state.time.compacted) break loop
const estimate = Token.estimate(part.state.output)
total += estimate
if (total > PRUNE_PROTECT) {
  pruned += estimate
  toPrune.push(part)
}
```

### 5.2 truncate 超长工具输出

在 [tool/truncate.ts](/home/xm1994/Projects/claude-code/opencode/packages/opencode/src/tool/truncate.ts#L63)，如果输出太大，就只返回预览，把完整内容写到磁盘：

```ts
if (lines.length <= maxLines && totalBytes <= maxBytes) {
  return { content: text, truncated: false } as const
}
...
yield* fs.writeFileString(file, text).pipe(Effect.orDie)
```

而且它会故意提示模型去用 `Task` 或 `Read/Grep` 再看细节：

```ts
const hint = hasTaskTool(agent)
  ? `... Use the Task tool to have explore agent process this file ...`
  : `... Use Grep to search the full content or Read with offset/limit ...`
```

这是一种非常典型的上下文管理技巧：**把大对象外置，只把索引和入口留在上下文里**。

## 6. skill 是按需加载，不是全量灌入

OpenCode 的 skill 机制也是上下文节流手段。

在 [tool/skill.ts](/home/xm1994/Projects/claude-code/opencode/packages/opencode/src/tool/skill.ts#L16) 里，它明确说 skill 会把详细指令和资源注入对话上下文：

```ts
"The skill will inject detailed instructions, workflows, and access to bundled resources (scripts, references, templates) into the conversation context."
```

但实际加载时只取：

- skill 主文档
- 最多 10 个附属文件
- sampled files，而不是整个目录

见 [tool/skill.ts](/home/xm1994/Projects/claude-code/opencode/packages/opencode/src/tool/skill.ts#L61)：

```ts
const limit = 10
...
if (arr.length >= limit) {
  break
}
```

这说明 OpenCode 的 skill 设计是 **按需展开、控制展开深度**。

## 7. Task 子代理默认是 fresh context

`TaskTool` 是另一个很重要的上下文隔离机制。

在 [tool/task.ts](/home/xm1994/Projects/claude-code/opencode/packages/opencode/src/tool/task.ts#L19) 中，`task_id` 明确表示可以续用之前的子代理会话；如果不传，就是新上下文：

```ts
task_id: z.string().describe(
  "This should only be set if you mean to resume a previous task ... instead of creating a fresh one",
).optional()
```

执行时会创建新的子会话：

```ts
return await Session.create({
  parentID: ctx.sessionID,
  title: params.description + ` (@${agent.name} subagent)`,
  permission: [...],
})
```

然后把 prompt 解析后交给新的子会话：

```ts
const result = await SessionPrompt.prompt({
  messageID,
  sessionID: session.id,
  model: { ... },
  agent: agent.name,
  tools: { ... },
  parts: promptParts,
})
```

这里体现的是一种典型策略：**把复杂任务拆到子代理里，避免主线程上下文被过程噪声污染**。

## 8. 会话摘要是单独持久化的

OpenCode 不是只依赖当前消息窗口，它还会为会话和单条消息生成摘要信息。

在 [session/processor.ts](/home/xm1994/Projects/claude-code/opencode/packages/opencode/src/session/processor.ts#L297) 中，每次 step 完成后都会异步做摘要：

```ts
yield* Effect.promise(() =>
  SessionSummary.summarize({
    sessionID: ctx.sessionID,
    messageID: ctx.assistantMessage.parentID,
  }),
)
```

`SessionSummary` 会提取 diff 和 summary 元数据，见 [session/summary.ts](/home/xm1994/Projects/claude-code/opencode/packages/opencode/src/session/summary.ts#L57)：

```ts
await Session.setSummary({
  sessionID: input.sessionID,
  summary: {
    additions: ...,
    deletions: ...,
    files: ...,
  },
})
```

这类数据不是直接写回 prompt，但会保留为会话可观察状态。它更像“工作日志索引”，不是通用长期记忆。

## 9. 有 prompt 级的上下文节制

默认 prompt 里本身就鼓励少 token、少冗余、优先利用 Task 工具，见 [session/prompt/default.txt](/home/xm1994/Projects/claude-code/opencode/packages/opencode/src/session/prompt/default.txt#L17)：

```txt
IMPORTANT: You should minimize output tokens as much as possible while maintaining helpfulness...
```

并且明确要求：

```txt
- When doing file search, prefer to use the Task tool in order to reduce context usage.
```

这意味着上下文管理并不是只靠 runtime 代码，prompt 也在推动模型主动“省上下文”。

## 10. 和 Claude Code 的差异

OpenCode 和 Claude Code 的共同点是：

- 都有会话级 compaction
- 都会裁剪工具输出
- 都鼓励用子代理处理复杂任务
- 都会注入项目级 instructions / environment

但 OpenCode 没有在主流程里看到 Claude Code 那种更完整的长期 memory 管线。它只有一个较弱的“memory”线索：`beast` 专用 prompt 中提到 `.github/instructions/memory.instruction.md`，见 [session/prompt/beast.txt](/home/xm1994/Projects/claude-code/opencode/packages/opencode/src/session/prompt/beast.txt#L113)：

```txt
You have a memory that stores information about the user and their preferences...
The memory is stored in a file called `.github/instructions/memory.instruction.md`.
```

但这更像是 **特定 agent 的提示约定**，不是一个全局 runtime memory 服务。

## 结论

OpenCode 的上下文管理可以概括为一句话：

> 用分层 prompt 管理稳定上下文，用 compaction 管理会话长度，用 truncate/prune 管理工具噪声，用 task/skill 管理子任务边界。

如果要把它和 Claude Code 对比，OpenCode 更像是一个 **轻量但完整的上下文预算系统**；它有压缩、有裁剪、有分工，但没有看到同等级别的长期记忆抽象。
