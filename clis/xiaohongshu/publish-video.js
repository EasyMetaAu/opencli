/**
 * Xiaohongshu 视频笔记 publisher — creator center UI automation.
 *
 * Flow:
 *   1. Navigate to creator publish page (target=video)
 *   2. Confirm / switch to the 视频 (video) tab
 *   3. Upload the video via CDP DOM.setFileInputFiles
 *   4. Wait for the upload + transcode to settle and the editor form to render
 *   5. Fill title and body text (description + topics)
 *   6. Publish (or save as draft) via the <xhs-publish-btn> web component
 *
 * Requires: logged into creator.xiaohongshu.com in Chrome.
 *
 * Usage:
 *   opencli xiaohongshu publish-video /path/to/clip.mp4 --title "标题" \
 *     --description "正文内容" --topics 生活,旅行
 *
 * Mirrors the tiktok/youtube `publish` command shape and reuses the shared
 * video-publish scaffolding (validation, file upload, structured results) plus
 * the XHS creator-center helpers extracted into publish-helpers.js.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import {
    classifyPlatformFailure,
    PUBLISH_ERROR_CODES,
    requireBrowserUploadSupport,
    setFileInput,
    successResult,
    throwPublishFailure,
    unsupportedResult,
    validateVideoPublishInput,
} from '../_shared/video-publish.js';
import {
    addTopics,
    BODY_SELECTORS,
    fillField,
    inspectPublishSurfaceState,
    invokePublishAction,
    TITLE_SELECTORS,
    unwrapBrowserResult,
    waitForEditForm,
} from './publish-helpers.js';

const PLATFORM = 'xiaohongshu';
const DOMAIN = 'creator.xiaohongshu.com';
const PUBLISH_URL = 'https://creator.xiaohongshu.com/publish/publish?from=menu_left&target=video';
// XHS creator-center caps the video note title at 20 characters, same as 图文.
const MAX_TITLE_LEN = 20;
// The video file input accepts video/*; fall back to a bare file input if the
// accept attribute is missing on the current UI variant.
const FILE_SELECTORS = [
    'input[type="file"][accept*="video"]',
    'input[type="file"][accept*=".mp4"]',
    'input[type="file"][accept*="mp4"]',
    'input[type="file"]',
];
// Upload + server-side transcode can take a while for a real clip. Poll until
// the editor form (title field) renders and no upload/transcode progress marker
// remains, bounded by the caller's --timeout budget.
const UPLOAD_SETTLE_MS = 3_000;
const UPLOAD_POLL_MS = 2_000;
const PUBLISH_RESULT_POLL_MS = 1_000;
const PUBLISH_RESULT_WAIT_MS = 30_000;
const VIDEO_UPLOAD_FAILURE_RE = /上传失败|转码失败|处理失败|视频格式不支持|上传出错|视频(?:时长)?(?:过长|过短)|视频时长(?:超出|超过|不足|不符合)(?:要求|限制)?/;
const PUBLISH_FAILURE_RE = /发布失败|保存失败|暂存失败|提交失败|操作失败|发布出错/;
const PUBLISH_SUCCESS_RE = /发布成功|发布完成/;
const DRAFT_SUCCESS_RE = /草稿已保存|暂存成功|保存草稿成功|保存成功/;

function hasVideoUploadFailure(text) {
    return VIDEO_UPLOAD_FAILURE_RE.test(String(text || ''));
}

function parseCreatorUrl(rawUrl) {
    try {
        return new URL(String(rawUrl || ''));
    }
    catch {
        return null;
    }
}

function isKnownPublishResultUrl(url) {
    if (!url || url.hostname.toLowerCase() !== DOMAIN) return false;
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    return pathname === '/new/note-manager'
        || pathname.startsWith('/new/note-manager/')
        || pathname === '/note-manager'
        || pathname.startsWith('/note-manager/')
        || pathname === '/publish/success'
        || pathname.startsWith('/publish/success/');
}

function classifyVideoPublishState({ url = '', text = '', isDraft = false } = {}) {
    const normalizedText = String(text || '').replace(/\s+/g, ' ').trim();
    const parsedUrl = parseCreatorUrl(url);
    if (parsedUrl && parsedUrl.hostname.toLowerCase() !== DOMAIN) {
        const isLogin = /login|signin|passport/i.test(parsedUrl.pathname + parsedUrl.search)
            || /登录|扫码/.test(normalizedText);
        return {
            error: isLogin ? 'auth' : 'platform',
            message: `Xiaohongshu redirected away from creator center after submit: ${parsedUrl.href}`,
        };
    }
    if (parsedUrl && /login|signin|passport/i.test(parsedUrl.pathname + parsedUrl.search)) {
        return { error: 'auth', message: 'Xiaohongshu login expired while submitting the video note' };
    }
    if (PUBLISH_FAILURE_RE.test(normalizedText)) {
        return { error: 'platform', message: normalizedText.slice(0, 500) };
    }

    const terminalSuccess = isDraft
        ? DRAFT_SUCCESS_RE.test(normalizedText)
        : PUBLISH_SUCCESS_RE.test(normalizedText);
    if (terminalSuccess) {
        return {
            ok: true,
            url: isKnownPublishResultUrl(parsedUrl) ? parsedUrl.href : '',
            message: normalizedText,
        };
    }
    if (isKnownPublishResultUrl(parsedUrl)) {
        return { ok: true, url: parsedUrl.href, message: normalizedText || parsedUrl.href };
    }

    if (parsedUrl && !parsedUrl.pathname.includes('/publish/publish')) {
        return {
            error: 'platform',
            message: `Xiaohongshu navigated to an unrecognized page after submit: ${parsedUrl.href}`,
        };
    }
    // “上传成功” belongs to the earlier upload phase and “发布中” is only an
    // intermediate state. Neither is a publish-side postcondition.
    return {
        pending: true,
        message: normalizedText || (parsedUrl?.href || 'waiting for a terminal publish result'),
    };
}

/**
 * Confirm the composer is on the video surface, switching to the 视频 tab first
 * if the page opened on the 图文 surface. Mirrors publish.js's selectImageTextTab
 * but targets the video entry (and does NOT exclude 视频 candidates).
 *
 * Returns { ok, target?, text?, visibleTexts? } — ok=true means a 视频 tab was
 * clicked; ok=false is not fatal (the page may already be on the video surface),
 * so the caller confirms via inspectPublishSurfaceState.
 */
async function selectVideoTab(page) {
    const result = await page.evaluate(`
    () => {
      const isVisible = (el) => {
        if (!el || el.offsetParent === null) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
      const selector = 'button, [role="tab"], [role="button"], a, label, div, span, li';
      const nodes = Array.from(document.querySelectorAll(selector));
      const targets = ['上传视频', '视频'];

      for (const target of targets) {
        for (const node of nodes) {
          if (!isVisible(node)) continue;
          const text = normalize(node.innerText || node.textContent || '');
          // Skip 图文/图片 entries so the video target never lands on them.
          if (!text || text.includes('图文') || text.includes('图片')) continue;
          if (text === target) {
            const clickable = node.closest('button, [role="tab"], [role="button"], a, label') || node;
            clickable.click();
            return { ok: true, target, text };
          }
        }
      }

      for (const target of targets) {
        for (const node of nodes) {
          if (!isVisible(node)) continue;
          const text = normalize(node.innerText || node.textContent || '');
          if (!text || text.includes('图文') || text.includes('图片')) continue;
          if (text.startsWith(target) || text.includes(target)) {
            const clickable = node.closest('button, [role="tab"], [role="button"], a, label') || node;
            clickable.click();
            return { ok: true, target, text };
          }
        }
      }

      const visibleTexts = [];
      for (const node of nodes) {
        if (!isVisible(node)) continue;
        const text = normalize(node.innerText || node.textContent || '');
        if (!text || text.length > 20) continue;
        visibleTexts.push(text);
        if (visibleTexts.length >= 20) break;
      }
      return { ok: false, visibleTexts };
    }
  `);
    if (result?.ok) {
        await page.wait({ time: 1 });
    }
    return result;
}

/**
 * Poll until the composer reaches the video-upload surface (the drop zone /
 * video file input) so setFileInput has a target. Returns the final surface
 * state; the caller decides whether video_surface / editor_ready is acceptable.
 */
async function waitForVideoSurface(page, maxWaitMs = 8_000) {
    const pollMs = 500;
    const maxAttempts = Math.max(1, Math.ceil(maxWaitMs / pollMs));
    let surface = await inspectPublishSurfaceState(page);
    for (let i = 0; i < maxAttempts; i++) {
        // video_surface = drop zone ready; editor_ready = a stale draft may have
        // reopened straight into the editor. Either lets us proceed.
        if (surface.state === 'video_surface' || surface.state === 'editor_ready') {
            return surface;
        }
        if (i < maxAttempts - 1) {
            await page.wait({ time: pollMs / 1_000 });
            surface = await inspectPublishSurfaceState(page);
        }
    }
    return surface;
}

/**
 * Wait for the upload + transcode to finish. XHS renders the editor form (title
 * field) once the video is processed; while uploading/transcoding it shows a
 * progress indicator ("上传中"/"转码中"/percentage) and a preview <video> only
 * after it completes. We treat "editor form present AND no progress marker" as
 * done, and surface upload/transcode failure text as a typed upload_failed.
 *
 * Bounded by budgetMs (from --timeout). Returns { ok:true } or throws.
 */
async function waitForVideoUploadReady(page, budgetMs) {
    const deadline = Date.now() + budgetMs;
    let sawProgress = false;
    while (Date.now() < deadline) {
        const state = unwrapBrowserResult(await page.evaluate(`
      (() => {
        const __opencli_xhs_video_upload_state = true;
        const text = (document.body?.innerText || '').replace(/\\s+/g, ' ').trim();
        // Explicit failure copy from XHS (upload rejected / transcode failed).
        if (${VIDEO_UPLOAD_FAILURE_RE}.test(text)) {
          return { error: 'upload', message: text.slice(0, 300) };
        }
        // Progress markers only present while uploading / transcoding.
        const progressText = /上传中|正在上传|转码中|正在处理|处理中|视频审核中/.test(text);
        const progressEl = !!document.querySelector(
          '[class*="upload"][class*="progress"], [class*="uploading"], [class*="transcod"], [class*="video"][class*="progress"], [class*="loading"][class*="video"]'
        );
        const uploading = progressText || progressEl;
        // Editor form is ready once the title field renders.
        const titleSels = ${JSON.stringify(TITLE_SELECTORS)};
        const hasTitle = titleSels.some((sel) => {
          const el = document.querySelector(sel);
          return el && el.offsetParent !== null;
        });
        // A preview <video> element appearing is a strong "processed" signal.
        const hasPreviewVideo = Array.from(document.querySelectorAll('video')).some((v) => {
          if (v.offsetParent === null) return false;
          const r = v.getBoundingClientRect();
          return r.width >= 48 && r.height >= 48;
        });
        return { uploading, hasTitle, hasPreviewVideo };
      })()
    `));
        // Surface a typed upload failure immediately.
        classifyPlatformFailure(PLATFORM, DOMAIN, state, 'xiaohongshu video upload failed');
        if (state?.uploading) {
            sawProgress = true;
        }
        if (!state?.uploading && state?.hasTitle) {
            return { ok: true, sawProgress, hadPreview: Boolean(state?.hasPreviewVideo) };
        }
        await page.wait({ time: UPLOAD_POLL_MS / 1_000 });
    }
    await page.screenshot({ path: '/tmp/xhs_publish_video_debug.png' });
    throwPublishFailure(PUBLISH_ERROR_CODES.uploadFailed, 'xiaohongshu video upload/transcode did not become editable before timeout. '
        + 'Debug screenshot: /tmp/xhs_publish_video_debug.png');
    return { ok: false };
}

async function waitForVideoPublishResult(page, { isDraft, maxWaitMs = PUBLISH_RESULT_WAIT_MS }) {
    const maxAttempts = Math.max(1, Math.ceil(maxWaitMs / PUBLISH_RESULT_POLL_MS));
    let lastState = { pending: true, message: '' };
    const markers = [
        '发布成功',
        '发布完成',
        '草稿已保存',
        '暂存成功',
        '保存草稿成功',
        '保存成功',
        '发布失败',
        '保存失败',
        '暂存失败',
        '提交失败',
        '操作失败',
        '发布出错',
        '上传成功',
        '发布中',
    ];

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const finalUrl = unwrapBrowserResult(await page.evaluate('() => location.href'));
        const statusText = unwrapBrowserResult(await page.evaluate(`
      (markers => {
        const matches = [];
        for (const el of document.querySelectorAll('*')) {
          if (el.tagName === 'STYLE' || el.tagName === 'SCRIPT') continue;
          const text = (el.innerText || '').trim();
          if (!text || text.length > 200 || el.children.length > 0) continue;
          if (markers.some(marker => text.includes(marker))) matches.push(text);
          if (matches.length >= 20) break;
        }
        return matches.join('\\n');
      })(${JSON.stringify(markers)})
    `));
        lastState = classifyVideoPublishState({
            url: typeof finalUrl === 'string' ? finalUrl : '',
            text: typeof statusText === 'string' ? statusText : '',
            isDraft,
        });
        classifyPlatformFailure(PLATFORM, DOMAIN, lastState, 'xiaohongshu video publish failed');
        if (lastState.ok) return lastState;
        if (attempt < maxAttempts - 1) {
            await page.wait({ time: PUBLISH_RESULT_POLL_MS / 1_000 });
        }
    }

    await page.screenshot({ path: '/tmp/xhs_publish_video_result_debug.png' });
    throwPublishFailure(
        PUBLISH_ERROR_CODES.platformError,
        `${isDraft ? '暂存' : '发布'}结果无法确认：等待终态超时。`
            + ` Last state: ${lastState.message || 'unknown'}.`
            + ' Debug screenshot: /tmp/xhs_publish_video_result_debug.png',
    );
}

/** First-version unsupported capabilities (parity with tiktok's first cut). */
function unsupportedForInput(input) {
    if (input.cover) {
        return unsupportedResult(PLATFORM, 'cover', '小红书视频封面选择暂未自动化；请省略 --cover 或在页面手动设置封面。');
    }
    if (input.schedule) {
        return unsupportedResult(PLATFORM, 'schedule', '小红书视频定时发布暂未自动化；当前仅支持立即发布或存草稿。');
    }
    if (input.account) {
        return unsupportedResult(PLATFORM, 'account', '小红书账号切换暂未自动化；使用当前登录的浏览器账号。');
    }
    return null;
}

export const publishVideoCommand = cli({
    site: 'xiaohongshu',
    name: 'publish-video',
    access: 'write',
    description: '小红书发布视频笔记 (creator center UI automation)',
    domain: DOMAIN,
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: false,
    args: [
        { name: 'video', required: true, positional: true, help: '本地视频文件路径 (mp4/mov/m4v/webm)' },
        { name: 'title', required: true, help: '视频标题 (最多20字)' },
        { name: 'description', default: '', help: '视频正文/描述' },
        { name: 'tags', default: '', help: '话题标签，逗号分隔，不含 # 号；写入正文话题' },
        { name: 'topics', default: '', help: '话题标签别名，与 --tags 等价（两者合并去重）' },
        { name: 'cover', default: '', help: '视频封面图路径 (当前返回 unsupported_capability)' },
        { name: 'schedule', default: '', help: '定时发布时间 (当前返回 unsupported_capability)' },
        { name: 'account', default: '', help: '账号选择 (当前返回 unsupported_capability)' },
        { name: 'draft', type: 'bool', default: false, help: '保存为草稿，不直接发布' },
        { name: 'timeout', type: 'int', default: 300, help: '整体命令最大秒数；视频上传+转码需要充足时间 (默认: 300)' },
    ],
    columns: ['ok', 'platform', 'status', 'code', 'capability', 'message', 'url', 'draft'],
    func: async (page, kwargs) => {
        // Merge --topics into --tags so either flag drives the note's topics.
        const topicList = String(kwargs.topics ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        const mergedKwargs = topicList.length
            ? { ...kwargs, tags: [kwargs.tags, kwargs.topics].filter(Boolean).join(',') }
            : kwargs;

        // ── Validate inputs (fast-fail before navigating) ──────────────────────────
        const input = validateVideoPublishInput(mergedKwargs, PLATFORM, {
            maxTitleLength: MAX_TITLE_LEN,
            maxDescriptionLength: 5_000,
            validateCover: false,
        });
        const isDraft = input.draft;
        const unsupported = unsupportedForInput(input);
        if (unsupported) return unsupported;

        await requireBrowserUploadSupport(page, PLATFORM);

        // ── Step 1: Navigate to the video publish page ─────────────────────────────
        await page.goto(PUBLISH_URL);
        await page.wait({ time: 3 });
        const pageUrl = await page.evaluate('() => location.href');
        if (!pageUrl.includes('creator.xiaohongshu.com')) {
            throwPublishFailure(PUBLISH_ERROR_CODES.platformError, 'Redirected away from creator center — session may have expired. '
                + 'Re-capture browser login via: opencli xiaohongshu creator-profile');
        }

        // ── Step 2: Confirm / switch to the 视频 tab ───────────────────────────────
        const tabResult = await selectVideoTab(page);
        const surface = await waitForVideoSurface(page, tabResult?.ok ? 8_000 : 4_000);
        if (surface.state === 'image_surface') {
            await page.screenshot({ path: '/tmp/xhs_publish_video_tab_debug.png' });
            const detail = tabResult?.ok
                ? `clicked "${tabResult.text}"`
                : `visible candidates: ${(tabResult?.visibleTexts || []).join(' | ') || 'none'}`;
            throwPublishFailure(PUBLISH_ERROR_CODES.platformError, 'Could not reach the video publish surface (still on 图文). '
                + `Details: ${detail}. Debug screenshot: /tmp/xhs_publish_video_tab_debug.png`);
        }

        // ── Step 3: Upload the video file ──────────────────────────────────────────
        await setFileInput(page, [input.videoPath], FILE_SELECTORS, PLATFORM);
        await page.wait({ time: UPLOAD_SETTLE_MS / 1_000 });

        // ── Step 4: Wait for upload + transcode + editor form ──────────────────────
        const budgetMs = Math.max(30_000, Number(kwargs.timeout || 300) * 1_000);
        await waitForVideoUploadReady(page, budgetMs);
        const formReady = await waitForEditForm(page, 15_000);
        if (!formReady) {
            await page.screenshot({ path: '/tmp/xhs_publish_video_form_debug.png' });
            throwPublishFailure(PUBLISH_ERROR_CODES.platformError, 'Editing form did not appear after video upload. The page layout may have changed. '
                + 'Debug screenshot: /tmp/xhs_publish_video_form_debug.png');
        }

        // ── Step 5: Fill title and body ────────────────────────────────────────────
        await fillField(page, TITLE_SELECTORS, input.title, 'title');
        await page.wait({ time: 0.5 });
        // The video note body only carries the description + inline topics (tags
        // are attached via the same inline-# flow as 图文, not appended as text).
        // Always overwrite the body, including with an empty string. Creator
        // Center may restore an auto-saved draft directly into editor_ready;
        // skipping an empty description would publish that draft's old body.
        await fillField(page, BODY_SELECTORS, input.description, 'content');
        await page.wait({ time: 0.5 });

        // ── Step 6: Attach topics (inline # flow) ──────────────────────────────────
        let addedTopics = [];
        if (input.tags.length) {
            addedTopics = await addTopics(page, BODY_SELECTORS, input.tags);
        }

        // ── Step 7: Publish or save draft ──────────────────────────────────────────
        const actionLabels = isDraft ? ['暂存离开', '存草稿'] : ['发布', '发布笔记'];
        const invokeResult = await invokePublishAction(page, { isDraft, labels: actionLabels });
        if (!invokeResult?.ok) {
            await page.screenshot({ path: '/tmp/xhs_publish_video_submit_debug.png' });
            const viaClause = invokeResult?.via ? ` (via=${invokeResult.via})` : '';
            const lastMethodClause = invokeResult?.lastMethodError ? `, lastMethodError=${invokeResult.lastMethodError}` : '';
            throwPublishFailure(PUBLISH_ERROR_CODES.platformError, `Could not trigger "${actionLabels[0]}" action${viaClause}${lastMethodClause}. `
                + 'Debug screenshot: /tmp/xhs_publish_video_submit_debug.png');
        }

        // ── Step 8: Verify a terminal publish result ────────────────────────────────
        const publishResult = await waitForVideoPublishResult(page, { isDraft });

        const detailParts = [
            addedTopics.length ? `话题: ${addedTopics.join(' ')}` : '',
            publishResult.message || publishResult.url || '',
        ].filter(Boolean);
        const message = `小红书视频${isDraft ? '暂存' : '发布'}成功: "${input.title}"`
            + (detailParts.length ? ` · ${detailParts.join(' · ')}` : '');
        return successResult(PLATFORM, message, {
            url: publishResult.url || '',
            draft: isDraft,
        });
    },
});

export const __test__ = {
    classifyVideoPublishState,
    hasVideoUploadFailure,
    isKnownPublishResultUrl,
};
