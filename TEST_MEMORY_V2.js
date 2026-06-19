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
            SHORT_TERM: 'mem_short_term', LONG_TERM: 'mem_long_term', VOLATILE: 'mem_volatile',
            LAST_GOOD_BACKUP: 'last_good_backup', MEMORY_ERROR_LOG: 'memory_error_log',
        },
        MAX_SHORT_TERM_ENTRIES: 50,
        debugState: {},
        selectedMemory: null,
        debugLog() {},
        updateMemoryPanel() {}, clearSelectedMemory() {}, showToast() {},
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
        extractMemoryUpdatePayload: value => value,
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(
        html.slice(helpersStart, helpersEnd) + '\n' +
        html.slice(classStart, classEnd) + '\nthis.MemorySystem = MemorySystem;',
        context
    );

    const manager = new context.MemorySystem();
    context.memorySystem = manager;
    const guardedCalls = [
        () => manager.addShortTerm('禁止直写'),
        () => manager.addPreference('测试', '禁止直写'),
        () => manager.addLongTermFact('测试', '禁止直写'),
        () => manager.addPlan('测试', '禁止直写'),
        () => manager.addTemporaryEvent('禁止直写'),
        () => manager.updateMemory({ scope: 'all', content: 'x' }, { content: 'y' }),
        () => manager.removeMemory({ scope: 'all', content: 'x' }),
    ];
    guardedCalls.forEach(call => assert.strictEqual(call(), false, '越权写入必须返回 false'));
    assert.strictEqual(storage.getItem('mem_short_term'), null, '越权调用不得写短期记忆');
    assert.strictEqual(storage.getItem('mem_long_term'), null, '越权调用不得写长期记忆');
    assert.strictEqual(storage.getItem('mem_volatile'), null, '越权调用不得写波动记忆');
    assert(warnings.some(args => args[0] === '[MEMORY VIOLATION]'), '越权调用必须 console.warn');

    storage.setItem('mem_long_term', '{"bypass":true}');
    assert.strictEqual(storage.getItem('mem_long_term'), null, '直接 localStorage 写核心 memory key 必须被拒绝');

    const guardedTopics = context.createGuardedTopicCards([]);
    assert.strictEqual(guardedTopics.push({ id: 'forbidden' }), 0, 'topicCards.push 必须被拒绝');
    assert.strictEqual(guardedTopics.length, 0, 'topicCards.push 不得改变数组');

    manager._applyMemoryData({ preference: { category: '测试', detail: '唯一入口可写' } }, 'API');
    assert(JSON.parse(storage.getItem('mem_long_term')).preferences.some(item => item.detail === '唯一入口可写'),
        '_applyMemoryData 应是可落盘的唯一入口');
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
    assert(!/memorySystem\.(?:shortTerm|longTerm|volatile)[^\n]*\.(?:push|splice)\(/.test(html),
        'UI/导入代码不得直接修改 memory 数组');
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
        memoryUserProfile: { version: 1, updated_at: null, sections: Object.fromEntries(Object.keys(sections).map(k => [k, []])) },
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
    assert(profile.sections.project_goals.some(item => item.text.includes('项目目标')), '早期项目目标应进入用户画像');
    assert(profile.sections.background_information.some(item => item.text.includes('请记住')), '不重复解释的背景应进入用户画像');
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
