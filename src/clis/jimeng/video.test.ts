import { describe, expect, it } from 'vitest';
import { ArgumentError } from '../../errors.js';
import { buildDraftContent, buildVideoInfo, parseRefImagePaths, validateVideoParams } from './video.js';

// ── Shared fixtures ──────────────────────────────────────────────────────────

const MODEL_CFG = { benefit: 'dreamina_seedance_20_fast', root: 'dreamina_seedance_40', reqKey: 'dreamina_seedance_40' };
const PROMPT = 'two dogs toasting';
const BASE_OPTS = { prompt: PROMPT, ratio: '16:9', duration: 4, modelCfg: MODEL_CFG };

const FAKE_IMG = { uri: 'image-uri-abc', width: 1920, height: 1080 };
const FAKE_IMG2 = { uri: 'image-uri-xyz', width: 1280, height: 720 };
const FAKE_VID = { vid: 'vid-abc123', fps: 30, width: 1920, height: 1080, durationMs: 5000, name: 'ref.mp4' };

function parseDraft(draftContent: string) {
  const draft = JSON.parse(draftContent);
  const component = draft.component_list[0];
  const params = component.abilities.gen_video.text_to_video_params;
  const videoGenInput = params.video_gen_inputs[0];
  return { draft, component, params, videoGenInput };
}

// ── Parameter validation tests ───────────────────────────────────────────────

describe('validateVideoParams', () => {
  it('allows text-to-video (no images)', () => {
    expect(() => validateVideoParams({ refImagePaths: [], firstFramePath: '', lastFramePath: '' })).not.toThrow();
  });

  it('allows ref-image only', () => {
    expect(() => validateVideoParams({ refImagePaths: ['ref.png'], firstFramePath: '', lastFramePath: '' })).not.toThrow();
  });

  it('allows multiple ref-images only', () => {
    expect(() => validateVideoParams({ refImagePaths: ['ref-a.png', 'ref-b.png'], firstFramePath: '', lastFramePath: '' })).not.toThrow();
  });

  it('allows first-frame only', () => {
    expect(() => validateVideoParams({ refImagePaths: [], firstFramePath: 'first.png', lastFramePath: '' })).not.toThrow();
  });

  it('allows first-frame + last-frame', () => {
    expect(() => validateVideoParams({ refImagePaths: [], firstFramePath: 'first.png', lastFramePath: 'last.png' })).not.toThrow();
  });

  it('rejects --last-frame without --first-frame', () => {
    expect(() => validateVideoParams({ refImagePaths: [], firstFramePath: '', lastFramePath: 'last.png' }))
      .toThrow(ArgumentError);
  });

  it('rejects --last-frame without --first-frame (error message)', () => {
    expect(() => validateVideoParams({ refImagePaths: [], firstFramePath: '', lastFramePath: 'last.png' }))
      .toThrow('--last-frame');
  });

  it('rejects --ref-image with --first-frame', () => {
    expect(() => validateVideoParams({ refImagePaths: ['ref.png'], firstFramePath: 'first.png', lastFramePath: '' }))
      .toThrow(ArgumentError);
  });

  it('rejects --ref-image with --last-frame', () => {
    expect(() => validateVideoParams({ refImagePaths: ['ref.png'], firstFramePath: '', lastFramePath: 'last.png' }))
      .toThrow(ArgumentError);
  });

  it('rejects --ref-image with both --first-frame and --last-frame', () => {
    expect(() => validateVideoParams({ refImagePaths: ['ref.png'], firstFramePath: 'first.png', lastFramePath: 'last.png' }))
      .toThrow(ArgumentError);
  });
});

describe('parseRefImagePaths', () => {
  it('keeps a single ref-image path as one entry', () => {
    expect(parseRefImagePaths('/path/to/img.jpg')).toEqual(['/path/to/img.jpg']);
  });

  it('splits comma-separated ref-image paths', () => {
    expect(parseRefImagePaths('/path/a.jpg,/path/b.jpg')).toEqual(['/path/a.jpg', '/path/b.jpg']);
  });

  it('trims whitespace and filters empty entries', () => {
    expect(parseRefImagePaths(' /path/a.jpg , , /path/b.jpg ')).toEqual(['/path/a.jpg', '/path/b.jpg']);
  });
});

// ── buildDraftContent payload tests ─────────────────────────────────────────

describe('buildDraftContent — text-to-video mode', () => {
  it('sets prompt on videoGenInput', () => {
    const { videoGenInput } = parseDraft(buildDraftContent(BASE_OPTS));
    expect(videoGenInput.prompt).toBe(PROMPT);
  });

  it('has no first_frame_image', () => {
    const { videoGenInput } = parseDraft(buildDraftContent(BASE_OPTS));
    expect(videoGenInput.first_frame_image).toBeUndefined();
  });

  it('has no last_frame_image', () => {
    const { videoGenInput } = parseDraft(buildDraftContent(BASE_OPTS));
    expect(videoGenInput.last_frame_image).toBeUndefined();
  });

  it('has no unified_edit_input', () => {
    const { videoGenInput } = parseDraft(buildDraftContent(BASE_OPTS));
    expect(videoGenInput.unified_edit_input).toBeUndefined();
  });

  it('min_features is empty', () => {
    const { draft } = parseDraft(buildDraftContent(BASE_OPTS));
    expect(draft.min_features).toEqual([]);
  });
});

describe('buildDraftContent — ref-image mode', () => {
  const opts = { ...BASE_OPTS, refImages: [FAKE_IMG] };

  it('has unified_edit_input with material_list', () => {
    const { videoGenInput } = parseDraft(buildDraftContent(opts));
    expect(videoGenInput.unified_edit_input).toBeDefined();
    const uei = videoGenInput.unified_edit_input as Record<string, unknown>;
    expect(Array.isArray(uei.material_list)).toBe(true);
  });

  it('places image uri inside unified_edit_input.material_list', () => {
    const { videoGenInput } = parseDraft(buildDraftContent(opts));
    const uei = videoGenInput.unified_edit_input as Record<string, unknown>;
    const material = (uei.material_list as Array<Record<string, unknown>>)[0];
    const imageInfo = material.image_info as Record<string, unknown>;
    expect(imageInfo.uri).toBe(FAKE_IMG.uri);
  });

  it('puts prompt in unified_edit_input.meta_list', () => {
    const { videoGenInput } = parseDraft(buildDraftContent(opts));
    const uei = videoGenInput.unified_edit_input as Record<string, unknown>;
    const meta = (uei.meta_list as Array<Record<string, unknown>>)[0];
    expect(meta.text).toBe(PROMPT);
  });

  it('has no first_frame_image', () => {
    const { videoGenInput } = parseDraft(buildDraftContent(opts));
    expect(videoGenInput.first_frame_image).toBeUndefined();
  });

  it('has no last_frame_image', () => {
    const { videoGenInput } = parseDraft(buildDraftContent(opts));
    expect(videoGenInput.last_frame_image).toBeUndefined();
  });

  it('includes AIGC_Video_UnifiedEdit in min_features', () => {
    const { draft } = parseDraft(buildDraftContent(opts));
    expect(draft.min_features).toContain('AIGC_Video_UnifiedEdit');
  });
});

describe('buildDraftContent — multi ref-image mode', () => {
  const opts = { ...BASE_OPTS, refImages: [FAKE_IMG, FAKE_IMG2] };

  it('places multiple images inside unified_edit_input.material_list in order', () => {
    const { videoGenInput } = parseDraft(buildDraftContent(opts));
    const uei = videoGenInput.unified_edit_input as Record<string, unknown>;
    const materials = uei.material_list as Array<Record<string, unknown>>;

    expect(materials).toHaveLength(2);
    expect((materials[0].image_info as Record<string, unknown>).uri).toBe(FAKE_IMG.uri);
    expect((materials[1].image_info as Record<string, unknown>).uri).toBe(FAKE_IMG2.uri);
  });

  it('includes AIGC_Video_UnifiedEdit in min_features', () => {
    const { draft } = parseDraft(buildDraftContent(opts));
    expect(draft.min_features).toContain('AIGC_Video_UnifiedEdit');
  });
});

describe('buildDraftContent — first-frame mode', () => {
  const opts = { ...BASE_OPTS, firstFrame: FAKE_IMG };

  it('has first_frame_image with correct uri', () => {
    const { videoGenInput } = parseDraft(buildDraftContent(opts));
    const ffi = videoGenInput.first_frame_image as Record<string, unknown>;
    expect(ffi.uri).toBe(FAKE_IMG.uri);
  });

  it('sets prompt on videoGenInput', () => {
    const { videoGenInput } = parseDraft(buildDraftContent(opts));
    expect(videoGenInput.prompt).toBe(PROMPT);
  });

  it('has no last_frame_image', () => {
    const { videoGenInput } = parseDraft(buildDraftContent(opts));
    expect(videoGenInput.last_frame_image).toBeUndefined();
  });

  it('has NO unified_edit_input', () => {
    const { videoGenInput } = parseDraft(buildDraftContent(opts));
    expect(videoGenInput.unified_edit_input).toBeUndefined();
  });

  it('min_features is empty', () => {
    const { draft } = parseDraft(buildDraftContent(opts));
    expect(draft.min_features).toEqual([]);
  });
});

describe('buildDraftContent — first-to-last-frame mode', () => {
  const opts = { ...BASE_OPTS, firstFrame: FAKE_IMG, lastFrame: FAKE_IMG2 };

  it('has first_frame_image with correct uri', () => {
    const { videoGenInput } = parseDraft(buildDraftContent(opts));
    const ffi = videoGenInput.first_frame_image as Record<string, unknown>;
    expect(ffi.uri).toBe(FAKE_IMG.uri);
  });

  it('has last_frame_image with correct uri', () => {
    const { videoGenInput } = parseDraft(buildDraftContent(opts));
    const lfi = videoGenInput.last_frame_image as Record<string, unknown>;
    expect(lfi.uri).toBe(FAKE_IMG2.uri);
  });

  it('sets prompt on videoGenInput', () => {
    const { videoGenInput } = parseDraft(buildDraftContent(opts));
    expect(videoGenInput.prompt).toBe(PROMPT);
  });

  it('has NO unified_edit_input', () => {
    const { videoGenInput } = parseDraft(buildDraftContent(opts));
    expect(videoGenInput.unified_edit_input).toBeUndefined();
  });

  it('first and last frame images are distinct', () => {
    const { videoGenInput } = parseDraft(buildDraftContent(opts));
    const ffi = videoGenInput.first_frame_image as Record<string, unknown>;
    const lfi = videoGenInput.last_frame_image as Record<string, unknown>;
    expect(ffi.uri).not.toBe(lfi.uri);
  });

  it('min_features is empty', () => {
    const { draft } = parseDraft(buildDraftContent(opts));
    expect(draft.min_features).toEqual([]);
  });
});

// ── buildVideoInfo tests ─────────────────────────────────────────────────────

describe('buildVideoInfo', () => {
  it('returns correct structure', () => {
    const info = buildVideoInfo(FAKE_VID) as Record<string, unknown>;
    expect(info.type).toBe('video');
    expect(info.source_from).toBe('upload');
    expect(info.vid).toBe(FAKE_VID.vid);
    expect(info.fps).toBe(FAKE_VID.fps);
    expect(info.width).toBe(FAKE_VID.width);
    expect(info.height).toBe(FAKE_VID.height);
    expect(info.duration).toBe(FAKE_VID.durationMs);
    expect(info.name).toBe(FAKE_VID.name);
  });

  it('has no uri field (uses vid instead)', () => {
    const info = buildVideoInfo(FAKE_VID) as Record<string, unknown>;
    expect(info.uri).toBeUndefined();
    expect(info.image_uri).toBeUndefined();
  });
});

// ── buildDraftContent — ref-video mode ──────────────────────────────────────

describe('buildDraftContent — ref-video mode', () => {
  const opts = { ...BASE_OPTS, refVideo: FAKE_VID };

  it('has unified_edit_input with material_list', () => {
    const { videoGenInput } = parseDraft(buildDraftContent(opts));
    expect(videoGenInput.unified_edit_input).toBeDefined();
    const uei = videoGenInput.unified_edit_input as Record<string, unknown>;
    expect(Array.isArray(uei.material_list)).toBe(true);
  });

  it('material_list[0] has material_type video', () => {
    const { videoGenInput } = parseDraft(buildDraftContent(opts));
    const uei = videoGenInput.unified_edit_input as Record<string, unknown>;
    const material = (uei.material_list as Array<Record<string, unknown>>)[0];
    expect(material.material_type).toBe('video');
  });

  it('video_info has correct vid', () => {
    const { videoGenInput } = parseDraft(buildDraftContent(opts));
    const uei = videoGenInput.unified_edit_input as Record<string, unknown>;
    const material = (uei.material_list as Array<Record<string, unknown>>)[0];
    const videoInfo = material.video_info as Record<string, unknown>;
    expect(videoInfo.vid).toBe(FAKE_VID.vid);
  });

  it('video_info.duration is in milliseconds', () => {
    const { videoGenInput } = parseDraft(buildDraftContent(opts));
    const uei = videoGenInput.unified_edit_input as Record<string, unknown>;
    const material = (uei.material_list as Array<Record<string, unknown>>)[0];
    const videoInfo = material.video_info as Record<string, unknown>;
    expect(videoInfo.duration).toBe(5000); // FAKE_VID.durationMs
  });

  it('puts prompt in unified_edit_input.meta_list', () => {
    const { videoGenInput } = parseDraft(buildDraftContent(opts));
    const uei = videoGenInput.unified_edit_input as Record<string, unknown>;
    const meta = (uei.meta_list as Array<Record<string, unknown>>)[0];
    expect(meta.text).toBe(PROMPT);
  });

  it('has no first_frame_image or last_frame_image', () => {
    const { videoGenInput } = parseDraft(buildDraftContent(opts));
    expect(videoGenInput.first_frame_image).toBeUndefined();
    expect(videoGenInput.last_frame_image).toBeUndefined();
  });

  it('has no image_info (using video_info instead)', () => {
    const { videoGenInput } = parseDraft(buildDraftContent(opts));
    const uei = videoGenInput.unified_edit_input as Record<string, unknown>;
    const material = (uei.material_list as Array<Record<string, unknown>>)[0];
    expect(material.image_info).toBeUndefined();
  });

  it('includes AIGC_Video_UnifiedEdit in min_features', () => {
    const { draft } = parseDraft(buildDraftContent(opts));
    expect(draft.min_features).toContain('AIGC_Video_UnifiedEdit');
  });
});

// ── validateVideoParams — ref-video mutual exclusion ────────────────────────

describe('validateVideoParams — ref-video', () => {
  it('allows ref-video only', () => {
    expect(() => validateVideoParams({ refImagePaths: [], refVideoPath: 'ref.mp4', firstFramePath: '', lastFramePath: '' })).not.toThrow();
  });

  it('rejects --ref-video with --ref-image', () => {
    expect(() => validateVideoParams({ refImagePaths: ['ref.png'], refVideoPath: 'ref.mp4', firstFramePath: '', lastFramePath: '' }))
      .toThrow(ArgumentError);
  });

  it('rejects --ref-video with --first-frame', () => {
    expect(() => validateVideoParams({ refImagePaths: [], refVideoPath: 'ref.mp4', firstFramePath: 'first.png', lastFramePath: '' }))
      .toThrow(ArgumentError);
  });

  it('rejects --ref-video with --last-frame', () => {
    expect(() => validateVideoParams({ refImagePaths: [], refVideoPath: 'ref.mp4', firstFramePath: '', lastFramePath: 'last.png' }))
      .toThrow(ArgumentError);
  });

  it('allows no ref flags (text-to-video)', () => {
    expect(() => validateVideoParams({ refImagePaths: [], refVideoPath: '', firstFramePath: '', lastFramePath: '' })).not.toThrow();
  });
});
