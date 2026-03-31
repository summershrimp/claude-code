# Claude Code LLM Context Management

本文档聚焦 `package/restored-src/` 中与 LLM Context 管理直接相关的实现，不讨论 React context 或一般应用状态管理。

目标有三件事：

1. 说明模型真正看到的上下文是怎么构成的
2. 拆解上下文管理流水线中的关键功能点
3. 摘录关键 prompt 和代码片段，分析背后的技术思路

## 1. 总览

Claude Code 的上下文管理不是单一的“对话太长就做摘要”，而是一套分层系统：

- 输入分层：`systemPrompt`、`systemContext`、`userContext`、`messages`
- 噪声削减：优先清理超大的工具输出
- 渐进压缩：`snip`、`microcompact`、`autocompact`
- 长期记忆：`session memory`
- 缓存优化：尽量保住 prompt cache，而不是每次全量重写上下文
- 恢复与续写：compact 后重建“可继续工作”的最小上下文

主入口在：

- `package/restored-src/src/query.ts`
- `package/restored-src/src/services/compact/compact.ts`
- `package/restored-src/src/services/compact/microCompact.ts`
- `package/restored-src/src/services/SessionMemory/sessionMemory.ts`

## 2. 模型真正看到的上下文

每次主查询发给模型前，系统会组装两类内容：

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

- `package/restored-src/src/query.ts`

这说明它显式区分了：

- 规则类上下文：进入 system prompt
- 工作环境类上下文：进入消息流前缀

### 2.1 systemContext

`systemContext` 来自 `src/context.ts`，主要包含：

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

- `package/restored-src/src/context.ts`

### 2.2 userContext

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

- `package/restored-src/src/context.ts`

### 2.3 注入方式

`systemContext` 和 `userContext` 的注入方式不同：

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

- `package/restored-src/src/utils/api.ts`

技术含义：

- `systemPrompt` 更稳定，利于 prompt cache
- `userContext` 用 `<system-reminder>` 包装，明确告诉模型这不是普通用户意图
- 系统显式提醒“may or may not be relevant”，防止模型过度响应注入信息

## 3. 主上下文管理流水线

主流水线在 `src/query.ts` 中，调用顺序如下：

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

const { compactionResult } = await deps.autocompact(
  messagesForQuery,
  toolUseContext,
  {
    systemPrompt,
    userContext,
    systemContext,
    toolUseContext,
    forkContextMessages: messagesForQuery,
  },
  querySource,
  tracking,
  snipTokensFreed,
)
```

来源：

- `package/restored-src/src/query.ts`

技术思路非常明确：

- 先从最近一个 compact 边界之后开始取历史
- 先削掉最吵、最胖的工具结果
- 再做轻量裁剪
- 最后才做摘要式 compact

这是一套“噪声优先”的 agent 上下文治理，而不是传统聊天应用的“整段摘要”。

## 4. 第一层：Tool Result Budget

在真正 compact 之前，会先控制单条或聚合工具结果的体积：

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

- `package/restored-src/src/query.ts`

作用：

- 避免 shell、Read、Grep、WebFetch 等输出把窗口瞬间打满
- 在 resume 或 agent sidechain 场景里还能持久化替换记录

这说明他们把工具输出看成 context inflation 的第一来源。

## 5. 第二层：Snip

`snip` 在 `microcompact` 之前执行：

```ts
let snipTokensFreed = 0
if (feature('HISTORY_SNIP')) {
  const snipResult = snipModule!.snipCompactIfNeeded(messagesForQuery)
  messagesForQuery = snipResult.messages
  snipTokensFreed = snipResult.tokensFreed
  if (snipResult.boundaryMessage) {
    yield snipResult.boundaryMessage
  }
}
```

来源：

- `package/restored-src/src/query.ts`

这里的关键不是单纯删消息，而是记录 `snipTokensFreed`，因为本地 token 估算和 API usage 可能存在滞后。后续 auto-compact 的阈值判断会把这个值扣掉，避免“明明已经缩了，系统还以为太长”的误判。

## 6. 第三层：Microcompact

`microcompact` 的核心目标不是“总结对话”，而是“清理旧的高噪声工具结果”。

### 6.1 可被 microcompact 的工具

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

- `package/restored-src/src/services/compact/microCompact.ts`

这是很典型的 coding agent 设计：

- 不是优先压缩用户消息
- 而是优先压缩大块工具输出

### 6.2 Cached Microcompact

如果 cache editing 可用，会走 cached microcompact：

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

- `package/restored-src/src/services/compact/microCompact.ts`

cached microcompact 不直接改本地 message 内容，而是准备 `cache_edits`：

```ts
const toolsToDelete = mod.getToolResultsToDelete(state)

if (toolsToDelete.length > 0) {
  const cacheEdits = mod.createCacheEditsBlock(state, toolsToDelete)
  if (cacheEdits) {
    pendingCacheEdits = cacheEdits
  }

  return {
    messages,
    compactionInfo: {
      pendingCacheEdits: {
        trigger: 'auto',
        deletedToolIds: toolsToDelete,
        baselineCacheDeletedTokens: baseline,
      },
    },
  }
}
```

来源：

- `package/restored-src/src/services/compact/microCompact.ts`

API 层会把这些 `cache_edits` 和 `cache_reference` 真正插进去：

```ts
// Re-insert all previously-pinned cache_edits at their original positions
for (const pinned of pinnedEdits ?? []) {
  const msg = result[pinned.userMessageIndex]
  if (msg && msg.role === 'user') {
    if (!Array.isArray(msg.content)) {
      msg.content = [{ type: 'text', text: msg.content as string }]
    }
    const dedupedBlock = deduplicateEdits(pinned.block)
    if (dedupedBlock.edits.length > 0) {
      insertBlockAfterToolResults(msg.content, dedupedBlock)
    }
  }
}

// Add cache_reference to tool_result blocks that are within the cached prefix.
if (enablePromptCaching) {
  ...
  if (lastCCMsg >= 0) {
    for (let i = 0; i < lastCCMsg; i++) {
      const msg = result[i]!
      if (msg.role !== 'user' || !Array.isArray(msg.content)) {
        continue
      }
      ...
      msg.content[j] = Object.assign({}, block, {
        cache_reference: block.tool_use_id,
      })
    }
  }
}
```

来源：

- `package/restored-src/src/services/api/claude.ts`

技术含义：

- 不是直接重写历史文本
- 而是在缓存层面对旧 tool result 做逻辑删除
- 尽量保住 prompt cache 的命中率

这是这套系统里最有技术特点的部分之一。

### 6.3 Time-based Microcompact

如果距离上次 assistant 回复已经很久，说明 cache 可能冷了，就不再做 cache-editing，而是直接把旧 tool result 内容清空：

```ts
const TIME_BASED_MC_CLEARED_MESSAGE = '[Old tool result content cleared]'

function maybeTimeBasedMicrocompact(
  messages: Message[],
  querySource: QuerySource | undefined,
): MicrocompactResult | null {
  const trigger = evaluateTimeBasedTrigger(messages, querySource)
  if (!trigger) {
    return null
  }
  ...
  const result: Message[] = messages.map(message => {
    if (message.type !== 'user' || !Array.isArray(message.message.content)) {
      return message
    }
    let touched = false
    const newContent = message.message.content.map(block => {
      if (
        block.type === 'tool_result' &&
        clearSet.has(block.tool_use_id) &&
        block.content !== TIME_BASED_MC_CLEARED_MESSAGE
      ) {
        tokensSaved += calculateToolResultTokens(block)
        touched = true
        return { ...block, content: TIME_BASED_MC_CLEARED_MESSAGE }
      }
      return block
    })
    ...
  })
}
```

来源：

- `package/restored-src/src/services/compact/microCompact.ts`

技术含义：

- cache 热：逻辑删除，保 cache
- cache 冷：物理清空，减 token

这是一种很务实的双路径设计。

## 7. 第四层：Auto-compact

真正的摘要式 compact 由 `autocompact` 驱动。

### 7.1 阈值设计

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

- `package/restored-src/src/services/compact/autoCompact.ts`

这说明它不是拿模型窗口上限硬顶，而是：

- 先预留 compact 自己需要的输出空间
- 再留 warning / error / blocking buffer
- 提前触发 compact

本质是 budget-driven context management。

### 7.2 Compact 后的上下文重建

compact 之后，不是只留一条摘要，而是重建一组 post-compact messages：

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

- `package/restored-src/src/services/compact/compact.ts`

技术含义：

- compact 后保留摘要
- 但也保留必须继续工作的最近消息段
- 还会重新注入文件、plan、skill、MCP 等附件

这不是“丢弃历史”，而是“重建最小工作集”。

## 8. Compact Prompt 设计

compact prompt 在：

- `package/restored-src/src/services/compact/prompt.ts`

### 8.1 禁止工具调用

```ts
const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.
`
```

目的：

- 防止 compact 过程中再把外部上下文拉进来
- 避免“为了做摘要又扩张上下文”

### 8.2 `<analysis>` 与 `<summary>` 双阶段输出

prompt 强制模型先给 `<analysis>` 再给 `<summary>`，但持久化到上下文前会删掉 `<analysis>`：

```ts
export function formatCompactSummary(summary: string): string {
  let formattedSummary = summary

  formattedSummary = formattedSummary.replace(
    /<analysis>[\s\S]*?<\/analysis>/,
    '',
  )

  const summaryMatch = formattedSummary.match(/<summary>([\s\S]*?)<\/summary>/)
  if (summaryMatch) {
    const content = summaryMatch[1] || ''
    formattedSummary = formattedSummary.replace(
      /<summary>[\s\S]*?<\/summary>/,
      `Summary:\n${content.trim()}`,
    )
  }

  return formattedSummary.trim()
}
```

来源：

- `package/restored-src/src/services/compact/prompt.ts`

这是典型的：

- 推理时允许冗余草稿
- 存储时只保留稠密摘要

### 8.3 摘要结构是“工作记忆模板”

Base compact prompt 不是让模型写普通摘要，而是要求覆盖：

- 用户主请求
- 技术概念
- 文件与代码片段
- 错误与修复
- 问题解决过程
- 所有用户消息
- Pending tasks
- Current work
- Optional next step

代码片段：

```ts
const BASE_COMPACT_PROMPT = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
...
Your summary should include the following sections:

1. Primary Request and Intent
2. Key Technical Concepts
3. Files and Code Sections
4. Errors and fixes
5. Problem Solving
6. All user messages
7. Pending Tasks
8. Current Work
9. Optional Next Step
...`
```

来源：

- `package/restored-src/src/services/compact/prompt.ts`

技术含义：

- compact summary 不是面向人类阅读
- 而是面向“下一轮 agent 继续干活”
- 本质上是工作状态转储格式

### 8.4 Partial compact

系统支持 partial compact，区分：

- `from`
- `up_to`

```ts
/**
 * Performs a partial compaction around the selected message index.
 * Direction 'from': summarizes messages after the index, keeps earlier ones.
 *   Prompt cache for kept (earlier) messages is preserved.
 * Direction 'up_to': summarizes messages before the index, keeps later ones.
 *   Prompt cache is invalidated since the summary precedes the kept messages.
 */
```

来源：

- `package/restored-src/src/services/compact/compact.ts`

这说明 partial compact 不是只考虑语义，还考虑 prompt cache 结构。

## 9. Compact 后的续写 Prompt

compact 后会生成一条“继续会话”的摘要消息：

```ts
export function getCompactUserSummaryMessage(
  summary: string,
  suppressFollowUpQuestions?: boolean,
  transcriptPath?: string,
  recentMessagesPreserved?: boolean,
): string {
  const formattedSummary = formatCompactSummary(summary)

  let baseSummary = `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.

${formattedSummary}`

  if (transcriptPath) {
    baseSummary += `\n\nIf you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: ${transcriptPath}`
  }

  if (recentMessagesPreserved) {
    baseSummary += `\n\nRecent messages are preserved verbatim.`
  }

  if (suppressFollowUpQuestions) {
    let continuation = `${baseSummary}
Continue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface with "I'll continue" or similar. Pick up the last task as if the break never happened.`
    return continuation
  }

  return baseSummary
}
```

来源：

- `package/restored-src/src/services/compact/prompt.ts`

技术含义：

- 这是一种“上下文桥接 prompt”
- 目标不是解释 compact，而是避免模型在 compact 后行为断层

## 10. Session Memory

`session memory` 是这套系统里的长期记忆层，不是当前轮上下文本身。

### 10.1 触发条件

```ts
export function shouldExtractMemory(messages: Message[]): boolean {
  const currentTokenCount = tokenCountWithEstimation(messages)
  if (!isSessionMemoryInitialized()) {
    if (!hasMetInitializationThreshold(currentTokenCount)) {
      return false
    }
    markSessionMemoryInitialized()
  }

  const hasMetTokenThreshold = hasMetUpdateThreshold(currentTokenCount)

  const toolCallsSinceLastUpdate = countToolCallsSince(
    messages,
    lastMemoryMessageUuid,
  )
  const hasMetToolCallThreshold =
    toolCallsSinceLastUpdate >= getToolCallsBetweenUpdates()

  const hasToolCallsInLastTurn = hasToolCallsInLastAssistantTurn(messages)

  const shouldExtract =
    (hasMetTokenThreshold && hasMetToolCallThreshold) ||
    (hasMetTokenThreshold && !hasToolCallsInLastTurn)

  ...
}
```

来源：

- `package/restored-src/src/services/SessionMemory/sessionMemory.ts`

它不是每轮都提取，而是：

- 会话够长后才开始
- 需要增长到一定 token
- 需要积累一定工具调用，或到达自然停顿点

### 10.2 提取方式

```ts
const setupContext = createSubagentContext(toolUseContext)

const { memoryPath, currentMemory } =
  await setupSessionMemoryFile(setupContext)

const userPrompt = await buildSessionMemoryUpdatePrompt(
  currentMemory,
  memoryPath,
)

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

- `package/restored-src/src/services/SessionMemory/sessionMemory.ts`

技术含义：

- 用 forked agent 提取记忆
- 限制可访问能力
- 避免污染主线程上下文和 file state cache

### 10.3 Session Memory 模板

默认 memory 文件模板：

```md
# Session Title

# Current State

# Task specification

# Files and Functions

# Workflow

# Errors & Corrections

# Codebase and System Documentation

# Learnings

# Key results

# Worklog
```

来源：

- `package/restored-src/src/services/SessionMemory/prompts.ts`

这不是普通摘要，而是结构化工作记忆。

### 10.4 Session Memory 更新 Prompt

```ts
function getDefaultUpdatePrompt(): string {
  return `IMPORTANT: This message and these instructions are NOT part of the actual user conversation.
...
Your ONLY task is to use the Edit tool to update the notes file, then stop.
...
- The file must maintain its exact structure with all sections, headers, and italic descriptions intact
- Do NOT reference this note-taking process or instructions anywhere in the notes
- Write DETAILED, INFO-DENSE content for each section
- Keep each section under ~${MAX_SECTION_LENGTH} tokens/words
- IMPORTANT: Always update "Current State" to reflect the most recent work`
}
```

来源：

- `package/restored-src/src/services/SessionMemory/prompts.ts`

技术含义：

- memory 不是自由文本
- 而是受模板约束的结构化长期工作记忆
- `Current State` 被特别强调，说明系统把“当前工作现场”看成最关键记忆

### 10.5 Session Memory 参与 Compact

如果 session memory 可用，auto-compact 会优先尝试拿它替代传统摘要：

```ts
const { truncatedContent, wasTruncated } =
  truncateSessionMemoryForCompact(sessionMemory)

let summaryContent = getCompactUserSummaryMessage(
  truncatedContent,
  true,
  transcriptPath,
  true,
)

const summaryMessages = [
  createUserMessage({
    content: summaryContent,
    isCompactSummary: true,
    isVisibleInTranscriptOnly: true,
  }),
]
```

来源：

- `package/restored-src/src/services/compact/sessionMemoryCompact.ts`

技术含义：

- 长期记忆可以直接作为 compact summary 使用
- 这样系统不必每次都重新总结整个历史
- 相当于把 summary 结果“资产化”为可复用记忆

## 11. Compact 请求本身也在做缓存优化

compact 请求并不总是走普通 streaming，它会尽量复用主线程已有的 prompt cache：

```ts
if (promptCacheSharingEnabled) {
  try {
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
    ...
    return assistantMsg
  } catch (error) {
    ...
  }
}
```

来源：

- `package/restored-src/src/services/compact/compact.ts`

技术含义：

- compact 自己也是一次模型调用
- 如果这次调用能复用主线程 cache，就能降低 compact 的额外成本
- 所以 compact 不只是“语义压缩”，还是“缓存敏感的压缩”

## 12. 上下文可观测性

系统还提供 `/context`，显示的不是原始历史，而是“模型真正看到的 API 视图”：

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

- `package/restored-src/src/commands/context/context.tsx`

这说明系统不仅管理上下文，还管理“上下文可见性”：

- 用户看到的 raw transcript
- 模型真正收到的 compacted / collapsed / budgeted transcript

二者并不总是相同。

## 13. 系统 Prompt 中对 Context 的行为设定

主 system prompt 里直接告诉模型：

```ts
return `- Tool results and user messages may include <system-reminder> tags. <system-reminder> tags contain useful information and reminders. They are automatically added by the system, and bear no direct relation to the specific tool results or user messages in which they appear.
- The conversation has unlimited context through automatic summarization.`
```

以及：

```ts
`The system will automatically compress prior messages in your conversation as it approaches context limits. This means your conversation with the user is not limited by the context window.`
```

来源：

- `package/restored-src/src/constants/prompts.ts`

技术含义：

- 模型被明确告知：上下文会被系统压缩
- 不需要因为窗口接近上限而改变任务节奏
- `<system-reminder>` 是系统注入上下文，不应误判为普通用户话语

## 14. 设计总结

从 LLM Context 管理角度看，这套实现有几个很鲜明的设计特征。

### 14.1 分层而不是扁平

上下文被拆成：

- system prompt
- system context
- user context
- live messages
- compact summary
- preserved messages
- attachments
- session memory
- prompt cache metadata

### 14.2 优先处理噪声，而不是优先摘要语义

先减大块工具输出，再做 conversation summary。这是 agent 场景下比传统聊天摘要更合理的策略。

### 14.3 推理草稿与持久摘要分离

- compact 时允许 `<analysis>`
- 写回上下文时删掉 `<analysis>`

这等于把“高质量推理”和“低体积存储”分开。

### 14.4 短期记忆、中期摘要、长期记忆三层化

- 短期：live messages
- 中期：compact summary
- 长期：session memory

这是一个典型的 memory hierarchy。

### 14.5 语义压缩与缓存压缩并行

`cache_edits` / `cache_reference` 说明系统不只在压缩 token，还在优化缓存结构。

### 14.6 compact 后不是“失忆”，而是“状态迁移”

compact 后会重建一个最小可继续工作的上下文包，而不是只塞一段摘要。

## 15. Skills 与 Subagents 的上下文管理技巧

除了主查询链路，这套系统在 `SkillTool`、`AgentTool`、fork/subagent 机制里也用了很多很成熟的 context management 技巧。

### 15.1 Skill 列表只给“发现信息”，不给完整内容

Skill 列表不是把全部 skill 内容都塞进上下文，而是只给发现层描述，并且严格受预算控制：

```ts
// Skill listing gets 1% of the context window (in characters)
export const SKILL_BUDGET_CONTEXT_PERCENT = 0.01
export const CHARS_PER_TOKEN = 4
export const DEFAULT_CHAR_BUDGET = 8_000

// Per-entry hard cap. The listing is for discovery only — the Skill tool loads
// full content on invoke, so verbose whenToUse strings waste turn-1 cache_creation
// tokens without improving match rate.
export const MAX_LISTING_DESC_CHARS = 250
```

来源：

- `package/restored-src/src/tools/SkillTool/prompt.ts`

这背后的技巧是：

- 把 skill 内容分成“发现层”和“执行层”
- 发现层只保留最小匹配信息
- 执行时再把完整 skill prompt 动态注入

这是一种典型的按需加载上下文策略。

### 15.2 Skill 描述按上下文预算自动截断

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

并且：

```ts
// All commands are always included (descriptions may be truncated to fit budget).
export function getLimitedSkillToolCommands(cwd: string): Promise<Command[]> {
  return getSkillToolCommands(cwd)
}
```

来源：

- `package/restored-src/src/tools/SkillTool/prompt.ts`

技巧点：

- 所有 skill 都保留“名字可见性”
- 但描述根据预算裁剪
- 这样既保留召回能力，又控制 token 消耗

### 15.3 已加载 skill 用 tag 防重复注入

Skill prompt 里有一条很实用的规则：

```ts
- If you see a <${COMMAND_NAME_TAG}> tag in the current conversation turn, the skill has ALREADY been loaded - follow the instructions directly instead of calling this tool again
```

来源：

- `package/restored-src/src/tools/SkillTool/prompt.ts`

这实际上是在做“上下文去重”：

- 防止同一 skill 在同一轮被重复展开
- 防止重复注入同一大段 prompt
- 避免工具调用和 prompt 内容双重膨胀

### 15.4 Agent 列表移出工具描述，避免 prompt cache bust

AgentTool 里专门有一条优化：

```ts
/**
 * Whether the agent list should be injected as an attachment message instead
 * of embedded in the tool description.
 *
 * The dynamic agent list was ~10.2% of fleet cache_creation tokens: MCP async
 * connect, /reload-plugins, or permission-mode changes mutate the list →
 * description changes → full tool-schema cache bust.
 */
```

来源：

- `package/restored-src/src/tools/AgentTool/prompt.ts`

这背后的技巧非常关键：

- 动态 agent 列表如果直接写进 tool prompt，会让工具 schema 频繁变
- tool schema 一变，prompt cache 前缀就容易失效
- 所以把 agent list 改成 attachment / system-reminder 注入

这属于“动态上下文与静态 schema 解耦”。

### 15.5 Fork 和 fresh subagent 被明确区分

AgentTool prompt 里把两种 delegation 模式分得很清楚：

```ts
Fork yourself ... when the intermediate tool output isn't worth keeping in your context.
...
When spawning a fresh agent (with a `subagent_type`), it starts with zero context.
```

来源：

- `package/restored-src/src/tools/AgentTool/prompt.ts`

这其实是非常成熟的上下文策略分流：

- `fork`: 继承父上下文，适合上下文相关的研究/实现
- `fresh subagent`: 零上下文启动，适合需要独立判断、避免父上下文污染的任务

### 15.6 Fork 的核心目的是“把中间噪声隔离出去”

AgentTool prompt 明说：

```ts
Fork yourself ... when the intermediate tool output isn't worth keeping in your context.
```

以及：

```ts
**Don't peek.** ... Reading the transcript mid-flight pulls the fork's tool noise into your context, which defeats the point of forking.
```

来源：

- `package/restored-src/src/tools/AgentTool/prompt.ts`

这是一个非常典型的 agentic context 管理技巧：

- 不是为了并行而并行
- 而是把“探索过程的工具噪声”隔离在子线程
- 主线程只消费最后结果，而不是消费全过程

### 15.7 Fork prompt 是 directive，不是 briefing

```ts
**Writing a fork prompt.** Since the fork inherits your context, the prompt is a *directive* — what to do, not what the situation is.
```

而 fresh agent 则相反：

```ts
When spawning a fresh agent ... it starts with zero context.
Brief the agent like a smart colleague who just walked into the room ...
```

来源：

- `package/restored-src/src/tools/AgentTool/prompt.ts`

技巧点：

- 继承上下文的 fork，用短 directive，避免重复背景
- 零上下文 agent，用完整 briefing，避免理解缺口

本质上是在避免两类浪费：

- fork 的重复背景浪费
- fresh agent 的信息不足返工

### 15.8 Fork 共享 prompt cache，但共享的是“缓存安全前缀”

`forkedAgent.ts` 的核心定义：

```ts
/**
 * Parameters that must be identical between the fork and parent API requests
 * to share the parent's prompt cache. The Anthropic API cache key is composed of:
 * system prompt, tools, model, messages (prefix), and thinking config.
 */
export type CacheSafeParams = {
  systemPrompt: SystemPrompt
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
  toolUseContext: ToolUseContext
  forkContextMessages: Message[]
}
```

来源：

- `package/restored-src/src/utils/forkedAgent.ts`

这是非常明确的“cache-safe prefix”设计。

系统把真正决定 cache key 的因素单独抽出来，以保证 fork 查询可以复用父查询的缓存前缀。

### 15.9 Fork 默认隔离可变状态，但保留 cache 命中条件

`createSubagentContext()` 的注释和实现非常值得看：

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
// them as unseen and make divergent replacement decisions → wire
// prefix differs → cache miss. A clone makes identical decisions →
// cache hit.
```

来源：

- `package/restored-src/src/utils/forkedAgent.ts`

这里的技巧非常高级：

- 可变状态要隔离，避免主子线程互相污染
- 但某些会影响请求字节序列的状态，又必须 clone 而不是 fresh
- 否则上下文虽然语义相同，wire prefix 也会不同，导致 cache miss

### 15.10 Fork child 用占位 tool_result 保证前缀字节一致

`forkSubagent.ts` 里为了 cache sharing，专门构造了统一前缀：

```ts
/** Placeholder text used for all tool_result blocks in the fork prefix.
 * Must be identical across all fork children for prompt cache sharing. */
const FORK_PLACEHOLDER_RESULT = 'Fork started — processing in background'
```

以及：

```ts
 * For prompt cache sharing, all fork children must produce byte-identical
 * API request prefixes.
```

来源：

- `package/restored-src/src/tools/AgentTool/forkSubagent.ts`

这说明他们不只在做“语义相似”，而是在追求“请求前缀字节级一致”。

### 15.11 Read-only subagents 主动瘦身上下文

在 `runAgent.ts` 里，`Explore` / `Plan` 这类只读 agent 会主动删掉部分父上下文：

```ts
const shouldOmitClaudeMd =
  agentDefinition.omitClaudeMd &&
  !override?.userContext &&
  getFeatureValue_CACHED_MAY_BE_STALE('tengu_slim_subagent_claudemd', true)
...
const resolvedUserContext = shouldOmitClaudeMd
  ? userContextNoClaudeMd
  : baseUserContext
```

还有：

```ts
const resolvedSystemContext =
  agentDefinition.agentType === 'Explore' ||
  agentDefinition.agentType === 'Plan'
    ? systemContextNoGit
    : baseSystemContext
```

来源：

- `package/restored-src/src/tools/AgentTool/runAgent.ts`

技巧点：

- 不是所有 subagent 都应该继承完整父上下文
- 只读搜索型 agent 不需要完整 `CLAUDE.md` 和 stale git status
- 主动瘦身可减少 token 开销

### 15.12 Fresh subagent 默认关闭 thinking，控制输出成本

```ts
thinkingConfig: useExactTools
  ? toolUseContext.options.thinkingConfig
  : { type: 'disabled' as const },
```

来源：

- `package/restored-src/src/tools/AgentTool/runAgent.ts`

这说明 fresh subagent 的默认策略是：

- 如果是 fork child，为了 cache 对齐，继承父 thinking config
- 如果是普通 subagent，为了控成本，直接禁掉 thinking

这是把“上下文一致性”和“成本控制”分情形处理。

### 15.13 Agent memory 是 agent 级的长期记忆外置

`agentMemory.ts` 提供了三种记忆 scope：

```ts
export type AgentMemoryScope = 'user' | 'project' | 'local'
```

并把记忆装配成 prompt：

```ts
export function loadAgentMemoryPrompt(
  agentType: string,
  scope: AgentMemoryScope,
): string {
  ...
  return buildMemoryPrompt({
    displayName: 'Persistent Agent Memory',
    memoryDir,
    extraGuidelines: ...
  })
}
```

来源：

- `package/restored-src/src/tools/AgentTool/agentMemory.ts`

这相当于把“subagent 的长期上下文”从会话消息流中外置到磁盘。

和 session memory 一样，本质上都是：

- 把长期高价值信息外置
- 需要时再重新注入 prompt

但 agent memory 的粒度更细，是“按 agent type / scope”分层。

## 16. 一句话总结 Skills / Subagents 的技巧

如果只用一句话概括 skills / subagents 里的上下文管理思想，就是：

“把可发现信息和可执行信息分层，把可继承上下文和需隔离上下文分流，把长期记忆外置，把中间噪声留在子线程，同时尽可能维持 prompt cache 的字节级稳定。”

## 17. 一句话心智模型

Claude Code 的 LLM Context 管理可以概括成：

“先把最吵的工具输出从上下文里移出去，再把必要历史摘要成工作记忆，同时尽量保住 prompt cache，并把长期重要信息沉淀到结构化 session memory 中。”
