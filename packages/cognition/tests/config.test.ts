import { describe, it, expect, afterEach } from 'vitest';
import { loadClassifierEnvConfig } from '../src/config.js';

describe('Cognition config — env-driven thresholds', () => {
  afterEach(() => {
    delete process.env['CLASSIFIER_TOP_K'];
    delete process.env['CLASSIFIER_SIMILARITY_THRESHOLD'];
  });

  it('loads CLASSIFIER_TOP_K from env', () => {
    process.env['CLASSIFIER_TOP_K'] = '10';
    const config = loadClassifierEnvConfig();
    expect(config.topK).toBe(10);
  });

  it('loads CLASSIFIER_SIMILARITY_THRESHOLD from env', () => {
    process.env['CLASSIFIER_SIMILARITY_THRESHOLD'] = '0.5';
    const config = loadClassifierEnvConfig();
    expect(config.similarityThreshold).toBe(0.5);
  });

  it('defaults to K=5, threshold=0.3 when env vars are not set', () => {
    delete process.env['CLASSIFIER_TOP_K'];
    delete process.env['CLASSIFIER_SIMILARITY_THRESHOLD'];
    const config = loadClassifierEnvConfig();
    expect(config.topK).toBe(5);
    expect(config.similarityThreshold).toBe(0.3);
  });
});
