import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { EngineAdapter, ImportMeta } from './adapter.js';
import { DEFAULT_ORIGIN_ALLOWLIST } from './origin.js';
import { Session, type SessionSink } from './session.js';
import { DEFAULT_FORMATS, DEFAULT_LIMITS, type Limits } from './types.js';

/** protocol/fixtures/*.json 的形状（见 protocol/spec.md 第 9 节）。 */
export interface Fixture {
  name: string;
  origin: string;
  server?: { limits?: Partial<Limits>; formats?: string[] };
  frames: FixtureFrame[];
  expect: FixtureExpect;
}
export type FixtureFrame =
  | { dir: 'in'; text: Record<string, unknown> }
  | { dir: 'in'; binary: { header: { transferId: string; index: number }; bytesBase64: string } }
  | { dir: 'tick'; ms: number };
export interface FixtureExpect {
  outFrames: Record<string, unknown>[];
  closeCode: number | null;
  finalState: string;
  savedFileSha256: string | null;
  files: string[];
  adapterCalls: { fileName: string; kind: string }[];
}

/** 跑完一个夹具后的实际观测，形状与 expect 一致，测试直接 toEqual。 */
export interface FixtureActual extends FixtureExpect {
  tmpLeftovers: string[];
}

export const FIXTURE_SERVER = {
  engine: 'fake',
  engineVersion: '0.0.0',
  pluginVersion: '0.1.0',
  project: { name: 'Fixture', id: 'fixture1' },
};

class FakeAdapter implements EngineAdapter {
  calls: { fileName: string; kind: string }[] = [];
  async importFile(absPath: string, meta: ImportMeta) {
    this.calls.push({ fileName: meta.fileName, kind: meta.kind });
    void absPath;
    const out: { savedPath: string; sceneNode?: string } = { savedPath: `<root>/RezonaAssets/${meta.fileName}` };
    if (meta.kind === 'model3d' && meta.displayName) out.sceneNode = meta.displayName;
    return out;
  }
  isProjectOpen() {
    return true;
  }
}

export async function loadFixtures(dir: string): Promise<Fixture[]> {
  const names = (await fs.readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  return Promise.all(names.map(async (n) => JSON.parse(await fs.readFile(join(dir, n), 'utf8')) as Fixture));
}

export async function runFixture(fixture: Fixture): Promise<FixtureActual> {
  const root = await fs.mkdtemp(join(tmpdir(), 'rezona-fixture-'));
  const assetsRoot = join(root, 'assets');
  const tmp = join(root, 'tmp');
  await fs.mkdir(assetsRoot, { recursive: true });
  await fs.mkdir(tmp, { recursive: true });
  const adapter = new FakeAdapter();
  const out: Record<string, unknown>[] = [];
  let closeCode: number | null = null;
  const sink: SessionSink = {
    send: (text) => out.push(JSON.parse(text) as Record<string, unknown>),
    close: (code) => {
      if (closeCode === null) closeCode = code;
    },
  };
  const session = new Session(
    fixture.origin,
    {
      ...FIXTURE_SERVER,
      assetsRoot,
      tmpDir: tmp,
      originAllowlist: DEFAULT_ORIGIN_ALLOWLIST,
      limits: { ...DEFAULT_LIMITS, ...fixture.server?.limits },
      formats: fixture.server?.formats ?? DEFAULT_FORMATS,
      adapter,
    },
    sink,
  );
  try {
    if (session.open()) {
      for (const frame of fixture.frames) {
        if (frame.dir === 'tick') session.advance(frame.ms);
        else if ('text' in frame) await session.handleText(JSON.stringify(frame.text));
        else {
          const head = Buffer.from(JSON.stringify(frame.binary.header), 'utf8');
          const data = Buffer.from(frame.binary.bytesBase64, 'base64');
          const buf = Buffer.alloc(4 + head.length + data.length);
          buf.writeUInt32BE(head.length, 0);
          head.copy(buf, 4);
          data.copy(buf, 4 + head.length);
          await session.handleBinary(buf);
        }
      }
    }
    const files = (await walk(assetsRoot)).map((p) => relative(assetsRoot, p).split('\\').join('/')).sort();
    let savedFileSha256: string | null = null;
    if (files.length === 1 && files[0]) {
      savedFileSha256 = createHash('sha256').update(await fs.readFile(join(assetsRoot, files[0]))).digest('hex');
    }
    const tmpLeftovers = await walk(tmp);
    return {
      outFrames: out,
      closeCode,
      finalState: session.state,
      savedFileSha256,
      files,
      adapterCalls: adapter.calls,
      tmpLeftovers: tmpLeftovers.map((p) => relative(tmp, p)),
    };
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}
