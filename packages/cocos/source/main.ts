import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createExtension } from './extension';

/** 插件版本从自身 package.json 读，避免 rootDir 之外的 import。 */
function readPluginVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// 只有在 Cocos 编辑器进程里才会有全局 Editor；本文件不进单测。
const extension = createExtension({ editor: Editor, pluginVersion: readPluginVersion() });

export const methods = extension.methods;

export function load(): void {
  void extension.load();
}

export function unload(): void {
  void extension.unload();
}
