// 把 protocol/schema/*.json 嵌成 TS 模块，让内核发包 / 打进 Cocos zip 后不依赖仓库目录结构。
// 产物 src/generated/ 已 gitignore；build 与 test 前自动跑。
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const schemaDir = join(here, '..', '..', '..', 'protocol', 'schema');
const outDir = join(here, '..', 'src', 'generated');
mkdirSync(outDir, { recursive: true });
const messages = JSON.parse(readFileSync(join(schemaDir, 'messages.schema.json'), 'utf8'));
const chunkHeader = JSON.parse(readFileSync(join(schemaDir, 'chunk-header.schema.json'), 'utf8'));
writeFileSync(
  join(outDir, 'schemas.ts'),
  `// 自动生成，勿手改：来源 protocol/schema/*.json\n` +
    `export const messagesSchema = ${JSON.stringify(messages)} as const;\n` +
    `export const chunkHeaderSchema = ${JSON.stringify(chunkHeader)} as const;\n`,
);
