import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import { generateBuiltinClashConfig } from '../../functions/modules/subscription/builtin-clash-generator.js';
import { generateBuiltinSingboxConfig } from '../../functions/modules/subscription/builtin-singbox-generator.js';
import { validateClashConfig, validateSingboxConfig } from '../../scripts/smoke-subscription.mjs';

const NODE = 'trojan://password@1.2.3.4:443#SmokeNode';

describe('Clash/sing-box subscription smoke invariants', () => {
    for (const mode of ['clean', 'polluted']) {
        it(`accepts ${mode} built-in Clash and sing-box output`, () => {
            const options = mode === 'polluted' ? { dnsMode: 'polluted' } : {};
            const clash = yaml.load(generateBuiltinClashConfig(NODE, options));
            const singbox = JSON.parse(generateBuiltinSingboxConfig(NODE, options));

            expect(() => validateClashConfig(clash, mode)).not.toThrow();
            expect(() => validateSingboxConfig(singbox, mode)).not.toThrow();
        });
    }
});
