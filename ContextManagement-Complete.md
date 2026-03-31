# Claude Code Context Management Complete Guide

本文档整合并重写以下两份文档：

- [ContextManagement.md](/home/xm1994/Projects/claude-code/ContextManagement.md)
- [ContextManagement-DeepDive.md](/home/xm1994/Projects/claude-code/ContextManagement-DeepDive.md)

目标是给出一份单一入口的完整说明，系统介绍 Claude Code 中与 LLM Context 管理直接相关的实现、prompt、skills/subagents 策略，以及可复用的设计模式。

本文只讨论 LLM Context，不讨论 React context 或一般应用状态管理。

---

## 1. 执行摘要

Claude Code 的上下文管理不是单一的“对话快满了就做摘要”，而是一套分层系统：

- 输入分层：`systemPrompt`、`systemContext`、`userContext`、`messages`
- 噪声削减：优先清理高噪声工具输出
- 渐进压缩：`Tool Result Budget`、`snip`、`microcompact`、`autocompact`
- 长期记忆：`session memory` 和 `agent memory`
- 缓存优化：尽量保持 prompt cache 前缀稳定
- 子代理隔离：把中间探索噪声留在 fork/subagent 内部
- 恢复续写：compact 后重建最小可继续工作上下文

可以把它理解成一个分层记忆系统：

- 短期工作记忆：当前消息和最近保留段
- 中期压缩记忆：compact summary
- 长期结构化记忆：session memory / agent memory
- 外围缓存层：prompt cache / cache edits / cache references

---

## 2. 代码地图

主入口和核心模块：

- [query.ts](/home/xm1994/Projects/claude-code/package/restored-src/src/query.ts)
- [context.ts](/home/xm1994/Projects/claude-code/package/restored-src/src/context.ts)
- [api.ts](/home/xm1994/Projects/claude-code/package/restored-src/src/utils/api.ts)
- [autoCompact.ts](/home/xm1994/Projects/claude-code/package/restored-src/src/services/compact/autoCompact.ts)
- [microCompact.ts](/home/xm1994/Projects/claude-code/package/restored-src/src/services/compact/microCompact.ts)
- [compact.ts](/home/xm1994/Projects/claude-code/package/restored-src/src/services/compact/compact.ts)
- [prompt.ts](/home/xm1994/Projects/claude-code/package/restored-src/src/services/compact/prompt.ts)
- [sessionMemory.ts](/home/xm1994/Projects/claude-code/package/restored-src/src/services/SessionMemory/sessionMemory.ts)
- [SessionMemory prompts.ts](/home/xm1994/Projects/claude-code/package/restored-src/src/services/SessionMemory/prompts.ts)
- [claude.ts](/home/xm1994/Projects/claude-code/package/restored-src/src/services/api/claude.ts)
- [SkillTool prompt.ts](/home/xm1994/Projects/claude-code/package/restored-src/src/tools/SkillTool/prompt.ts)
- [AgentTool prompt.ts](/home/xm1994/Projects/claude-code/package/restored-src/src/tools/AgentTool/prompt.ts)
- [forkedAgent.ts](/home/xm1994/Projects/claude-code/package/restored-src/src/utils/forkedAgent.ts)
- [forkSubagent.ts](/home/xm1994/Projects/claude-code/package/restored-src/src/tools/AgentTool/forkSubagent.ts)
- [runAgent.ts](/home/xm1994/Projects/claude-code/package/restored-src/src/tools/AgentTool/runAgent.ts)
- [agentMemory.ts](/home/xm1994/Projects/claude-code/package/restored-src/src/tools/AgentTool/agentMemory.ts)

---

## 3. 模型真正看到的上下文

每次主查询发给模型前，Claude Code 会组装两类内容：

- `systemPrompt + systemContext`
- `messages + userContext`

关键代码：

```ts
const fullSystemPrompt = asSystemPrompt(
  appendSystemContext(systemPrompt, systemContext),
)

for await (const message of deps.callModel({
  messages: prependUserContext(messagesForQuery, userContext),
  systemPrompt: fullSystemPrompt,
  thinkingConfig: toolUseContext.options.thinkingConfig,
  tools: toolUseContext.options.tools,
  signal: toolUseContext.abortController.signal,
  options: {
    model: currentModel,
    querySource,
  },
})) {
```

来源：

- [query.ts](/home/xm1994/Projects/claude-code/package/restored-src/src/query.ts)

### 3.1 `systemContext`

`systemContext` 主要包含：

- git status
- 当前分支 / 主分支
- 最近提交
- cache breaker

代码片段：

```ts
export const getSystemContext = memoize(
  async (): Promise<{
    [k: string]: string
  }> => {
    const gitStatus =
      isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) ||
      !shouldIncludeGitInstructions()
        ? null
        : await getGitStatus()

    const injection = feature('BREAK_CACHE_COMMAND')
      ? getSystemPromptInjection()
      : null

    return {
      ...(gitStatus && { gitStatus }),
      ...(feature('BREAK_CACHE_COMMAND') && injection
        ? {
            cacheBreaker: `[CACHE_BREAKER: ${injection}]`,
          }
        : {}),
    }
  },
)
```

来源：

- [context.ts](/home/xm1994/Projects/claude-code/package/restored-src/src/context.ts)

### 3.2 `userContext`

`userContext` 主要包含：

- `CLAUDE.md`
- memory files
- 当前日期

代码片段：

```ts
export const getUserContext = memoize(
  async (): Promise<{
    [k: string]: string
  }> => {
    const shouldDisableClaudeMd =
      isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS) ||
      (isBareMode() && getAdditionalDirectoriesForClaudeMd().length === 0)

    const claudeMd = shouldDisableClaudeMd
      ? null
      : getClaudeMds(filterInjectedMemoryFiles(await getMemoryFiles()))

    return {
      ...(claudeMd && { claudeMd }),
      currentDate: `Today's date is ${getLocalISODate()}.`,
    }
  },
)
```

来源：

- [context.ts](/home/xm1994/Projects/claude-code/package/restored-src/src/context.ts)

### 3.3 注入方式

两类上下文的注入位置不同：

```ts
export function appendSystemContext(
  systemPrompt: SystemPrompt,
  context: { [k: string]: string },
): string[] {
  return [
    ...systemPrompt,
    Object.entries(context)
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n'),
  ].filter(Boolean)
}

export function prependUserContext(
  messages: Message[],
  context: { [k: string]: string },
): Message[] {
  if (Object.entries(context).length === 0) {
    return messages
  }

  return [
    createUserMessage({
      content: `<system-reminder>\nAs you answer the user's questions, you can use the following context:\n${Object.entries(
        context,
      )
        .map(([key, value]) => `# ${key}\n${value}`)
        .join('\n')}

      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.\n</system-reminder>\n`,
      isMeta: true,
    }),
    ...messages,
  ]
}
```

来源：

- [api.ts](/home/xm1994/Projects/claude-code/package/restored-src/src/utils/api.ts)

技术含义：

- 规则类信息进 system prompt
- 工作环境信息进 message 前缀
- `<system-reminder>` 用来标记“这是系统注入环境信息，不是普通用户意图”

---

## 4. 主上下文管理流水线

主查询链路在 [query.ts](/home/xm1994/Projects/claude-code/package/restored-src/src/query.ts) 中。

关键顺序：

```ts
let messagesForQuery = [...getMessagesAfterCompactBoundary(messages)]

messagesForQuery = await applyToolResultBudget(...)

if (feature('HISTORY_SNIP')) {
  const snipResult = snipModule!.snipCompactIfNeeded(messagesForQuery)
  messagesForQuery = snipResult.messages
}

const microcompactResult = await deps.microcompact(
  messagesForQuery,
  toolUseContext,
  querySource,
)
messagesForQuery = microcompactResult.messages

if (feature('CONTEXT_COLLAPSE') && contextCollapse) {
  const collapseResult = await contextCollapse.applyCollapsesIfNeeded(
    messagesForQuery,
    toolUseContext,
    querySource,
  )
  messagesForQuery = collapseResult.messages
}

const { compactionResult } = await deps.autocompact(...)
```

来源：

- [query.ts](/home/xm1994/Projects/claude-code/package/restored-src/src/query.ts)

这个顺序说明了 Claude Code 的设计哲学：

- 先去噪
- 再轻量裁剪
- 最后才做语义摘要

也就是说，它默认认为“工具输出噪声”比“用户对话长度”更值得优先处理。

---

## 5. 第一层：Tool Result Budget

在摘要之前，系统先控制工具输出体积：

```ts
messagesForQuery = await applyToolResultBudget(
  messagesForQuery,
  toolUseContext.contentReplacementState,
  persistReplacements
    ? records =>
        void recordContentReplacement(
          records,
          toolUseContext.agentId,
        ).catch(logError)
    : undefined,
  new Set(
    toolUseContext.options.tools
      .filter(t => !Number.isFinite(t.maxResultSizeChars))
      .map(t => t.name),
  ),
)
```

来源：

- [query.ts](/home/xm1994/Projects/claude-code/package/restored-src/src/query.ts)

这层解决的是 coding agent 的一个典型现实问题：

- 不是用户消息最占上下文
- 而是 `Read`、shell、grep、web fetch 等工具输出

---

## 6. 第二层：Snip

`snip` 在 `microcompact` 之前执行：

```ts
let snipTokensFreed = 0
if (feature('HISTORY_SNIP')) {
  const snipResult = snipModule!.snipCompactIfNeeded(messagesForQuery)
  messagesForQuery = snipResult.messages
  snipTokensFreed = snipResult.tokensFreed
}
```

来源：

- [query.ts](/home/xm1994/Projects/claude-code/package/restored-src/src/query.ts)

关键点不只是“删掉一些历史”，而是保留 `snipTokensFreed`，用来修正后续 auto-compact 的阈值判断，避免 token 估算和真实状态脱节。

---

## 7. 第三层：Microcompact

### 7.1 目标

`microcompact` 的目标不是总结整个对话，而是定向清理旧的高噪声工具结果。

可处理的工具包括：

```ts
const COMPACTABLE_TOOLS = new Set<string>([
  FILE_READ_TOOL_NAME,
  ...SHELL_TOOL_NAMES,
  GREP_TOOL_NAME,
  GLOB_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
])
```

来源：

- [microCompact.ts](/home/xm1994/Projects/claude-code/package/restored-src/src/services/compact/microCompact.ts)

### 7.2 Cached Microcompact

当 cache editing 可用时，系统会优先走“缓存层删除”，而不是直接改消息：

```ts
if (
  mod.isCachedMicrocompactEnabled() &&
  mod.isModelSupportedForCacheEditing(model) &&
  isMainThreadSource(querySource)
) {
  return await cachedMicrocompactPath(messages, querySource)
}
```

来源：

- [microCompact.ts](/home/xm1994/Projects/claude-code/package/restored-src/src/services/compact/microCompact.ts)

准备 `cache_edits`：

```ts
const toolsToDelete = mod.getToolResultsToDelete(state)

if (toolsToDelete.length > 0) {
  const cacheEdits = mod.createCacheEditsBlock(state, toolsToDelete)
  if (cacheEdits) {
    pendingCacheEdits = cacheEdits
  }
}
```

来源：

- [microCompact.ts](/home/xm1994/Projects/claude-code/package/restored-src/src/services/compact/microCompact.ts)

API 层插入 `cache_edits` 和 `cache_reference`：

```ts
// Re-insert all previously-pinned cache_edits at their original positions
for (const pinned of pinnedEdits ?? []) {
  ...
  insertBlockAfterToolResults(msg.content, dedupedBlock)
}

// Add cache_reference to tool_result blocks that are within the cached prefix.
if (enablePromptCaching) {
  ...
  msg.content[j] = Object.assign({}, block, {
    cache_reference: block.tool_use_id,
  })
}
```

来源：

- [claude.ts](/home/xm1994/Projects/claude-code/package/restored-src/src/services/api/claude.ts)

技术含义：

- 不直接重写历史文本
- 先在缓存层做逻辑删除
- 尽量保住 prompt cache

### 7.3 Time-based Microcompact

如果距离上次 assistant 已经很久，cache 可能冷了，就直接清空旧 tool result 内容：

```ts
const TIME_BASED_MC_CLEARED_MESSAGE = '[Old tool result content cleared]'
```

以及：

```ts
if (
  block.type === 'tool_result' &&
  clearSet.has(block.tool_use_id) &&
  block.content !== TIME_BASED_MC_CLEARED_MESSAGE
) {
  return { ...block, content: TIME_BASED_MC_CLEARED_MESSAGE }
}
```

来源：

- [microCompact.ts](/home/xm1994/Projects/claude-code/package/restored-src/src/services/compact/microCompact.ts)

这里的策略是：

- cache 热：逻辑删除，保 cache
- cache 冷：物理清空，减 token

---

## 8. 第四层：Auto-compact

真正的摘要式 compact 由 `autocompact` 驱动。

### 8.1 阈值设计

```ts
const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000

export function getEffectiveContextWindowSize(model: string): number {
  const reservedTokensForSummary = Math.min(
    getMaxOutputTokensForModel(model),
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  )
  let contextWindow = getContextWindowForModel(model, getSdkBetas())
  return contextWindow - reservedTokensForSummary
}

export const AUTOCOMPACT_BUFFER_TOKENS = 13_000
export const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000
export const ERROR_THRESHOLD_BUFFER_TOKENS = 20_000
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000
```

来源：

- [autoCompact.ts](/home/xm1994/Projects/claude-code/package/restored-src/src/services/compact/autoCompact.ts)

本质上它不是在“吃满上下文”，而是在做 budget management：

- 预留摘要输出空间
- 留 warning / blocking buffer
- 提前触发 compact

### 8.2 Compact 后的消息重建

compact 之后系统不会只留一条 summary，而会重建一个“可继续工作”的上下文包：

```ts
export function buildPostCompactMessages(result: CompactionResult): Message[] {
  return [
    result.boundaryMarker,
    ...result.summaryMessages,
    ...(result.messagesToKeep ?? []),
    ...result.attachments,
    ...result.hookResults,
  ]
}
```

来源：

- [compact.ts](/home/xm1994/Projects/claude-code/package/restored-src/src/services/compact/compact.ts)

---

## 9. Compact Prompt 设计

compact prompt 在：

- [compact prompt.ts](/home/xm1994/Projects/claude-code/package/restored-src/src/services/compact/prompt.ts)

### 9.1 总体结构

`compact` prompt 由以下几部分组成：

1. `NO_TOOLS_PREAMBLE`
2. 主模板 `BASE_COMPACT_PROMPT`
3. `Additional Instructions`
4. `NO_TOOLS_TRAILER`

```ts
export function getCompactPrompt(customInstructions?: string): string {
  let prompt = NO_TOOLS_PREAMBLE + BASE_COMPACT_PROMPT

  if (customInstructions && customInstructions.trim() !== '') {
    prompt += `\n\nAdditional Instructions:\n${customInstructions}`
  }

  prompt += NO_TOOLS_TRAILER

  return prompt
}
```

### 9.2 `NO_TOOLS_PREAMBLE`

```ts
const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.
`
```

这段 prompt 的目标是：

- 防止 compact 过程再次拉入外部上下文
- 把 compact 固定成一个纯压缩步骤
- 避免唯一回合浪费在工具调用上

### 9.3 `<analysis>` + `<summary>` 双阶段输出

compact prompt 要求模型先写 `<analysis>` 再写 `<summary>`：

```ts
const DETAILED_ANALYSIS_INSTRUCTION_BASE = `Before providing your final summary, wrap your analysis in <analysis> tags ...
`
```

但写回上下文前，系统会删除 `<analysis>`：

```ts
formattedSummary = formattedSummary.replace(
  /<analysis>[\s\S]*?<\/analysis>/,
  '',
)
```

来源：

- [prompt.ts](/home/xm1994/Projects/claude-code/package/restored-src/src/services/compact/prompt.ts)

这是典型的：

- 生成时允许冗余思考
- 持久化时只保留稠密结果

### 9.4 摘要字段为什么这么重

`BASE_COMPACT_PROMPT` 要求总结：

- 用户意图
- 技术概念
- 文件与代码片段
- 错误与修复
- 问题解决过程
- 所有用户消息
- 待办任务
- 当前工作
- 下一步

这说明 compact summary 不是“给人读的摘要”，而是“给 agent 接力的工作状态转储”。

### 9.5 为什么要求 direct quotes

compact prompt 要求在 `Optional Next Step` 中引用最近对话原文，以防任务理解漂移。这是在保护“最后工作点”的准确性。

### 9.6 `NO_TOOLS_TRAILER`

尾部再次强调不要调工具：

```ts
const NO_TOOLS_TRAILER =
  '\n\nREMINDER: Do NOT call any tools. Respond with plain text only — ' +
  'an <analysis> block followed by a <summary> block. ' +
  'Tool calls will be rejected and you will fail the task.'
```

这属于 prompt sandwich：

- 开头立规则
- 中间给任务
- 结尾再钉最重要约束

---

## 10. Partial Compact Prompt

系统支持 partial compact，两种方向：

- `from`
- `up_to`

### 10.1 `PARTIAL_COMPACT_PROMPT`

它强调只总结 recent 部分：

```ts
const PARTIAL_COMPACT_PROMPT = `Your task is to create a detailed summary of the RECENT portion of the conversation ...
The earlier messages are being kept intact and do NOT need to be summarized.
`
```

作用：

- 避免重复总结已保留内容
- 避免摘要和保留消息段重叠

### 10.2 `PARTIAL_COMPACT_UP_TO_PROMPT`

这个版本用于“总结前缀、保留后缀”：

```ts
const PARTIAL_COMPACT_UP_TO_PROMPT = `This summary will be placed at the start of a continuing session; newer messages ... will follow after your summary ...`
```

并新增了：

- `Context for Continuing Work`

这是在要求模型构造一个“可拼接前缀摘要”。

---

## 11. Compact 后的桥接 Prompt

compact 后系统会把摘要封装成一条 continuation message：

```ts
export function getCompactUserSummaryMessage(
  summary: string,
  suppressFollowUpQuestions?: boolean,
  transcriptPath?: string,
  recentMessagesPreserved?: boolean,
): string {
  ...
  if (suppressFollowUpQuestions) {
    let continuation = `${baseSummary}
Continue the conversation from where it left off without asking the user any further questions. Resume directly ...`
    return continuation
  }
  return baseSummary
}
```

来源：

- [prompt.ts](/home/xm1994/Projects/claude-code/package/restored-src/src/services/compact/prompt.ts)

这是一种“上下文桥接 prompt”，目的是避免 compact 后行为断层。

---

## 12. Session Memory

### 12.1 触发条件

session memory 不是每轮都更新，而是在满足阈值后异步提取：

```ts
export function shouldExtractMemory(messages: Message[]): boolean {
  const currentTokenCount = tokenCountWithEstimation(messages)
  ...
  const hasMetTokenThreshold = hasMetUpdateThreshold(currentTokenCount)
  const hasMetToolCallThreshold =
    toolCallsSinceLastUpdate >= getToolCallsBetweenUpdates()
  const hasToolCallsInLastTurn = hasToolCallsInLastAssistantTurn(messages)

  const shouldExtract =
    (hasMetTokenThreshold && hasMetToolCallThreshold) ||
    (hasMetTokenThreshold && !hasToolCallsInLastTurn)
}
```

来源：

- [sessionMemory.ts](/home/xm1994/Projects/claude-code/package/restored-src/src/services/SessionMemory/sessionMemory.ts)

### 12.2 提取方式

session memory 用 forked agent 更新，避免污染主线程上下文：

```ts
await runForkedAgent({
  promptMessages: [createUserMessage({ content: userPrompt })],
  cacheSafeParams: createCacheSafeParams(context),
  canUseTool: createMemoryFileCanUseTool(memoryPath),
  querySource: 'session_memory',
  forkLabel: 'session_memory',
  overrides: { readFileState: setupContext.readFileState },
})
```

来源：

- [sessionMemory.ts](/home/xm1994/Projects/claude-code/package/restored-src/src/services/SessionMemory/sessionMemory.ts)

### 12.3 Session Memory 模板

默认模板包含：

- `Session Title`
- `Current State`
- `Task specification`
- `Files and Functions`
- `Workflow`
- `Errors & Corrections`
- `Codebase and System Documentation`
- `Learnings`
- `Key results`
- `Worklog`

来源：

- [SessionMemory prompts.ts](/home/xm1994/Projects/claude-code/package/restored-src/src/services/SessionMemory/prompts.ts)

本质上它把长期工作记忆拆成：

- 任务记忆
- 代码记忆
- 经验记忆
- 恢复点记忆

### 12.4 Session Memory 更新 Prompt

默认更新 prompt 的几个核心约束：

- 这不是实际用户对话
- 只能用 Edit 更新 notes 文件
- 不能改模板结构
- 必须写 info-dense 内容
- 每个 section 有预算
- 必须更新 `Current State`

示例片段：

```ts
Your ONLY task is to use the Edit tool to update the notes file, then stop.
...
- The file must maintain its exact structure with all sections, headers, and italic descriptions intact
- Do NOT reference this note-taking process or instructions anywhere in the notes
- Write DETAILED, INFO-DENSE content for each section
- IMPORTANT: Always update "Current State" to reflect the most recent work
```

来源：

- [SessionMemory prompts.ts](/home/xm1994/Projects/claude-code/package/restored-src/src/services/SessionMemory/prompts.ts)

### 12.5 长度预算

session memory 有 section 级和 total 级两层预算：

```ts
const MAX_SECTION_LENGTH = 2000
const MAX_TOTAL_SESSION_MEMORY_TOKENS = 12000
```

预算超了会自动追加压缩提醒：

```ts
Prioritize keeping "Current State" and "Errors & Corrections" accurate and detailed.
```

这说明系统认为最值得保留的是：

- 当前做什么
- 哪些坑踩过

### 12.6 Session Memory 参与 Compact

如果 session memory 可用，系统会优先尝试直接把它拿来作为 compact summary：

```ts
let summaryContent = getCompactUserSummaryMessage(
  truncatedContent,
  true,
  transcriptPath,
  true,
)
```

来源：

- [sessionMemoryCompact.ts](/home/xm1994/Projects/claude-code/package/restored-src/src/services/compact/sessionMemoryCompact.ts)

这相当于把 compact 结果资产化，而不是每次都重算全文摘要。

---

## 13. Prompt Cache 与 Compact 请求本身

compact 请求并不总走普通 streaming，它会尽量复用主线程已有的 prompt cache：

```ts
if (promptCacheSharingEnabled) {
  const result = await runForkedAgent({
    promptMessages: [summaryRequest],
    cacheSafeParams,
    canUseTool: createCompactCanUseTool(),
    querySource: 'compact',
    forkLabel: 'compact',
    maxTurns: 1,
    skipCacheWrite: true,
    overrides: { abortController: context.abortController },
  })
}
```

来源：

- [compact.ts](/home/xm1994/Projects/claude-code/package/restored-src/src/services/compact/compact.ts)

这说明 compact 不只是“语义压缩”，也是“缓存敏感的特殊查询”。

---

## 14. `/context` 与上下文可观测性

系统提供 `/context` 来显示模型真正看到的上下文视图，而不是 raw transcript：

```ts
function toApiView(messages: Message[]): Message[] {
  let view = getMessagesAfterCompactBoundary(messages);
  if (feature('CONTEXT_COLLAPSE')) {
    const { projectView } =
      require('../../services/contextCollapse/operations.js')
    view = projectView(view);
  }
  return view;
}

const { messages: compactedMessages } = await microcompactMessages(apiView);
const data = await analyzeContextUsage(compactedMessages, ...)
```

来源：

- [commands/context/context.tsx](/home/xm1994/Projects/claude-code/package/restored-src/src/commands/context/context.tsx)

这说明 Claude Code 不只管理上下文，还提供“上下文可观测性”。

---

## 15. 主 System Prompt 对 Context 的行为设定

系统 prompt 里直接告诉模型：

```ts
return `- Tool results and user messages may include <system-reminder> tags. ...
- The conversation has unlimited context through automatic summarization.`
```

以及：

```ts
`The system will automatically compress prior messages in your conversation as it approaches context limits. This means your conversation with the user is not limited by the context window.`
```

来源：

- [constants/prompts.ts](/home/xm1994/Projects/claude-code/package/restored-src/src/constants/prompts.ts)

这相当于给模型建立一套“上下文会被系统维护”的世界模型。

---

## 16. Skills 的上下文管理技巧

### 16.1 Skill 发现层和执行层分离

Skill 列表只提供发现信息，不展开完整内容：

```ts
// Skill listing gets 1% of the context window (in characters)
export const SKILL_BUDGET_CONTEXT_PERCENT = 0.01
export const MAX_LISTING_DESC_CHARS = 250
```

来源：

- [SkillTool prompt.ts](/home/xm1994/Projects/claude-code/package/restored-src/src/tools/SkillTool/prompt.ts)

含义：

- 列表只负责召回
- 真正执行 skill 时再注入完整 prompt

### 16.2 Skill 描述按预算截断

```ts
export function getCharBudget(contextWindowTokens?: number): number {
  if (contextWindowTokens) {
    return Math.floor(
      contextWindowTokens * CHARS_PER_TOKEN * SKILL_BUDGET_CONTEXT_PERCENT,
    )
  }
  return DEFAULT_CHAR_BUDGET
}
```

这样：

- 所有 skill 名字都保留
- 描述在预算内自动缩短

### 16.3 已加载 skill 防重复注入

```ts
- If you see a <${COMMAND_NAME_TAG}> tag in the current conversation turn, the skill has ALREADY been loaded - follow the instructions directly instead of calling this tool again
```

来源：

- [SkillTool prompt.ts](/home/xm1994/Projects/claude-code/package/restored-src/src/tools/SkillTool/prompt.ts)

这是一种 prompt 级别的上下文去重。

---

## 17. Subagents / Forks 的上下文管理技巧

### 17.1 动态 agent list 改为 attachment，避免 cache bust

```ts
/**
 * The dynamic agent list was ~10.2% of fleet cache_creation tokens ...
 * description changes → full tool-schema cache bust.
 */
```

来源：

- [AgentTool prompt.ts](/home/xm1994/Projects/claude-code/package/restored-src/src/tools/AgentTool/prompt.ts)

技巧：

- 动态 agent list 不放进 tool prompt
- 改成 attachment / system-reminder
- 静态 schema 保稳定，动态内容单独注入

### 17.2 Fork vs fresh subagent

AgentTool prompt 明确区分：

```ts
Fork yourself ... when the intermediate tool output isn't worth keeping in your context.
...
When spawning a fresh agent ... it starts with zero context.
```

来源：

- [AgentTool prompt.ts](/home/xm1994/Projects/claude-code/package/restored-src/src/tools/AgentTool/prompt.ts)

这相当于两种上下文模式：

- `fork`: 继承上下文，适合隔离中间噪声
- `fresh subagent`: 零上下文，适合独立判断

### 17.3 Fork 的核心价值之一是“噪声隔离”

```ts
**Don't peek.** ... Reading the transcript mid-flight pulls the fork's tool noise into your context, which defeats the point of forking.
```

来源：

- [AgentTool prompt.ts](/home/xm1994/Projects/claude-code/package/restored-src/src/tools/AgentTool/prompt.ts)

这非常关键。fork 的意义不只是并行，而是：

- 把探索过程的工具噪声隔离到子线程
- 主线程只消费结果，不消费全过程

### 17.4 Fork prompt 是 directive，不是 briefing

```ts
**Writing a fork prompt.** Since the fork inherits your context, the prompt is a *directive* — what to do, not what the situation is.
```

而 fresh agent：

```ts
When spawning a fresh agent ... it starts with zero context.
Brief the agent like a smart colleague who just walked into the room ...
```

来源：

- [AgentTool prompt.ts](/home/xm1994/Projects/claude-code/package/restored-src/src/tools/AgentTool/prompt.ts)

技巧：

- fork：简短 directive，避免重复背景
- fresh agent：完整 briefing，避免信息不足

### 17.5 Fork 共享 cache-safe prefix

`forkedAgent.ts` 定义了必须和父查询一致的 cache 关键参数：

```ts
export type CacheSafeParams = {
  systemPrompt: SystemPrompt
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
  toolUseContext: ToolUseContext
  forkContextMessages: Message[]
}
```

来源：

- [forkedAgent.ts](/home/xm1994/Projects/claude-code/package/restored-src/src/utils/forkedAgent.ts)

这是显式的“cache-safe prefix”设计。

### 17.6 Subagent 默认隔离可变状态，但保留 cache 命中条件

`createSubagentContext()` 的设计要点：

```ts
/**
 * By default, ALL mutable state is isolated to prevent interference:
 * - readFileState: cloned from parent
 * - abortController: new controller linked to parent
 * - All mutation callbacks: no-op
 */
```

同时：

```ts
// Clone by default (not fresh): cache-sharing forks process parent
// messages containing parent tool_use_ids. A fresh state would see
// them as unseen and make divergent replacement decisions → cache miss.
```

来源：

- [forkedAgent.ts](/home/xm1994/Projects/claude-code/package/restored-src/src/utils/forkedAgent.ts)

这是一种很细的上下文工程技巧：

- 语义上隔离
- 字节上尽量保持前缀一致

### 17.7 Fork child 用统一 placeholder 保证前缀字节一致

```ts
const FORK_PLACEHOLDER_RESULT = 'Fork started — processing in background'
```

并且：

```ts
 * For prompt cache sharing, all fork children must produce byte-identical
 * API request prefixes.
```

来源：

- [forkSubagent.ts](/home/xm1994/Projects/claude-code/package/restored-src/src/tools/AgentTool/forkSubagent.ts)

这里追求的是字节级一致，而不只是语义一致。

### 17.8 Read-only subagent 主动瘦身父上下文

`Explore` / `Plan` 这类 agent 会主动丢弃一部分父上下文：

```ts
const shouldOmitClaudeMd = ...
const resolvedUserContext = shouldOmitClaudeMd
  ? userContextNoClaudeMd
  : baseUserContext
```

以及：

```ts
const resolvedSystemContext =
  agentDefinition.agentType === 'Explore' ||
  agentDefinition.agentType === 'Plan'
    ? systemContextNoGit
    : baseSystemContext
```

来源：

- [runAgent.ts](/home/xm1994/Projects/claude-code/package/restored-src/src/tools/AgentTool/runAgent.ts)

这说明不是所有 subagent 都继承完整父上下文。只读搜索型 agent 会主动瘦身，以减少无效 token。

### 17.9 Fresh subagent 默认关闭 thinking

```ts
thinkingConfig: useExactTools
  ? toolUseContext.options.thinkingConfig
  : { type: 'disabled' as const },
```

来源：

- [runAgent.ts](/home/xm1994/Projects/claude-code/package/restored-src/src/tools/AgentTool/runAgent.ts)

含义：

- fork child 为了 cache 对齐，继承 thinking config
- 普通 subagent 为了控成本，默认关闭 thinking

### 17.10 Agent memory 是 agent 粒度的长期记忆外置

```ts
export type AgentMemoryScope = 'user' | 'project' | 'local'
```

并通过：

```ts
export function loadAgentMemoryPrompt(
  agentType: string,
  scope: AgentMemoryScope,
): string {
  return buildMemoryPrompt({
    displayName: 'Persistent Agent Memory',
    memoryDir,
    extraGuidelines: ...
  })
}
```

来源：

- [agentMemory.ts](/home/xm1994/Projects/claude-code/package/restored-src/src/tools/AgentTool/agentMemory.ts)

这与 session memory 一样，都是把长期高价值信息外置到磁盘，再在需要时重新注入 prompt。

---

## 18. 可复用的设计模式

从这套实现里，可以提炼出一些通用的 Context Engineering 模式。

### 18.1 Discovery / Execution 分层

Skill 列表只放发现信息，完整 skill prompt 按需加载。

适用：

- 工具列表
- 技能库
- 能力目录

### 18.2 先去噪，再摘要

优先处理：

- 工具输出
- 大块附件
- 可清空中间结果

再处理：

- 用户意图摘要
- 对话语义压缩

### 18.3 生成态和持久态分离

compact 时允许 `<analysis>`，写回时只保留 `<summary>`。

### 18.4 短期记忆 / 中期摘要 / 长期记忆 分层

- 短期：live messages
- 中期：compact summary
- 长期：session memory / agent memory

### 18.5 动态内容从 cache-critical schema 中剥离

例如 agent list 用 attachment，而不是直接塞进 tool prompt。

### 18.6 子线程隔离噪声

把中间探索、研究、工具噪声放进 fork/subagent。

### 18.7 cache-safe prefix 显式建模

把决定 cache key 的关键字段单独抽象出来，而不是隐式耦合在巨大上下文对象里。

---

## 19. 结论

Claude Code 的上下文管理可以概括成一句话：

“先把最吵的工具输出从上下文里移出去，再把必要历史压成可继续工作的状态表示，同时尽量保住 prompt cache，并把长期高价值信息沉淀到结构化记忆中。”

更具体一点：

- 主线程负责最终任务连续性
- compact 负责把历史压成工作状态
- session memory / agent memory 负责长期记忆沉淀
- skills 负责按需加载专用能力
- subagents/forks 负责把中间噪声隔离在子线程
- prompt cache 负责降低重复上下文成本

这套系统的重点不在“把消息删短”，而在“让长任务在有限窗口内仍然保持状态连续、行为稳定、成本可控”。
