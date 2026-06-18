当前版本：0.8

本次修改：
- Memory 写入收敛为唯一主链路：sendMessage → callDeepSeekAPI → parseAIResponseMemoryUpdate → memorySystem._applyMemoryData → memorySystem._saveAll
- 禁用本地 applyLocalSaveIntent / applyLocalUpdateIntent / applyLocalDeleteIntent 对 memory 的直接写入
- 禁用用户输入兜底 shortTerm 写入与 AI 回复摘要 shortTerm 写入
- Topic 写入收敛为唯一主链路：TopicMemoryManager.enqueue → processBatch → applyModelResult → save → mem_topic_memory
- 禁用 chat_history_cache.topicCards、本地 organizeTopicMessagesBatch、upsertTopicCardForTurn、rebuildTopicCardsFromHistory 的 topic 写入
- Chat history 收敛为只保存 messages
- memorySystem.parseMemoryUpdate 改为只解析 wrapper；extractMemoryUpdatePayload 只解析；processMemoryUpdate 保留为兼容 wrapper

验证结果：
- 无 API Key 的本地记忆意图不写 mem_short_term / mem_long_term / mem_volatile
- API MEMORY_UPDATE 可写入 memory
- mem_topic_memory 可由 TopicMemoryManager 异步写入
- chat_history_cache 仅包含 messages
- 旧 parseMemoryUpdate 入口可解析但不写入

残余写入点：
- critical：未发现仍可从 UI 主流程直接写 memory/topic/chat 派生数据的残余写入点
- 非 critical：addShortTerm/addPreference/addLongTermFact/addPlan/addTemporaryEvent/updateMemory/removeMemory 仍作为 MemorySystem 内部能力存在，由 _applyMemoryData 或不可达旧代码引用
- 非 critical：processMemoryUpdate 仍可作为兼容 wrapper 调用 _applyMemoryData，不属于 UI 主流程入口

待测试：
- Android Chrome
- PWA模式
