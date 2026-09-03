/**
 * Cocos Creator 编辑器全局 `Editor` 的最小声明。
 * 只声明本扩展用到的表面，避免把 `@cocos/creator-types` 变成构建必需项；
 * 需要完整类型时可自行 `npm i -D @cocos/creator-types` 并把 tsconfig 的 types 换掉。
 */
declare const Editor: {
  App: { readonly version: string };
  Project: { readonly path: string; readonly name?: string };
  Message: {
    request(pkg: string, message: string, ...args: unknown[]): Promise<unknown>;
    send(pkg: string, message: string, ...args: unknown[]): void;
    broadcast(message: string, ...args: unknown[]): void;
    addBroadcastListener(message: string, listener: (...args: unknown[]) => void): void;
    removeBroadcastListener(message: string, listener: (...args: unknown[]) => void): void;
  };
  Panel: {
    open(name: string): void;
    define(options: Record<string, unknown>): unknown;
  };
  Profile: {
    getConfig(pkg: string, key: string, type?: string): Promise<unknown>;
    setConfig(pkg: string, key: string, value: unknown, type?: string): Promise<void>;
  };
  I18n: { t(key: string): string };
};
