/**
 * Shared utilities for Jimeng AI adapters.
 */

import { AuthRequiredError, CommandExecutionError } from '../../errors.js';
import type { IPage } from '../../types.js';

export const JIMENG_API = '/mweb/v1';
export const COMMON_PARAMS = 'aid=513695&web_version=7.5.0&da_version=3.3.12';

export async function jimengFetch(
  page: IPage,
  endpoint: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const url = `${JIMENG_API}/${endpoint}?${COMMON_PARAMS}`;
  const js = `
    fetch(${JSON.stringify(url)}, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: ${JSON.stringify(JSON.stringify(body))}
    }).then(r => r.json())
  `;
  return (await page.evaluate(js)) as Record<string, unknown>;
}

export function checkRet(res: Record<string, unknown>, context: string): void {
  const ret = res.ret;
  if (ret === '1014' || ret === 1014) {
    throw new AuthRequiredError('jimeng.jianying.com', 'Not logged in');
  }
  if (ret !== '0' && ret !== 0) {
    throw new CommandExecutionError(
      `${context} failed: ret=${ret} errmsg=${(res.errmsg as string) || ''}`,
    );
  }
}

// generate_type mapping
export const GEN_TYPE_MAP: Record<number, string> = {
  1: 'image',
  2: 'video',
  10: 'video',
  12: 'image',
};

// Status codes from get_history (records_list / history_list)
export const STATUS_MAP: Record<number, string> = {
  10: 'queued',
  20: 'processing',
  30: 'failed',
  50: 'completed',
  100: 'processing',
  102: 'completed',
  103: 'failed',
};

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface NormalizedTask {
  task_id: string;
  prompt: string;
  model: string;
  status: string;
  type: string;
  url: string;
  created_at: string;
}

/**
 * Extract the best video URL from transcoded_video, preferring higher quality.
 */
export function extractVideoUrl(item: any): string {
  const transcoded = item?.video?.transcoded_video;
  if (!transcoded) return item?.common_attr?.video_url || item?.video_url || '';
  for (const quality of ['1080p', '720p', '480p', '360p']) {
    if (transcoded[quality]?.video_url) return transcoded[quality].video_url;
  }
  return item?.common_attr?.video_url || item?.video_url || '';
}

/**
 * Parse draft_content JSON to extract prompt and model for video records.
 */
export function parseDraftContent(record: any): { prompt: string; model: string } {
  try {
    const draft =
      typeof record.draft_content === 'string'
        ? JSON.parse(record.draft_content)
        : record.draft_content;
    const comp = draft?.component_list?.[0];
    const genVideo = comp?.abilities?.gen_video?.text_to_video_params;
    const model = genVideo?.model_req_key || '';
    const inp = genVideo?.video_gen_inputs?.[0];
    let prompt = inp?.prompt || '';
    if (!prompt) {
      const metaList = inp?.unified_edit_input?.meta_list;
      if (Array.isArray(metaList)) {
        for (const meta of metaList) {
          if (meta.meta_type === 'text' && meta.text) { prompt = meta.text; break; }
        }
      }
    }
    return { prompt, model };
  } catch {
    return { prompt: '', model: '' };
  }
}

/**
 * Normalize a history record (from get_history or get_history_by_ids)
 * into a consistent NormalizedTask shape.
 */
export function normalizeRecord(record: any): NormalizedTask {
  const i0 = record.item_list?.[0];

  const taskId = record.history_record_id || record.history_id || '';

  const statusCode =
    record.status ??
    record.common_attr?.status ??
    i0?.common_attr?.status ??
    0;
  const status = STATUS_MAP[statusCode] || `unknown(${statusCode})`;

  let type = GEN_TYPE_MAP[record.generate_type ?? 0] || 'unknown';

  let model =
    record.model_info?.model_name ||
    i0?.aigc_image_params?.text2image_params?.model_config?.model_name ||
    record.aigc_image_params?.text2image_params?.model_config?.model_name ||
    '';

  let prompt =
    i0?.aigc_image_params?.text2image_params?.prompt ||
    record.aigc_image_params?.text2image_params?.prompt ||
    i0?.common_attr?.prompt ||
    record.common_attr?.title ||
    '';
  if (record.draft_content) {
    const draft = parseDraftContent(record);
    if (!prompt) prompt = draft.prompt;
    if (!model) model = draft.model;
  }

  let url = '';
  const videoUrl = i0 ? extractVideoUrl(i0) : '';
  const imageUrl =
    i0?.image?.large_images?.[0]?.image_url ||
    record.image?.large_images?.[0]?.image_url ||
    '';

  if (videoUrl) {
    type = 'video';
    url = videoUrl;
  } else if (imageUrl) {
    type = type === 'unknown' ? 'image' : type;
    url = imageUrl;
  }

  const timestamp =
    record.created_time ||
    record.common_attr?.create_time ||
    i0?.common_attr?.create_time ||
    0;
  const createdAt = timestamp
    ? new Date(timestamp * 1000).toLocaleString('zh-CN')
    : '';

  return {
    task_id: taskId,
    prompt: prompt.length > 50 ? prompt.substring(0, 47) + '...' : prompt,
    model,
    status,
    type,
    url,
    created_at: createdAt,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
