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

    const manager = new global.TopicMemoryManager({
        debounceMs: 0,
        hasApiKey: () => true,
        isBusy: () => false,
        callApi: async () => '{"topics":[{"topic_id":"broken" "title":"缺逗号"}]}',
    });
    const messages = [
        { id: 'm1', role: 'user', content: '请修复记忆系统 JSON 报错', timestamp: 1 },
        { id: 'm2', role: 'assistant', content: '正在修复', timestamp: 2 },
    ];
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
    testHistoryOverflowProfile();
    console.log('Memory V2 tests passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
