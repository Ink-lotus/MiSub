function literalRejectAction(policy) {
    const name = String(policy || '').toUpperCase();
    if (name === 'REJECT') return { action: 'reject' };
    if (name === 'REJECT-DROP') return { action: 'reject', method: 'drop' };
    return null;
}

export function prepareSingboxGroups(groups) {
    const rejectPolicies = new Map();
    const rejectAction = policy => literalRejectAction(policy) || rejectPolicies.get(policy);

    // Resolve defaults before removing reject members, including nested selectors.
    let changed = true;
    while (changed) {
        changed = false;
        for (const group of groups) {
            if (rejectPolicies.has(group.tag) || group.outbounds.length === 0) continue;
            const action = rejectAction(group.default || group.outbounds[0]);
            if (!action) continue;
            if (group.type === 'urltest' && !group.outbounds.every(member => rejectAction(member))) continue;
            rejectPolicies.set(group.tag, action);
            changed = true;
        }
    }

    let outbounds = groups.map(group => ({
        ...group,
        outbounds: group.outbounds.filter(member => !(group.type === 'urltest'
            ? rejectAction(member)
            : literalRejectAction(member)))
    }));
    const removedGroups = new Set();
    while (true) {
        const empty = new Set(outbounds.filter(group => group.outbounds.length === 0).map(group => group.tag));
        if (empty.size === 0) break;
        empty.forEach(tag => removedGroups.add(tag));
        outbounds = outbounds.filter(group => !empty.has(group.tag)).map(group => ({
            ...group,
            outbounds: group.outbounds.filter(member => !empty.has(member))
        }));
    }
    outbounds.forEach(group => {
        if (group.default && !group.outbounds.includes(group.default)) {
            group.default = group.outbounds[0];
        }
    });

    return {
        outbounds,
        resolveAction: policy => {
            const action = rejectAction(policy);
            if (action) return { ...action };
            if (removedGroups.has(policy)) {
                throw new Error(`[Singbox] Policy "${policy}" has no usable outbound`);
            }
            return { outbound: policy };
        }
    };
}
