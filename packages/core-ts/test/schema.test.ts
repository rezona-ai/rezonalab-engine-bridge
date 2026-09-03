import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseText } from '../src/framing.js';

const FIXTURES_DIR = join(__dirname, '..', '..', '..', 'protocol', 'fixtures');

// 夹具里所有文本帧（入向与期望出向）都必须过 Schema，保证规格、Schema、夹具三者不漂移。
describe('messages.schema.json covers every fixture text frame', () => {
  for (const file of readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.json'))) {
    it(file, () => {
      const fx = JSON.parse(readFileSync(join(FIXTURES_DIR, file), 'utf8'));
      const texts: unknown[] = [];
      for (const fr of fx.frames) if (fr.dir === 'in' && fr.text) texts.push(fr.text);
      texts.push(...fx.expect.outFrames);
      for (const t of texts) {
        const r = parseText(JSON.stringify(t));
        expect(r.ok, `${JSON.stringify(t)} → ${r.ok ? '' : r.error}`).toBe(true);
      }
    });
  }
});
