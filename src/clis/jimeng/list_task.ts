/**
 * Jimeng AI list tasks — view recent generation history (images + videos).
 *
 * The get_history API separates images and videos via the `type` body param:
 *   - omitted → image records (generate_type 1/12)
 *   - 'video' → video records (generate_type 2/10)
 *
 * To show both, we issue two requests and merge by created_time desc.
 */

import { cli, Strategy } from '../../registry.js';
import type { IPage } from '../../types.js';
import {
  jimengFetch, checkRet, normalizeRecord,
  type NormalizedTask,
} from './utils.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
function extractItems(data: any): any[] {
  return data?.records_list || data?.history_list || [];
}

async function fetchHistory(
  page: IPage,
  limit: number,
  workspace: string,
  apiType?: string,
): Promise<any[]> {
  const needFilter = workspace !== '';
  const wsId = needFilter ? (parseInt(workspace) || 0) : 0;
  const pageSize = needFilter ? Math.max(limit, 30) : limit;

  const collected: any[] = [];
  let cursor = '';

  for (;;) {
    const body: Record<string, any> = {
      cursor,
      count: pageSize,
      need_page_item: true,
      need_aigc_data: true,
      aigc_mode_list: ['workbench'],
    };
    if (apiType) {
      body.type = apiType;
    }

    const resp = await jimengFetch(page, 'get_history', body);
    checkRet(resp, 'get_history');

    const items = extractItems(resp.data as any);
    if (items.length === 0) break;

    if (needFilter) {
      for (const r of items) {
        if (r.workspace_id === wsId) collected.push(r);
      }
    } else {
      collected.push(...items);
    }

    if (collected.length >= limit) break;

    // Advance cursor for next page
    const nextCursor =
      (resp.data as any)?.cursor ??
      (resp.data as any)?.next_cursor ??
      '';
    if (!nextCursor || nextCursor === cursor) break;
    cursor = nextCursor;
  }

  return collected;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

cli({
  site: 'jimeng',
  name: 'list_task',
  description: '即梦AI 查历史任务 — 列出最近生成的图片/视频任务',
  domain: 'jimeng.jianying.com',
  strategy: Strategy.COOKIE,
  args: [
    { name: 'limit', type: 'int', default: 10, help: '返回条数（默认 10）' },
    { name: 'workspace', type: 'string', default: '', help: '工作区 ID（留空查全部，0=默认）' },
    { name: 'type', type: 'string', default: '', help: '过滤类型：image/video（留空显示全部）' },
  ],
  columns: ['task_id', 'prompt', 'model', 'status', 'type', 'url', 'created_at'],
  navigateBefore: 'https://jimeng.jianying.com/ai-tool/generate?type=video&workspace=0',

  func: async (page: IPage, kwargs) => {
    const limit = kwargs.limit as number;
    const workspace = kwargs.workspace as string;
    const typeFilter = kwargs.type as string;

    if (typeFilter === 'video') {
      const items = await fetchHistory(page, limit, workspace, 'video');
      return items.slice(0, limit).map(normalizeRecord);
    } else if (typeFilter === 'image') {
      const items = await fetchHistory(page, limit, workspace);
      return items.slice(0, limit).map(normalizeRecord);
    }

    // Both: fetch images and videos, merge by created_time desc, deduplicate
    const [imageItems, videoItems] = await Promise.all([
      fetchHistory(page, limit, workspace),
      fetchHistory(page, limit, workspace, 'video'),
    ]);
    const seen = new Set<string>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const merged: any[] = [];
    for (const item of [...imageItems, ...videoItems]) {
      const id = item.history_record_id || item.history_id || '';
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      merged.push(item);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    merged.sort((a: any, b: any) => {
      const ta = a.created_time || a.common_attr?.create_time || 0;
      const tb = b.created_time || b.common_attr?.create_time || 0;
      return tb - ta;
    });
    return merged.slice(0, limit).map(normalizeRecord);
  },
});
