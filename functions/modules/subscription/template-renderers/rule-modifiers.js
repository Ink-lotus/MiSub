/**
 * 规则修饰符透传 —— 四个文本类渲染器共用。
 *
 * `ini-template-parser.js:82` 已经把 `ruleset=策略,[]TYPE,值,no-resolve` 里
 * 值之后的所有段收进 `rule.extras`，但 render-clash / surge / loon / quanx 的
 * 规则拼装原先只输出 `type/value/policy`，修饰符到这一步被静默丢弃。
 *
 * 为什么要透传：`GEOIP,CN,策略` 不带 `no-resolve` 时，凡是走到这条规则的
 * 连接都得先做一次真实 DNS 解析才能判定归属地。在 `enhanced-mode: fake-ip`
 * 下这既是每条兜底流量的延迟成本，也是一处 DNS 泄漏面。上游
 * ACL4SSR / subconverter 一律写 `GEOIP,CN,DIRECT,no-resolve`。
 *
 * 两条刻意的约束：
 *
 *   1. **白名单**，不是把 extras 整段拼回去。`parseAclRuleSetLine` 会把值
 *      之后的所有内容都塞进 extras，无脑拼接会把用户手写的垃圾也带进配置。
 *   2. **按规则类型 gate**。`no-resolve` 挂在域名类规则上是非法语法，
 *      部分客户端会因此拒绝加载整份配置，因此见到 extras 也不能照拼。
 *
 * 不覆盖 sing-box 与 egern：sing-box 没有逐条修饰符的概念，等价行为由
 * DNS strategy 与 `route.rules` 控制；egern 的对应语法未经核实，不写没验证的东西。
 */

/** 接受 `no-resolve` 的规则类型。域名类与进程类一律不接受。 */
const IP_RULE_TYPES = new Set([
    'GEOIP',
    'IP-CIDR',
    'IP-CIDR6',
    'IP-ASN',
    'IP-SUFFIX'
]);

/** 白名单修饰符。目前只有一个，留成集合是为了后续加 `src` 一类时不用改结构。 */
const ALLOWED_MODIFIERS = new Set(['no-resolve']);

/**
 * 取一条规则该追加的修饰符后缀。
 *
 * 返回值形如 `',no-resolve'` 或空串，调用方直接拼在**策略之后** ——
 * mihomo / Surge / Loon 的规则形态都是 `TYPE,VALUE,POLICY[,修饰符]`。
 *
 * @param {{type?: string, extras?: string[]}} rule 统一模型里的一条规则
 * @returns {string} 可直接拼接的后缀，无修饰符时为空串
 */
export function ruleModifierSuffix(rule) {
    const type = String(rule?.type || '').trim().toUpperCase();
    if (!IP_RULE_TYPES.has(type)) return '';

    const extras = Array.isArray(rule?.extras) ? rule.extras : [];
    const modifiers = extras
        .map(entry => String(entry || '').trim().toLowerCase())
        .filter(entry => ALLOWED_MODIFIERS.has(entry));

    return modifiers.length > 0 ? `,${Array.from(new Set(modifiers)).join(',')}` : '';
}
