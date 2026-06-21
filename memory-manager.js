const fs = require('fs');
const path = require('path');

// 配置
const MEMORY_DIR = './memory_backups'; // 记忆备份目录
const MAX_BACKUPS = 30; // 最多保留的备份文件数

// 确保目录存在
function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

// 获取所有记忆备份文件
function getMemoryFiles(dir) {
    ensureDir(dir);
    return fs.readdirSync(dir)
        .filter(file => (file.startsWith('ai-backup-') || file.startsWith('ai-memory-backup-')) && file.endsWith('.json'))
        .sort((a, b) => fs.statSync(path.join(dir, b)).mtime.getTime() - fs.statSync(path.join(dir, a)).mtime.getTime());
}

// 读取单个记忆文件
function readMemoryFile(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(content);
    } catch (err) {
        console.error(`读取文件失败: ${filePath}`, err.message);
        return null;
    }
}

// 合并多个记忆文件
function mergeMemoryFiles(files) {
    const merged = {
        longTerm: { expenses: [], preferences: [], basicInfo: { age: null, job: null, pets: [], tools: [] }, aiLearning: [], facts: [] },
        volatile: { plans: [], temporaryEvents: [] },
        chatHistory: [],
        mergedFrom: files.length,
        mergedAt: new Date().toISOString(),
    };

    const seenLongTerm = new Set();
    const seenVolatile = new Set();
    const seenChat = new Set();

    files.forEach(file => {
        const data = readMemoryFile(path.join(MEMORY_DIR, file));
        if (!data) return;

        // 合并聊天历史
        (data.chatHistory || []).forEach(msg => {
            if (msg.role && msg.content) {
                const key = (msg.timestamp || '') + '-' + msg.role + '-' + msg.content;
                if (!seenChat.has(key)) {
                    seenChat.add(key);
                    merged.chatHistory.push(msg);
                }
            }
        });

        // 合并长期记忆
        (data.longTerm?.expenses || []).forEach(item => {
            const key = JSON.stringify(item);
            if (!seenLongTerm.has(key)) {
                seenLongTerm.add(key);
                merged.longTerm.expenses.push(item);
            }
        });
        (data.longTerm?.preferences || []).forEach(item => {
            const key = JSON.stringify(item);
            if (!seenLongTerm.has(key)) {
                seenLongTerm.add(key);
                merged.longTerm.preferences.push(item);
            }
        });
        (data.longTerm?.aiLearning || []).forEach(item => {
            const key = JSON.stringify(item);
            if (!seenLongTerm.has(key)) {
                seenLongTerm.add(key);
                merged.longTerm.aiLearning.push(item);
            }
        });
        (data.longTerm?.facts || []).forEach(item => {
            const key = JSON.stringify(item);
            if (!seenLongTerm.has(key)) {
                seenLongTerm.add(key);
                merged.longTerm.facts.push(item);
            }
        });
        // 更新基本信息（标量取最新，数组去重合并）
        if (data.longTerm?.basicInfo) {
            Object.entries(data.longTerm.basicInfo).forEach(([key, value]) => {
                if (Array.isArray(value)) {
                    if (!Array.isArray(merged.longTerm.basicInfo[key])) {
                        merged.longTerm.basicInfo[key] = [];
                    }
                    value.forEach(item => {
                        const itemKey = JSON.stringify(item);
                        const exists = merged.longTerm.basicInfo[key].some(existing =>
                            JSON.stringify(existing) === itemKey
                        );
                        if (!exists) merged.longTerm.basicInfo[key].push(item);
                    });
                } else if (value !== null && value !== undefined && value !== '') {
                    merged.longTerm.basicInfo[key] = value;
                }
            });
        }

        // 合并临时记忆
        (data.volatile?.plans || []).forEach(item => {
            const key = JSON.stringify(item);
            if (!seenVolatile.has(key)) {
                seenVolatile.add(key);
                merged.volatile.plans.push(item);
            }
        });
        (data.volatile?.temporaryEvents || []).forEach(item => {
            const key = JSON.stringify(item);
            if (!seenVolatile.has(key)) {
                seenVolatile.add(key);
                merged.volatile.temporaryEvents.push(item);
            }
        });
    });

    // 按时间排序
    merged.chatHistory.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    merged.longTerm.expenses.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    merged.longTerm.preferences.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    merged.longTerm.aiLearning.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    merged.longTerm.facts.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    merged.volatile.plans.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    merged.volatile.temporaryEvents.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    return merged;
}

// 清理旧备份
function cleanupOldBackups(files, maxKeep = MAX_BACKUPS) {
    if (files.length <= maxKeep) return [];
    
    const toDelete = files.slice(maxKeep);
    toDelete.forEach(file => {
        fs.unlinkSync(path.join(MEMORY_DIR, file));
        console.log(`已删除旧备份: ${file}`);
    });
    
    return toDelete;
}

// 显示统计信息
function showStats(data) {
    console.log('\n📊 记忆统计:');
    console.log(`  ├── 对话历史: ${data.chatHistory ? data.chatHistory.length : 0} 条`);
    console.log(`  ├── 长期记忆:`);
    console.log(`  │   ├── 支出记录: ${data.longTerm.expenses.length} 条`);
    console.log(`  │   ├── 偏好设置: ${data.longTerm.preferences.length} 条`);
    console.log(`  │   ├── 学习记录: ${data.longTerm.aiLearning.length} 条`);
    console.log(`  │   ├── 长期事实: ${(data.longTerm.facts || []).length} 条`);
    console.log(`  │   └── 基本信息: ${[
        data.longTerm.basicInfo.age,
        data.longTerm.basicInfo.job,
        ...(data.longTerm.basicInfo.pets || []),
        ...(data.longTerm.basicInfo.tools || []),
    ].filter(v => v != null && v !== '').length} 项`);
    console.log(`  └── 临时记忆:`);
    console.log(`      ├── 计划: ${data.volatile.plans.length} 条`);
    console.log(`      └── 临时事件: ${data.volatile.temporaryEvents.length} 条`);
}

// 主函数
function main() {
    const args = process.argv.slice(2);
    const command = args[0] || 'help';

    switch (command) {
        case 'merge': {
            const files = getMemoryFiles(MEMORY_DIR);
            if (files.length === 0) {
                console.log('❌ 没有找到记忆备份文件');
                return;
            }
            
            console.log(`📥 正在合并 ${files.length} 个记忆文件...`);
            const merged = mergeMemoryFiles(files);
            
            const now = new Date();
            const yyyy = now.getFullYear();
            const MM = String(now.getMonth() + 1).padStart(2, '0');
            const dd = String(now.getDate()).padStart(2, '0');
            const hh = String(now.getHours()).padStart(2, '0');
            const mm = String(now.getMinutes()).padStart(2, '0');
            const ss = String(now.getSeconds()).padStart(2, '0');
            const outputFile = path.join(MEMORY_DIR, `ai-backup-${yyyy}${MM}${dd}-${hh}${mm}${ss}.json`);
            fs.writeFileSync(outputFile, JSON.stringify(merged, null, 2));
            console.log(`✅ 合并完成！已保存到: ${outputFile}`);
            showStats(merged);
            break;
        }
        
        case 'cleanup': {
            const files = getMemoryFiles(MEMORY_DIR);
            if (files.length === 0) {
                console.log('❌ 没有找到记忆备份文件');
                return;
            }
            
            console.log(`📁 当前有 ${files.length} 个备份文件`);
            const deleted = cleanupOldBackups(files, MAX_BACKUPS);
            console.log(`✅ 清理完成！删除了 ${deleted.length} 个旧备份`);
            break;
        }
        
        case 'stats': {
            const files = getMemoryFiles(MEMORY_DIR);
            if (files.length === 0) {
                console.log('❌ 没有找到记忆备份文件');
                return;
            }
            
            console.log(`📊 读取最新的记忆文件...`);
            const latest = readMemoryFile(path.join(MEMORY_DIR, files[0]));
            if (latest) {
                showStats(latest);
            }
            break;
        }
        
        case 'list': {
            const files = getMemoryFiles(MEMORY_DIR);
            if (files.length === 0) {
                console.log('❌ 没有找到记忆备份文件');
                return;
            }
            
            console.log(`📋 备份文件列表 (共 ${files.length} 个):`);
            files.forEach((file, index) => {
                const stats = fs.statSync(path.join(MEMORY_DIR, file));
                const size = (stats.size / 1024).toFixed(2);
                const time = stats.mtime.toLocaleString('zh-CN');
                console.log(`  ${index + 1}. ${file} (${size} KB, ${time})`);
            });
            break;
        }
        
        case 'help':
        default: {
            console.log(`
🤖 AI记忆管理器

用法: node memory-manager.js <命令>

命令:
  merge    - 合并所有记忆备份文件到一个新文件
  cleanup  - 清理旧备份（保留最近${MAX_BACKUPS}个）
  stats    - 显示最新记忆文件的统计信息
  list     - 列出所有备份文件
  help     - 显示此帮助信息

说明:
  - 记忆文件应放在 ${MEMORY_DIR} 目录下
  - 支持的文件格式: ai-backup-*.json, ai-memory-backup-*.json
  - 合并时会自动去重并按时间排序
            `);
            break;
        }
    }
}

main();
