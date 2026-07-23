import { describe, expect, it } from 'vitest';
import { profileCommand } from './profile.js';

describe('tiktok profile adapter', () => {
    it('navigates to the profile so TikTok can complete its WAF challenge', () => {
        const [navigateStep, evaluateStep] = profileCommand.pipeline;

        expect(navigateStep).toEqual({
            navigate: {
                url: 'https://www.tiktok.com/@${{ args.username | urlencode }}',
                settleMs: 8000,
            },
        });
        expect(evaluateStep.evaluate).toContain("document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__')");
        expect(evaluateStep.evaluate).not.toContain('await fetch(');
    });
});
