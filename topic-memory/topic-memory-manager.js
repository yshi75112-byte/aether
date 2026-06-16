(function() {
    const DEFAULT_STATE = {
        version: 1,
        topics: [],
        marker: {
            lastProcessedMessageId: null,
            lastProcessedAt: null,
        },
        status: {
            phase: 'idle',
            text: '等待新消息',
            updatedAt: Date.now(),
        },
        pendingCount: 0,
        lastRun: null,
        lastError: '',
    };

    function clone(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function safeId(prefix) {
        return prefix + '_' + Date.now().toString(36) + '_' +
            Math.random().toString(36).slice(2, 8);
    }

    function normalizeMessage(msg, index) {
        if (!msg || !msg.content) return null;
        const role = msg.role === 'assistant' || msg.role === 'ai' ? 'assistant' : 'user';
        const timestamp = Number(msg.timestamp) || Date.now();
        return {
            id: msg.id || msg.messageId || `${role}_${timestamp}_${index}`,
            role,
            content: String(msg.content).slice(0, 1200),
            timestamp,
            timeText: new Date(timestamp).toLocaleString('zh-CN', { hour12: false }),
        };
    }

    function extractJSON(text) {
        if (!text) throw new Error('DeepSeek 返回为空');
        const trimmed = String(text).trim()
            .replace(/^```json\s*/i, '')
            .replace(/^```\s*/i, '')
            .replace(/```$/i, '')
            .trim();
        try {
            return JSON.parse(trimmed);
        } catch (firstError) {
            const start = trimmed.indexOf('{');
            const end = trimmed.lastIndexOf('}');
            if (start >= 0 && end > start) {
                return JSON.parse(trimmed.slice(start, end + 1));
            }
            throw firstError;
        }
    }

    function isJSONParseError(error) {
        return error instanceof SyntaxError ||
            /JSON|array element|Unexpected token|Expected/i.test(
                error && error.message ? error.message : String(error)
            );
    }

    function compactTopic(topic) {
        return {
            id: topic.id,
            title: topic.title,
            startTime: topic.startTime || topic.createdAt || topic.updatedAt || Date.now(),
            updatedAt: topic.updatedAt || Date.now(),
            messageIds: Array.isArray(topic.messageIds) ? topic.messageIds.slice(0, 80) : [],
            chain: Array.isArray(topic.chain)
                ? topic.chain.map(node => ({
                    id: node.id,
                    label: node.label,
                    messageIds: Array.isArray(node.messageIds) ? node.messageIds.slice(0, 24) : [],
                })).slice(0, 16)
                : [],
        };
    }

    class TopicMemoryManager {
        constructor(options = {}) {
            this.storageKey = options.storageKey || 'mem_topic_memory';
            this.callApi = options.callApi;
            this.hasApiKey = options.hasApiKey || (() => true);
            this.isBusy = options.isBusy || (() => false);
            this.onChange = options.onChange || (() => {});
            this.debounceMs = options.debounceMs || 1600;
            this.maxContextMessages = options.maxContextMessages || 120;
            this.maxBatchMessages = options.maxBatchMessages || 32;
            this.maxTopics = options.maxTopics || 60;
            this.timer = null;
            this.processing = false;
            this.state = this.load();
            this.notify();
        }

        load() {
            try {
                const raw = localStorage.getItem(this.storageKey);
                if (!raw) return clone(DEFAULT_STATE);
                const parsed = JSON.parse(raw);
                return this.normalizeState(parsed);
            } catch (error) {
                return clone(DEFAULT_STATE);
            }
        }

        normalizeState(state) {
            const next = { ...clone(DEFAULT_STATE), ...(state || {}) };
            next.topics = Array.isArray(next.topics) ? next.topics.map(compactTopic) : [];
            next.marker = next.marker && typeof next.marker === 'object'
                ? { ...DEFAULT_STATE.marker, ...next.marker }
                : clone(DEFAULT_STATE.marker);
            next.status = next.status && typeof next.status === 'object'
                ? { ...DEFAULT_STATE.status, ...next.status }
                : clone(DEFAULT_STATE.status);
            return next;
        }

        save() {
            localStorage.setItem(this.storageKey, JSON.stringify(this.state));
        }

        notify() {
            this.onChange(this.getState());
        }

        setStatus(phase, text, extra = {}) {
            this.state.status = {
                phase,
                text,
                updatedAt: Date.now(),
                ...extra,
            };
            this.save();
            this.notify();
        }

        getState() {
            return clone(this.state);
        }

        clear() {
            this.state = clone(DEFAULT_STATE);
            this.save();
            this.notify();
        }

        importData(data) {
            if (!data) return 0;
            const incoming = Array.isArray(data.topics) ? data.topics :
                (data.topicMemory && Array.isArray(data.topicMemory.topics) ? data.topicMemory.topics : []);
            if (incoming.length === 0) return 0;

            const before = this.state.topics.length;
            this.state.topics = this.mergeTopics(this.state.topics, incoming);
            if (data.marker || (data.topicMemory && data.topicMemory.marker)) {
                const marker = data.marker || data.topicMemory.marker;
                this.state.marker = {
                    ...this.state.marker,
                    ...marker,
                };
            }
            this.state.lastRun = {
                at: Date.now(),
                imported: incoming.length,
            };
            this.save();
            this.notify();
            return this.state.topics.length - before;
        }

        enqueue(messages, options = {}) {
            const normalized = this.normalizeMessages(messages);
            if (normalized.length === 0) return;

            const lastMessage = normalized[normalized.length - 1];
            if (!options.force && lastMessage.id === this.state.marker.lastProcessedMessageId) {
                this.setStatus('idle', '没有新消息需要整理');
                return;
            }

            const startIndex = this.findStartIndex(normalized);
            this.state.pendingCount = Math.max(0, normalized.length - startIndex);
            this.setStatus('queued', `已排队 ${this.state.pendingCount} 条消息`);

            clearTimeout(this.timer);
            this.timer = setTimeout(() => {
                this.process(normalized, options);
            }, options.immediate ? 0 : this.debounceMs);
        }

        normalizeMessages(messages) {
            return (Array.isArray(messages) ? messages : [])
                .map(normalizeMessage)
                .filter(Boolean)
                .slice(-this.maxContextMessages);
        }

        findStartIndex(messages) {
            const markerId = this.state.marker.lastProcessedMessageId;
            if (!markerId) return 0;
            const markerIndex = messages.findIndex(msg => msg.id === markerId);
            return markerIndex >= 0 ? markerIndex + 1 : 0;
        }

        async process(messages, options = {}) {
            if (this.processing) return;
            if (!this.callApi) {
                this.setStatus('error', '缺少 DeepSeek 调用入口');
                return;
            }
            if (!this.hasApiKey()) {
                this.setStatus('waiting', '等待配置 DeepSeek API Key');
                return;
            }
            if (!options.force && this.isBusy()) {
                this.setStatus('waiting', '等待当前回复完成');
                clearTimeout(this.timer);
                this.timer = setTimeout(() => this.process(messages, options), this.debounceMs);
                return;
            }

            const startIndex = this.findStartIndex(messages);
            const pendingMessages = messages.slice(startIndex);
            if (pendingMessages.length === 0) {
                this.state.pendingCount = 0;
                this.setStatus('idle', '没有新消息需要整理');
                return;
            }

            this.processing = true;
            this.state.pendingCount = pendingMessages.length;
            this.setStatus('processing', `正在整理 ${pendingMessages.length} 条消息`);

            try {
                let processedCount = 0;
                for (let offset = 0; offset < pendingMessages.length; offset += this.maxBatchMessages) {
                    const batch = pendingMessages.slice(offset, offset + this.maxBatchMessages);
                    const batchEnd = startIndex + offset + batch.length;
                    const context = messages.slice(
                        Math.max(0, batchEnd - this.maxContextMessages),
                        batchEnd
                    );
                    const batchProcessed = await this.processBatch(context, batch);
                    processedCount += batchProcessed;
                    this.state.pendingCount = Math.max(0, pendingMessages.length - processedCount);
                    this.setStatus(
                        'processing',
                        `正在整理 ${pendingMessages.length} 条消息（已完成 ${processedCount} 条）`
                    );
                }
                this.state.pendingCount = 0;
                this.state.lastError = '';
                this.state.lastRun = {
                    at: Date.now(),
                    processed: pendingMessages.length,
                    topics: this.state.topics.length,
                };
                this.setStatus('idle', `完成整理 ${pendingMessages.length} 条消息`);
            } catch (error) {
                this.state.lastError = error && error.message ? error.message : String(error);
                this.setStatus('error', '整理失败：' + this.state.lastError);
            } finally {
                this.processing = false;
            }
        }

        async processBatch(contextMessages, batchMessages) {
            try {
                const response = await this.callApi(this.buildPrompt(contextMessages, batchMessages));
                const parsed = extractJSON(response);
                this.applyModelResult(parsed, contextMessages);
                return batchMessages.length;
            } catch (error) {
                if (!isJSONParseError(error) || batchMessages.length <= 8) {
                    throw error;
                }

                const midpoint = Math.ceil(batchMessages.length / 2);
                const firstBatch = batchMessages.slice(0, midpoint);
                const secondBatch = batchMessages.slice(midpoint);
                const firstLastId = firstBatch[firstBatch.length - 1].id;
                const firstEnd = contextMessages.findIndex(msg => msg.id === firstLastId) + 1;
                if (firstEnd <= 0) throw error;

                const firstContext = contextMessages.slice(0, firstEnd);
                const firstCount = await this.processBatch(firstContext, firstBatch);
                const secondCount = await this.processBatch(contextMessages, secondBatch);
                return firstCount + secondCount;
            }
        }

        buildPrompt(allMessages, newMessages) {
            const existingTopics = this.state.topics
                .slice(-20)
                .map(compactTopic);
            const lastMessage = allMessages[allMessages.length - 1];

            return [
                {
                    role: 'system',
                    content: [
                        '你是对话话题记忆整理器。只输出 JSON，不要输出 Markdown、解释或 HTML 注释。',
                        '任务：检测同类话题对话，将新消息归入已有话题或创建新话题，并维护按时间顺序排列的因果链。',
                        '不要保存完整消息内容，只能引用 messageIds。',
                        '每个 chain 节点只写概述标签，不写时间；节点顺序代表因果时间顺序。',
                        '如果消息属于测试、纠错、计划、偏好、工具问题等，请给出简短明确的 title。',
                        'title 和 label 必须简短，避免引号、换行和列表符号。',
                        '最多返回 8 个 topics；每个 topic 最多 6 个 chain 节点。',
                        '输出 schema：{"topics":[{"id":"topic_x","title":"话题名","startTime":毫秒时间戳,"updatedAt":毫秒时间戳,"messageIds":["msg"],"chain":[{"id":"node_x","label":"概述","messageIds":["msg"]}]}],"marker":{"lastProcessedMessageId":"msg","lastProcessedAt":毫秒时间戳}}',
                        '可以复用已有 topic/node id；新建 id 用 topic_ 或 node_ 开头。',
                        '必须返回合法 JSON：所有数组元素之间必须有逗号，字符串必须用双引号并正确转义。',
                    ].join('\n'),
                },
                {
                    role: 'user',
                    content: JSON.stringify({
                        existingTopics,
                        marker: this.state.marker,
                        newMessages,
                        recentMessages: allMessages.slice(-24),
                        requiredLastProcessedMessageId: lastMessage ? lastMessage.id : null,
                    }, null, 2),
                },
            ];
        }

        applyModelResult(result, messages) {
            const messageIdSet = new Set(messages.map(msg => msg.id));
            const incomingTopics = Array.isArray(result && result.topics) ? result.topics : [];
            const sanitized = incomingTopics
                .map(topic => this.sanitizeTopic(topic, messageIdSet))
                .filter(topic => topic.title && topic.messageIds.length > 0);

            this.state.topics = this.mergeTopics(this.state.topics, sanitized)
                .sort((a, b) => (a.startTime || 0) - (b.startTime || 0))
                .slice(-this.maxTopics);

            const lastMessage = messages[messages.length - 1];
            const marker = result && result.marker ? result.marker : {};
            this.state.marker = {
                lastProcessedMessageId: marker.lastProcessedMessageId || (lastMessage && lastMessage.id) || null,
                lastProcessedAt: Number(marker.lastProcessedAt) || Date.now(),
            };
            this.save();
            this.notify();
        }

        sanitizeTopic(topic, messageIdSet) {
            const now = Date.now();
            const chain = Array.isArray(topic && topic.chain)
                ? topic.chain.map(node => ({
                    id: node.id || safeId('node'),
                    label: String(node.label || '').trim().slice(0, 40),
                    messageIds: this.uniqueIds(node.messageIds, messageIdSet),
                })).filter(node => node.label && node.messageIds.length > 0)
                : [];
            const messageIds = this.uniqueIds(
                (topic && topic.messageIds) || chain.flatMap(node => node.messageIds),
                messageIdSet
            );

            return compactTopic({
                id: topic.id || safeId('topic'),
                title: String(topic.title || '').trim().slice(0, 40),
                startTime: Number(topic.startTime) || now,
                updatedAt: Number(topic.updatedAt) || now,
                messageIds,
                chain,
            });
        }

        uniqueIds(ids, allowedSet) {
            const seen = new Set();
            return (Array.isArray(ids) ? ids : [])
                .map(id => String(id || '').trim())
                .filter(id => id && allowedSet.has(id) && !seen.has(id) && seen.add(id));
        }

        mergeTopics(existing, incoming) {
            const byId = new Map();
            (existing || []).forEach(topic => {
                if (topic && topic.id) byId.set(topic.id, compactTopic(topic));
            });

            (incoming || []).forEach(topic => {
                if (!topic) return;
                const clean = compactTopic(topic);
                const prior = byId.get(clean.id);
                if (!prior) {
                    byId.set(clean.id, clean);
                    return;
                }

                const messageIds = Array.from(new Set([
                    ...(prior.messageIds || []),
                    ...(clean.messageIds || []),
                ]));
                const nodeMap = new Map();
                (prior.chain || []).concat(clean.chain || []).forEach(node => {
                    const id = node.id || safeId('node');
                    const existingNode = nodeMap.get(id);
                    if (!existingNode) {
                        nodeMap.set(id, {
                            id,
                            label: node.label,
                            messageIds: Array.from(new Set(node.messageIds || [])),
                        });
                    } else {
                        existingNode.label = node.label || existingNode.label;
                        existingNode.messageIds = Array.from(new Set([
                            ...(existingNode.messageIds || []),
                            ...(node.messageIds || []),
                        ]));
                    }
                });

                byId.set(clean.id, compactTopic({
                    ...prior,
                    ...clean,
                    startTime: Math.min(prior.startTime || clean.startTime, clean.startTime || prior.startTime),
                    updatedAt: Math.max(prior.updatedAt || 0, clean.updatedAt || 0, Date.now()),
                    messageIds,
                    chain: Array.from(nodeMap.values()),
                }));
            });

            return Array.from(byId.values());
        }
    }

    window.TopicMemoryManager = TopicMemoryManager;
})();
