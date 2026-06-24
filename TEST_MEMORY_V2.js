const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

class LocalStorageMock {
    constructor() { this.data = new Map(); }
    getItem(key) { return this.data.has(key) ? this.data.get(key) : null; }
    setItem(key, value) { this.data.set(key, String(value)); }
    removeItem(key) { this.data.delete(key); }
}

async function testTopicIndex() {
    global.localStorage = new LocalStorageMock();
    global.window = global;
    vm.runInThisContext(fs.readFileSync('./topic-memory/topic-memory-manager.js', 'utf8'));

    const messages = [
        { id: 'm1', role: 'user', content: '请修复记忆系统 JSON 报错', timestamp: 1 },
        { id: 'm2', role: 'assistant', content: '正在修复', timestamp: 2 },
    ];
    const repairManager = new global.TopicMemoryManager({
        debounceMs: 0,
        hasApiKey: () => true,
        isBusy: () => false,
        callApi: async () => '说明文字```json\n{topics:[{"topic_id":"topic_repaired" "title":"解析修复","summary":"第一行\n第二行","messageIds":["m1"],},],marker:{"lastProcessedMessageId":"m2","lastProcessedAt":2,},}\n```',
    });
    await repairManager.process(messages, { force: true });
    const repairedState = repairManager.getState();
    assert(repairedState.topics.some(topic => topic.id === 'topic_repaired'), '应修复常见模型 JSON 格式瑕疵');
    assert.strictEqual(repairedState.marker.lastProcessedMessageId, 'm2', '修复后的结果应进入 applyModelResult');
    assert.strictEqual(repairedState.lastErrorType, '', '可修复 JSON 不应记录解析错误');

    const manager = new global.TopicMemoryManager({
        debounceMs: 0,
        hasApiKey: () => true,
        isBusy: () => false,
        callApi: async () => '{"topics":[{"topic_id":"broken","title":"内容被截断"',
    });
    manager.applyFallbackTopics(messages);
    const before = manager.getState().topics.length;
    manager.applyFallbackTopics(messages);
    assert.strictEqual(manager.getState().topics.length, before, '同类话题应合并而不是重复新建');

    await manager.process(messages, { force: true });
    const state = manager.getState();
    assert(state.topics.length >= before, '非法 JSON 不应清空原话题');
    assert.strictEqual(state.lastErrorType, 'topic_index_json_parse');
    assert(localStorage.getItem('topic_index'), '应保存 topic_index');
    assert(localStorage.getItem('last_good_backup'), '应保存 last_good_backup');
    assert(localStorage.getItem('memory_error_log').includes('topic_index_json_parse'), '应写入分类错误日志');

    const topicBeforeViolation = localStorage.getItem('mem_topic_memory');
    localStorage.setItem('mem_topic_memory', '{"bypass":true}');
    assert.strictEqual(localStorage.getItem('mem_topic_memory'), topicBeforeViolation,
        '非 TopicMemoryManager 不得写 mem_topic_memory');
}

function testMemoryWriteGuard() {
    const html = fs.readFileSync('./aether.html', 'utf8');
    const helpersStart = html.indexOf('const memoryWriteAuthorization =');
    const helpersEnd = html.indexOf('function writeRuntimeSelfCheck(', helpersStart);
    const classStart = html.indexOf('class MemorySystem {');
    const classEnd = html.indexOf('// 初始化记忆系统', classStart);
    assert(helpersStart >= 0 && helpersEnd > helpersStart, '未找到 memory guard helpers');
    assert(classStart >= 0 && classEnd > classStart, '未找到 MemorySystem');

    const storage = new LocalStorageMock();
    const warnings = [];
    const context = {
        console: {
            log() {}, info() {}, error() {},
            warn(...args) { warnings.push(args); },
        },
        localStorage: storage,
        window: {},
        memoryDebugMode: true,
        STORAGE_KEYS: {
            LONG_TERM: 'mem_long_term', VOLATILE: 'mem_volatile',
            USER_PROFILE: 'memory_user_profile',
            LAST_GOOD_BACKUP: 'last_good_backup', MEMORY_ERROR_LOG: 'memory_error_log',
        },
        debugState: {},
        selectedMemory: null,
        memoryUserProfile: {
            updated_at: null,
            sections: { background_information: [] },
            observed_candidates: [],
        },
        debugLog() {},
        updateMemoryPanel() {}, clearSelectedMemory() {}, showToast() {},
        mergeUserProfileObservation(section, text, messageId, timestamp) {
            context.memoryUserProfile.observed_candidates.push({
                section,
                text,
                source_message_ids: messageId ? [messageId] : [],
                updated_at: timestamp,
            });
        },
        mergeUserProfileItem(section, text, messageId, timestamp) {
            const list = context.memoryUserProfile.sections[section] ||
                (context.memoryUserProfile.sections[section] = []);
            list.push({
                text,
                source_message_ids: messageId ? [messageId] : [],
                updated_at: timestamp,
            });
        },
        saveUserProfile() {
            storage.setItem('memory_user_profile', JSON.stringify(context.memoryUserProfile));
        },
        getBeijingDateParts: () => ({ dateText: '2026-06-19' }),
        countLongTermEntriesFromValue: value => ['expenses', 'preferences', 'aiLearning', 'facts']
            .reduce((sum, key) => sum + ((value && value[key]) || []).length, 0),
        countVolatileEntriesFromValue: value => ['plans', 'temporaryEvents']
            .reduce((sum, key) => sum + ((value && value[key]) || []).length, 0),
        countDefinedBasicInfo: () => 0,
        countArray: value => Array.isArray(value) ? value.length : 0,
        safeJsonParse(raw, fallback) {
            try { return { ok: true, value: JSON.parse(raw) }; }
            catch (error) { return { ok: false, value: fallback, error }; }
        },
        writeLastGoodBackup() {},
        recordMemoryError() {},
        extractMemoryUpdatePayload(value) {
            const match = String(value || '').match(/<!--\s*MEMORY_UPDATE\s*:\s*([\s\S]*?)\s*-->/i);
            return match ? JSON.parse(match[1]) : null;
        },
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(
        html.slice(helpersStart, helpersEnd) + '\n' +
        html.slice(classStart, classEnd) + '\nthis.MemorySystem = MemorySystem;',
        context
    );

    assert.strictEqual(context.classifyMemory({ basicInfo: { name: 'Ada' } }), 'profile');
    assert.strictEqual(context.classifyMemory({ fact: { content: '事实' } }), 'long_term');
    assert.strictEqual(context.classifyMemory({ plan: { content: '计划' } }), 'volatile');
    assert.strictEqual(context.classifyMemory({ topic: { title: '话题' } }), 'topic');
    assert.strictEqual(context.classifyMemory({ preference: { detail: '默认长期' } }), 'unknown');
    const routerScore = context.scoreMemory(
        { fact: { content: '重复事实' } },
        { recentMessages: [{ content: '重复事实' }, { content: '重复事实 again' }] }
    );
    assert.strictEqual(routerScore.recency, 1, 'Router recency 轻量版应固定为 1');
    assert('importance' in routerScore && 'frequency' in routerScore, 'Router score 应包含 importance/frequency');
    assert('confidence' in routerScore && 'value' in routerScore.confidence,
        'Router score 应包含 confidenceScore 对象');
    const onceConfidence = context.confidenceScore(
        { profileCandidate: { text: '我喜欢AI项目' } },
        { repetition: 1 }
    );
    assert(onceConfidence.value >= 0.39 && onceConfidence.value <= 0.5,
        '一次出现的画像候选 confidence 应约为 0.4');
    const repeatedConfidence = context.confidenceScore(
        { profileCandidate: { text: '我每天都在做AI项目' } },
        { repetition: 3 }
    );
    assert(repeatedConfidence.value >= 0.85,
        '三次稳定重复的画像候选 confidence 应达到 0.85');
    const contradictedConfidence = context.confidenceScore(
        { profileCandidate: { text: '我喜欢AI项目' } },
        { repetition: 3, contradictionPenalty: 0.4 }
    );
    assert(contradictedConfidence.value < repeatedConfidence.value,
        '矛盾惩罚应降低 confidence');
    assert.strictEqual(context.routeMemory('profile', routerScore), 'memory_user_profile');
    assert.strictEqual(context.routeMemory('volatile', routerScore), 'mem_volatile');
    assert.strictEqual(context.routeMemory('topic', routerScore), 'mem_topic_memory');
    assert.deepStrictEqual(
        context.memoryRouter({
            type: 'memory_update',
            data: { plan: { content: 'Router 主入口' } },
            context: { recentMessages: [], timestamp: 1 },
        }).target,
        'mem_volatile',
        'memoryRouter 主入口应返回目标存储'
    );
    const promotionEngine = new context.MemoryPromotionEngine();
    assert.strictEqual(promotionEngine.evaluate({
        memory: { type: 'plan', content: '重复计划' },
        score: { frequency: 2, importance: 0.7 },
        historyContext: {},
    }).target, 'mem_long_term', 'Rule 1 应将高频重要 plan 升级到长期记忆');
    assert.strictEqual(promotionEngine.evaluate({
        memory: { type: 'topic', content: '重复话题' },
        score: {},
        historyContext: { repeatedAcrossSessions: 2 },
    }).target, 'profile_candidate', 'Rule 2 应将跨 session 重复 topic 升级为画像候选');
    assert.strictEqual(promotionEngine.evaluate({
        memory: { type: 'profile_candidate', content: '稳定行为' },
        score: {},
        historyContext: {
            confidenceScore: { repetitionWeight: 0.85, consistency: 1, contradictionPenalty: 0, value: 0.85 },
            repetition: 3,
        },
    }).target, 'memory_user_profile', 'Rule 3 应将高置信画像候选确认进画像');
    const goalKernel = new context.GoalKernel();
    const inferredGoal = goalKernel.infer({
        recentMessages: [
            { content: '我想继续做AI项目' },
            { content: '今天还是推进AI助手' },
            { content: '重点是记忆系统 memory router' },
        ],
    });
    assert.strictEqual(inferredGoal.currentGoal.id, 'ai_project_build',
        'GoalKernel 应在重复意图 >= 3 时自动识别 currentGoal');
    assert(inferredGoal.subGoals.some(goal => goal.id === 'memory_system'),
        'GoalKernel 应为 AI 项目补充 memory_system 子目标');
    const oldGoal = goalKernel.currentGoal;
    goalKernel.switchGoal({ id: 'low_priority_goal', priority: 0.1, type: 'short_term_goal', description: '低优先级目标' });
    assert.strictEqual(goalKernel.currentGoal.id, oldGoal.id,
        '低优先级新目标不得切换 currentGoal');
    goalKernel.switchGoal({ id: 'urgent_release', priority: 0.95, type: 'short_term_goal', description: '紧急发布' });
    assert.strictEqual(goalKernel.currentGoal.id, 'urgent_release',
        '高优先级新目标应切换 currentGoal');
    const attentionEngine = new context.MemoryAttentionEngine();
    const attention = attentionEngine.score({
        content: 'AI系统设计',
        relevance: 0.8,
        recency: 0.6,
        frequency: 0.4,
        utility: 1,
    }, { currentText: 'AI系统设计' });
    assert(Math.abs(attention.finalScore - 0.68) < 0.001,
        'Memory Attention finalScore 必须按 0.35/0.25/0.25/0.15 公式计算');
    assert.strictEqual(attentionEngine.score({
        content: '很旧的低价值记忆',
        relevance: 0,
        recency: 0,
        frequency: 0,
        utility: 0,
    }).visible, false, 'finalScore < 0.2 的记忆必须从 prompt 隐藏');
    const nowTs = Date.now();
    const decayed = attentionEngine.score({
        content: '长期不用的记忆',
        relevance: 1,
        recency: 1,
        frequency: 1,
        utility: 1,
        lastUsedAt: nowTs - 10 * 24 * 60 * 60 * 1000,
    }, { timestamp: nowTs });
    assert(decayed.decay >= 0.1 && decayed.finalScore < 1,
        '长期不用的记忆必须按 days_since_last_use * 0.01 衰减');
    const contradicted = attentionEngine.score({
        content: '我是理性、稳定的人',
        relevance: 1,
        recency: 1,
        frequency: 1,
        utility: 1,
    }, { currentState: '最近连续熬夜 + 项目焦虑' });
    assert.strictEqual(contradicted.contradictionPenalty, 0.3,
        '冲突记忆必须优先降权 0.3');
    const goalRelatedAttention = attentionEngine.score({
        content: 'AI助手记忆系统重构',
        relevance: 1,
        recency: 1,
        frequency: 1,
        utility: 1,
    }, { goal: { id: 'ai_project_build', description: '完成个人AI助手系统', priority: 0.9 } });
    const unrelatedAttention = attentionEngine.score({
        content: '烹饪偏好',
        relevance: 1,
        recency: 1,
        frequency: 1,
        utility: 1,
    }, { goal: { id: 'ai_project_build', description: '完成个人AI助手系统', priority: 0.9 } });
    assert(goalRelatedAttention.finalScore > unrelatedAttention.finalScore,
        'Goal-aware Attention 应让目标相关记忆权重更高');
    assert.strictEqual(unrelatedAttention.goalRelevanceScore, 0.2,
        'Goal-aware Attention 对无关记忆应给 0.2 goalRelevanceScore');
    const compressionEngine = new context.MemoryCompressionEngine();
    const compressed = compressionEngine.compress([
        { content: '喜欢AI项目' },
        { content: '经常写代码' },
        { content: '关注系统设计' },
        { content: '最近在做记忆系统' },
        { content: '持续进行工程型项目开发' },
        { content: '偏好AI系统构建' },
    ]);
    assert.strictEqual(compressed.length, 1, 'memoryCount > 5 必须触发压缩');
    assert(compressed[0].summary.includes('AI系统构建'),
        'Compression Layer 应生成语义摘要');
    const synthesisEngine = new context.MemorySynthesisEngine();
    const synthesis = synthesisEngine.synthesize({
        long_term: {
            preferences: [{ category: '思维', detail: 'AI系统结构化思维' }],
            facts: [{ category: '人格', content: '我是理性、稳定的人' }],
        },
        volatile: {
            plans: [{ type: '项目', content: '记忆系统重构' }],
            temporaryEvents: [{ content: '最近连续熬夜 + 项目焦虑' }],
        },
        profile: {
            sections: {
                background_information: [{ text: '喜欢系统设计' }],
                common_patterns: [{ text: '容易沉浸式推进项目' }],
            },
        },
        topic: {
            topics: [{ title: 'AI项目', summary: '正在做AI项目' }],
        },
        recentMessages: [
            { content: '继续AI项目' },
            { content: 'AI助手系统要推进' },
            { content: '记忆系统是当前目标' },
        ],
    });
    assert.strictEqual(synthesis.goal.currentGoal.id, 'ai_project_build',
        'Synthesis 应先经过 GoalKernel 推断当前目标');
    assert(synthesis.now.focus.includes('记忆系统重构'), 'Synthesis NOW STATE 应来自 volatile/topic');
    assert(synthesis.core.traits.some(item => item.includes('喜欢系统设计') || item.includes('AI系统构建')),
        'Synthesis CORE SELF 应包含 confirmed profile 或其压缩摘要');
    assert(synthesis.core.preferences.includes('AI系统结构化思维'),
        'Synthesis CORE SELF 应包含目标相关长期偏好');
    assert(synthesis.modifier.overrides.some(item => item.includes('当前行为优先于长期人格')),
        'Synthesis 冲突解决必须让当前行为覆盖长期人格');
    assert(/class GoalKernel/.test(html) && /class MemorySynthesisEngine/.test(html) &&
        /\[CURRENT GOAL\]/.test(html) && /\[CURRENT STATE\]/.test(html) &&
        /\[CORE IDENTITY\]/.test(html) && /\[ACTIVE OVERRIDES\]/.test(html) &&
        /\[MEMORY FACTS\]/.test(html),
        'Prompt Builder 必须注入 Goal + Synthesis 分层块');

    const manager = new context.MemorySystem();
    context.memorySystem = manager;
    const guardedCalls = [
        () => manager.addPreference('测试', '禁止直写'),
        () => manager.addLongTermFact('测试', '禁止直写'),
        () => manager.addPlan('测试', '禁止直写'),
        () => manager.addTemporaryEvent('禁止直写'),
        () => manager.parseVisibleMemoryUpdate('已存入波动记忆：禁止直写'),
        () => manager.updateMemory({ scope: 'all', content: 'x' }, { content: 'y' }),
        () => manager.removeMemory({ scope: 'all', content: 'x' }),
    ];
    guardedCalls.forEach(call => assert.strictEqual(call(), false, '越权写入必须返回 false'));
    assert.strictEqual(storage.getItem('mem_long_term'), null, '越权调用不得写长期记忆');
    assert.strictEqual(storage.getItem('mem_volatile'), null, '越权调用不得写波动记忆');
    assert(warnings.some(args => args[0] === '[MEMORY VIOLATION]'), '越权调用必须 console.warn');

    storage.setItem('mem_long_term', '{"bypass":true}');
    assert.strictEqual(storage.getItem('mem_long_term'), null, '直接 localStorage 写核心 memory key 必须被拒绝');

    manager._applyMemoryData({ preference: { category: '测试', detail: '唯一入口可写' } }, 'API');
    assert(JSON.parse(storage.getItem('mem_long_term')).preferences.some(item => item.detail === '唯一入口可写'),
        '_applyMemoryData 应是可落盘的唯一入口');
    assert.strictEqual(manager.lastMemoryUpdateRoute.target, 'mem_long_term',
        '_applyMemoryData 前置 router 应返回长期记忆 target');
    manager._applyMemoryData({ fact: { category: '测试', content: '长期事实仍可写' } }, 'API');
    assert(JSON.parse(storage.getItem('mem_long_term')).facts.some(item => item.content === '长期事实仍可写'),
        'API MEMORY_UPDATE 应继续写入长期记忆');
    manager._applyMemoryData({ plan: { type: '测试', content: '波动计划仍可写' } }, 'API');
    assert(JSON.parse(storage.getItem('mem_volatile')).plans.some(item => item.content === '波动计划仍可写'),
        'API MEMORY_UPDATE 应继续写入波动记忆');
    manager._applyMemoryData(
        { plan: { type: '测试', content: '升级计划' } },
        'API',
        { score: { frequency: 2, importance: 0.7 } }
    );
    assert.strictEqual(manager.lastMemoryUpdateRoute.target, 'mem_volatile',
        'V2.1 应先按 Router 写入 volatile memory pool');
    assert.strictEqual(manager.lastMemoryUpdateRoute.promotedFrom, 'mem_volatile',
        'V2.1 Promotion 应记录原始 memory pool');
    assert.strictEqual(manager.lastMemoryUpdateRoute.promotedTo, 'mem_long_term',
        'V2.1 Promotion 应记录升级后的目标类型');
    assert.strictEqual(manager.lastMemoryUpdateRoute.migration.from, 'mem_volatile',
        'Promotion 迁移必须记录来源池');
    assert.strictEqual(manager.lastMemoryUpdateRoute.migration.to, 'mem_long_term',
        'Promotion 迁移必须记录目标池');
    assert.strictEqual(manager.lastMemoryUpdateRoute.migration.memoryId, '升级计划',
        'Promotion 迁移必须使用明确 memoryId');
    assert(manager.lastMemoryUpdateRoute.migration.removed &&
        manager.lastMemoryUpdateRoute.migration.removed.content === '升级计划',
        'migrateMemory 必须先从来源池 remove 对应 memoryId');
    assert(manager.lastMemoryUpdateRoute.migration.added,
        'migrateMemory 必须向目标池 add 对应 memoryId');
    assert(JSON.parse(storage.getItem('mem_long_term')).facts.some(item => item.content.includes('升级计划')),
        'Promotion Rule 1 应将高频重要计划写为长期事实');
    assert(!JSON.parse(storage.getItem('mem_volatile')).plans.some(item => item.content === '升级计划'),
        'Promotion Rule 1 不应再把升级计划写入波动记忆');
    const parsedOnly = manager.parseMemoryUpdate('仅解析<!--MEMORY_UPDATE:{"memoryUpdate":{"plan":{"type":"测试","content":"只解析不写入"}}}-->');
    assert.strictEqual(parsedOnly.data.plan.content, '只解析不写入',
        'parseMemoryUpdate 应先经过 router 并解开兼容 wrapper');
    assert.strictEqual(parsedOnly.target, 'mem_volatile',
        'parseMemoryUpdate 应返回 router 目标但不执行写入');
    assert(!JSON.parse(storage.getItem('mem_volatile') || '{"plans":[]}').plans.some(item => item.content === '只解析不写入'),
        'parseMemoryUpdate 兼容入口不得写入 memory');
    manager._applyMemoryData({ basicInfo: { display_name: 'Router 用户' } }, 'API');
    assert(JSON.parse(storage.getItem('memory_user_profile')).observed_candidates.some(item =>
        item.text.includes('Router 用户')
    ), 'profile 路由应写入 memory_user_profile 候选观察');
    assert(!JSON.parse(storage.getItem('memory_user_profile')).sections.background_information.some(item =>
        item.text.includes('Router 用户')
    ), '规则1：一句 profile 输入不得一步到位写入正式画像');
    assert(!JSON.parse(storage.getItem('mem_long_term')).basicInfo.display_name,
        'profile 路由不得写入 mem_long_term.basicInfo');
    const beforeTopicRoute = storage.getItem('mem_topic_memory');
    const topicRoute = manager._applyMemoryData({ topic: { title: 'Router topic' } }, 'API');
    assert.strictEqual(topicRoute.target, 'mem_topic_memory', 'topic 路由应返回 mem_topic_memory target');
    assert.strictEqual(storage.getItem('mem_topic_memory'), beforeTopicRoute,
        'topic 路由不得直接写 mem_topic_memory');
    const promotedTopicRoute = manager._applyMemoryData(
        { topic: { title: '重复出现的话题' } },
        'API',
        { repeatedAcrossSessions: 2 }
    );
    assert.strictEqual(promotedTopicRoute.promotion.target, 'profile_candidate',
        'Promotion Rule 2 应将重复 topic 升级为 profile candidate');
    assert(JSON.parse(storage.getItem('memory_user_profile')).observed_candidates.some(item =>
        item.text.includes('重复出现的话题')
    ), 'Promotion Rule 2 应写入画像候选观察');
    manager._applyMemoryData(
        { profileCandidate: { text: '单次人格推断不得确认' } },
        'API',
        {
            confidenceScore: { repetitionWeight: 0.85, consistency: 1, contradictionPenalty: 0, value: 0.85 },
            repetition: 1,
        }
    );
    assert(!JSON.parse(storage.getItem('memory_user_profile')).sections.background_information.some(item =>
        item.text.includes('单次人格推断不得确认')
    ), '规则2：高置信但缺少多次证据不得进入正式画像');
    manager._applyMemoryData(
        { profileCandidate: { text: '矛盾证据不得确认' } },
        'API',
        {
            confidenceScore: { repetitionWeight: 0.85, consistency: 1, contradictionPenalty: 0.4, value: 0.45 },
            repetition: 3,
        }
    );
    assert(!JSON.parse(storage.getItem('memory_user_profile')).sections.background_information.some(item =>
        item.text.includes('矛盾证据不得确认')
    ), '规则2：存在明显矛盾惩罚时不得进入正式画像');
    manager._applyMemoryData(
        { profileCandidate: { text: '反复验证的人格特征' } },
        'API',
        {
            confidenceScore: { repetitionWeight: 0.85, consistency: 1, contradictionPenalty: 0, value: 0.85 },
            repetition: 3,
        }
    );
    assert(JSON.parse(storage.getItem('memory_user_profile')).sections.background_information.some(item =>
        item.text.includes('反复验证的人格特征')
    ), 'Promotion Rule 3 应写入正式画像 section');
    manager._applyMemoryData({ shortTerm: [{ content: '旧备份不得复活' }] }, 'UI/import');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(manager, 'shortTerm'), false,
        '导入旧 shortTerm 字段不得恢复短期记忆状态');
    assert.strictEqual(storage.getItem('mem_short_term'), null,
        '导入旧 shortTerm 字段不得恢复短期记忆存储');
    const saved = storage.getItem('mem_long_term');
    assert.strictEqual(manager._saveAll(), false, '直接调用 _saveAll 必须被总闸拒绝');
    assert.strictEqual(storage.getItem('mem_long_term'), saved, '被拒绝的 _saveAll 不得改变存储');

    ['applyLocalSaveIntent', 'applyLocalUpdateIntent', 'applyLocalDeleteIntent'].forEach(name => {
        const start = html.indexOf(`function ${name}(`);
        const end = html.indexOf('\n            function ', start + 1);
        const body = html.slice(start, end > start ? end : start + 2000);
        assert(body.includes('memoryViolation(') && body.includes('memory-write-disabled'),
            `${name} 必须 warn 并 reject`);
    });
    assert(!/memorySystem\.(?:longTerm|volatile)[^\n]*\.(?:push|splice)\(/.test(html),
        'UI/导入代码不得直接修改 memory 数组');
    assert(!/\b(?:addShortTerm|removeShortTerm|MAX_SHORT_TERM_ENTRIES)\b/.test(html),
        '短期记忆运行时 API 必须完全移除');
    assert(!/SHORT_TERM\s*:\s*['"]mem_short_term['"]/.test(html),
        'mem_short_term 不得继续作为活动存储键');
    assert(html.includes("localStorage.removeItem(LEGACY_SHORT_TERM_STORAGE_KEY)"),
        '启动时必须清理旧 mem_short_term 存储');
    assert(!/"shortTerm"\s*:|\bmemData\.shortTerm\b|\bremoveShortTerm\b/.test(html),
        '模型协议与导入链路不得继续接受短期记忆字段');
    assert(!/\b(?:topicCards|createGuardedTopicCards|normalizeTopicCard|mergeImportedTopicCards|rebuildTopicCardsFromHistory)\b/.test(html),
        '旧话题卡片运行时、导入和调试接口必须完全移除');
    assert(!/id=["']memTopics["']|话题卡片/.test(html),
        '旧话题卡片面板和文案必须完全移除');
    assert(/new window\.TopicMemoryManager\(/.test(html) && /topicMemoryManager\.getState\(\)/.test(html),
        '近期话题索引必须继续由 TopicMemoryManager 提供');
    assert(!/\b(?:class StateEngine|stateEngine|getStateEngine|refreshStateEngine|renderStateEnginePanel)\b/.test(html),
        '持久化状态引擎运行时、面板与调试接口必须完全移除');
    assert(!/MEMORY_UPDATE[^\n]*stateEngine|persistentGoal|stateTransitions|trajectoryWarning/.test(html),
        '模型提示词与协议不得继续要求状态引擎字段');
    assert(html.includes("localStorage.removeItem(LEGACY_STATE_ENGINE_STORAGE_KEY)"),
        '启动时必须清理旧 mem_state_engine 存储');
    assert(/\bactiveFocus\b/.test(html) && /function setActiveFocus\(/.test(html),
        '仅用于运行阶段显示的 activeFocus 必须保留');
}

function testHistoryOverflowProfile() {
    const html = fs.readFileSync('./aether.html', 'utf8');
    const start = html.indexOf('function compactConversationHistory()');
    const end = html.indexOf('function buildApiConversationMessages()', start);
    assert(start >= 0 && end > start, '未找到历史压缩实现');
    const code = html.slice(start, end);
    const storage = new LocalStorageMock();
    const sections = {
        long_term_preferences: '长期偏好', project_goals: '项目目标', common_patterns: '常见问题/行为模式',
        ai_project_status: '当前AI助手项目状态', background_information: '不希望重复解释的背景',
    };
    const context = {
        console,
        localStorage: storage,
        MAX_STORED_CHAT_MESSAGES: 120,
        USER_PROFILE_SECTIONS: sections,
        memoryUserProfile: {
            version: 1,
            updated_at: null,
            manual_basic: {},
            sections: Object.fromEntries(Object.keys(sections).map(k => [k, []])),
            observed_candidates: [],
            uncategorized_candidates: [],
        },
        memorySystem: { _similarity: (a, b) => a === b ? 1 : 0 },
        topicMemoryManager: { applyFallbackTopics() {} },
        conversationHistory: Array.from({ length: 125 }, (_, i) => ({
            id: 'm' + i,
            role: i % 2 ? 'assistant' : 'user',
            content: i === 0 ? '我的项目目标是修复 AI 助手记忆系统，请记住这个背景' : '消息 ' + i,
            timestamp: i + 1,
        })),
        conversationSummary: '',
        messageSnippetForSummary: msg => msg.content,
        mergeConversationSummaryLines: (a, b) => a.concat(b),
        saveUserProfile() { storage.setItem('memory_user_profile', JSON.stringify(context.memoryUserProfile)); },
        recordMemoryError(type, error) { throw new Error(type + ': ' + error); },
    };
    vm.createContext(context);
    vm.runInContext(code + '\ncompactConversationHistory();', context);
    assert.strictEqual(context.conversationHistory.length, 120, '聊天缓存仍应保持 120 条窗口');
    const profile = JSON.parse(storage.getItem('memory_user_profile'));
    assert(!profile.sections.project_goals.some(item => item.text.includes('项目目标')), '早期项目目标不应直接进入正式画像');
    assert(!profile.sections.background_information.some(item => item.text.includes('请记住')), '背景信息不应直接进入正式画像');
    assert(profile.observed_candidates.some(item =>
        item.section === 'project_goals' && item.text.includes('项目目标')
    ), '早期项目目标应进入低可信观察候选池');
    assert(profile.observed_candidates.some(item =>
        item.section === 'background_information' && item.text.includes('请记住')
    ), '不重复解释的背景应进入低可信观察候选池');
}

(async () => {
    await testTopicIndex();
    testMemoryWriteGuard();
    testHistoryOverflowProfile();
    console.log('Memory V2 tests passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
