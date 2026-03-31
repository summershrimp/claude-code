# ContextManagement Deep Dive

本文档是 [ContextManagement.md](/home/xm1994/Projects/claude-code/ContextManagement.md) 的补充版本，专门深入拆解 Claude Code 中与 LLM Context 管理直接相关的 prompt 设计。

重点分析三类 prompt：

1. `compact` prompt
2. `partial compact` prompt
3. `session memory` prompt

目标不是重复源码，而是回答下面几个问题：

- 这些 prompt 在上下文管理链路中扮演什么角色
- 每一段 prompt 为什么要这样写
- 它们分别在控制什么风险
- 它们是如何服务于“有限窗口 + 长任务连续性”的

## 1. 为什么要专门分析 Prompt

在 Claude Code 里，Context Management 不只是工程层面的“截断消息”和“计算 token”。

它同样依赖 prompt 把模型引导成一个“可压缩、可恢复、可接力”的工作代理。也就是说：

- 工程代码决定什么时候压缩
- prompt 决定压缩成什么形状
- prompt 决定 compact 之后模型会不会偏航
- prompt 决定长期记忆会不会逐渐退化成无用噪声

所以 prompt 不是外围文案，而是上下文管理机制的一部分。

## 2. Compact Prompt 在整个系统里的位置

完整 compact 链路里，摘要请求是这样产生的：

```ts
const compactPrompt = getCompactPrompt(customInstructions)
const summaryRequest = createUserMessage({
  content: compactPrompt,
})

summaryResponse = await streamCompactSummary({
  messages: messagesToSummarize,
  summaryRequest,
  appState,
  context,
  preCompactTokenCount,
  cacheSafeParams: retryCacheSafeParams,
})
```

来源：

- `package/restored-src/src/services/compact/compact.ts`

也就是说，compact prompt 是“系统发给模型的一次特殊任务说明”。这个任务的目标不是帮助用户，而是把当前会话压缩成下一轮还能继续工作的工作记忆。

## 3. Compact Prompt 总体结构

`compact` prompt 的组成大体是：

1. `NO_TOOLS_PREAMBLE`
2. 主摘要说明 `BASE_COMPACT_PROMPT`
3. 可选 `Additional Instructions`
4. `NO_TOOLS_TRAILER`

关键代码：

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

来源：

- `package/restored-src/src/services/compact/prompt.ts`

这是一个很典型的“护栏前置 + 主任务模板 + 尾部再强调”结构。

## 4. `NO_TOOLS_PREAMBLE` 的设计意图

原始代码：

```ts
const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.

`
```

来源：

- `package/restored-src/src/services/compact/prompt.ts`

### 4.1 这段 prompt 在防什么

它防的是 compact 阶段出现“上下文膨胀反向传播”。

compact 本来是为了缩上下文。如果这个时候模型又去：

- `Read` 文件
- `Grep` 更多代码
- `Bash` 运行命令
- `WebFetch` 拉外部内容

那 compact 过程本身就会继续扩大上下文，直接违背目标。

### 4.2 为什么要写得这么强硬

源码注释已经说得很直接：

```ts
// Aggressive no-tools preamble. The cache-sharing fork path inherits the
// parent's full tool set ...
// ... the model sometimes attempts a tool call despite the weaker trailer instruction.
// With maxTurns: 1, a denied tool call means no text output → falls through to the streaming fallback
// Putting this FIRST and making it explicit about rejection consequences prevents the wasted turn.
```

来源：

- `package/restored-src/src/services/compact/prompt.ts`

这段注释暴露了几个关键现实：

- compact 不是普通对话，而是 `maxTurns: 1` 的特殊任务
- 模型会因为继承的工具 schema 而尝试调工具
- 一旦浪费这个唯一回合，compact 失败率就会上升

所以这段 prompt 的本质是：

- 不是单纯“提醒不要调工具”
- 而是在做一次明确的失败成本提示

这属于 prompt 里的“代价显式化”。

### 4.3 这和上下文管理的关系

这段 prompt 管理的不是内容，而是“摘要过程的边界”。

它保证 compact 是一个纯压缩步骤，而不是重新探索环境。

## 5. `<analysis>` + `<summary>` 双阶段输出

compact prompt 里要求模型：

- 先输出 `<analysis>`
- 再输出 `<summary>`

原始片段：

```ts
const DETAILED_ANALYSIS_INSTRUCTION_BASE = `Before providing your final summary, wrap your analysis in <analysis> tags ...
...
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.`
```

同时，持久化前会删掉 `<analysis>`：

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

### 5.1 为什么要让模型先写分析

因为 compact 是高风险任务。它一旦做差了，后面整个会话都建立在一个有偏差的摘要上。

这里让模型先按时间顺序梳理：

- 用户请求
- 技术决策
- 文件和代码片段
- 错误与修复
- 用户纠正

作用是提升摘要前的“内部校对”质量。

### 5.2 为什么最后又把分析删掉

因为 `<analysis>` 虽然对生成摘要有帮助，但对后续上下文没有长期价值。

换句话说：

- `analysis` 是生成中间态
- `summary` 才是可持久化工作记忆

这是一种非常典型的上下文管理策略：

- 计算时允许冗余
- 存储时要求稠密

如果把 `<analysis>` 也写回上下文，会出现两个问题：

1. token 浪费
2. 把模型的草稿、试探和重复思路也带到后续上下文中，污染记忆

所以这里本质上是在做“推理态”和“持久态”的分离。

## 6. `BASE_COMPACT_PROMPT` 的信息结构为什么这么重

compact 主模板要求输出 9 个部分：

1. Primary Request and Intent
2. Key Technical Concepts
3. Files and Code Sections
4. Errors and fixes
5. Problem Solving
6. All user messages
7. Pending Tasks
8. Current Work
9. Optional Next Step

原始片段：

```ts
const BASE_COMPACT_PROMPT = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.
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

### 6.1 为什么不是“简短总结一下”

因为 Claude Code 不是在管理聊天记忆，而是在管理编码工作流记忆。

编码工作流中真正不能丢的是：

- 用户意图
- 当前工作点
- 代码位置
- 失败尝试
- 用户纠偏
- 未完成项

普通摘要容易变成：

- “讨论了某功能”
- “修改了若干文件”
- “解决了一些问题”

这对继续工作几乎没有帮助。

### 6.2 9 个字段分别在守什么

`Primary Request and Intent`

- 防止任务目标漂移
- compact 后仍然知道用户真正想要什么

`Key Technical Concepts`

- 保留架构和术语层记忆
- 避免后续重新推理技术栈

`Files and Code Sections`

- 防止代码定位信息丢失
- 对 coding agent 非常关键

`Errors and fixes`

- 防止模型重复踩坑
- 保留“哪些路走不通”

`Problem Solving`

- 保留当前思路链和调试链

`All user messages`

- 这是最不寻常但也最重要的一项
- 它明确要求把所有非 tool-result 的用户消息都列出来
- 本质上是在保留“人类纠偏信号”

`Pending Tasks`

- 避免 compact 后出现“以为已经做完”

`Current Work`

- 确保恢复时能回到中断点

`Optional Next Step`

- 给 compact 后的自动续写一个明确落点

### 6.3 为什么要求 direct quotes

`Optional Next Step` 里要求引用最近对话的 verbatim quote：

```ts
If there is a next step, include direct quotes from the most recent conversation showing exactly what task you were working on and where you left off. This should be verbatim to ensure there's no drift in task interpretation.
```

来源：

- `package/restored-src/src/services/compact/prompt.ts`

这就是在防“任务解释漂移”。

compact 之后最危险的不是忘掉旧背景，而是把“当前最后一步”理解错。加直接引用，相当于在摘要里钉住最后状态。

## 7. Additional Instructions 的作用

compact prompt 支持 hook 或用户侧额外摘要指令：

```ts
if (customInstructions && customInstructions.trim() !== '') {
  prompt += `\n\nAdditional Instructions:\n${customInstructions}`
}
```

来源：

- `package/restored-src/src/services/compact/prompt.ts`

这层设计很实用，因为不同上下文压缩需求并不一样。

例如某些项目可能更关心：

- test output
- 文件读取原文
- TypeScript 改动
- 某一类错误

这相当于给 compact 留了一个“压缩策略插槽”。

也就是说，compact 模板本身是通用策略，而 `Additional Instructions` 是局部策略。

## 8. `NO_TOOLS_TRAILER` 为什么还要再重复一遍

原始代码：

```ts
const NO_TOOLS_TRAILER =
  '\n\nREMINDER: Do NOT call any tools. Respond with plain text only — ' +
  'an <analysis> block followed by a <summary> block. ' +
  'Tool calls will be rejected and you will fail the task.'
```

来源：

- `package/restored-src/src/services/compact/prompt.ts`

这属于典型的 prompt sandwich：

- 开头立规则
- 中间给任务
- 结尾再钉一次最重要约束

这样做的目的很简单：

- 中间长模板容易让模型忘记前置禁令
- 所以尾部再次强化最关键边界

## 9. `PARTIAL_COMPACT_PROMPT` 的设计

partial compact 不是压缩整个会话，而是压缩一部分。

原始片段：

```ts
const PARTIAL_COMPACT_PROMPT = `Your task is to create a detailed summary of the RECENT portion of the conversation — the messages that follow earlier retained context. The earlier messages are being kept intact and do NOT need to be summarized. Focus your summary on what was discussed, learned, and accomplished in the recent messages only.
...
Please provide your summary based on the RECENT messages only (after the retained earlier context), following this structure and ensuring precision and thoroughness in your response.
`
```

来源：

- `package/restored-src/src/services/compact/prompt.ts`

### 9.1 它在解决什么问题

如果保留了一部分上下文原文，那么摘要模型必须知道：

- 哪些消息已经被保留
- 哪些消息才是它应该总结的目标

否则会出现两个问题：

1. 重复总结已保留内容
2. 错误总结上下文边界，导致摘要和保留段之间重叠或断裂

### 9.2 为什么强调“RECENT only”

因为 partial compact 的本质是局部重写。

它不是“把全局历史缩短”，而是“对某一段做稠密表示，另一段保持原样”。

所以 prompt 里必须清楚告诉模型自己的视野边界。

## 10. `PARTIAL_COMPACT_UP_TO_PROMPT` 的设计

`up_to` 方向是另一种 partial compact：

```ts
const PARTIAL_COMPACT_UP_TO_PROMPT = `Your task is to create a detailed summary of this conversation. This summary will be placed at the start of a continuing session; newer messages that build on this context will follow after your summary (you do not see them here). Summarize thoroughly so that someone reading only your summary and then the newer messages can fully understand what happened and continue the work.
...
9. Context for Continuing Work: Summarize any context, decisions, or state that would be needed to understand and continue the work in subsequent messages.
`
```

来源：

- `package/restored-src/src/services/compact/prompt.ts`

### 10.1 它和普通 partial compact 的区别

这个版本不是总结“最近段”，而是总结“前缀段”，后面保留的新消息会接在摘要后面。

所以它新增了一个关键字段：

- `Context for Continuing Work`

因为这里的摘要必须承担桥梁作用：

- 它后面会直接接新的消息
- 读者只看这个摘要 + 后续消息，也必须能继续工作

### 10.2 为什么这很重要

普通 compact 更多是在替代旧历史。

而 `up_to` partial compact 更像是在构造一个“可拼接前缀”。

这里的 prompt 设计是在要求模型产出一个“可拼接上下文层”。

## 11. Compact Prompt 为什么总强调 Chronological

无论 base 还是 partial 版本，分析阶段都强调 chronological：

```ts
1. Chronologically analyze each message and section of the conversation.
```

或者：

```ts
1. Analyze the recent messages chronologically.
```

来源：

- `package/restored-src/src/services/compact/prompt.ts`

### 11.1 这是在防什么

主要防两个问题：

1. 因果关系丢失
2. 错误归因错位

编码任务里很多信息是时序性的：

- 用户先提需求
- 模型尝试方案
- 用户纠正
- 工具输出错误
- 模型修复

如果按主题聚合而不是按时间梳理，很容易把：

- 失败方案写成最终方案
- 用户纠正写成普通备注
- 当前工作点和旧工作点混在一起

所以 chronological 本质是在保护因果结构。

## 12. Session Memory Prompt 的定位

compact prompt 解决的是：

- 对话快装不下时，如何把历史压成能继续工作的摘要

session memory prompt 解决的是：

- 长时任务里，如何持续维护一个结构化长期记忆文件

也就是说：

- compact 是事件驱动压缩
- session memory 是持续性知识沉淀

## 13. Session Memory 模板为什么是这些字段

默认模板：

```md
# Session Title
_A short and distinctive 5-10 word descriptive title for the session. Super info dense, no filler_

# Current State
_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._

# Task specification
_What did the user ask to build? Any design decisions or other explanatory context_

# Files and Functions
_What are the important files? In short, what do they contain and why are they relevant?_

# Workflow
_What bash commands are usually run and in what order? How to interpret their output if not obvious?_

# Errors & Corrections
_Errors encountered and how they were fixed. What did the user correct? What approaches failed and should not be tried again?_

# Codebase and System Documentation
_What are the important system components? How do they work/fit together?_

# Learnings
_What has worked well? What has not? What to avoid? Do not duplicate items from other sections_

# Key results
_If the user asked a specific output such as an answer to a question, a table, or other document, repeat the exact result here_

# Worklog
_Step by step, what was attempted, done? Very terse summary for each step_
```

来源：

- `package/restored-src/src/services/SessionMemory/prompts.ts`

### 13.1 这些字段其实对应三类记忆

任务记忆：

- `Current State`
- `Task specification`
- `Pending next steps` 的隐含部分

代码记忆：

- `Files and Functions`
- `Codebase and System Documentation`
- `Workflow`

经验记忆：

- `Errors & Corrections`
- `Learnings`

另有两个补充层：

- `Key results`：保存用户真正要的产物
- `Worklog`：保存时间序列

这个模板明显不是随便列的，它试图覆盖 coding agent 最常失忆的几类信息。

## 14. Session Memory Update Prompt 的核心约束

默认更新 prompt：

```ts
return `IMPORTANT: This message and these instructions are NOT part of the actual user conversation. Do NOT include any references to "note-taking", "session notes extraction", or these update instructions in the notes content.
...
Your ONLY task is to use the Edit tool to update the notes file, then stop.
...
- The file must maintain its exact structure with all sections, headers, and italic descriptions intact
- Do NOT reference this note-taking process or instructions anywhere in the notes
- Write DETAILED, INFO-DENSE content for each section
- Keep each section under ~${MAX_SECTION_LENGTH} tokens/words
- IMPORTANT: Always update "Current State" to reflect the most recent work
...`
```

来源：

- `package/restored-src/src/services/SessionMemory/prompts.ts`

### 14.1 “These instructions are NOT part of the actual conversation”

这句非常关键。

它在防模型把“提取记忆的指令”本身写入记忆。

这是典型的自反污染问题：

- 系统给模型一个 note-taking prompt
- 模型错误地把 note-taking 任务本身当成用户上下文

如果不防，记忆文件很容易出现：

- “需要更新 session notes”
- “此处根据 note-taking 指令编辑”

这种完全无助于后续工作的噪声。

### 14.2 “Your ONLY task is to use the Edit tool”

这是在做能力边界压缩。

session memory 提取不是让模型继续思考问题，而是让它：

- 读当前 notes
- 基于当前会话更新 notes
- 停止

它相当于一个专门的记忆维护 worker。

### 14.3 为什么严禁改模板结构

更新 prompt 一再强调：

- 不能删 section header
- 不能改 italic description
- 只能改描述下方内容

这是为了保持：

1. memory 的 schema 稳定
2. 后续 compact / resume 时更容易读取
3. 长期演化中不至于 drift 成自由文本

如果放任模型自由改结构，session memory 很快会退化：

- 某些 section 消失
- 某些 section 合并
- 字段语义漂移

这样长期记忆的可维护性会很差。

### 14.4 为什么强调 `Current State`

更新 prompt 特别强调：

```ts
- IMPORTANT: Always update "Current State" to reflect the most recent work - this is critical for continuity after compaction
```

来源：

- `package/restored-src/src/services/SessionMemory/prompts.ts`

这里非常直白：`Current State` 是 compact 后恢复连续性的核心。

长任务里最宝贵的不是全部历史，而是：

- 现在做到哪了
- 下一步该干嘛

这就是 agent 工作记忆里的“CPU 寄存器”。

## 15. Session Memory 的长度约束为什么分两层

有两个预算：

```ts
const MAX_SECTION_LENGTH = 2000
const MAX_TOTAL_SESSION_MEMORY_TOKENS = 12000
```

来源：

- `package/restored-src/src/services/SessionMemory/prompts.ts`

并且会自动生成压缩提醒：

```ts
if (overBudget) {
  parts.push(
    `\n\nCRITICAL: The session memory file is currently ~${totalTokens} tokens, which exceeds the maximum of ${MAX_TOTAL_SESSION_MEMORY_TOKENS} tokens. You MUST condense the file to fit within this budget. Aggressively shorten oversized sections by removing less important details, merging related items, and summarizing older entries. Prioritize keeping "Current State" and "Errors & Corrections" accurate and detailed.`,
  )
}
```

来源：

- `package/restored-src/src/services/SessionMemory/prompts.ts`

### 15.1 这在解决什么问题

长期记忆本身也会膨胀。

如果没有长度控制，session memory 最终会变成：

- 另一个超长 transcript
- 继续吞噬上下文预算

所以这里做了两层预算：

- section 级别：防某个模块无限膨胀
- total 级别：防整体失控

### 15.2 为什么优先保留 `Current State` 和 `Errors & Corrections`

源码里明确说：

- 优先保证 `Current State`
- 优先保证 `Errors & Corrections`

这其实非常合理，因为这两类信息对继续工作的边际价值最高：

- 当前做什么
- 哪些坑已经踩过

比起冗长的 worklog，它们更值钱。

## 16. Session Memory 如何参与 Compact

session memory 不是单纯独立存在，它会被拿来替代传统 compact 结果：

```ts
let summaryContent = getCompactUserSummaryMessage(
  truncatedContent,
  true,
  transcriptPath,
  true,
)

if (wasTruncated) {
  const memoryPath = getSessionMemoryPath()
  summaryContent += `\n\nSome session memory sections were truncated for length. The full session memory can be viewed at: ${memoryPath}`
}
```

来源：

- `package/restored-src/src/services/compact/sessionMemoryCompact.ts`

这说明系统设计上已经把 session memory 视为一种“预先结构化好的 compact summary”。

它和普通 compact 的区别是：

- 普通 compact：即时从对话生成摘要
- session memory compact：从长期维护的结构化记忆文件直接生成恢复上下文

后者显然更稳定，也更便宜。

## 17. Prompt 层面的核心技术策略总结

从这些 prompt 可以提炼出几条非常清晰的上下文管理策略。

### 17.1 边界先行

无论 compact 还是 memory update，第一件事都是先收缩模型能力边界：

- 不能调工具
- 不能继续工作
- 只能做摘要
- 只能更新 memory 文件

这样能防止“上下文管理任务本身”扩张成新的主任务。

### 17.2 先允许高质量推理，再压缩结果

compact prompt 容许 `<analysis>`，但最终只保留 `<summary>`。

这是：

- 生成时保质量
- 存储时保密度

### 17.3 用结构化模板代替自由摘要

无论 compact summary 还是 session memory，都不是自由写作，而是强模板输出。

这是因为对 agent 来说，结构稳定比文采重要得多。

### 17.4 保留“纠偏信号”

prompt 一直强调：

- 用户反馈
- 所有用户消息
- 错误与修复
- 用户告诉你要做得不一样的地方

这说明他们很清楚：长任务里最容易丢的不是代码本身，而是人类纠偏。

### 17.5 保留“当前工作点”

`Current Work` 和 `Current State` 被 repeatedly 强调，本质上是在保存恢复点。

这比完整历史更重要。

## 18. 一个简化理解

如果把这些 prompt 的职责压缩成一句话：

- compact prompt 负责把“完整历史”压成“可继续接力的工作状态”
- partial compact prompt 负责把“局部历史”压成“与保留段无缝拼接的工作状态”
- session memory prompt 负责把“长期经验”沉淀成“结构稳定、可复用的长期工作记忆”

## 19. 结论

Claude Code 的上下文管理 prompt 设计不是在做普通摘要，而是在做三件更具体的事情：

1. 约束摘要过程，不让它反向扩张上下文
2. 把工作历史压成“任务连续性优先”的稠密状态表示
3. 把长期高价值信息沉淀成结构化工作记忆，而不是任由对话历史无限增长

从 LLM Context 管理角度看，这些 prompt 的价值不在“语言优美”，而在“信息守恒”和“状态可恢复”。它们本质上是上下文压缩协议，而不只是提示词。
