import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadFixtures, runFixture, type Fixture } from '../src/fixtures-runner.js';

const FIXTURES_DIR = join(__dirname, '..', '..', '..', 'protocol', 'fixtures');
const EXPECTED_FIXTURE_COUNT = 11;

// 夹具是 TS 内核与 C# 移植的唯一一致性保障；数量断言防止漏跑（新增夹具必须同时改这里与 Unity 测试）。
describe('protocol fixtures', () => {
  const fixtures: Fixture[] = [];
  const files = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.json'));

  it(`directory holds exactly ${EXPECTED_FIXTURE_COUNT} fixtures`, async () => {
    fixtures.push(...(await loadFixtures(FIXTURES_DIR)));
    expect(files.length).toBe(EXPECTED_FIXTURE_COUNT);
    expect(fixtures.length).toBe(EXPECTED_FIXTURE_COUNT);
  });

  for (const file of files) {
    it(`replays ${file}`, async () => {
      const fixture = (await loadFixtures(FIXTURES_DIR)).find((f) => `${f.name}.json` === file);
      expect(fixture, `fixture name must equal file name for ${file}`).toBeDefined();
      const actual = await runFixture(fixture!);
      const { tmpLeftovers, ...observed } = actual;
      expect(observed).toEqual(fixture!.expect);
      expect(tmpLeftovers, 'temp dir must be empty after run').toEqual([]);
    });
  }
});
