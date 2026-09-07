import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOG_CODES, LOG_TEMPLATES, interpolateLog, renderLog, type LogCode } from '../src/log-codes.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('log codes', () => {
  it('renders both languages and leaves unknown placeholders visible', () => {
    expect(renderLog('imported', { file: 'a.png', path: '/x/a.png' }, 'zh')).toBe('a.png 已导入：/x/a.png');
    expect(renderLog('imported', { file: 'a.png', path: '/x/a.png' }, 'en')).toBe('a.png imported: /x/a.png');
    // 漏传参数必须留着 {path}，否则面板上只会看到一句少了半截的话，没人知道是内核漏传
    expect(renderLog('imported', { file: 'a.png' }, 'en')).toBe('a.png imported: {path}');
    expect(interpolateLog('{a}-{b}', { a: 1, b: 'x' })).toBe('1-x');
  });

  it('every code has the same placeholders in zh and en', () => {
    for (const code of LOG_CODES) {
      const { zh, en } = LOG_TEMPLATES[code];
      expect(placeholders(zh), `${code} 的中英插值位不一致`).toEqual(placeholders(en));
    }
  });

  it('no kernel log call passes a human-readable string instead of a code', () => {
    for (const file of ['server.ts', 'session.ts']) {
      const src = readFileSync(join(ROOT, 'packages', 'core-ts', 'src', file), 'utf8');
      // 内核里出现中日韩字符就说明有人又把文案写回了调用点
      const offenders = src.split('\n').filter((l) => /log\(['"](info|warn|error)['"]/.test(l) && /[一-鿿]/.test(l));
      expect(offenders, `${file} 的 log 调用里带上了人类语言`).toEqual([]);
    }
  });

  it('the Unity mirror covers exactly the same codes with the same placeholders', () => {
    const cs = readFileSync(join(ROOT, 'packages', 'unity', 'Editor', 'Core', 'LogCodes.cs'), 'utf8');
    const table = (name: string) => {
      const start = cs.indexOf(`${name} = new Dictionary`);
      expect(start, `LogCodes.cs 里找不到 ${name} 表`).toBeGreaterThan(-1);
      const chunk = cs.slice(start, cs.indexOf('};', start));
      const out = new Map<string, string>();
      for (const m of chunk.matchAll(/\["(\w+)"\] = "((?:[^"\\]|\\.)*)",/g)) out.set(m[1], m[2].replace(/\\"/g, '"'));
      return out;
    };
    const zh = table('Zh');
    const en = table('En');
    expect([...zh.keys()].sort()).toEqual([...LOG_CODES].sort());
    expect([...en.keys()].sort()).toEqual([...LOG_CODES].sort());
    for (const code of LOG_CODES) {
      expect(placeholders(zh.get(code)!), `${code}: Unity 中文模板与内核不一致`).toEqual(placeholders(LOG_TEMPLATES[code].zh));
      expect(placeholders(en.get(code)!), `${code}: Unity 英文模板与内核不一致`).toEqual(placeholders(LOG_TEMPLATES[code].en));
    }
  });

  it('the Cocos panel i18n covers exactly the same codes', () => {
    for (const [lang, file] of [['zh', 'zh.js'], ['en', 'en.js']] as const) {
      const src = readFileSync(join(ROOT, 'packages', 'cocos', 'i18n', file), 'utf8');
      const found = new Map<string, string>();
      for (const m of src.matchAll(/\blog_(\w+): '((?:[^'\\]|\\.)*)',/g)) found.set(m[1], m[2].replace(/\\'/g, "'"));
      expect([...found.keys()].sort(), `${file} 的 log_ 键集与内核不一致`).toEqual([...LOG_CODES].sort());
      for (const code of LOG_CODES) {
        expect(placeholders(found.get(code)!), `${code}: ${file} 插值位与内核不一致`).toEqual(placeholders(LOG_TEMPLATES[code][lang]));
      }
    }
  });

  it('no code was added to the union without a template', () => {
    const src = readFileSync(join(ROOT, 'packages', 'core-ts', 'src', 'log-codes.ts'), 'utf8');
    const union = [...src.split('export type LogLang')[0].matchAll(/^\s*\| '(\w+)';?$/gm)].map((m) => m[1] as LogCode);
    expect(union.length).toBeGreaterThan(0);
    expect(union.sort()).toEqual([...LOG_CODES].sort());
  });
});
