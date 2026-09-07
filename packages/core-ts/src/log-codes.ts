/**
 * 面板日志的事件码与文案表。
 *
 * 内核（server / session）只发码 + 参数，永远不拼人类语言；文案在这里按语言渲染。
 * 这样英文环境的面板不会出现「标签英文、日志中文」的混排。Unity 侧在
 * `packages/unity/Editor/Core/LogCodes.cs` 镜像同一张表，码集一致由测试保证。
 */

export type LogCode =
  | 'listening'
  | 'stopped'
  | 'origin_rejected'
  | 'busy_rejected'
  | 'client_connected'
  | 'connection_closed'
  | 'heartbeat_timeout'
  | 'receive_start'
  | 'transfer_rejected'
  | 'checksum_failed'
  | 'save_failed'
  | 'imported'
  | 'import_failed'
  | 'chunk_write_failed'
  | 'tmp_create_failed'
  | 'frame_error'
  | 'connection_error'
  | 'server_error';

export type LogLang = 'zh' | 'en';
export type LogArgs = Readonly<Record<string, string | number>>;

/** `{name}` 是插值位；两种语言的位名必须一致。 */
export const LOG_TEMPLATES: Readonly<Record<LogCode, Readonly<Record<LogLang, string>>>> = {
  listening: { zh: '监听中 127.0.0.1:{port}{path}', en: 'Listening on 127.0.0.1:{port}{path}' },
  stopped: { zh: '已停止', en: 'Stopped' },
  origin_rejected: { zh: '拒绝来源 {origin}', en: 'Rejected origin {origin}' },
  busy_rejected: { zh: '已有传输进行中，拒绝新连接', en: 'A transfer is in progress; new connection refused' },
  client_connected: { zh: '客户端已连接：{client} {clientVersion}', en: 'Client connected: {client} {clientVersion}' },
  connection_closed: { zh: '关闭连接（{code}）：{reason}', en: 'Connection closed ({code}): {reason}' },
  heartbeat_timeout: { zh: '心跳超时，关闭连接', en: 'Heartbeat timed out; closing the connection' },
  receive_start: { zh: '开始接收 {file}（{bytes} 字节，{chunks} 块）', en: 'Receiving {file} ({bytes} bytes, {chunks} chunks)' },
  transfer_rejected: { zh: '拒绝传输 {file}：{reason}', en: 'Rejected {file}: {reason}' },
  checksum_failed: { zh: '{file} 校验失败：{reason}', en: '{file} failed verification: {reason}' },
  save_failed: { zh: '{file} 落盘失败：{reason}', en: 'Could not save {file}: {reason}' },
  imported: { zh: '{file} 已导入：{path}', en: '{file} imported: {path}' },
  import_failed: { zh: '{file} 导入失败：{code} {reason}', en: 'Import of {file} failed: {code} {reason}' },
  chunk_write_failed: { zh: '写入分块失败：{reason}', en: 'Writing a chunk failed: {reason}' },
  tmp_create_failed: { zh: '无法创建临时文件：{reason}', en: 'Could not create the temp file: {reason}' },
  frame_error: { zh: '处理帧时异常：{reason}', en: 'Error while handling a frame: {reason}' },
  connection_error: { zh: '连接错误：{reason}', en: 'Connection error: {reason}' },
  server_error: { zh: '服务端错误：{reason}', en: 'Server error: {reason}' },
};

/** 缺 Origin 头时 `origin` 参数用的占位文案。 */
export const MISSING_ORIGIN: Readonly<Record<LogLang, string>> = { zh: '(缺 Origin 头)', en: '(no Origin header)' };

/** 把参数填进模板。未知的插值位原样留下，方便一眼看出漏传了参数。 */
export function interpolateLog(template: string, args: LogArgs | undefined): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const v = args?.[name];
    return v === undefined ? whole : String(v);
  });
}

/** 用内置表渲染一条日志。面板若有自己的 i18n（Cocos 的 `Editor.I18n`），应改用 `interpolateLog`。 */
export function renderLog(code: LogCode, args: LogArgs | undefined, lang: LogLang): string {
  const template = LOG_TEMPLATES[code]?.[lang];
  if (!template) return code;
  return interpolateLog(template, args);
}

/** 全部事件码，供面板 / 测试遍历。 */
export const LOG_CODES = Object.keys(LOG_TEMPLATES) as readonly LogCode[];
