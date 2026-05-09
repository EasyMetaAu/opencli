import { cli, Strategy } from '@jackwener/opencli/registry';
import { AuthRequiredError } from '@jackwener/opencli/errors';
import {
    buildDescriptionWithTags,
    PUBLISH_ERROR_CODES,
    classifyPlatformFailure,
    throwPublishFailure,
    requireBrowserUploadSupport,
    setFileInput,
    successResult,
    unsupportedResult,
    validateVideoPublishInput,
    visibleElementScript,
} from '../_shared/video-publish.js';

const PLATFORM = 'tiktok';
const DOMAIN = 'www.tiktok.com';
const UPLOAD_URL = 'https://www.tiktok.com/tiktokstudio/upload';
const FILE_SELECTORS = [
    'input[type="file"][accept*="video"]',
    'input[type="file"]',
];
const READY_TIMEOUT_MS = 180_000;
const READY_POLL_MS = 1500;
const SUBMIT_TIMEOUT_MS = 90_000;
const SUBMIT_POLL_MS = 1500;

function unsupportedForInput(input) {
    if (input.schedule) {
        return unsupportedResult(PLATFORM, 'schedule', 'TikTok publish adapter currently supports immediate publish only; scheduled publish is reported as unsupported.');
    }
    if (input.cover) {
        return unsupportedResult(PLATFORM, 'cover', 'TikTok cover selection is not automated yet; pass no --cover or handle cover manually.');
    }
    if (input.account) {
        return unsupportedResult(PLATFORM, 'account', 'TikTok account switching is not automated yet; use the active logged-in browser account.');
    }
    if (input.privacy !== 'public') {
        return unsupportedResult(PLATFORM, 'privacy', 'TikTok publish adapter currently supports public immediate publish only.');
    }
    if (input.draft) {
        return unsupportedResult(PLATFORM, 'draft', 'TikTok draft save is not automated yet; immediate publish is supported.');
    }
    return null;
}

async function assertTikTokLoggedIn(page) {
    const state = await page.evaluate(`
        (() => {
            const text = (document.body?.innerText || '').replace(/\s+/g, ' ');
            const url = location.href;
            const hasFileInput = !!document.querySelector('input[type="file"]');
            const loginLike = /log in|sign up|continue with google|继续|登录|注册/i.test(text);
            const uploadLike = /upload|select file|drag and drop|上传|选择文件/i.test(text) || hasFileInput;
            if (/\/login/i.test(url) || (loginLike && !uploadLike)) {
                return { ok: false, message: 'TikTok Studio requires login' };
            }
            return { ok: true, hasFileInput, url };
        })()
    `);
    if (!state?.ok) {
        throw new AuthRequiredError(DOMAIN, state?.message || 'TikTok Studio requires login');
    }
}

async function waitForUploadReady(page) {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
        const result = await page.evaluate(`
            (() => {
                const text = (document.body?.innerText || '').replace(/\s+/g, ' ');
                if (/failed|error|try again|上传失败|处理失败/i.test(text)) {
                    return { error: 'upload', message: text.slice(0, 300) };
                }
                const hasCaption = !!document.querySelector('[contenteditable="true"], textarea, input[type="text"]');
                const hasPost = Array.from(document.querySelectorAll('button, [role="button"]')).some((el) => {
                    const label = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim();
                    return /post|publish|发布|立即发布/i.test(label);
                });
                if (hasCaption || hasPost || /uploaded|processing complete|publish settings|caption|描述|标题|发布设置/i.test(text)) {
                    return { ok: true };
                }
                return null;
            })()
        `);
        if (result?.ok) return;
        classifyPlatformFailure(PLATFORM, DOMAIN, result, 'TikTok upload failed');
        await page.wait({ time: READY_POLL_MS / 1000 });
    }
    throwPublishFailure(PUBLISH_ERROR_CODES.uploadFailed, 'TikTok upload did not become editable before timeout');
}

async function fillTikTokCaption(page, text) {
    const result = await page.evaluateWithArgs(`
        (() => {
            ${visibleElementScript()}
            const selectors = [
                '[data-e2e="caption-input"] [contenteditable="true"]',
                '[data-e2e="caption-input"] textarea',
                '[contenteditable="true"][role="textbox"]',
                '[contenteditable="true"]',
                'textarea'
            ];
            for (const selector of selectors) {
                const el = Array.from(document.querySelectorAll(selector)).find(isVisible);
                if (el) {
                    setNativeText(el, captionText);
                    return { ok: true, selector };
                }
            }
            return { error: 'platform', message: 'TikTok caption editor was not found after upload' };
        })()
    `, { captionText: text });
    classifyPlatformFailure(PLATFORM, DOMAIN, result, 'TikTok caption fill failed');
}

async function clickTikTokPublish(page) {
    const result = await page.evaluate(`
        (() => {
            ${visibleElementScript()}
            return clickByLabels(['Post', 'Publish', '发布', '立即发布']);
        })()
    `);
    if (!result?.ok) {
        throwPublishFailure(PUBLISH_ERROR_CODES.platformError, result?.message || 'TikTok publish button was not found');
    }
}

async function waitForTikTokPublishResult(page) {
    const deadline = Date.now() + SUBMIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
        const result = await page.evaluate(`
            (() => {
                const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
                const url = location.href;
                const anchors = Array.from(document.querySelectorAll('a[href*="/video/"]')).map((a) => a.href).filter(Boolean);
                if (anchors.length) return { ok: true, url: anchors[0], message: 'TikTok publish completed' };
                if (/successfully posted|published successfully|post has been published|发布成功|已发布/i.test(text)) {
                    return { ok: true, url: '', message: 'TikTok publish completed' };
                }
                if (/log in|session expired|please login|请登录|登录已过期/i.test(text)) {
                    return { error: 'auth', message: 'TikTok login expired during publish' };
                }
                if (/failed|try again|violat|not eligible|上传失败|发布失败|违规|稍后再试/i.test(text)) {
                    return { error: 'platform', message: text.slice(0, 500) };
                }
                return null;
            })()
        `);
        if (result?.ok) return result;
        classifyPlatformFailure(PLATFORM, DOMAIN, result, 'TikTok publish failed');
        await page.wait({ time: SUBMIT_POLL_MS / 1000 });
    }
    throwPublishFailure(PUBLISH_ERROR_CODES.platformError, 'TikTok publish button clicked but result was unclear before timeout; check TikTok Studio manually.');
}

export const publishCommand = cli({
    site: 'tiktok',
    name: 'publish',
    access: 'write',
    description: 'Publish a local video to TikTok Studio and return a structured result',
    domain: DOMAIN,
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: UPLOAD_URL,
    args: [
        { name: 'video', required: true, positional: true, help: 'Local video file path (mp4/mov/m4v/webm)' },
        { name: 'title', required: true, help: 'Video title/caption prefix' },
        { name: 'description', default: '', help: 'Video description appended after title' },
        { name: 'tags', default: '', help: 'Comma-separated hashtags; written into the caption as #tags' },
        { name: 'cover', default: '', help: 'Cover image path (currently returns unsupported_capability)' },
        { name: 'schedule', default: '', help: 'Scheduled publish time (currently returns unsupported_capability)' },
        { name: 'privacy', default: 'public', choices: ['public', 'friends', 'private'], help: 'Privacy setting; currently only public is automated' },
        { name: 'account', default: '', help: 'Account selector (currently returns unsupported_capability)' },
        { name: 'draft', type: 'bool', default: false, help: 'Save as draft (currently returns unsupported_capability)' },
    ],
    columns: ['ok', 'platform', 'status', 'code', 'capability', 'message', 'url', 'draft'],
    func: async (page, kwargs) => {
        const input = validateVideoPublishInput(kwargs, PLATFORM, {
            maxTitleLength: 300,
            maxDescriptionLength: 1900,
            validateCover: false,
        });
        const unsupported = unsupportedForInput(input);
        if (unsupported) return unsupported;

        await requireBrowserUploadSupport(page, PLATFORM);
        await page.goto(UPLOAD_URL, { waitUntil: 'load', settleMs: 3000 });
        await assertTikTokLoggedIn(page);
        await setFileInput(page, [input.videoPath], FILE_SELECTORS, PLATFORM);
        await waitForUploadReady(page);

        const caption = [input.title, buildDescriptionWithTags(input.description, input.tags)].filter(Boolean).join('\n\n');
        await fillTikTokCaption(page, caption);
        await clickTikTokPublish(page);
        const publishResult = await waitForTikTokPublishResult(page);

        return successResult(PLATFORM, publishResult.message || 'TikTok publish completed', {
            url: publishResult.url || '',
            draft: false,
        });
    },
});

export const __test__ = {
    unsupportedForInput,
    fillTikTokCaption,
    waitForTikTokPublishResult,
};
