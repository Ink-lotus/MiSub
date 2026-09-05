import { groupNodeLinesByRegion } from './region-groups.js';
import { AI_SERVICE_RULES, DEFAULT_SELECT_GROUP, DEFAULT_RELAY_GROUP } from './builtin-rules-provider.js';
import { DNS_PROXY_GROUP } from './safe-dns.js';

/**
 * 解析并扩展策略组中的正则过滤器
 * @param {Object} model - 统一模板模型
 */
function resolveGroupFilters(model) {
    const proxyNames = model.proxies.map(p => p.name || p.tag).filter(Boolean);
    if (proxyNames.length === 0) return;

    model.groups.forEach(group => {
        if (!Array.isArray(group.filters) || group.filters.length === 0) return;

        group.members = group.members || [];
        const currentMembers = new Set(group.members);

        group.filters.forEach(filter => {
            if (filter === '.*') {
                proxyNames.forEach(name => currentMembers.add(name));
                return;
            }

            try {
                const regex = new RegExp(filter, 'i');
                proxyNames.forEach(name => {
                    if (regex.test(name)) {
                        currentMembers.add(name);
                    }
                });
            } catch (e) {
                console.warn(`[Template Processor] Invalid regex filter: ${filter}`, e);
            }
        });

        group.members = Array.from(currentMembers);
    });
}

/**
 * 递归修剪所有成员为空的策略组，并清理相关引用
 * @param {Object} model - 统一模板模型
 */
function pruneEmptyGroups(model) {
    let changed = true;
    while (changed) {
        changed = false;
        const emptyGroupNames = new Set(
            model.groups
                .filter(g => (!Array.isArray(g.members) || g.members.length === 0))
                .map(g => g.name)
        );

        if (emptyGroupNames.size === 0) break;

        // 1. 移除空组本身
        const initialCount = model.groups.length;
        model.groups = model.groups.filter(g => !emptyGroupNames.has(g.name));
        if (model.groups.length !== initialCount) changed = true;

        // 2. 从其它组的成员列表中移除对空组的引用
        model.groups.forEach(group => {
            if (Array.isArray(group.members)) {
                const newMembers = group.members.filter(m => !emptyGroupNames.has(m));
                if (newMembers.length !== group.members.length) {
                    group.members = newMembers;
                    changed = true;
                }
            }
        });

        // 3. 从规则列表中移除指向空组的规则
        const initialRuleCount = model.rules.length;
        model.rules = model.rules.filter(rule => !emptyGroupNames.has(rule.policy));
        if (model.rules.length !== initialRuleCount) changed = true;
    }
}

function normalizeGroupSemanticName(name = '') {
    return String(name)
        .replace(/^[^\u4e00-\u9fa5A-Za-z0-9]+/, '')
        .replace(/[\s_-]+/g, '')
        .replace(/节点/g, '')
        .toLowerCase();
}

function hasEquivalentRegionGroup(model, region) {
    const regionTags = new Set(region.tags || []);
    const normalizedRegionName = normalizeGroupSemanticName(region.name);

    return model.groups.some(group => {
        const normalizedGroupName = normalizeGroupSemanticName(group.name);
        if (normalizedGroupName === normalizedRegionName) return true;

        const members = Array.isArray(group.members) ? group.members : [];
        if (members.length === 0) return false;

        const overlapCount = members.filter(member => regionTags.has(member)).length;
        return overlapCount > 0 && overlapCount === members.length && overlapCount === regionTags.size;
    });
}

function dedupeGroupsByName(model) {
    const mergedGroups = [];
    const seen = new Map();

    model.groups.forEach(group => {
        const name = String(group.name || '').trim();
        if (!name) return;

        if (!seen.has(name)) {
            const normalized = {
                ...group,
                name,
                members: Array.isArray(group.members) ? Array.from(new Set(group.members.filter(Boolean))) : [],
                filters: Array.isArray(group.filters) ? Array.from(new Set(group.filters.filter(Boolean))) : [],
                options: typeof group.options === 'object' && group.options !== null ? { ...group.options } : {}
            };
            seen.set(name, normalized);
            mergedGroups.push(normalized);
            return;
        }

        const existing = seen.get(name);
        existing.members = Array.from(new Set([...(existing.members || []), ...((group.members || []).filter(Boolean))]));
        existing.filters = Array.from(new Set([...(existing.filters || []), ...((group.filters || []).filter(Boolean))]));
        existing.options = {
            ...(existing.options || {}),
            ...((typeof group.options === 'object' && group.options !== null) ? group.options : {})
        };

        if ((!existing.type || existing.type === 'select') && group.type) {
            existing.type = group.type;
        }
    });

    model.groups = mergedGroups;
}

/**
 * 展开魔法占位符（如 <%regionStrategyChain%>）
 * @param {Object} model - 统一模板模型
 */
function expandMagicPlaceholders(model) {
    const regionNames = Array.from(new Set(
        model.groups
            .filter(g => g.type === 'url-test' && !g.name.includes('自动'))
            .map(g => g.name)
    ));
    
    // 获取协议分组（如果存在）
    const protocolNames = Array.from(new Set(
        model.groups
            .filter(g => g.name.includes('节点') && !regionNames.includes(g.name))
            .map(g => g.name)
    ));

    model.groups.forEach(group => {
        if (!Array.isArray(group.members)) return;

        const newMembers = [];
        group.members.forEach(member => {
            if (member === '<%regionStrategyChain%>') {
                newMembers.push(...regionNames);
            } else if (member === '<%protocolStrategyChain%>') {
                newMembers.push(...protocolNames);
            } else {
                newMembers.push(member);
            }
        });
        group.members = newMembers;
    });
}

/**
 * 清理策略组中指向空组或不存在节点的无效引用
 * @param {Object} model - 统一模板模型
 */
function pruneInvalidMembers(model) {
    const validTargetNames = new Set([
        ...model.proxies.map(p => p.name || p.tag),
        ...model.groups.map(g => g.name),
        'DIRECT', 'REJECT'
    ]);

    model.groups.forEach(group => {
        if (Array.isArray(group.members)) {
            group.members = group.members.filter(m => validTargetNames.has(m));
        }
    });
}

function ensureDnsProxyGroup(model) {
    if (model.groups.some(group => group.name === DNS_PROXY_GROUP)) return;
    const proxyNames = model.proxies.map(proxy => proxy.name || proxy.tag).filter(Boolean);
    model.groups.push({
        name: DNS_PROXY_GROUP,
        type: 'url-test',
        members: proxyNames.length > 0 ? proxyNames : ['REJECT'],
        filters: [],
        options: {
            url: 'http://www.gstatic.com/generate_204',
            interval: 300,
            tolerance: 50
        }
    });
}

/**
 * 决定「DNS 走代理」时把外部解析器绑到哪个策略组。
 *
 * 两种形态，由 cardDerivedGroups 区分：
 *
 * **策略组由卡片派生**（可视化规则生成器产出的规则模板）：复用模型里已有的
 * 入口组，不插专用的 `🌐 DNS 出口`。三条理由：
 *   1. 生成器的策略组全部由卡片派生，凭空多一个组会让预览与实际产物不一致
 *      （实测生成器自报 9 组、产物 10 组）
 *   2. INI 模板格式没有 `hidden` 字段的位置，那个专用组在客户端里是**可见的**
 *      （内置生成器那条路才带 hidden）。mihomo 的 hidden 本身也只是 api 状态位、
 *      需要面板适配，sing-box 更是完全没有这个字段
 *   3. 复用入口组后 DNS 跟着流量走：用户把出口切到 DIRECT 时 DNS 也直连，
 *      不会出现「流量直连而 DNS 仍走代理」的错位
 *
 * **其余形态**（内置模板、用户手写的远程 INI）：照上游插专用组。那些路径没有
 * 卡片、不涉及上述不变量，凭空改上游行为无益，且没有可靠的复用目标 ——
 * 「取第一个组」可能撞上 `🛑 广告拦截`（成员首位是 REJECT），DNS 会被直接拒掉。
 *
 * 卡片派生但确实找不到入口组时（在高级模式手写、把 `🚀 节点选择` 删掉了）
 * 同样退回专用组：宁可多一个可见的组，也不能让 DNS 引用不存在的组。
 */
const DNS_DETOUR_PREFERENCE = [DEFAULT_SELECT_GROUP, DEFAULT_RELAY_GROUP];

function resolveDnsProxyGroup(model, cardDerivedGroups) {
    if (cardDerivedGroups) {
        const names = new Set((model.groups || []).map(group => group?.name).filter(Boolean));
        const reused = DNS_DETOUR_PREFERENCE.find(name => names.has(name));
        if (reused) return { target: reused, needsDedicatedGroup: false };
    }
    return { target: DNS_PROXY_GROUP, needsDedicatedGroup: true };
}

function isAiGroupName(name) {
    const value = String(name || '');
    return /人工智能|智能\s*ai|(?:^|[^a-z])(ai|claude|openai|gemini|grok|mistral|deepseek|perplexity|copilot)(?=$|[^a-z])/i.test(value);
}

function proxyOnlyMembers(members) {
    return Array.from(new Set((Array.isArray(members) ? members : []).filter(member =>
        !['DIRECT', 'REJECT-DROP', 'PASS'].includes(String(member).toUpperCase())
    )));
}

function ensureAiPolicy(model) {
    const aiGroups = model.groups.filter(group => isAiGroupName(group.name));
    const mainGroup = model.groups.find(group => !isAiGroupName(group.name) && /选择|proxy|default|global|main/i.test(group.name));
    const fallbackMembers = proxyOnlyMembers(mainGroup?.members);
    const preferredMembers = proxyOnlyMembers(aiGroups[0]?.members);
    const nodeMembers = model.proxies.map(proxy => proxy.name || proxy.tag).filter(Boolean);
    const aiMembers = Array.from(new Set([
        ...(preferredMembers.length > 0 ? preferredMembers : fallbackMembers),
        ...(preferredMembers.length > 0 || fallbackMembers.length > 0 ? [] : nodeMembers)
    ]));
    const nodeCandidates = aiMembers.length > 0 ? aiMembers : ['REJECT'];

    aiGroups.forEach(group => {
        group.members = proxyOnlyMembers(group.members);
        if (group.members.length === 0) group.members = ['REJECT'];
    });

    const existingNames = new Set(model.groups.map(group => group.name));
    if (!existingNames.has('🤖 AI 自动')) {
        model.groups.push({
            name: '🤖 AI 自动',
            type: 'url-test',
            members: nodeCandidates,
            filters: [],
            options: { url: 'http://www.gstatic.com/generate_204', interval: 300, tolerance: 50 }
        });
        existingNames.add('🤖 AI 自动');
    }
    if (!existingNames.has('🤖 AI 故障转移')) {
        model.groups.push({
            name: '🤖 AI 故障转移',
            type: 'fallback',
            members: nodeCandidates,
            filters: [],
            options: { url: 'http://www.gstatic.com/generate_204', interval: 300, tolerance: 50 }
        });
        existingNames.add('🤖 AI 故障转移');
    }
    if (!existingNames.has('🤖 智能 AI')) {
        model.groups.push({
            name: '🤖 智能 AI',
            type: 'select',
            members: ['🤖 AI 自动', '🤖 AI 故障转移']
        });
        existingNames.add('🤖 智能 AI');
    }
    AI_SERVICE_RULES.forEach(service => {
        const groupName = `🤖 ${service.name}`;
        if (!existingNames.has(groupName)) {
            model.groups.push({
                name: groupName,
                type: 'select',
                members: ['🤖 AI 自动', '🤖 AI 故障转移'],
                filters: [],
                options: {}
            });
            existingNames.add(groupName);
        }
    });

    const existingRules = new Set(model.rules.map(rule => `${rule.type}|${rule.value}|${rule.policy}`));
    const aiRules = [];
    AI_SERVICE_RULES.forEach(service => service.domains.forEach(domain => {
        const rule = {
            type: 'domain-suffix',
            value: domain,
            policy: `🤖 ${service.name}`,
            source: 'inline',
            extras: []
        };
        const key = `${rule.type}|${rule.value}|${rule.policy}`;
        if (!existingRules.has(key)) aiRules.push(rule);
    }));
    // 保留模板作者已有的精确规则优先级；新服务规则只补缺失项。
    model.rules = [...model.rules, ...aiRules];
}

/**
 * 模板模型智能优化器（主入口）
 * 包含：自动解析过滤器、注入地区组、展开占位符、清理无效引用及空组
 * @param {Object} model - 统一模板模型
 * @param {Object} [options]
 * @param {boolean} [options.dnsBindable=true] - 目标格式的 DNS 配置位能否绑策略组。
 *        clash / sing-box 可以；surge / loon / quanx / egern 不行，传 false 以免注入死组。
 * @param {boolean} [options.cardDerivedGroups=false] - 该模型的策略组是否由可视化
 *        规则生成器的卡片派生。为 true 时 DNS 复用已有入口组而不插专用组，
 *        见 resolveDnsProxyGroup。
 */
export function applySmartModelOptimizations(model, { dnsBindable = true, cardDerivedGroups = false } = {}) {
    const { ruleLevel } = model.meta || {};
    const normalizedLevel = (ruleLevel || '').toLowerCase();
    const isCustomOrNone = !normalizedLevel || normalizedLevel === 'none';

    // 1. 执行现有的正则过滤器解析 (始终执行)
    resolveGroupFilters(model);

    // 2. DNS 绑定目标：三个条件全满足才绑，否则合成的 DNS 不带 #组名 后缀
    //   - dnsBindable：目标格式的 DNS 配置位能绑策略组（clash 的 #组名 / sing-box 的 detour）。
    //     surge / loon / quanx 没有这种写法，由 template-pipeline 传 false
    //   - dnsThroughProxy：用户的「DNS 走代理」开关
    //   - 未用自定义 DNS：用户自己写的 DNS 块未必引用任何组
    //
    // 决定结果写进 model.settings.dnsProxyGroup，渲染器只读不再自行判断，
    // 保证「组是否存在」与「DNS 是否引用它」出自同一处。
    const dnsThroughProxy = model.settings?.dnsThroughProxy !== false;
    const hasCustomDns = Boolean(model.settings?.customDnsOverride && String(model.settings.customDnsOverride).trim());
    if (dnsBindable && dnsThroughProxy && !hasCustomDns) {
        const { target, needsDedicatedGroup } = resolveDnsProxyGroup(model, cardDerivedGroups);
        model.settings.dnsProxyGroup = target;
        // 只有拿不到可复用入口组时才插专用组，见 resolveDnsProxyGroup 的注释
        if (needsDedicatedGroup) ensureDnsProxyGroup(model);
    } else {
        model.settings.dnsProxyGroup = '';
    }

    // 3. AI 服务分组与分流规则注入：
    // 仅在非纯自定义模板模式（启用内置分流）下才注入
    if (!isCustomOrNone) {
        ensureAiPolicy(model);
    }

    // 4. 检查等级。如果是 none (完全禁用)，我们只执行占位符展开和清理，不进行智能注入。
    if (!isCustomOrNone && normalizedLevel !== 'base') {
        // 3. 准备获取所有节点的名称，用于后续注入
        const proxyNames = model.proxies.map(p => p.name || p.tag).filter(Boolean);
        if (proxyNames.length > 0) {
            // 4. 识别地区分组并注入
            const nodeEntries = proxyNames.map(name => ({ tag: name }));
            const regions = groupNodeLinesByRegion(nodeEntries);
            
            // 注入地区自动选优组
            regions.forEach(region => {
                if (hasEquivalentRegionGroup(model, region)) return;
                model.groups.push({
                    name: region.name,
                    type: 'url-test',
                    members: region.tags,
                    options: {
                        url: 'http://www.gstatic.com/generate_204',
                        interval: '300',
                        tolerance: '50'
                    }
                });
            });
        }
    }

    // 5. 展开魔法占位符 (始终执行，确保模板标签被替换)
    expandMagicPlaceholders(model);

    // 6. 只有在非精简模式下才执行主选择器兜底注入
    if (normalizedLevel !== 'none' && normalizedLevel !== 'base' && normalizedLevel) {
        const mainGroupCandidates = model.groups.filter(g => 
            /选择|Proxy|Default|Global|Main|select/i.test(g.name)
        );
        if (mainGroupCandidates.length > 0) {
            const targetGroup = mainGroupCandidates[0];
            // 如果该组还没有任何成员，注入所有可用的组
            if (targetGroup.members.length === 0) {
                const availableGroups = model.groups
                    .filter(g => g.name !== targetGroup.name && (g.type === 'url-test' || g.type === 'fallback'))
                    .map(g => g.name);
                targetGroup.members.push(...availableGroups);
            }
        }
    }

    // 7. 最后进行全局修剪与去重 (始终执行，保证输出质量)
    dedupeGroupsByName(model);
    pruneInvalidMembers(model); 
    pruneEmptyGroups(model);

    return model;
}
