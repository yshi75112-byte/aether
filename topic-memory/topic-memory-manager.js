(function() {
    let topicWriteDepth = 0;
    const storagePrototype = typeof Storage !== 'undefined'
        ? Storage.prototype
        : (typeof localStorage !== 'undefined' ? Object.getPrototypeOf(localStorage) : null);

    if (storagePrototype && !storagePrototype.__aetherTopicWriteGuardInstalled) {
        const originalSetItem = storagePrototype.setItem;
        Object.defineProperty(storagePrototype, '__aetherTopicWriteGuardInstalled', { value: true });
        storagePrototype.setItem = function(key, value) {
            if (key === 'mem_topic_memory' && topicWriteDepth === 0) {
                const stack = new Error('unauthorized mem_topic_memory write').stack || '';
                console.warn('[MEMORY VIOLATION]', stack, {
                    action: 'localStorage.setItem(mem_topic_memory)',
                    source: 'topic/non-TopicMemoryManager',
                });
                return false;
            }
            return originalSetItem.call(this, key, value);
        };
    }

    const DEFAULT_STATE = {
        version: 2,
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
        lastErrorType: '',
        errorLog: [],
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

    function getModelText(response) {
        if (typeof response === 'string') return response;
        if (response && typeof response.content === 'string') return response.content;
        if (response && response.message && typeof response.message.content === 'string') {
            return response.message.content;
        }
        return response == null ? '' : String(response);
    }

    function cleanAIJSON(text) {
        const source = getModelText(text)
            .replace(/^\uFEFF/, '')
            .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
            .trim();
        const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
        let cleaned = (fenced ? fenced[1] : source).trim();
        const objectStart = cleaned.indexOf('{');
        const arrayStart = cleaned.indexOf('[');
        const start = objectStart < 0 ? arrayStart : (arrayStart < 0 ? objectStart : Math.min(objectStart, arrayStart));
        if (start > 0) cleaned = cleaned.slice(start);
        const objectEnd = cleaned.lastIndexOf('}');
        const arrayEnd = cleaned.lastIndexOf(']');
        const end = Math.max(objectEnd, arrayEnd);
        if (end >= 0) cleaned = cleaned.slice(0, end + 1);
        return cleaned
            .replace(/,\s*([}\]])/g, '$1')
            .trim();
    }

    function escapeStringControls(text) {
        let result = '';
        let inString = false;
        let escaped = false;
        for (const char of String(text || '')) {
            if (inString && (char === '\n' || char === '\r' || char === '\t')) {
                result += char === '\n' ? '\\n' : (char === '\r' ? '\\r' : '\\t');
                escaped = false;
                continue;
            }
            result += char;
            if (escaped) {
                escaped = false;
            } else if (char === '\\' && inString) {
                escaped = true;
            } else if (char === '"') {
                inString = !inString;
            }
        }
        return result;
    }

    function repairAIJSON(text) {
        return escapeStringControls(text)
            .replace(/,\s*([}\]])/g, '$1')
            .replace(/([{,]\s*)([A-Za-z_][\w-]*)(\s*:)/g, '$1"$2"$3')
            .replace(/(["}\]\d])\s*(?="[^"\\]*(?:\\.[^"\\]*)*"\s*:)/g, '$1,')
            .replace(/([}\]])\s*(?=[{[])/g, '$1,')
            .trim();
    }

    function extractJSON(response) {
        const raw = getModelText(response);
        if (!raw.trim()) throw new SyntaxError('DeepSeek 返回为空，无法解析话题索引 JSON');

        const cleaned = cleanAIJSON(raw);
        const candidates = [cleaned];
        const objectStart = cleaned.indexOf('{');
        const objectEnd = cleaned.lastIndexOf('}');
        if (objectStart >= 0 && objectEnd > objectStart) {
            candidates.push(cleaned.slice(objectStart, objectEnd + 1));
        }
        const arrayStart = cleaned.indexOf('[');
        const arrayEnd = cleaned.lastIndexOf(']');
        if (arrayStart >= 0 && arrayEnd > arrayStart) {
            candidates.push(cleaned.slice(arrayStart, arrayEnd + 1));
        }

        const attempts = [];
        const uniqueCandidates = Array.from(new Set(candidates.filter(Boolean)));
        for (const candidate of uniqueCandidates) {
            for (const [source, value] of [['cleaned', candidate], ['repaired', repairAIJSON(candidate)]]) {
                try {
                    return JSON.parse(value);
                } catch (error) {
                    attempts.push(source + ': ' + (error && error.message ? error.message : String(error)));
                }
            }
        }

        const error = new SyntaxError('话题索引 JSON 解析失败：' + (attempts[attempts.length - 1] || '没有 JSON 内容'));
        error.raw = raw;
        error.attempts = attempts;
        throw error;
    }

    function isJSONParseError(error) {
        return error instanceof SyntaxError ||
            /JSON|array element|Unexpected token|Expected/i.test(
                error && error.message ? error.message : String(error)
            );
    }

    function compactTopic(topic) {
        const facts = Array.isArray(topic.facts)
            ? topic.facts.map(fact => String(fact || '').trim()).filter(Boolean).slice(0, 8)
            : [];
        const messageIds = Array.isArray(topic.messageIds) ? Array.from(new Set(topic.messageIds)).slice(0, 160) : [];
        return {
            topic_id: topic.topic_id || topic.id,
            id: topic.topic_id || topic.id,
            category: String(topic.category || '其他').trim().slice(0, 20),
            title: String(topic.title || '未命名话题').trim().slice(0, 32),
            summary: String(topic.summary || '').trim().slice(0, 140),
            facts,
            startTime: topic.startTime || topic.createdAt || topic.updatedAt || Date.now(),
            updated_at: topic.updated_at || topic.updatedAt || Date.now(),
            updatedAt: topic.updated_at || topic.updatedAt || Date.now(),
            message_count: Math.max(Number(topic.message_count) || 0, messageIds.length),
            messageIds,
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
            this.storageKey = options.storageKey || 'topic_index';
            this.legacyStorageKey = options.legacyStorageKey || 'mem_topic_memory';
            this.backupKey = options.backupKey || 'last_good_backup';
            this.errorLogKey = options.errorLogKey || 'memory_error_log';
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
            this.loadFailed = false;
            this.state = this.load();
            if (!this.loadFailed) this.save();
            this.notify();
        }

        load() {
            try {
                const raw = localStorage.getItem(this.storageKey) || localStorage.getItem(this.legacyStorageKey);
                if (!raw) return clone(DEFAULT_STATE);
                const parsed = JSON.parse(raw);
                return this.normalizeState(parsed);
            } catch (error) {
                this.logError('topic_index_load', error);
                try {
                    const legacyRaw = localStorage.getItem(this.legacyStorageKey);
                    if (legacyRaw) return this.normalizeState(JSON.parse(legacyRaw));
                    const backup = JSON.parse(localStorage.getItem(this.backupKey) || '{}');
                    if (backup.topic_index && backup.topic_index.value) {
                        return this.normalizeState(backup.topic_index.value);
                    }
                } catch (backupError) { /* preserve the corrupt source */ }
                this.loadFailed = true;
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
            const stack = new Error('TopicMemoryManager.save').stack || '';
            if (window.memoryDebugMode === true) {
                console.info('[MEMORY WRITE]', { action: 'TopicMemoryManager.save', source: 'topic', stack });
            }
            topicWriteDepth += 1;
            try {
                const next = JSON.stringify(this.state);
                const current = localStorage.getItem(this.storageKey);
                if (current) this.writeBackup('topic_index', current);
                localStorage.setItem(this.storageKey, next);
                localStorage.setItem(this.legacyStorageKey, next);
            } finally {
                topicWriteDepth -= 1;
            }
        }

        writeBackup(type, value) {
            try {
                const existing = JSON.parse(localStorage.getItem(this.backupKey) || '{}');
                existing[type] = { saved_at: Date.now(), value: typeof value === 'string' ? JSON.parse(value) : value };
                localStorage.setItem(this.backupKey, JSON.stringify(existing));
            } catch (error) { /* backup must never block the primary save */ }
        }

        logError(type, error, raw = '') {
            const entry = {
                type,
                message: error && error.message ? error.message : String(error),
                at: Date.now(),
                raw: String(raw || '').slice(0, 500),
            };
            try {
                const stored = JSON.parse(localStorage.getItem(this.errorLogKey) || '[]');
                localStorage.setItem(this.errorLogKey, JSON.stringify([entry].concat(Array.isArray(stored) ? stored : []).slice(0, 50)));
            } catch (ignore) { /* logging failure must not interrupt organizing */ }
            if (this.state) {
                this.state.lastError = entry.message;
                this.state.lastErrorType = type;
                this.state.errorLog = [entry].concat(this.state.errorLog || []).slice(0, 12);
            }
            console.error('[TopicMemoryManager][' + type + ']', entry);
            return entry;
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

            const startIndex = options.force ? 0 : this.findStartIndex(normalized);
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

            const startIndex = options.force ? 0 : this.findStartIndex(messages);
            const pendingMessages = messages.slice(startIndex);
            if (pendingMessages.length === 0) {
                this.state.pendingCount = 0;
                this.setStatus('idle', '没有新消息需要整理');
                return;
            }

            this.processing = true;
            this.state.pendingCount = pendingMessages.length;
            this.state.lastError = '';
            this.state.lastErrorType = '';
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
                    let batchProcessed = 0;
                    try {
                        batchProcessed = await this.processBatch(context, batch);
                    } catch (error) {
                        this.logError(
                            isJSONParseError(error) ? 'topic_index_json_parse' : 'topic_index_organize',
                            error,
                            error && error.raw
                        );
                        this.applyFallbackTopics(batch);
                        batchProcessed = batch.length;
                    }
                    processedCount += batchProcessed;
                    this.state.pendingCount = Math.max(0, pendingMessages.length - processedCount);
                    this.setStatus(
                        'processing',
                        `正在整理 ${pendingMessages.length} 条消息（已完成 ${processedCount} 条）`
                    );
                }
                this.state.pendingCount = 0;
                this.state.lastRun = {
                    at: Date.now(),
                    processed: pendingMessages.length,
                    topics: this.state.topics.length,
                };
                this.setStatus(
                    'idle',
                    this.state.lastErrorType
                        ? `完成整理 ${pendingMessages.length} 条消息（部分使用本地兜底）`
                        : `完成整理 ${pendingMessages.length} 条消息`
                );
            } catch (error) {
                this.state.lastError = error && error.message ? error.message : String(error);
                this.state.lastErrorType = isJSONParseError(error) ? 'topic_index_json_parse' : 'topic_index_organize';
                this.logError(this.state.lastErrorType, error, error && error.raw);
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

        applyFallbackTopics(messages, options = {}) {
            const groups = new Map();
            (messages || []).forEach(message => {
                if (!message || !message.content) return;
                const category = this.inferCategory(message.content);
                if (!groups.has(category)) groups.set(category, []);
                groups.get(category).push(message);
            });
            const topics = Array.from(groups.entries()).map(([category, items]) => {
                const first = items.find(item => item.role === 'user') || items[0];
                const summary = String(first.content || '').replace(/\s+/g, ' ').slice(0, 100);
                const sameCategory = (this.state.topics || []).slice().reverse().find(topic => topic.category === category);
                return {
                    topic_id: sameCategory ? sameCategory.id : ('topic_archive_' + category),
                    category,
                    title: this.inferTitle(summary, category),
                    summary,
                    facts: items.filter(item => item.role === 'user').map(item => String(item.content).replace(/\s+/g, ' ').slice(0, 100)).slice(0, 5),
                    startTime: Math.min(...items.map(item => item.timestamp || Date.now())),
                    updated_at: Math.max(...items.map(item => item.timestamp || Date.now())),
                    messageIds: items.map(item => item.id),
                };
            });
            this.state.topics = this.mergeTopics(this.state.topics, topics).slice(-this.maxTopics);
            const last = messages[messages.length - 1];
            if (last && options.advanceMarker !== false) {
                this.state.marker = { lastProcessedMessageId: last.id, lastProcessedAt: Date.now() };
            }
            this.save();
            this.notify();
        }

        inferCategory(text) {
            const value = String(text || '');
            if (/报错|错误|bug|修复|调试|JSON|代码/i.test(value)) return '代码与调试';
            if (/项目|功能|开发|版本|状态|进度/i.test(value)) return '项目进展';
            if (/偏好|喜欢|不要|习惯|风格/i.test(value)) return '用户偏好';
            if (/计划|目标|下一步|待办/i.test(value)) return '计划与目标';
            if (/记忆|话题|上下文/i.test(value)) return '记忆系统';
            return '其他';
        }

        inferTitle(text, category) {
            const clean = String(text || '').replace(/[\r\n]+/g, ' ').replace(/^[，。！？、\s]+|[，。！？、\s]+$/g, '');
            return (clean.slice(0, 24) || category || '未命名话题');
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
                        '任务：维护去重的话题索引。新消息必须优先合并到语义相同的已有话题，只有确实不同才新建。',
                        '不要保存完整消息内容，只能引用 messageIds。',
                        '每个 chain 节点只写概述标签，不写时间；节点顺序代表因果时间顺序。',
                        '如果消息属于测试、纠错、计划、偏好、工具问题等，请给出简短明确的 title。',
                        'title 和 label 必须简短，避免引号、换行和列表符号。',
                        'category 优先沿用已有话题检测分类；summary 不超过 60 字；facts 最多 5 条，每条不超过 50 字。',
                        '最多返回 8 个 topics；每个 topic 最多 6 个 chain 节点。',
                        '输出 schema：{"topics":[{"topic_id":"topic_x","category":"分类","title":"短标题","summary":"短摘要","facts":["关键事实"],"updated_at":毫秒时间戳,"messageIds":["msg"],"chain":[{"id":"node_x","label":"概述","messageIds":["msg"]}]}],"marker":{"lastProcessedMessageId":"msg","lastProcessedAt":毫秒时间戳}}',
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
            if (!result || typeof result !== 'object' || Array.isArray(result) || !Array.isArray(result.topics)) {
                throw new SyntaxError('话题索引 JSON schema 无效：缺少 topics 数组');
            }
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
                topic_id: topic.topic_id || topic.id || '',
                category: String(topic.category || this.inferCategory(topic.title || topic.summary || '')).trim().slice(0, 20),
                title: String(topic.title || '').trim().slice(0, 40),
                summary: String(topic.summary || '').trim().slice(0, 140),
                facts: Array.isArray(topic.facts) ? topic.facts : [],
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
                const clean = compactTopic(topic);
                if (clean && clean.id) byId.set(clean.id, clean);
            });

            (incoming || []).forEach(topic => {
                if (!topic) return;
                let clean = compactTopic(topic);
                let prior = clean.id ? byId.get(clean.id) : null;
                if (!prior) {
                    prior = Array.from(byId.values()).find(candidate => this.topicSimilarity(candidate, clean) >= 0.62) || null;
                    if (prior) clean = { ...clean, id: prior.id, topic_id: prior.id };
                }
                if (!prior) {
                    if (!clean.id) clean.id = clean.topic_id = safeId('topic');
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
                    updated_at: Math.max(prior.updated_at || 0, clean.updated_at || 0, Date.now()),
                    summary: clean.summary || prior.summary,
                    facts: this.mergeFacts(prior.facts, clean.facts),
                    message_count: Math.max(prior.message_count || 0, clean.message_count || 0, messageIds.length),
                    messageIds,
                    chain: Array.from(nodeMap.values()),
                }));
            });

            return Array.from(byId.values());
        }

        mergeFacts(left, right) {
            const result = [];
            (left || []).concat(right || []).forEach(fact => {
                const text = String(fact || '').trim().slice(0, 100);
                if (text && !result.some(existing => this.textSimilarity(existing, text) > 0.72)) result.push(text);
            });
            return result.slice(-8);
        }

        textSimilarity(a, b) {
            const left = new Set(String(a || '').toLowerCase().replace(/\s+/g, '').split(''));
            const right = new Set(String(b || '').toLowerCase().replace(/\s+/g, '').split(''));
            if (!left.size || !right.size) return 0;
            let common = 0;
            left.forEach(char => { if (right.has(char)) common += 1; });
            return common / Math.max(left.size, right.size);
        }

        topicSimilarity(a, b) {
            const categoryBonus = a.category && b.category && a.category === b.category ? 0.2 : 0;
            const titleScore = this.textSimilarity(a.title, b.title);
            const summaryScore = this.textSimilarity(a.summary || a.title, b.summary || b.title);
            return Math.min(1, categoryBonus + titleScore * 0.5 + summaryScore * 0.3);
        }
    }

    window.TopicMemoryManager = TopicMemoryManager;
})();
