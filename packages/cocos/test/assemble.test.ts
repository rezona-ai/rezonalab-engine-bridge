import { describe, expect, it } from 'vitest';
import type { EngineAdapter } from '@rezonalab/engine-bridge-core';
import {
  COCOS_PORT_RANGE,
  buildServerConfig,
  deriveProjectId,
  normalizeExtraOrigins,
  portsExhaustedMessage,
  resolveAutoStart,
} from '../source/assemble';

const adapter: EngineAdapter = {
  importFile: async () => ({ savedPath: 'db://assets/RezonaAssets/x.glb' }),
  isProjectOpen: () => true,
};

describe('buildServerConfig', () => {
  const base = { projectPath: '/Users/me/Games/MyGame', appVersion: '3.8.6', pluginVersion: '0.1.0' };

  it('固定 Cocos 端口段与 engine 字段', () => {
    const cfg = buildServerConfig(base, adapter);
    expect(cfg.engine).toBe('cocos');
    expect(cfg.engineVersion).toBe('3.8.6');
    expect(cfg.pluginVersion).toBe('0.1.0');
    expect(cfg.portRange).toEqual([41700, 41719]);
    expect(COCOS_PORT_RANGE).toEqual([41700, 41719]);
    expect(cfg.adapter).toBe(adapter);
  });

  it('工程名取路径末段，id 为路径 sha1 前 8 位', () => {
    const cfg = buildServerConfig(base, adapter);
    expect(cfg.project.name).toBe('MyGame');
    expect(cfg.project.id).toBe(deriveProjectId('/Users/me/Games/MyGame'));
    expect(cfg.project.id).toMatch(/^[0-9a-f]{8}$/);
    expect(deriveProjectId('/a')).not.toBe(deriveProjectId('/b'));
  });

  it('assetsRoot 指向工程 assets 目录', () => {
    expect(buildServerConfig(base, adapter).assetsRoot).toBe('/Users/me/Games/MyGame/assets');
  });

  it('extraOrigins 原样追加，不替换默认白名单', () => {
    const cfg = buildServerConfig({ ...base, extraOrigins: ['http://localhost:5173'] }, adapter);
    expect(cfg.extraOrigins).toEqual(['http://localhost:5173']);
    expect(cfg.originAllowlist).toBeUndefined();
  });
});

describe('profile 值归一化', () => {
  it('autoStart 默认 true，只有明确 false 才关', () => {
    expect(resolveAutoStart(undefined)).toBe(true);
    expect(resolveAutoStart(null)).toBe(true);
    expect(resolveAutoStart(true)).toBe(true);
    expect(resolveAutoStart(false)).toBe(false);
  });

  it('extraOrigins 过滤非字符串与空白', () => {
    expect(normalizeExtraOrigins(undefined)).toEqual([]);
    expect(normalizeExtraOrigins('not-array')).toEqual([]);
    expect(normalizeExtraOrigins([' http://localhost:5173 ', '', 3, null])).toEqual(['http://localhost:5173']);
  });
});

describe('portsExhaustedMessage', () => {
  it('面板可见文案', () => {
    expect(portsExhaustedMessage(COCOS_PORT_RANGE)).toBe('41700 到 41719 全部被占用');
  });
});
