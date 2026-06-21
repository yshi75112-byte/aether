当前版本：0.12

本次修改：
- 实现 topic-index-json-parse：TopicMemoryManager 可清洗并修复代码围栏、前后说明、尾逗号、对象字段漏逗号、裸键和字符串内原始换行
- 解析成功完整接入 processBatch → applyModelResult → save → topic_index / mem_topic_memory 主链路
- 不可修复的模型输出继续分类为 topic_index_json_parse，保留已有话题并使用本地 fallback；原始响应截断写入 memory_error_log
- Service Worker 缓存升级至 aether-pwa-v7，确保 PWA 获取新版主程序与 topic-memory-manager.js
- Memory 写入收敛为唯一主链路：sendMessage → callDeepSeekAPI → parseAIResponseMemoryUpdate → memorySystem._applyMemoryData → memorySystem._saveAll
- 禁用本地 applyLocalSaveIntent / applyLocalUpdateIntent / applyLocalDeleteIntent 对 memory 的直接写入
- 完整移除结构化短期记忆：删除运行时 API、UI、模型协议、上下文注入、导入导出和备份合并支持
- 启动时清理旧 mem_short_term；旧备份中的 shortTerm 字段会被忽略，不再复活
- 完整移除旧话题卡片：删除 topicCards 状态、UI、算法、导入导出、失败重试和调试接口
- 旧备份中的 topicCards 字段会被忽略；话题记忆保留并统一称为“近期话题”
- Topic 写入收敛为唯一主链路：TopicMemoryManager.enqueue → processBatch → applyModelResult → save → mem_topic_memory
- 完整移除持久化状态引擎：删除 StateEngine、mem_state_engine、状态面板、自动推断、模型协议、导入导出和调试接口
- 启动时清理旧 mem_state_engine；旧备份中的 stateEngine 字段会被忽略
- 保留 activeFocus，仅用于显示当前运行阶段，不持久化且不注入模型上下文
- 导入聊天后自动排队更新近期话题
- Chat history 收敛为只保存 messages
- memorySystem.parseMemoryUpdate 改为只解析 wrapper；extractMemoryUpdatePayload 只解析；processMemoryUpdate 保留为兼容 wrapper

验证结果：
- topic-index 可修复模型 JSON 能正常写入话题并推进 marker，不产生解析错误
- 不可修复/截断 JSON 不清空已有话题，记录 topic_index_json_parse 后进入本地 fallback
- topic-memory-manager.js、service-worker.js、TEST_MEMORY_V2.js 均通过 Node 语法检查
- TEST_MEMORY_V2.js 回归测试通过
- 无 API Key 的本地记忆意图不写 mem_long_term / mem_volatile
- API MEMORY_UPDATE 可写入 memory
- mem_topic_memory 可由 TopicMemoryManager 异步写入
- chat_history_cache 仅包含 messages
- 旧 parseMemoryUpdate 入口可解析但不写入

残余写入点：
- critical：未发现仍可从 UI 主流程直接写 memory/topic/chat 派生数据的残余写入点
- 非 critical：addPreference/addLongTermFact/addPlan/addTemporaryEvent/updateMemory/removeMemory 仍作为 MemorySystem 内部能力存在，由 _applyMemoryData 或不可达旧代码引用
- 非 critical：processMemoryUpdate 仍可作为兼容 wrapper 调用 _applyMemoryData，不属于 UI 主流程入口

待测试：
- Android Chrome
- PWA模式
- 浏览器环境运行 TEST_MEMORY_SYSTEM.js（该脚本依赖 window，不能直接由 Node 执行）
