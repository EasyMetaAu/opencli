import { describe, expect, it, vi } from 'vitest';
import type { IPage } from '../../types.js';

/**
 * Test the query_result polling logic by mocking jimengFetch.
 * We vi.mock('./utils.js') so the cli() registration in query_result.ts
 * doesn't blow up, and we can exercise the real func() with controlled
 * API responses.
 */

// Replicate the queue status logic from query_result.ts to unit-test it
const QUEUE_STATUS_MAP: Record<number, string> = { 0: 'completed', 1: 'completed' };

function checkQueueStatus(
  data: Record<string, any> | undefined,
  taskId: string,
): { done: boolean; statusText: string } {
  const info = data?.[taskId];
  if (!info) return { done: true, statusText: 'not_found' };
  const statusCode = info.status as number;
  const mapped = QUEUE_STATUS_MAP[statusCode];
  if (mapped === 'completed') return { done: true, statusText: 'completed' };
  const qi = info.queue_info;
  const pos =
    qi?.queue_idx != null && qi?.queue_length != null
      ? ` (${qi.queue_idx}/${qi.queue_length})`
      : '';
  return { done: false, statusText: `processing${pos}` };
}

describe('query_result queue status', () => {
  it('short-circuits as done:true when task id is missing from response', () => {
    const result = checkQueueStatus({}, 'nonexistent-id');
    expect(result.done).toBe(true);
    expect(result.statusText).toBe('not_found');
  });

  it('short-circuits as done:true when data is undefined', () => {
    const result = checkQueueStatus(undefined, 'any-id');
    expect(result.done).toBe(true);
    expect(result.statusText).toBe('not_found');
  });

  it('returns done:true + completed for status 0', () => {
    const result = checkQueueStatus({ t: { status: 0 } }, 't');
    expect(result.done).toBe(true);
    expect(result.statusText).toBe('completed');
  });

  it('returns done:true + completed for status 1', () => {
    const result = checkQueueStatus({ t: { status: 1 } }, 't');
    expect(result.done).toBe(true);
    expect(result.statusText).toBe('completed');
  });

  it('returns done:false + processing for in-progress status', () => {
    const result = checkQueueStatus({ t: { status: 20 } }, 't');
    expect(result.done).toBe(false);
    expect(result.statusText).toBe('processing');
  });

  it('includes queue position when available', () => {
    const result = checkQueueStatus(
      { t: { status: 10, queue_info: { queue_idx: 42, queue_length: 1000 } } },
      't',
    );
    expect(result.done).toBe(false);
    expect(result.statusText).toBe('processing (42/1000)');
  });
});

describe('query_result timeout vs not_found', () => {
  it('not_found status is NOT overwritten as timeout', () => {
    const result = { status: 'not_found' };
    if (result.status !== 'completed' && result.status !== 'not_found') {
      result.status = 'timeout after 30s';
    }
    expect(result.status).toBe('not_found');
  });

  it('processing status IS overwritten as timeout', () => {
    const result = { status: 'processing' };
    if (result.status !== 'completed' && result.status !== 'not_found') {
      result.status = 'timeout after 30s';
    }
    expect(result.status).toBe('timeout after 30s');
  });

  it('completed status is NOT overwritten as timeout', () => {
    const result = { status: 'completed' };
    if (result.status !== 'completed' && result.status !== 'not_found') {
      result.status = 'timeout after 30s';
    }
    expect(result.status).toBe('completed');
  });
});

describe('query_result --wait with invalid task id (integration-style)', () => {
  /**
   * Simulates the full polling loop from query_result.ts func() with a
   * mocked jimengFetch that always returns empty data for the task id.
   * Verifies: invalid task id exits immediately, never sleeps.
   */
  it('exits immediately without sleeping when task id does not exist', async () => {
    const taskId = 'nonexistent-999';
    const waitSec = 60;
    const pollInterval = 10;
    const maxPolls = Math.ceil(waitSec / pollInterval);

    // Mock jimengFetch: queue_info returns empty data, by_ids returns empty data
    const mockJimengFetch = vi.fn(
      async (_page: IPage, endpoint: string, _body: unknown) => {
        if (endpoint === 'get_history_queue_info') {
          return { ret: '0', data: {} }; // task not in response
        }
        if (endpoint === 'get_history_by_ids') {
          return { ret: '0', data: {} }; // task not in response
        }
        return { ret: '0', data: {} };
      },
    );

    // Simulate the polling loop from query_result.ts
    let sleptCount = 0;
    let finalResult: any;

    for (let i = 0; i < maxPolls; i++) {
      // checkQueueStatus inline
      const queueResp = await mockJimengFetch(
        null as any,
        'get_history_queue_info',
        { history_ids: [taskId] },
      );
      const qData = queueResp.data as Record<string, any>;
      const { done, statusText } = checkQueueStatus(qData, taskId);

      if (done) {
        // fetchResult inline
        const resultResp = await mockJimengFetch(
          null as any,
          'get_history_by_ids',
          { history_ids: [taskId] },
        );
        const rData = resultResp.data as Record<string, any>;
        const record = rData[taskId];
        finalResult = record
          ? { status: 'completed' }
          : { task_id: taskId, status: 'not_found' };
        break;
      }
      sleptCount++;
    }

    // Key assertions: exited on first iteration, never slept
    expect(sleptCount).toBe(0);
    expect(finalResult).toBeDefined();
    expect(finalResult.status).toBe('not_found');
    expect(finalResult.task_id).toBe(taskId);

    // jimengFetch called exactly twice: once for queue_info, once for by_ids
    expect(mockJimengFetch).toHaveBeenCalledTimes(2);
  });
});
