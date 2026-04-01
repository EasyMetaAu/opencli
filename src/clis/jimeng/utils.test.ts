import { describe, expect, it } from 'vitest';
import { normalizeRecord } from './utils.js';

// ── Fixtures: new API schema (records_list, 2026-03+) ──────────────────────

const NEW_SCHEMA_VIDEO = {
  history_record_id: '30241682199308',
  generate_type: 2,
  status: 50,
  created_time: 1774793316.952,
  submit_id: '8b41b3c6-9e5a-4674-a2d1-e2e0ae84f0cd',
  model_info: { model_name: 'Seedance 2.0 Fast' },
  item_list: [{
    common_attr: {
      video_url: 'https://v3-web.douyinvod.com/video.mp4',
      prompt: '两只小狗干杯',
      cover_url: 'https://example.com/cover.jpg',
    },
    image: { large_images: [] },
    aigc_image_params: { text2image_params: { prompt: '两只小狗干杯' } },
  }],
};

const NEW_SCHEMA_IMAGE = {
  history_record_id: '30293101988364',
  generate_type: 1,
  status: 50,
  created_time: 1774890621.624,
  model_info: { model_name: '图片5.0 Lite' },
  item_list: [{
    common_attr: { prompt: '录音室里的猫咪' },
    image: {
      large_images: [{ image_url: 'https://p3-dreamina-sign.byteimg.com/image.png' }],
    },
    aigc_image_params: {
      text2image_params: { prompt: '录音室里的猫咪和拉布拉多' },
    },
  }],
};

const NEW_SCHEMA_QUEUED = {
  history_record_id: '30300000000000',
  generate_type: 2,
  status: 10,
  created_time: 1774900000,
  model_info: { model_name: 'Seedance 2.0' },
  item_list: [],
};

// New schema video with transcoded_video (real structure from API exploration)
const NEW_SCHEMA_VIDEO_TRANSCODED = {
  history_record_id: '30300252136204',
  generate_type: 10,
  status: 50,
  created_time: 1774927785.416,
  model_info: { model_name: '' },
  draft_content: JSON.stringify({
    type: 'draft',
    component_list: [{
      type: 'video_base_component',
      abilities: {
        gen_video: {
          text_to_video_params: {
            model_req_key: 'dreamina_seedance_40',
            video_gen_inputs: [{
              prompt: '',
              unified_edit_input: {
                meta_list: [{ meta_type: 'text', text: '参考图片生成视频' }],
              },
            }],
          },
        },
      },
    }],
  }),
  item_list: [{
    common_attr: { cover_url: 'https://example.com/cover.jpg' },
    image: undefined,
    video: {
      transcoded_video: {
        '1080p': { video_url: 'https://v6-artist.vlabvod.com/video-1080p.mp4' },
        '720p': { video_url: 'https://v6-artist.vlabvod.com/video-720p.mp4' },
        '360p': { video_url: 'https://v6-artist.vlabvod.com/video-360p.mp4' },
      },
    },
    aigc_image_params: { text2video_params: {} },
  }],
};

// ── Fixtures: old API schema (history_list) ─────────────────────────────────

const OLD_SCHEMA_IMAGE = {
  history_id: 'old-12345',
  common_attr: {
    title: '可爱的小猫',
    status: 102,
    create_time: 1774000000,
  },
  aigc_image_params: {
    text2image_params: {
      prompt: '一只可爱的小猫在草地上',
      model_config: { model_name: 'SDXL' },
    },
  },
  image: {
    large_images: [{ image_url: 'https://old-cdn.example.com/cat.png' }],
  },
  item_list: [],
};

const OLD_SCHEMA_VIDEO = {
  history_id: 'old-67890',
  common_attr: {
    title: '跳舞的猫',
    status: 102,
    create_time: 1774100000,
  },
  aigc_image_params: {
    text2image_params: { prompt: '一只猫在跳舞' },
  },
  image: { large_images: [] },
  item_list: [{ video_url: 'https://old-cdn.example.com/dance.mp4' }],
};

const OLD_SCHEMA_FAILED = {
  history_id: 'old-failed',
  common_attr: {
    title: '失败任务',
    status: 103,
    create_time: 1774200000,
  },
  aigc_image_params: {},
  image: { large_images: [] },
  item_list: [],
};

// ── Tests ───────────────────────────────────────────────────────────────────

describe('normalizeRecord', () => {
  describe('new schema (records_list)', () => {
    it('normalizes completed video', () => {
      const result = normalizeRecord(NEW_SCHEMA_VIDEO);
      expect(result.task_id).toBe('30241682199308');
      expect(result.status).toBe('completed');
      expect(result.type).toBe('video');
      expect(result.url).toBe('https://v3-web.douyinvod.com/video.mp4');
      expect(result.prompt).toBe('两只小狗干杯');
      expect(result.created_at).not.toBe('');
      expect(result.created_at).not.toContain('1970');
    });

    it('normalizes completed image', () => {
      const result = normalizeRecord(NEW_SCHEMA_IMAGE);
      expect(result.task_id).toBe('30293101988364');
      expect(result.status).toBe('completed');
      expect(result.type).toBe('image');
      expect(result.url).toBe('https://p3-dreamina-sign.byteimg.com/image.png');
      expect(result.prompt).toContain('录音室');
      expect(result.model).toBe('图片5.0 Lite');
    });

    it('normalizes queued task', () => {
      const result = normalizeRecord(NEW_SCHEMA_QUEUED);
      expect(result.task_id).toBe('30300000000000');
      expect(result.status).toBe('queued');
      expect(result.url).toBe('');
    });

    it('normalizes video with transcoded_video (prefers 1080p)', () => {
      const result = normalizeRecord(NEW_SCHEMA_VIDEO_TRANSCODED);
      expect(result.task_id).toBe('30300252136204');
      expect(result.status).toBe('completed');
      expect(result.type).toBe('video');
      expect(result.url).toBe('https://v6-artist.vlabvod.com/video-1080p.mp4');
    });

    it('extracts prompt from draft_content for ref-image videos', () => {
      const result = normalizeRecord(NEW_SCHEMA_VIDEO_TRANSCODED);
      expect(result.prompt).toBe('参考图片生成视频');
    });

    it('extracts model from draft_content model_req_key', () => {
      const result = normalizeRecord(NEW_SCHEMA_VIDEO_TRANSCODED);
      expect(result.model).toBe('dreamina_seedance_40');
    });
  });

  describe('old schema (history_list)', () => {
    it('normalizes completed image', () => {
      const result = normalizeRecord(OLD_SCHEMA_IMAGE);
      expect(result.task_id).toBe('old-12345');
      expect(result.status).toBe('completed');
      expect(result.type).toBe('image');
      expect(result.url).toBe('https://old-cdn.example.com/cat.png');
      expect(result.prompt).toContain('可爱的小猫');
      expect(result.model).toBe('SDXL');
      expect(result.created_at).not.toBe('');
      expect(result.created_at).not.toContain('1970');
    });

    it('normalizes completed video', () => {
      const result = normalizeRecord(OLD_SCHEMA_VIDEO);
      expect(result.task_id).toBe('old-67890');
      expect(result.status).toBe('completed');
      expect(result.type).toBe('video');
      expect(result.url).toBe('https://old-cdn.example.com/dance.mp4');
      expect(result.prompt).toContain('猫在跳舞');
      expect(result.created_at).not.toContain('1970');
    });

    it('normalizes failed task', () => {
      const result = normalizeRecord(OLD_SCHEMA_FAILED);
      expect(result.task_id).toBe('old-failed');
      expect(result.status).toBe('failed');
    });
  });

  describe('prompt truncation', () => {
    it('truncates long prompts to 50 chars', () => {
      const record = {
        ...NEW_SCHEMA_IMAGE,
        item_list: [{
          ...NEW_SCHEMA_IMAGE.item_list[0],
          aigc_image_params: {
            text2image_params: { prompt: 'A'.repeat(100) },
          },
        }],
      };
      const result = normalizeRecord(record);
      expect(result.prompt.length).toBeLessThanOrEqual(50);
      expect(result.prompt).toContain('...');
    });
  });
});
