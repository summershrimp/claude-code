# Codex 的 LLM Context Management 分析

本文分析的是 `/home/xm1994/Projects/codex/` 源码里的 **LLM 上下文管理**，不是普通的会话状态或 UI 状态。结论先说：Codex 确实有一套很明确的上下文治理机制，而且和 Claude Code 的思路高度接近，但实现路径更偏向于 **线程历史 baseline + 增量上下文更新 + 自动/手动 compaction + token 预算控制**。它不是一个单纯“把聊天记录原样累积”的系统。

## 1. Codex 不是把历史直接拼给模型，而是维护上下文 baseline

Codex 的历史管理不是简单 list append。核心结构在 [core/src/context_manager/history.rs](/home/xm1994/Projects/codex/codex-rs/core/src/context_manager/history.rs#L32)：

- `items` 保存线程历史
- `token_info` 保存 token 使用
- `reference_context_item` 保存上下文 baseline

注释已经把语义写得很直白：`reference_context_item` 是“下一轮 regular turn 的 baseline”，如果它是 `None`，下一个 turn 会走 **full reinjection**；否则走 **settings diff**。

这意味着 Codex 在上下文管理上用的是“**基线 + 差分**”模型，而不是每轮完全重建一份完整 prompt。

## 2. regular turn 会只注入上下文差异

真正构造上下文的代码在 [core/src/codex.rs](/home/xm1994/Projects/codex/codex-rs/core/src/codex.rs#L3748)：

- 如果 `reference_context_item` 为空，就调用 `build_initial_context()`
- 如果 baseline 已存在，就调用 `build_settings_update_items()`

对应逻辑如下：

```rust
let should_inject_full_context = reference_context_item.is_none();
let context_items = if should_inject_full_context {
    self.build_initial_context(turn_context).await
} else {
    self.build_settings_update_items(reference_context_item.as_ref(), turn_context)
        .await
};
```

这里的注释也明确说了 steady-state 路径是 “append only context diffs to minimize token overhead”。这就是典型的上下文节流手法：**稳定部分不重复灌入，变化部分才更新**。

同一个函数还会把 `TurnContextItem` 持久化，并且在内存里更新 `reference_context_item`。这说明 Codex 的上下文不是纯运行时临时拼装，而是有跨 turn 的持久 baseline。

## 3. Codex 有自动 compaction，而且是按 token 阈值触发

在 [core/src/codex.rs](/home/xm1994/Projects/codex/codex-rs/core/src/codex.rs#L5658) 的 `run_turn()` 里，Codex 会先做 pre-sampling compaction，然后在采样之后检查 token 使用：

```rust
let auto_compact_limit = model_info.auto_compact_token_limit().unwrap_or(i64::MAX);
...
let total_usage_tokens = sess.get_total_token_usage().await;
let token_limit_reached = total_usage_tokens >= auto_compact_limit;
...
if token_limit_reached && needs_follow_up {
    run_auto_compact(...).await?;
    continue;
}
```

这和 Claude Code 的上下文治理思路非常接近：

- 先统计当前上下文是否接近阈值
- 再触发压缩
- 再继续后续对话

Codex 不是等到彻底爆掉才处理，而是把 compaction 当成运行时控制流的一部分。

## 4. 还有一层 pre-turn compaction，用于模型切换或跨窗口风险

`run_pre_sampling_compact()` 会在真正采样前先判断是否需要压缩。见 [core/src/codex.rs](/home/xm1994/Projects/codex/codex-rs/core/src/codex.rs#L6147)。

其中一个关键逻辑是 [core/src/codex.rs](/home/xm1994/Projects/codex/codex-rs/core/src/codex.rs#L6170) 的 `maybe_run_previous_model_inline_compact()`：

- 取出上一轮 regular turn 的模型
- 比较旧模型和新模型的 `context_window`
- 如果旧窗口更大、新窗口更小，并且当前 token 使用已经超过新模型的 compaction 阈值，就先对旧模型执行 compaction

这说明 Codex 不只是“当前模型 token 紧张才压缩”，还考虑了 **模型切换带来的上下文窗缩窄**。这类行为已经很接近成熟 agent 的上下文调度器，而不是简单聊天前端。

## 5. 手动 compaction 是正式 API，不是内部黑盒

Codex 的 app-server 明确暴露了 `thread/compact/start`。文档在 [app-server/README.md](/home/xm1994/Projects/codex/codex-rs/app-server/README.md#L416) 写得很清楚：

- 这是手动触发历史 compaction 的接口
- 请求立即返回 `{}`
- 进度通过标准 `turn/*` 和 `item/*` 事件流出
- 只会看到一个 `contextCompaction` item

文档还说这个 item 也可能自动发生，见 [app-server/README.md](/home/xm1994/Projects/codex/codex-rs/app-server/README.md#L909)。

这点很重要，因为它说明 Codex 把上下文压缩当成了**一等能力**，而不是某个偶发补救逻辑。

## 6. 压缩后的历史会真正替换原历史

Codex 的 compaction 不是只生成一段摘要文本，它会把原历史替换成新的 compacted history。

### 6.1 本地 compaction

在 [core/src/compact.rs](/home/xm1994/Projects/codex/codex-rs/core/src/compact.rs#L54) 里，`run_inline_auto_compact_task()` 会把 `compact_prompt` 当成合成输入，跑一个 `contextCompaction` item，然后在结束后构造新的历史：

```rust
let summary_text = format!("{SUMMARY_PREFIX}\n{summary_suffix}");
let mut new_history = build_compacted_history(Vec::new(), &user_messages, &summary_text);
...
sess.replace_compacted_history(new_history, reference_context_item, compacted_item).await;
sess.recompute_token_usage(turn_context).await;
```

这里不是“保存一个摘要，继续沿用旧历史”，而是**替换历史本身**。

### 6.2 远程 compaction

OpenAI provider 走的是远程路径。在 [core/src/compact_remote.rs](/home/xm1994/Projects/codex/codex-rs/core/src/compact_remote.rs#L68) 里：

- 先裁剪掉一部分函数调用历史，避免超窗
- 再调用 `compact_conversation_history()`
- 再 `process_compacted_history()`
- 最后 `replace_compacted_history()` 并 `recompute_token_usage()`

这说明 Codex 的上下文压缩不是一种“UI 视图压缩”，而是对线程历史的结构性重写。

## 7. Codex 也会主动裁剪“易膨胀”历史项

在远程 compaction 之前，Codex 会先把历史里最容易爆上下文的部分裁掉。见 [core/src/compact_remote.rs](/home/xm1994/Projects/codex/codex-rs/core/src/compact_remote.rs#L78)：

```rust
let deleted_items = trim_function_call_history_to_fit_context_window(
    &mut history,
    turn_context.as_ref(),
    &base_instructions,
);
```

这个函数会在历史超窗时，从末尾回退删除 Codex 生成的项，直到能塞进 context window。对应逻辑在同文件后半段，说明 Codex 处理上下文的方式不仅有“摘要”，还有更细粒度的 **历史裁剪**。

这和 Claude Code 里常见的“工具输出裁剪 / 大块上下文外置”属于同一类技术路线。

## 8. token 使用是实时维护的，而不是事后估算

Codex 会在每轮更新 token 使用，并把它发给 UI。见 [core/src/codex.rs](/home/xm1994/Projects/codex/codex-rs/core/src/codex.rs#L3780)：

```rust
state.update_token_info_from_usage(token_usage, turn_context.model_context_window());
self.send_token_count_event(turn_context).await;
```

还有一个回退路径是 `recompute_token_usage()`，它会直接根据当前历史重新估算总 token，并更新 `TokenUsageInfo`。见 [core/src/codex.rs](/home/xm1994/Projects/codex/codex-rs/core/src/codex.rs#L3792)。

这说明 Codex 的上下文管理不是只在“快满了”的时候才看一眼，而是持续跟踪：

- 当前总 token
- 模型 context window
- auto compact limit
- 历史项增长速度

## 9. Codex 把“长期记忆”与“当前上下文”分开了

这里很容易混淆：Codex 里确实有 `memories`，但那不是当前 thread 的短期上下文本身。

例如 [core/src/memories/prompts.rs](/home/xm1994/Projects/codex/codex-rs/core/src/memories/prompts.rs#L129) 里，rollout 内容会被按模型窗口截断；`memory_summary.md` 也会被单独裁剪后注入到 developer instructions。见 [core/src/memories/prompts.rs](/home/xm1994/Projects/codex/codex-rs/core/src/memories/prompts.rs#L160)。

这说明 Codex 的设计是：

- 当前会话上下文：由 history / baseline / compaction 管
- 长期工作记忆：由 memories 管

二者是分层的，不是混在一个 message buffer 里。

## 10. 和 Claude Code 的关系

如果只看上下文管理，Codex 和 Claude Code 的相似点很明显：

- 都有明确的 context window 意识
- 都会在阈值触发时做 compaction
- 都会保留结构化的长期上下文，而不是把所有东西永久塞进 prompt
- 都会把工具输出、历史项、模型切换视为上下文治理对象

但 Codex 的实现又有自己的特点：

- 更强的线程/turn/compaction 一体化协议
- `thread/compact/start` 直接暴露为正式 API
- `reference_context_item` 让它更像“baseline diff 系统”
- `memories` 是单独子系统，而不是把长期记忆揉进聊天历史

所以如果你要一句话概括：

> Codex 不是“没有上下文管理”，而是有一套相当完整的上下文预算与压缩系统；它和 Claude Code 的思路很接近，但更强调 thread 级结构化 compaction 和 baseline diff。

## 结论

Codex 代码里能明确看到这些上下文管理技术：

- `reference_context_item` 作为上下文 baseline
- regular turn 的增量上下文注入
- token 使用的实时 tracking
- 自动 compaction
- 手动 compaction API
- 远程 compaction endpoint
- compaction 后替换历史并重算 token
- 长期 memories 与短期上下文分离

如果你的问题是“Codex 有没有类似 Claude Code 的上下文管理技术”，答案是：**有，而且不是浅层相似，是同一类 agent 上下文治理思想的实现**。区别主要在于 Codex 的线程协议和 compaction 机制更显式、更结构化。
