import { createServer, type Server } from 'node:http';

export type PortRange = readonly [number, number];

/** 各引擎固定端口段；同引擎多实例从段首顺延各占一个。 */
export const PORT_RANGES = {
  cocos: [41700, 41719] as PortRange,
  unity: [41720, 41739] as PortRange,
  godot: [41740, 41759] as PortRange,
  unreal: [41760, 41779] as PortRange,
  blender: [41780, 41799] as PortRange,
  fake: [41700, 41719] as PortRange,
} as const;

export class PortsExhaustedError extends Error {
  readonly range: PortRange;
  constructor(range: PortRange) {
    super(`ports ${range[0]}-${range[1]} are all in use`);
    this.name = 'PortsExhaustedError';
    this.range = range;
  }
}

/**
 * 在 127.0.0.1 上从段首逐个尝试监听，返回第一个成功绑定的 http server 与端口。
 * 直接把最终要用的 server 绑上去（而不是探测后再绑），避免探测与真正监听之间的竞争窗口。
 */
export async function listenOnFirstFreePort(range: PortRange, host = '127.0.0.1'): Promise<{ server: Server; port: number }> {
  for (let port = range[0]; port <= range[1]; port++) {
    const server = createServer();
    const ok = await new Promise<boolean>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener('listening', onListening);
        if (err.code === 'EADDRINUSE' || err.code === 'EACCES') resolve(false);
        else reject(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve(true);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
    if (ok) return { server, port };
    server.close();
  }
  throw new PortsExhaustedError(range);
}
