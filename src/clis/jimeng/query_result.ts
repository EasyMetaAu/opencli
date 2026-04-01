/**
 * Jimeng AI task result query — fetch generation result by task_id.
 *
 * API exploration results (2026-04-01):
 *
 * get_history_queue_info:
 *   - Request: { history_ids: [taskId] }
 *   - Response: data[taskId].status — NOTE: uses different status codes than get_history:
 *     0 = completed (with queue_info), 1 = completed (no queue_info), other = in progress
 *   - Only used for lightweight status check during polling, NOT for final data.
 *
 * get_history_by_ids:
 *   - Request: { history_ids: [taskId] }
 *   - Response: data[taskId] — same record structure as get_history records_list items.
 *     Reuse normalizeRecord() to extract all fields consistently.
 *   - Video URL: item_list[0].video.transcoded_video["1080p"].video_url
 *   - Image URL: item_list[0].image.large_images[0].image_url
 */

import { cli, Strategy } from '../../registry.js';
import type { IPage } from '../../types.js';
import { jimengFetch, checkRet, normalizeRecord } from './utils.js';

// get_history_queue_info uses its own status codes (different from get_history)
const QUEUE_STATUS_MAP: Record<number, string> = {
  0: 'completed',
  1: 'completed',
};

cli({
  site: 'jimeng',
  name: 'query_result',
  description: '即梦AI 查任务结果 — 获取生成的视频/图片详情',
  domain: 'jimeng.jianying.com',
  strategy: Strategy.COOKIE,
  args: [
    { name: 'task_id', type: 'string', required: true, positional: true, help: '任务 ID（list_task/video 命令返回的 task_id）' },
    { name: 'wait', type: 'int', default: 0, help: '轮询等待秒数（默认 0 查一次就返回）' },
  ],
  columns: ['task_id', 'prompt', 'model', 'status', 'type', 'url', 'created_at'],
  navigateBefore: 'https://jimeng.jianying.com/ai-tool/generate?type=video&workspace=0',

  func: async (page: IPage, kwargs) => {
    const taskId = kwargs.task_id as string;
    const waitSec = kwargs.wait as number;

    const fetchResult = async () => {
      // Use get_history_by_ids directly — it returns the full record
      // with the same structure as get_history records_list items.
      const resp = await jimengFetch(page, 'get_history_by_ids', {
        history_ids: [taskId],
      });
      checkRet(resp, 'get_history_by_ids');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = resp.data as Record<string, any> | undefined;
      const record = data?.[taskId];

      if (!record) {
        return {
          task_id: taskId, prompt: '', model: '',
          status: 'not_found', type: '', url: '', created_at: '',
        };
      }

      return normalizeRecord(record);
    };

    const checkQueueStatus = async (): Promise<{ done: boolean; statusText: string }> => {
      const resp = await jimengFetch(page, 'get_history_queue_info', {
        history_ids: [taskId],
      });
      checkRet(resp, 'get_history_queue_info');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = resp.data as Record<string, any> | undefined;
      const info = data?.[taskId];
      if (!info) return { done: true, statusText: 'not_found' };

      const statusCode = info.status as number;
      const mapped = QUEUE_STATUS_MAP[statusCode];
      if (mapped === 'completed') return { done: true, statusText: 'completed' };

      // Extract queue position if available
      const qi = info.queue_info;
      const pos = qi?.queue_idx != null && qi?.queue_length != null
        ? ` (${qi.queue_idx}/${qi.queue_length})`
        : '';
      return { done: false, statusText: `processing${pos}` };
    };

    // Single query — just fetch full result directly
    if (waitSec <= 0) {
      return [await fetchResult()];
    }

    // Poll mode: use lightweight queue_info for status, fetch full result on completion
    const pollInterval = 10;
    const maxPolls = Math.ceil(waitSec / pollInterval);

    for (let i = 0; i < maxPolls; i++) {
      const { done, statusText } = await checkQueueStatus();
      if (done) {
        return [await fetchResult()];
      }
      process.stderr.write(`  [${i + 1}/${maxPolls}] ${statusText}, waiting...\n`);
      await new Promise((r) => setTimeout(r, pollInterval * 1000));
    }

    // Timeout — fetch whatever we have, but don't mask not_found as timeout
    const result = await fetchResult();
    if (result.status !== 'completed' && result.status !== 'not_found') {
      result.status = `timeout after ${waitSec}s`;
    }
    return [result];
  },
});
