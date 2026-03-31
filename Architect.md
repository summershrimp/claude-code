# Claude Code 系统架构分析

## 1. 分析范围与结论

本次分析基于仓库中的恢复源码：

- `package/restored-src/src`
- 包元数据见 `package/package.json`，当前恢复出的 npm 版本为 `2.1.88`

从代码结构判断，这不是一个单纯的命令行包装器，而是一个完整的“终端内智能代理平台”，核心特征包括：

- 以 CLI/TUI 为主的人机交互界面
- 以 `QueryEngine` 为核心的多轮会话与推理调度
- 以 Tool/Task 为执行抽象的代理动作系统
- 以 `AppState` 为中心的状态管理
- 支持本地执行、远程会话、MCP 扩展、插件、技能、子代理/团队协作

一句话概括：

> 该系统采用“命令入口层 + 会话编排层 + 工具/任务执行层 + 状态/UI 层 + 扩展/远程集成层”的分层架构，本质上是一个运行在终端中的 Agent OS。

## 2. 顶层目录与模块分层

从 `package/restored-src/src` 的目录结构可以归纳出以下核心层次。

### 2.1 入口与启动层

关键文件：

- `src/entrypoints/cli.tsx`
- `src/main.tsx`
- `src/entrypoints/init.ts`

职责：

- 处理 CLI 启动参数
- 对若干高频场景做 fast-path 分流，减少冷启动开销
- 初始化配置、认证、遥测、网络代理、受管设置、LSP、清理逻辑
- 启动主交互循环或特定子模式

架构特点：

- `cli.tsx` 尽量延迟 import，大量路径按需动态加载
- `init.ts` 负责“安全初始化”，先处理配置和环境，再允许后续能力启动
- `main.tsx` 是主装配器，负责把命令、工具、状态、服务装配成完整运行时

这说明系统在启动性能和 feature gate 上投入很深，属于“壳很薄、装配很重”的启动架构。

### 2.2 命令层

关键文件：

- `src/commands.ts`
- `src/commands/*`

职责：

- 注册 slash/CLI 命令
- 区分 builtin command、plugin command、skill command
- 将命令映射为本地动作、prompt 生成、配置修改或运行模式切换

从 `commands.ts` 可以看到：

- 命令种类非常多，覆盖登录、配置、记忆、模型、权限、插件、review、teleport、remote、skills 等
- 存在动态技能命令、插件命令、内建命令共存的机制
- 很多命令受 feature flag 控制，说明产品形态按环境裁剪

因此命令层不是简单的参数解析器，而是“用户意图入口路由层”。

### 2.3 会话编排层

关键文件：

- `src/QueryEngine.ts`
- `src/query.ts`
- `src/query/*`

职责：

- 管理一段会话的消息状态
- 构建 system prompt / user context / tool context
- 调用模型 API
- 处理流式响应
- 调用工具并把结果回灌到消息流
- 执行自动 compact、token budget、stop hooks、错误恢复等逻辑

这是系统最核心的一层。

`QueryEngine` 更像“会话对象”：

- 持有消息历史
- 持有权限拒绝记录、usage、文件缓存等跨轮次状态
- 对外暴露 `submitMessage()`，表示一次用户输入驱动的一轮 agent 交互

`query.ts` 更像“推理执行器”：

- 管理 query loop
- 对工具调用进行编排
- 控制上下文压缩、预算检查、工具结果处理、继续/终止状态转换

可以理解为：

- `QueryEngine` = 会话级 orchestration facade
- `query.ts` = 单轮推理执行状态机

### 2.4 工具层

关键文件：

- `src/tools.ts`
- `src/tools/*`

职责：

- 统一注册系统可用工具
- 通过 `isEnabled()`、feature flag、权限上下文筛选工具
- 为模型暴露“可调用能力”

从 `tools.ts` 可以看出，工具是系统最重要的扩展点之一。默认工具大致分为几类：

- 文件类：`FileReadTool`、`FileEditTool`、`FileWriteTool`
- Shell 类：`BashTool`、`PowerShellTool`
- 搜索类：`GlobTool`、`GrepTool`、`WebFetchTool`、`WebSearchTool`
- 计划/任务类：`TodoWriteTool`、`Task*Tool`、`TaskStopTool`
- 代理类：`AgentTool`、`SendMessageTool`、`TeamCreateTool`
- 扩展类：`SkillTool`、`LSPTool`、MCP 资源工具

说明该系统采用的是“LLM + 显式工具调用”架构，而不是把所有动作硬编码在主循环中。

### 2.5 任务执行层

关键文件：

- `src/Task.ts`
- `src/tasks.ts`
- `src/tasks/*`

职责：

- 抽象长生命周期、可异步运行的执行单元
- 支持 shell、local agent、remote agent、workflow、monitor 等不同任务类型
- 提供任务级状态、输出文件、终止控制

从 `Task.ts` 和 `tasks.ts` 可见：

- 任务是比 tool 更“重”的执行实体
- tool 更偏单次能力调用
- task 更偏后台运行、可观测、可中断、可持久化输出的工作流实体

这意味着系统把“瞬时动作”和“持续执行”明确分层了：

- Tool：能力接口
- Task：运行载体

这是整个系统能支持后台代理、远程代理、团队协作的关键。

### 2.6 状态与 UI 层

关键文件：

- `src/state/AppStateStore.ts`
- `src/state/*`
- `src/components/*`
- `src/ink/*`

职责：

- 保存全局运行态
- 驱动终端 TUI 渲染
- 管理通知、任务列表、插件状态、远程连接状态、思考开关、todo、agent registry 等

`AppStateStore.ts` 显示该系统的状态面非常大，至少覆盖：

- 设置与模型配置
- 工具权限上下文
- 任务集合与前台/后台切换
- MCP 客户端、工具、资源
- 插件状态
- 代理定义与团队状态
- 文件历史与 attribution
- 通知队列、elicitation 队列
- 远程 bridge / remote session 状态
- 特定功能面板状态

所以 UI 并不是简单 stdout 输出，而是一个基于 Ink/React 的终端应用。

### 2.7 扩展与集成层

关键目录：

- `src/services/mcp/*`
- `src/plugins/*`
- `src/skills/*`
- `src/services/lsp/*`
- `src/services/api/*`
- `src/remote/*`
- `src/bridge/*`

职责：

- 连接外部 MCP server
- 装载插件和技能
- 接入 LSP
- 对接远程控制、远程会话、云侧服务
- 接入认证、策略限制、受管配置

其中 MCP 类型定义显示其支持多种传输：

- `stdio`
- `sse`
- `http`
- `ws`
- `sdk`

这意味着系统把外部能力抽象成标准协议接入，而非仅支持本地内置工具。

## 3. 核心运行流程

结合入口、QueryEngine、工具和状态管理，可以抽象出主调用链。

### 3.1 启动阶段

1. 用户执行 `claude` 或某个子命令
2. `entrypoints/cli.tsx` 检查是否命中 fast-path
3. 若不是简单路径，则进入完整启动流程
4. `entrypoints/init.ts` 完成配置、证书、代理、遥测、受管设置、清理器初始化
5. `main.tsx` 装配命令、工具、MCP、插件、状态、会话上下文
6. 进入交互模式、非交互模式、remote 模式或特定命令执行模式

### 3.2 一轮对话执行阶段

1. 用户输入文本或触发命令
2. 命令层先判断是否属于 slash command / local command
3. 若进入模型主循环，则由 `QueryEngine.submitMessage()` 接管
4. `QueryEngine` 组织：
   - 消息历史
   - system prompt
   - user/system context
   - 当前可用 tools
   - MCP 客户端
   - 权限检查函数
5. `query.ts` 启动 query loop
6. 模型返回普通文本或 tool use
7. 若有工具调用，则通过工具编排层执行
8. 工具结果转成消息重新注入上下文
9. 反复循环直到达到终止条件

### 3.3 长任务/后台任务阶段

当某些动作不适合在当前同步调用中完成时：

- 工具会创建 task
- task 写入 `AppState.tasks`
- task 输出写入独立 output file
- UI 显示任务状态、前后台切换、通知
- 任务可被停止、前置或作为远程代理继续执行

因此，系统是“对话驱动的任务型 agent”，而不仅是“对话型问答程序”。

## 4. 关键架构角色

### 4.1 `main.tsx`：运行时装配器

它负责把以下内容装配起来：

- 配置与环境
- 命令集合
- 工具集合
- AppState store
- 认证与模型设置
- MCP、插件、LSP、remote session
- 渲染与输入循环

从职责上看，`main.tsx` 接近前端应用中的 composition root / bootstrapper。

### 4.2 `QueryEngine`：会话域核心

它是整个系统最重要的业务对象之一，职责包括：

- 持有会话消息
- 跨轮复用文件缓存、usage、权限拒绝信息
- 为每轮消息提交构造运行上下文
- 调用 `query()` 执行实际推理流程

它相当于“单会话 Agent Runtime”。

### 4.3 `query.ts`：推理状态机

这里集中体现了系统的 agent loop 设计：

- 流式消费模型输出
- 识别 tool use
- 执行工具
- 处理 compact 与 token budget
- 错误恢复与 fallback
- 执行 hook 和 stop 逻辑

这部分是系统最像“工作流引擎”的地方。

### 4.4 `tools.ts`：能力注册中心

它是模型可见能力的统一清单，也是权限控制和功能裁剪的接入点。

特点：

- 工具统一注册
- 可按 feature flag 和环境动态裁剪
- 可在执行前结合 permission context 做过滤
- 可混合内置工具、MCP 工具、技能相关工具

这使得能力扩展不会侵入主循环。

### 4.5 `AppState`：统一运行态容器

系统的大部分 UI 状态和运行态都挂在这里，包括：

- 任务
- 插件
- MCP
- 通知
- 远程连接
- 权限上下文
- 用户设置
- 各种功能面板状态

这是一个典型的“富客户端终端应用”状态模型。

## 5. 架构风格判断

综合代码结构，可以把该系统归类为以下几种架构风格的混合体。

### 5.1 分层架构

清晰存在：

- 入口层
- 命令层
- 会话编排层
- 工具/任务执行层
- 状态/UI 层
- 外部集成层

### 5.2 插件化架构

通过以下机制体现：

- skills
- plugins
- MCP servers
- 动态命令
- feature flags

说明系统高度模块化，很多能力都不是编译时写死的。

### 5.3 事件/流式驱动架构

体现为：

- 模型输出是流式事件
- 工具执行结果持续回灌
- 远程 session 基于 WebSocket
- 任务与通知也是事件驱动更新

### 5.4 Agent Runtime 架构

区别于普通 CLI 的关键在于：

- 存在显式 query loop
- 模型会调用工具
- 工具可创建任务
- 任务可继续派生 agent/remote agent
- 会话、权限、上下文、预算共同约束主循环

因此这个系统本质上更接近“Agent 运行时”而不是“命令行客户端”。

## 6. 远程与多端能力

从 `entrypoints/cli.tsx`、`remote/RemoteSessionManager.ts`、`bridge/*` 可以看出系统支持远程工作模式。

### 6.1 Remote Session

`RemoteSessionManager` 负责：

- 建立 WebSocket 连接接收远端消息
- 通过 HTTP 将用户消息发送到远端 session
- 处理远程权限请求/响应
- 维护连接、断线重连、viewerOnly 模式

说明系统支持“本地 UI + 远端 agent runtime”分离部署。

### 6.2 Bridge / Remote Control

CLI 入口中存在专门的 fast-path：

- `remote-control`
- `bridge`
- `daemon`
- 后台会话相关命令

说明它不仅能连接远端，还能把本地环境暴露成受控执行环境。

### 6.3 架构意义

这使系统具备以下能力：

- 本地交互、远程执行
- 远程 viewer 模式
- 会话迁移/teleport
- 守护进程与后台 session 管理

所以它在架构上已经不是单机终端工具，而是具备“控制面/执行面分离”雏形。

## 7. 扩展机制分析

### 7.1 Skills

技能目录和 bundled skills 表明：

- skills 是更高层次的能力封装
- 往往用于复用 prompt、流程或工具使用模式
- 可动态发现并加载

### 7.2 Plugins

插件系统体现在：

- 插件命令
- 插件状态管理
- 插件缓存与 reload
- 插件对 MCP/命令的扩展

插件更偏“产品能力扩展”，而非单个工具。

### 7.3 MCP

MCP 是该系统最标准化的外部扩展协议层，特点包括：

- 多传输协议
- server 连接状态机
- 资源、工具、命令统一暴露
- 可接入 OAuth/XAA 等认证配置

这让 Claude Code 可以把外部系统当作可组合能力接入。

## 8. 状态与数据流

系统数据流可以抽象为：

1. 用户输入进入命令层
2. 命令层决定是本地命令还是进入模型主循环
3. 主循环通过 `QueryEngine` 组织上下文
4. 模型输出产生文本、工具调用或控制事件
5. 工具层执行动作，必要时创建任务
6. task / tool / remote / mcp 的结果写回消息流与 `AppState`
7. UI 根据 `AppState` 进行重绘

其中有两个核心数据中心：

- 消息流：驱动 agent reasoning
- `AppState`：驱动 UI 和运行态

这是“双核心状态模型”：

- Conversation State
- Application Runtime State

## 9. 主要优势

从架构上看，该系统有几个明显优点。

### 9.1 模块边界较清晰

- 命令、工具、任务、状态、远程、MCP 分层明显
- 主循环没有把所有细节硬塞在一个文件里

### 9.2 可扩展性强

- 工具可增删
- 命令可扩展
- skills/plugins/MCP 可并存
- feature flag 方便裁剪产品形态

### 9.3 适合复杂 agent 场景

- 多轮会话
- 工具调用
- 子任务
- 远程代理
- 后台会话

这套结构天然支持从“问答”升级到“执行型代理”。

### 9.4 启动和运行时性能有专门设计

- 动态 import
- fast-path
- 预连接与预取
- 启动 profile

说明工程上已经进入成熟产品阶段，而不是实验原型。

## 10. 潜在复杂度与风险

这套架构也有明显代价。

### 10.1 `main.tsx` 过于庞大

从导入规模和职责范围看，`main.tsx` 已经承担了非常重的装配职责，容易出现：

- 启动路径理解困难
- feature gate 交叉影响
- 测试隔离成本高

### 10.2 feature flag 很多

大量 `feature(...)` 与动态 require 带来灵活性，但也会导致：

- 行为组合爆炸
- 某些路径很难完全覆盖测试
- 恢复源码阅读难度高

### 10.3 状态面很大

`AppState` 已经承载大量领域状态，后续如果持续膨胀，可能出现：

- 状态耦合增强
- 更新链路难追踪
- UI 和业务状态界限变模糊

### 10.4 Tool 与 Task 的协同复杂

这种设计很强，但也意味着：

- 工具权限、任务生命周期、消息回灌必须高度一致
- 一旦某一层约束失配，容易出现“任务还活着但会话已结束”之类问题

## 11. 建议的架构图心智模型

可以把整个系统理解成下面这个结构：

```text
用户/CLI
  -> Entrypoint(cli.tsx / init.ts / main.tsx)
  -> Command Router(commands.ts)
  -> QueryEngine
  -> Query Loop(query.ts)
  -> Tool Registry(tools.ts)
  -> Tool Execution / Task Runtime(tasks.ts, Task.ts)
  -> External Integrations(MCP / Plugins / Skills / LSP / Remote)
  -> AppState Store
  -> Ink/React TUI
```

如果按控制流再简化一次：

```text
输入 -> 命令解析 -> Agent 主循环 -> 工具/任务执行 -> 状态更新 -> UI反馈
```

## 12. 最终判断

基于恢复源码，这套系统的本质不是“命令行调用 Claude API”，而是一个完整的终端 Agent 平台，具备以下架构特征：

- 以会话引擎为中心的 agent runtime
- 以工具和任务为核心的执行模型
- 以 AppState + Ink 为核心的富终端 UI
- 以 MCP / 插件 / 技能为核心的扩展体系
- 以 remote session / bridge / daemon 为核心的分布式执行能力

如果从工程定位上命名，我认为最准确的表述是：

> Claude Code 是一个面向终端场景的、可扩展的、多运行模式的 Agent Operating Runtime。

## 13. 关键源码定位

后续如果要继续深入，可优先从这些文件切入：

- `package/restored-src/src/entrypoints/cli.tsx`
- `package/restored-src/src/main.tsx`
- `package/restored-src/src/entrypoints/init.ts`
- `package/restored-src/src/commands.ts`
- `package/restored-src/src/QueryEngine.ts`
- `package/restored-src/src/query.ts`
- `package/restored-src/src/tools.ts`
- `package/restored-src/src/tasks.ts`
- `package/restored-src/src/Task.ts`
- `package/restored-src/src/state/AppStateStore.ts`
- `package/restored-src/src/remote/RemoteSessionManager.ts`
- `package/restored-src/src/services/mcp/types.ts`

## 14. 代码证据

下面给出本分析中几个关键判断所对应的源码证据，便于交叉验证。

### 14.1 “这是分层启动架构，不是单一入口脚本”

证据 1：`entrypoints/cli.tsx` 明确把自己定义为 bootstrap entrypoint，并强调 fast-path 与动态导入。

```ts
/**
 * Bootstrap entrypoint - checks for special flags before loading the full CLI.
 * All imports are dynamic to minimize module evaluation for fast paths.
 * Fast-path for --version has zero imports beyond this file.
 */
async function main(): Promise<void> {
```

位置：

- `package/restored-src/src/entrypoints/cli.tsx:28-33`

证据 2：`cli.tsx` 中存在大量模式分流，而不是统一进入同一执行路径，例如：

- `--version` fast-path
- `--daemon-worker`
- `remote-control` / `bridge`
- `daemon`
- `ps|logs|attach|kill`

对应源码：

- `package/restored-src/src/entrypoints/cli.tsx:36-42`
- `package/restored-src/src/entrypoints/cli.tsx:95-105`
- `package/restored-src/src/entrypoints/cli.tsx:108-161`
- `package/restored-src/src/entrypoints/cli.tsx:164-179`
- `package/restored-src/src/entrypoints/cli.tsx:182-208`

这说明入口层本身就是一个“模式路由器”。

### 14.2 “系统核心是会话引擎，而不是一次性请求函数”

证据 1：`QueryEngine` 的类型定义直接暴露出会话级上下文依赖：

```ts
export type QueryEngineConfig = {
  cwd: string
  tools: Tools
  commands: Command[]
  mcpClients: MCPServerConnection[]
  agents: AgentDefinition[]
  canUseTool: CanUseToolFn
  getAppState: () => AppState
  setAppState: (f: (prev: AppState) => AppState) => void
  initialMessages?: Message[]
  readFileCache: FileStateCache
  ...
}
```

位置：

- `package/restored-src/src/QueryEngine.ts:130-173`

证据 2：源码注释直接说明它是“每个会话一个实例”，并跨轮次持久化消息、文件缓存和 usage：

```ts
/**
 * QueryEngine owns the query lifecycle and session state for a conversation.
 * ...
 * One QueryEngine per conversation. Each submitMessage() call starts a new
 * turn within the same conversation. State (messages, file cache, usage, etc.)
 * persists across turns.
 */
```

位置：

- `package/restored-src/src/QueryEngine.ts:175-183`

证据 3：`submitMessage()` 不是简单返回单次结果，而是 `AsyncGenerator<SDKMessage>`，说明其面向流式、多阶段输出：

```ts
async *submitMessage(
  prompt: string | ContentBlockParam[],
  options?: { uuid?: string; isMeta?: boolean },
): AsyncGenerator<SDKMessage, void, unknown> {
```

位置：

- `package/restored-src/src/QueryEngine.ts:209-212`

### 14.3 “query.ts 是 agent loop / 推理状态机”

证据 1：`query.ts` 中直接引入工具编排器 `runTools`：

```ts
import { runTools } from './services/tools/toolOrchestration.js'
```

位置：

- `package/restored-src/src/query.ts:98`

证据 2：源码里明确存在 “query loop state” 注释，说明这不是薄封装，而是显式循环状态机：

```ts
// -- query loop state
```

位置：

- `package/restored-src/src/query.ts:201`

证据 3：在工具执行阶段，代码会在流式执行器和普通 `runTools(...)` 之间切换：

```ts
const toolUpdates = streamingToolExecutor
  ? streamingToolExecutor.getRemainingResults()
  : runTools(toolUseBlocks, assistantMessages, canUseTool, toolUseContext)
```

位置：

- `package/restored-src/src/query.ts:1380-1382`

这说明模型输出、工具执行、结果回灌是显式主循环的一部分。

### 14.4 “系统能力暴露采用 Tool Registry，而不是把行为硬编码在主循环中”

证据 1：`tools.ts` 的注释直接说明 `getAllBaseTools()` 是所有工具的 source of truth：

```ts
/**
 * Get the complete exhaustive list of all tools that could be available
 * in the current environment (respecting process.env flags).
 * This is the source of truth for ALL tools.
 */
export function getAllBaseTools(): Tools {
```

位置：

- `package/restored-src/src/tools.ts:185-193`

证据 2：注册列表中同时存在文件、shell、web、任务、代理、计划、技能、LSP、MCP 资源等能力：

```ts
return [
  AgentTool,
  TaskOutputTool,
  BashTool,
  ...(hasEmbeddedSearchTools() ? [] : [GlobTool, GrepTool]),
  ExitPlanModeV2Tool,
  FileReadTool,
  FileEditTool,
  FileWriteTool,
  NotebookEditTool,
  WebFetchTool,
  TodoWriteTool,
  WebSearchTool,
  TaskStopTool,
  AskUserQuestionTool,
  SkillTool,
  EnterPlanModeTool,
  ...
  ListMcpResourcesTool,
  ReadMcpResourceTool,
  ...(isToolSearchEnabledOptimistic() ? [ToolSearchTool] : []),
]
```

位置：

- `package/restored-src/src/tools.ts:193-250`

证据 3：工具注册大量受 feature flag 和环境约束控制，例如：

- `SleepTool` 取决于 `PROACTIVE` / `KAIROS`
- `WebBrowserTool` 取决于 `WEB_BROWSER_TOOL`
- `VerifyPlanExecutionTool` 取决于环境变量
- `LSPTool` 取决于 `ENABLE_LSP_TOOL`

对应源码：

- `package/restored-src/src/tools.ts:25-52`
- `package/restored-src/src/tools.ts:89-95`
- `package/restored-src/src/tools.ts:107-134`
- `package/restored-src/src/tools.ts:224-249`

这证明能力体系是“注册驱动 + 条件装配”的。

### 14.5 “Tool 和 Task 是两层抽象，不是同一个概念”

证据 1：`Task.ts` 中把 task 作为独立生命周期对象建模，拥有 `type/status/outputFile/outputOffset` 等字段：

```ts
export type TaskStateBase = {
  id: string
  type: TaskType
  status: TaskStatus
  description: string
  toolUseId?: string
  startTime: number
  endTime?: number
  totalPausedMs?: number
  outputFile: string
  outputOffset: number
  notified: boolean
}
```

位置：

- `package/restored-src/src/Task.ts:44-57`

证据 2：Task 类型本身包含独立类型系统：

```ts
export type TaskType =
  | 'local_bash'
  | 'local_agent'
  | 'remote_agent'
  | 'in_process_teammate'
  | 'local_workflow'
  | 'monitor_mcp'
  | 'dream'
```

位置：

- `package/restored-src/src/Task.ts:6-13`

证据 3：`tasks.ts` 注册的是另一套运行实体，而不是工具别名：

```ts
export function getAllTasks(): Task[] {
  const tasks: Task[] = [
    LocalShellTask,
    LocalAgentTask,
    RemoteAgentTask,
    DreamTask,
  ]
  if (LocalWorkflowTask) tasks.push(LocalWorkflowTask)
  if (MonitorMcpTask) tasks.push(MonitorMcpTask)
  return tasks
}
```

位置：

- `package/restored-src/src/tasks.ts:22-32`

因此可以确认：

- Tool = 模型可调用能力接口
- Task = 长生命周期执行单元

### 14.6 “AppState 是富终端应用的统一运行态容器”

证据 1：`AppState` 同时持有 UI 状态、远程连接状态、权限状态和业务运行态，例如：

```ts
export type AppState = DeepImmutable<{
  settings: SettingsJson
  verbose: boolean
  mainLoopModel: ModelSetting
  ...
  remoteSessionUrl: string | undefined
  remoteConnectionStatus:
    | 'connecting'
    | 'connected'
    | 'reconnecting'
    | 'disconnected'
  ...
  replBridgeEnabled: boolean
  ...
}> & {
  tasks: { [taskId: string]: TaskState }
  agentNameRegistry: Map<string, AgentId>
  ...
  mcp: {
    clients: MCPServerConnection[]
    tools: Tool[]
    commands: Command[]
    resources: Record<string, ServerResource[]>
    pluginReconnectKey: number
  }
  plugins: {
    enabled: LoadedPlugin[]
    disabled: LoadedPlugin[]
    commands: Command[]
    ...
  }
```

位置：

- `package/restored-src/src/state/AppStateStore.ts:89-158`
- `package/restored-src/src/state/AppStateStore.ts:158-216`

证据 2：状态中还包含通知、elicitation、todos、远程任务建议、tmux/web 面板等，这已经明显超出“对话状态”：

- `package/restored-src/src/state/AppStateStore.ts:220-259`

这说明 UI 不是纯打印流，而是由统一状态驱动的终端应用。

### 14.7 “命令层是路由层，且支持 builtin/plugin/skill 混合装配”

证据 1：`commands.ts` 顶部直接导入大量业务命令，说明命令层本身是一个大规模注册中心：

- `package/restored-src/src/commands.ts:2-58`
- `package/restored-src/src/commands.ts:124-205`

证据 2：文件中同时装配 skill 与 plugin 相关命令来源：

```ts
import {
  getSkillDirCommands,
  clearSkillCaches,
  getDynamicSkills,
} from './skills/loadSkillsDir.js'
import { getBundledSkills } from './skills/bundledSkills.js'
import { getBuiltinPluginSkillCommands } from './plugins/builtinPlugins.js'
import {
  getPluginCommands,
  clearPluginCommandCache,
  getPluginSkills,
  clearPluginSkillsCache,
} from './utils/plugins/loadPluginCommands.js'
```

位置：

- `package/restored-src/src/commands.ts:156-168`

证据 3：文件内明确区分 `INTERNAL_ONLY_COMMANDS`，说明命令体系支持按构建目标裁剪：

```ts
export const INTERNAL_ONLY_COMMANDS = [
  backfillSessions,
  breakCache,
  bughunter,
  ...
].filter(Boolean)
```

位置：

- `package/restored-src/src/commands.ts:224-254`

### 14.8 “系统具备远程会话与控制面/执行面分离能力”

证据 1：`RemoteSessionManager` 类注释直接写明它负责三件事：

```ts
/**
 * Manages a remote CCR session.
 *
 * Coordinates:
 * - WebSocket subscription for receiving messages from CCR
 * - HTTP POST for sending user messages to CCR
 * - Permission request/response flow
 */
```

位置：

- `package/restored-src/src/remote/RemoteSessionManager.ts:87-94`

证据 2：其配置中有 `viewerOnly`，注释说明本地客户端可以仅作为观察者：

```ts
/**
 * When true, this client is a pure viewer. Ctrl+C/Escape do NOT send
 * interrupt to the remote agent; 60s reconnect timeout is disabled;
 * session title is never updated. Used by `claude assistant`.
 */
viewerOnly?: boolean
```

位置：

- `package/restored-src/src/remote/RemoteSessionManager.ts:56-61`

证据 3：`connect()` 中确实通过 `SessionsWebSocket` 建立远程事件流，而 `sendMessage()` 通过 HTTP 投递消息：

- WebSocket：`package/restored-src/src/remote/RemoteSessionManager.ts:108-140`
- HTTP 发送：`package/restored-src/src/remote/RemoteSessionManager.ts:217-241`

这直接支撑了“本地 UI / 远端 agent runtime 分离”的判断。

### 14.9 “MCP 是标准化扩展协议层，而不是临时适配”

证据 1：MCP 类型里显式支持多种 transport：

```ts
export const TransportSchema = lazySchema(() =>
  z.enum(['stdio', 'sse', 'sse-ide', 'http', 'ws', 'sdk']),
)
```

位置：

- `package/restored-src/src/services/mcp/types.ts:23-26`

证据 2：MCP server config 是一个 union，而不是单一协议结构：

```ts
export const McpServerConfigSchema = lazySchema(() =>
  z.union([
    McpStdioServerConfigSchema(),
    McpSSEServerConfigSchema(),
    McpSSEIDEServerConfigSchema(),
    McpWebSocketIDEServerConfigSchema(),
    McpHTTPServerConfigSchema(),
    McpWebSocketServerConfigSchema(),
    McpSdkServerConfigSchema(),
    McpClaudeAIProxyServerConfigSchema(),
  ]),
)
```

位置：

- `package/restored-src/src/services/mcp/types.ts:124-135`

证据 3：连接状态被建模为完整状态机，而不是只有 connected/disconnected：

```ts
export type MCPServerConnection =
  | ConnectedMCPServer
  | FailedMCPServer
  | NeedsAuthMCPServer
  | PendingMCPServer
  | DisabledMCPServer
```

位置：

- `package/restored-src/src/services/mcp/types.ts:221-226`

这说明 MCP 集成在架构上是“一等公民”。

### 14.10 “系统存在大量 feature gate，产品能力可裁剪”

证据可在多个关键注册点同时看到：

- `entrypoints/cli.tsx` 中 `feature('DAEMON')`、`feature('BRIDGE_MODE')`、`feature('BG_SESSIONS')`
- `commands.ts` 中 `feature('KAIROS')`、`feature('VOICE_MODE')`、`feature('WORKFLOW_SCRIPTS')`
- `tools.ts` 中 `feature('WEB_BROWSER_TOOL')`、`feature('HISTORY_SNIP')`、`feature('AGENT_TRIGGERS')`
- `tasks.ts` 中 `feature('WORKFLOW_SCRIPTS')`、`feature('MONITOR_TOOL')`

代表性位置：

- `package/restored-src/src/entrypoints/cli.tsx:100-112`
- `package/restored-src/src/commands.ts:62-122`
- `package/restored-src/src/tools.ts:25-52`
- `package/restored-src/src/tools.ts:107-134`
- `package/restored-src/src/tasks.ts:8-14`

这也是前文判断“该系统是平台化产品，而非简单 CLI”的重要证据之一。
