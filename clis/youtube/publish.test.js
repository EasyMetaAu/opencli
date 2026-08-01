import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getRegistry } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError } from '@jackwener/opencli/errors';
import { publishCommand, __test__ } from './publish.js';

function tempVideo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencli-youtube-publish-'));
    const file = path.join(dir, 'video.mp4');
    fs.writeFileSync(file, 'fake video');
    return file;
}

function pageReturning(result) {
    return {
        async evaluate() { return result; },
        async evaluateWithArgs() { return result; },
        async wait() {},
    };
}

describe('youtube publish adapter', () => {
    it('registers a write publish command with structured columns', () => {
        const cmd = [...getRegistry().values()].find((c) => c.site === 'youtube' && c.name === 'publish');
        expect(cmd).toBeDefined();
        expect(cmd?.access).toBe('write');
        expect(cmd?.strategy).toBe('cookie');
        expect(cmd?.columns).toContain('code');
        expect(cmd?.args.map((a) => a.name)).toEqual(expect.arrayContaining(['video', 'title', 'description', 'tags', 'cover', 'schedule', 'privacy']));
    });

    it('rejects invalid parameters before browser interaction', async () => {
        await expect(publishCommand.func({}, { video: '/no/such.mp4', title: 'x' })).rejects.toBeInstanceOf(ArgumentError);
        await expect(publishCommand.func({}, { video: tempVideo(), title: '' })).rejects.toBeInstanceOf(ArgumentError);
    });

    it('returns structured unsupported capability rows', async () => {
        const video = tempVideo();
        await expect(publishCommand.func({}, { video, title: 'x', schedule: '2026-01-01T00:00:00Z' })).resolves.toMatchObject([{ code: 'unsupported_capability', capability: 'schedule' }]);
        await expect(publishCommand.func({}, { video, title: 'x', cover: '/tmp/cover.png' })).resolves.toMatchObject([{ code: 'unsupported_capability', capability: 'cover' }]);
        await expect(publishCommand.func({}, { video, title: 'x', account: 'brand' })).resolves.toMatchObject([{ code: 'unsupported_capability', capability: 'account' }]);
    });

    it('selects the made-for-kids radio by name once it mounts (even at rect 0×0)', async () => {
        // Flow: presence-probe → (present) → click pass → verify pass. The radio
        // mounts on the first probe; the name-anchored click no longer needs the
        // element to be laid out.
        const evaluateWithArgsResults = [
            true, // presence probe: nameSelector found in DOM
            { ok: true, via: 'attr', sel: '[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]', checked: true }, // click pass
            { ok: true, via: 'attr', sel: '[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]' }, // verify pass
        ];
        const page = {
            async evaluate() { return { ok: false }; },
            async evaluateWithArgs() { return evaluateWithArgsResults.shift(); },
            async wait() {},
        };
        await expect(__test__.chooseNotMadeForKids(page, false)).resolves.toMatchObject({ ok: true, via: 'attr' });
    });

    it('still requires privacy radio selection after optional audience skip', async () => {
        await expect(__test__.clickAndVerifyYouTubeRadio(
            pageReturning({ ok: false, message: 'privacy radio was not found' }),
            { nameSelectors: ['[name="PUBLIC"]'], labels: ['Public'], settingName: 'privacy', required: true },
        )).rejects.toMatchObject({ code: 'platform_error' });
    });

    it('selects a radio via its stable name attribute and confirms via read-back', async () => {
        // First evaluateWithArgs = click pass (attr hit); second = verify pass (aria-checked read-back).
        const results = [
            { ok: true, via: 'attr', sel: '[name="PUBLIC"]', checked: true },
            { ok: true, via: 'attr', sel: '[name="PUBLIC"]' },
        ];
        const page = {
            async evaluate() { return { ok: false }; },
            async evaluateWithArgs() { return results.shift(); },
            async wait() {},
        };
        await expect(__test__.clickAndVerifyYouTubeRadio(
            page,
            { nameSelectors: ['[name="PUBLIC"]'], labels: ['Public'], settingName: 'privacy', required: true },
        )).resolves.toMatchObject({ ok: true, via: 'attr' });
    });

    it('pages until the privacy radios appear (on the REVIEW step), waiting out processing', async () => {
        // The privacy radios live on the REVIEW step — there is no separate
        // VISIBILITY step. Page on privacyReady, tolerating the disabled-Continue
        // processing window on REVIEW. Sequence readWorkflowStep() will observe:
        const steps = [
            { present: true, step: 'DETAILS', privacyReady: false },
            { present: true, step: 'VIDEO_ELEMENTS', privacyReady: false },
            { present: true, step: 'CHECKS', privacyReady: false },
            { present: true, step: 'REVIEW', privacyReady: false }, // still processing
            { present: true, step: 'REVIEW', privacyReady: false }, // still processing
            { present: true, step: 'REVIEW', privacyReady: true },  // radios now on screen
        ];
        let i = 0;
        const clickCalls = [];
        const page = {
            // Both readWorkflowStep and the next-button click go through evaluate();
            // distinguish by script content. The probe reads workflow-step and
            // advances the sequence; the click just reports success.
            async evaluate(script) {
                if (/workflow-step/.test(script)) { const s = steps[Math.min(i, steps.length - 1)]; i += 1; return s; }
                clickCalls.push(script);
                return { ok: true };
            },
            async wait() {},
        };
        const result = await __test__.advanceToPrivacyStep(page);
        expect(result).toMatchObject({ privacyReady: true });
        expect(clickCalls.length).toBeGreaterThanOrEqual(3);
    });

    it('derives the privacy-step budget from --timeout, with an env override and a floor', () => {
        const saved = process.env.OPENCLI_YOUTUBE_NEXT_TIMEOUT_MS;
        delete process.env.OPENCLI_YOUTUBE_NEXT_TIMEOUT_MS;
        try {
            // No --timeout to work from: fall back to the historical default.
            expect(__test__.computeNextBudgetMs({})).toBe(240_000);
            // The regression this fixes: --timeout 840 must actually extend the
            // inner wait instead of being ignored in favor of a 240s constant.
            expect(__test__.computeNextBudgetMs({ timeoutSec: 840, elapsedMs: 60_000 })).toBe(620_000);
            // Tiny --timeout cannot shrink the wait below one processing cycle.
            expect(__test__.computeNextBudgetMs({ timeoutSec: 10 })).toBe(60_000);
            // Explicit env override wins over the --timeout-derived value...
            process.env.OPENCLI_YOUTUBE_NEXT_TIMEOUT_MS = '500000';
            expect(__test__.computeNextBudgetMs({ timeoutSec: 840 })).toBe(500_000);
            // ...but is still floored.
            process.env.OPENCLI_YOUTUBE_NEXT_TIMEOUT_MS = '1000';
            expect(__test__.computeNextBudgetMs({ timeoutSec: 840 })).toBe(60_000);
        } finally {
            if (saved === undefined) delete process.env.OPENCLI_YOUTUBE_NEXT_TIMEOUT_MS;
            else process.env.OPENCLI_YOUTUBE_NEXT_TIMEOUT_MS = saved;
        }
    });

    it('fails fast when the dialog never reaches REVIEW, without burning the full budget', async () => {
        // Stuck on DETAILS (e.g. an unanswered made-for-kids radio keeps
        // #next-button disabled). Waiting out a large budget just delays the
        // same failure, so the reach-REVIEW gate must fire first.
        const page = {
            async evaluate(script) {
                if (/workflow-step/.test(script)) return { present: true, step: 'DETAILS', privacyReady: false, privacyPresent: false, nextFound: true, nextDisabled: true };
                return { ok: false, reason: 'disabled' };
            },
            async wait() {},
            async screenshot() {},
        };
        const startedAt = Date.now();
        await expect(__test__.advanceToPrivacyStep(page, { budgetMs: 600_000, reachReviewMs: 40 }))
            .rejects.toMatchObject({ code: 'platform_error', message: expect.stringContaining('never reached the REVIEW step') });
        // Bounded by reachReviewMs, nowhere near budgetMs.
        expect(Date.now() - startedAt).toBeLessThan(10_000);
    });

    it('switches to the full budget once REVIEW is reached and waits out processing', async () => {
        // Reaching REVIEW means the remaining wait is YouTube-side processing,
        // so the tight reach-REVIEW gate must no longer apply.
        const steps = [
            { present: true, step: 'DETAILS', privacyReady: false, privacyPresent: false },
            { present: true, step: 'REVIEW', privacyReady: false, privacyPresent: false },
            { present: true, step: 'REVIEW', privacyReady: false, privacyPresent: true },
            { present: true, step: 'REVIEW', privacyReady: false, privacyPresent: true },
            { present: true, step: 'REVIEW', privacyReady: false, privacyPresent: true },
            { present: true, step: 'REVIEW', privacyReady: true, privacyPresent: true },
        ];
        let i = 0;
        const page = {
            async evaluate(script) {
                if (/workflow-step/.test(script)) { const s = steps[Math.min(i, steps.length - 1)]; i += 1; return s; }
                return { ok: true };
            },
            // Burn real time per tick so the reach-REVIEW gate would actually
            // expire mid-sequence; without the budget switch this run dies.
            async wait() { await new Promise((r) => setTimeout(r, 12)); },
            async screenshot() {},
        };
        // reachReviewMs expires around the 3rd tick: only the post-REVIEW budget
        // switch keeps this alive to the end of the sequence.
        await expect(__test__.advanceToPrivacyStep(page, { budgetMs: 600_000, reachReviewMs: 30 }))
            .resolves.toMatchObject({ privacyReady: true });
    });

    it('reports the full probe state and a debug screenshot on timeout', async () => {
        const shots = [];
        const page = {
            async evaluate(script) {
                if (/workflow-step/.test(script)) return { present: true, step: 'REVIEW', privacyReady: false, privacyPresent: true, nextFound: true, nextDisabled: true, progressPct: 42 };
                return { ok: false, reason: 'disabled' };
            },
            async wait() {},
            async screenshot(opts) { shots.push(opts?.path); },
        };
        await expect(__test__.advanceToPrivacyStep(page, { budgetMs: 40 })).rejects.toMatchObject({
            code: 'platform_error',
            message: expect.stringContaining('last state:'),
        });
        expect(shots).toEqual(['/tmp/youtube_visibility_debug.png']);
    });

    it('still reports the timeout when the debug screenshot itself fails', async () => {
        const page = {
            async evaluate(script) {
                if (/workflow-step/.test(script)) return { present: true, step: 'REVIEW', privacyReady: false, privacyPresent: false };
                return { ok: false, reason: 'disabled' };
            },
            async wait() {},
            async screenshot() { throw new Error('CDP screenshot failed'); },
        };
        // Having reached REVIEW, the hint must name the lever that actually
        // works — raising --timeout, which the old code ignored entirely.
        await expect(__test__.advanceToPrivacyStep(page, { budgetMs: 40 }))
            .rejects.toMatchObject({ code: 'platform_error', message: expect.stringContaining('raise --timeout') });
    });

    it('rescues a rect-0 privacy radio at the budget edge only when read-back confirms', async () => {
        const makePage = (radioResult) => ({
            async evaluate(script) {
                if (/workflow-step/.test(script)) return { present: true, step: 'REVIEW', privacyReady: false, privacyPresent: true };
                return { ok: false, reason: 'disabled' };
            },
            // Both the click pass and the aria-checked verify pass go through here.
            async evaluateWithArgs() { return radioResult; },
            async wait() {},
            async screenshot() {},
        });
        const privacyRadio = { nameSelectors: ['[name="PUBLIC"]'], labels: ['Public'], settingName: 'privacy' };

        // Read-back confirms → accept instead of failing on the timeout.
        await expect(__test__.advanceToPrivacyStep(makePage({ ok: true, via: 'attr', sel: '[name="PUBLIC"]', checked: true }), { budgetMs: 40, privacyRadio }))
            .resolves.toMatchObject({ privacyRescued: true });

        // Radio not found → no false positive, the timeout stands.
        await expect(__test__.advanceToPrivacyStep(makePage({ ok: false, message: 'privacy radio was not found' }), { budgetMs: 40, privacyRadio }))
            .rejects.toMatchObject({ code: 'platform_error', message: expect.stringContaining('did not appear') });
    });

    it('maps auth and platform failures from publish polling to stable codes', async () => {
        await expect(__test__.waitForYouTubePublishResult(pageReturning({ text: 'session expired', anchors: [] }), 'public')).rejects.toBeInstanceOf(AuthRequiredError);
        await expect(__test__.waitForYouTubePublishResult(pageReturning({ text: 'publish failed', anchors: [] }), 'public')).rejects.toMatchObject({ code: 'platform_error' });
    });

    it('does not treat upload-complete text as publish success and detects privacy mismatch', () => {
        expect(__test__.classifyYouTubePublishState({ text: 'Upload complete. Processing will begin shortly.', privacy: 'public' })).toMatchObject({ pending: true });
        expect(__test__.classifyYouTubePublishState({ text: 'Video published Private', privacy: 'public' })).toMatchObject({ error: 'platform' });
        expect(__test__.classifyYouTubePublishState({ text: 'Video published Public', privacy: 'public', anchors: ['https://youtu.be/x'] })).toMatchObject({ ok: true, url: 'https://youtu.be/x' });
    });
});
