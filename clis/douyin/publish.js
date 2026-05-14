/**
 * Douyin publish — 8-phase pipeline for scheduling video posts.
 *
 * Phases:
 *   1. upload auth v5 credentials
 *   2. Apply TOS upload URL
 *   3. TOS multipart upload
 *   4. Cover upload (optional, via ImageX)
 *   5. Enable video
 *   6. Poll transcode
 *   7. Content safety check
 *   8. create_v2 publish
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import { getUploadAuthV5Credentials, applyVideoUploadInner, commitVideoUploadInner } from './_shared/vod-upload.js';
import { tosUpload } from './_shared/tos-upload.js';
import { imagexUpload } from './_shared/imagex-upload.js';
import { browserFetch } from './_shared/browser-fetch.js';
import { generateCreationId } from './_shared/creation-id.js';
import { validateTiming, toUnixSeconds } from './_shared/timing.js';
import { parseTextExtra, extractHashtagNames } from './_shared/text-extra.js';
const VISIBILITY_MAP = {
    public: 0,
    friends: 1,
    private: 2,
};
const IMAGEX_BASE = 'https://imagex.bytedanceapi.com';
const IMAGEX_SERVICE_ID = '1147';
const DEVICE_PARAMS = 'aid=1128&cookie_enabled=true&screen_width=1512&screen_height=982&browser_language=zh-CN&browser_platform=MacIntel&browser_name=Mozilla&browser_online=true&timezone_name=Asia%2FTokyo&support_h265=1';
const DEFAULT_COVER_TOOLS_INFO = JSON.stringify({
    video_cover_source: 2,
    cover_timestamp: 0,
    recommend_timestamp: 0,
    is_cover_edit: 0,
    is_cover_template: 0,
    cover_template_id: '',
    is_text_template: 0,
    text_template_id: '',
    text_template_content: '',
    is_text: 0,
    text_num: 0,
    text_content: '',
    is_use_sticker: 0,
    sticker_id: '',
    is_use_filter: 0,
    filter_id: '',
    is_cover_modify: 0,
    to_status: 0,
    cover_type: 0,
    initial_cover_uri: '',
    cut_coordinate: '',
});
function isFastDetectUnavailable(error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('post_assistant/fast_detect') && (message.includes('Empty response') || message.includes('404') || message.includes('Not Found'));
}
cli({
    site: 'douyin',
    name: 'publish',
    access: 'write',
    description: '定时发布视频到抖音（必须设置 2h ~ 14天后的发布时间）',
    domain: 'creator.douyin.com',
    strategy: Strategy.COOKIE,
    args: [
        { name: 'video', required: true, positional: true, help: '视频文件路径' },
        { name: 'title', required: true, help: '视频标题（≤30字）' },
        { name: 'schedule', required: true, help: '定时发布时间（ISO8601 或 Unix 秒，2h ~ 14天后）' },
        { name: 'caption', default: '', help: '正文内容（≤1000字，支持 #话题）' },
        { name: 'cover', default: '', help: '封面图片路径（不提供时使用视频截帧）' },
        { name: 'visibility', default: 'public', choices: ['public', 'friends', 'private'] },
        { name: 'allow_download', type: 'bool', default: false, help: '允许下载' },
        { name: 'collection', default: '', help: '合集 ID' },
        { name: 'activity', default: '', help: '活动 ID' },
        { name: 'poi_id', default: '', help: '地理位置 ID' },
        { name: 'poi_name', default: '', help: '地理位置名称' },
        { name: 'hotspot', default: '', help: '关联热点词' },
        { name: 'no_safety_check', type: 'bool', default: false, help: '跳过内容安全检测' },
        { name: 'sync_toutiao', type: 'bool', default: false, help: '同步发布到头条' },
    ],
    columns: ['status', 'aweme_id', 'url', 'publish_time'],
    func: async (page, kwargs) => {
        // ── Fail-fast validation ────────────────────────────────────────────
        const videoPath = path.resolve(kwargs.video);
        if (!fs.existsSync(videoPath)) {
            throw new ArgumentError(`视频文件不存在: ${videoPath}`);
        }
        const ext = path.extname(videoPath).toLowerCase();
        if (!['.mp4', '.mov', '.avi', '.webm'].includes(ext)) {
            throw new ArgumentError(`不支持的视频格式: ${ext}（支持 mp4/mov/avi/webm）`);
        }
        const fileSize = fs.statSync(videoPath).size;
        const title = kwargs.title;
        if (title.length > 30) {
            throw new ArgumentError('标题不能超过 30 字');
        }
        const caption = kwargs.caption || '';
        if (caption.length > 1000) {
            throw new ArgumentError('正文不能超过 1000 字');
        }
        const timingTs = toUnixSeconds(kwargs.schedule);
        validateTiming(timingTs);
        const visibilityType = VISIBILITY_MAP[kwargs.visibility] ?? 0;
        const coverPath = kwargs.cover;
        if (coverPath) {
            if (!fs.existsSync(path.resolve(coverPath))) {
                throw new ArgumentError(`封面文件不存在: ${path.resolve(coverPath)}`);
            }
        }
        // ── Phase 1: upload credentials ────────────────────────────────────
        const credentials = await getUploadAuthV5Credentials(page);
        // ── Phase 2: Apply TOS upload URL ───────────────────────────────────
        const tosUploadInfo = await applyVideoUploadInner(fileSize, credentials);
        let coverUri = '';
        let coverWidth = 720;
        let coverHeight = 1280;
        // ── Phase 3: TOS upload ─────────────────────────────────────────────
        await tosUpload({
            filePath: videoPath,
            uploadInfo: tosUploadInfo,
            credentials,
            onProgress: (uploaded, total) => {
                const pct = Math.round((uploaded / total) * 100);
                process.stderr.write(`\r  上传进度: ${pct}%`);
            },
        });
        process.stderr.write('\n');
        process.stderr.write('  提交上传...\n');
        const committedVideo = await commitVideoUploadInner(tosUploadInfo, credentials);
        const videoId = committedVideo.video_id;
        process.stderr.write(`  上传已提交: ${videoId}\n`);
        coverWidth = committedVideo.width || coverWidth;
        coverHeight = committedVideo.height || coverHeight;
        if (!coverUri && committedVideo.poster_uri) {
            coverUri = committedVideo.poster_uri;
        }
        // ── Phase 4: Cover upload (optional) ────────────────────────────────
        if (kwargs.cover) {
            const resolvedCoverPath = path.resolve(kwargs.cover);
            // 4A: Apply ImageX upload
            const applyUrl = `${IMAGEX_BASE}/?Action=ApplyImageUpload&ServiceId=${IMAGEX_SERVICE_ID}&Version=2018-08-01&UploadNum=1`;
            const applyJs = `fetch(${JSON.stringify(applyUrl)}, { credentials: 'include' }).then(r => r.json())`;
            const applyRes = (await page.evaluate(applyJs));
            const { StoreInfos: imgStoreInfos } = applyRes.Result.UploadAddress;
            const imgUploadUrl = `https://${imgStoreInfos[0].UploadHost}/${imgStoreInfos[0].StoreUri}`;
            // 4B: Upload image
            const coverStoreUri = await imagexUpload(resolvedCoverPath, {
                upload_url: imgUploadUrl,
                store_uri: imgStoreInfos[0].StoreUri,
            });
            // 4C: Commit ImageX upload
            const commitUrl = `${IMAGEX_BASE}/?Action=CommitImageUpload&ServiceId=${IMAGEX_SERVICE_ID}&Version=2018-08-01`;
            const commitBody = JSON.stringify({ SuccessObjKeys: [coverStoreUri] });
            const commitJs = `
        fetch(${JSON.stringify(commitUrl)}, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: ${JSON.stringify(commitBody)}
        }).then(r => r.json())
      `;
            await page.evaluate(commitJs);
            coverUri = coverStoreUri;
        }
        // The gateway upload flow returns a committed VOD upload result; the legacy
        // enable/transend endpoints can hang for that flow, so create_v2 consumes
        // the committed video_id and poster metadata directly.
        // ── Phase 7: Content safety check ───────────────────────────────────
        if (!kwargs.no_safety_check) {
            const safetyUrl = 'https://creator.douyin.com/aweme/v1/post_assistant/fast_detect/pre_check';
            const safetyBody = {
                video_id: videoId,
                title,
                desc: caption,
            };
            let safetyCheckAvailable = true;
            try {
                await browserFetch(page, 'POST', safetyUrl, { body: safetyBody });
            } catch (error) {
                if (!isFastDetectUnavailable(error)) {
                    throw error;
                }
                safetyCheckAvailable = false;
                process.stderr.write('  内容安全预检接口不可用，跳过本地预检，交由 create_v2 后的平台审核。\n');
            }
            const pollUrl = 'https://creator.douyin.com/aweme/v1/post_assistant/fast_detect/poll';
            const deadline = Date.now() + 30_000;
            let safetyPassed = false;
            while (safetyCheckAvailable && Date.now() < deadline) {
                let pollRes;
                try {
                    pollRes = (await browserFetch(page, 'POST', pollUrl, {
                        body: safetyBody,
                    }));
                } catch (error) {
                    if (!isFastDetectUnavailable(error)) {
                        throw error;
                    }
                    safetyCheckAvailable = false;
                    process.stderr.write('  内容安全轮询接口不可用，跳过本地预检，交由 create_v2 后的平台审核。\n');
                    break;
                }
                if (pollRes.status === 0) {
                    safetyPassed = true;
                    break;
                }
                if (pollRes.status === 1) {
                    throw new CommandExecutionError('内容安全检测不通过，请修改后重试', '使用 --no_safety_check 跳过');
                }
                await new Promise((r) => setTimeout(r, 2000));
            }
            if (safetyCheckAvailable && !safetyPassed) {
                throw new CommandExecutionError('内容安全检测超时（30s），请稍后重试', '使用 --no_safety_check 跳过');
            }
        }
        // ── Phase 8: create_v2 publish ──────────────────────────────────────
        const hashtagNames = extractHashtagNames(caption);
        const hashtags = [];
        let searchFrom = 0;
        for (const name of hashtagNames) {
            const idx = caption.indexOf(`#${name}`, searchFrom);
            if (idx === -1)
                continue;
            hashtags.push({ name, id: 0, start: idx, end: idx + name.length + 1 });
            searchFrom = idx + name.length + 1;
        }
        const textExtraArr = parseTextExtra(caption, hashtags);
        const publishBody = {
            item: {
                common: {
                    text: caption,
                    caption: '',
                    item_title: title,
                    activity: JSON.stringify(kwargs.activity ? [kwargs.activity] : []),
                    text_extra: JSON.stringify(textExtraArr),
                    challenges: '[]',
                    mentions: '[]',
                    hashtag_source: '',
                    hot_sentence: kwargs.hotspot || '',
                    interaction_stickers: '[]',
                    visibility_type: visibilityType,
                    download: kwargs.allow_download ? 1 : 0,
                    timing: timingTs,
                    creation_id: generateCreationId(),
                    media_type: 4,
                    video_id: videoId,
                    music_source: 0,
                    music_id: null,
                    ...(kwargs.poi_id
                        ? { poi_id: kwargs.poi_id, poi_name: kwargs.poi_name }
                        : {}),
                },
                cover: {
                    poster: coverUri,
                    custom_cover_image_height: coverHeight,
                    custom_cover_image_width: coverWidth,
                    poster_delay: 0,
                    cover_tools_info: DEFAULT_COVER_TOOLS_INFO,
                    cover_tools_extend_info: '{}',
                },
                mix: kwargs.collection
                    ? { mix_id: kwargs.collection, mix_order: 0 }
                    : {},
                chapter: {
                    chapter: JSON.stringify({
                        chapter_abstract: '',
                        chapter_details: [],
                        chapter_type: 0,
                    }),
                },
                anchor: {},
                sync: {
                    should_sync: false,
                    sync_to_toutiao: kwargs.sync_toutiao ? 1 : 0,
                },
                open_platform: {},
                assistant: { is_preview: 0, is_post_assistant: 1 },
                declare: { user_declare_info: '{}' },
            },
        };
        const publishUrl = `https://creator.douyin.com/web/api/media/aweme/create_v2/?read_aid=2906&${DEVICE_PARAMS}`;
        process.stderr.write('  创建定时发布...\n');
        const publishRes = (await browserFetch(page, 'POST', publishUrl, {
            body: publishBody,
        }));
        const awemeId = publishRes.aweme_id ?? publishRes.item_id;
        if (!awemeId) {
            throw new CommandExecutionError(`发布成功但未返回 aweme_id/item_id: ${JSON.stringify(publishRes)}`);
        }
        const url = `https://www.douyin.com/video/${awemeId}`;
        const publishTimeStr = new Date(timingTs * 1000).toLocaleString('zh-CN', {
            timeZone: 'Asia/Tokyo',
        });
        return [
            {
                status: '✅ 定时发布成功！',
                aweme_id: awemeId,
                url,
                publish_time: publishTimeStr,
            },
        ];
    },
});
