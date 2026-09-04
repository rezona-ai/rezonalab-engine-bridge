import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LogEntry, ServerSnapshot } from '@rezonalab/engine-bridge-core';

/** 面板与主进程约定的包名；与 package.json 的 name 一致。 */
const PKG = 'rezona-bridge';
const MAX_LOG_LINES = 200;

type PanelDom = {
  badge: HTMLElement;
  stateText: HTMLElement;
  clientRow: HTMLElement;
  client: HTMLElement;
  progressFill: HTMLElement;
  docs: HTMLElement;
  port: HTMLElement;
  toggle: HTMLElement;
  project: HTMLElement;
  currentFile: HTMLElement;
  percent: HTMLElement;
  error: HTMLElement;
  logs: HTMLElement;
  clearLogs: HTMLElement;
  extraOrigins: HTMLElement & { value?: string };
  saveOrigins: HTMLElement;
  allowlist: HTMLElement;
};

type PanelThis = {
  $: PanelDom;
  _running: boolean;
  _pending: boolean;
  _originsDirty: boolean;
  _onState: (snapshot: unknown) => void;
};

/** i18n：键在 i18n/*.js 里；找不到时回落到内置英文。 */
function t(key: string, fallback: string): string {
  const full = `${PKG}.${key}`;
  const s = Editor.I18n.t(full);
  return s && s !== full ? s : fallback;
}

/** 扩展版本：面板运行在 dist/panels/default/，包清单在三级之上。 */
function pluginVersion(): string {
  try {
    return (JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf8')) as { version?: string }).version ?? '';
  } catch {
    return '';
  }
}

const DOCS_URL = 'https://github.com/rezona-ai/rezonalab-engine-bridge/blob/main/docs/install-cocos.md';

function renderTemplate(): string {
  const html = readFileSync(join(__dirname, 'template.html'), 'utf8');
  const dict: Record<string, string> = {
    __VERSION__: pluginVersion(),
    __TAGLINE__: t('tagline', 'Push canvas assets straight into this project'),
    __CLIENT__: t('client', 'Client'),
    __DOCS__: t('docs', 'Install & troubleshooting'),
    __FOOT_NOTE__: t('foot_note', 'Listens on 127.0.0.1 only · allow-listed origins only'),
    __STATE_STOPPED__: t('state_stopped', 'Stopped'),
    __PORT__: t('port', 'Port'),
    __START__: t('start', 'Start'),
    __PROJECT__: t('project', 'Project'),
    __SAVE_DIR__: t('save_dir', 'Save dir'),
    __CURRENT_FILE__: t('current_file', 'Current file'),
    __LOGS__: t('logs', 'Logs'),
    __CLEAR_LOGS__: t('clear_logs', 'Clear'),
    __ADVANCED__: t('advanced', 'Advanced'),
    __EXTRA_ORIGINS_HINT__: t('extra_origins_hint', 'Extra allowed origins, one per line (e.g. a local dev server). Takes effect after saving.'),
    __SAVE__: t('save', 'Save'),
    __ALLOWLIST__: t('allowlist', 'Current allowlist:'),
  };
  return html.replace(/__[A-Z_]+__/g, (m) => dict[m] ?? m);
}

function formatLog(e: LogEntry): string {
  const d = new Date(e.at);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const tag = e.level === 'error' ? 'E' : e.level === 'warn' ? 'W' : 'I';
  return `${hh}:${mm}:${ss} [${tag}] ${e.msg}`;
}

function applySnapshot(this: PanelThis, snap: ServerSnapshot): void {
  const $ = this.$;
  const hasError = !!snap.lastError && snap.state === 'stopped';
  const stateKey = hasError ? 'error' : snap.state === 'listening' && snap.connected ? 'connected' : snap.state;
  $.badge.dataset.state = stateKey;
  $.stateText.textContent = hasError
    ? t('state_error', 'Error')
    : snap.state === 'busy'
      ? t('state_busy', 'Transferring')
      : snap.state === 'listening'
        ? snap.connected
          ? t('state_connected', 'Connected')
          : t('state_listening', 'Listening')
        : t('state_stopped', 'Stopped');
  $.port.textContent = snap.port ? String(snap.port) : '-';
  $.project.textContent = snap.project.name || '-';

  const p = snap.progress;
  $.currentFile.textContent = p ? p.fileName : '-';
  const percent = p ? Math.max(0, Math.min(100, Math.round(p.percent))) : 0;
  $.progressFill.style.width = `${percent}%`;
  $.progressFill.dataset.stage = p?.stage ?? '';
  $.percent.textContent = p?.stage === 'failed' ? t('stage_failed', 'failed') : p?.stage === 'importing' ? t('stage_importing', 'importing') : `${percent}%`;
  $.clientRow.hidden = !snap.connected;
  $.client.textContent = snap.clientOrigin ?? '-';

  $.error.hidden = !snap.lastError;
  $.error.textContent = snap.lastError ?? '';

  // 日志区：最近 200 行，error / warn 上色。
  const lines = snap.logs.slice(-MAX_LOG_LINES);
  $.logs.replaceChildren(
    ...lines.map((e) => {
      const span = document.createElement('span');
      span.textContent = `${formatLog(e)}\n`;
      if (e.level !== 'info') span.className = `rb-log-${e.level}`;
      return span;
    }),
  );
  $.logs.scrollTop = $.logs.scrollHeight;

  this._running = snap.state !== 'stopped';
  $.toggle.textContent = this._running ? t('stop', 'Stop') : t('start', 'Start');
  $.toggle.dataset.running = String(this._running);

  $.allowlist.textContent = snap.originAllowlist.join('  ');
}

async function refresh(this: PanelThis): Promise<void> {
  const snap = (await Editor.Message.request(PKG, 'query-state')) as ServerSnapshot;
  applySnapshot.call(this, snap);
}

async function loadExtraOrigins(this: PanelThis): Promise<void> {
  const raw = await Editor.Profile.getConfig(PKG, 'extraOrigins');
  const list = Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
  this.$.extraOrigins.value = list.join('\n');
  this.$.extraOrigins.setAttribute('value', list.join('\n'));
}

module.exports = Editor.Panel.define({
  template: renderTemplate(),
  style: readFileSync(join(__dirname, 'style.css'), 'utf8'),
  $: {
    badge: '#state-badge',
    stateText: '#state-text',
    clientRow: '#client-row',
    client: '#client',
    progressFill: '#progress-fill',
    docs: '#docs',
    port: '#port',
    toggle: '#toggle',
    project: '#project',
    currentFile: '#current-file',
    percent: '#percent',
    error: '#error',
    logs: '#logs',
    clearLogs: '#clear-logs',
    extraOrigins: '#extra-origins',
    saveOrigins: '#save-origins',
    allowlist: '#allowlist',
  },
  methods: {
    /** 主进程 `Editor.Message.broadcast('rezona-bridge:state', snapshot)` 落到这里。 */
    onState(this: PanelThis, snapshot: unknown) {
      if (snapshot && typeof snapshot === 'object') applySnapshot.call(this, snapshot as ServerSnapshot);
    },
  },
  async ready(this: PanelThis) {
    this._running = false;
    this._pending = false;
    this._originsDirty = false;
    // 兜底：不同 3.8 小版本对 contributions.messages 里自家广播的投递行为有差异，双路接收，applySnapshot 幂等。
    this._onState = (snapshot: unknown) => {
      if (snapshot && typeof snapshot === 'object') applySnapshot.call(this, snapshot as ServerSnapshot);
    };
    Editor.Message.addBroadcastListener(`${PKG}:state`, this._onState);

    this.$.toggle.addEventListener('confirm', async () => {
      if (this._pending) return;
      this._pending = true;
      try {
        await Editor.Message.request(PKG, this._running ? 'stop-server' : 'start-server');
        await refresh.call(this);
      } finally {
        this._pending = false;
      }
    });
    this.$.docs.addEventListener('click', (ev) => {
      ev.preventDefault();
      try {
        // 面板是 Electron 渲染进程，外链交给系统浏览器；拿不到 shell 时退回 window.open。
        (require('electron') as { shell: { openExternal(u: string): void } }).shell.openExternal(DOCS_URL);
      } catch {
        window.open(DOCS_URL, '_blank');
      }
    });
    this.$.clearLogs.addEventListener('confirm', async () => {
      await Editor.Message.request(PKG, 'clear-logs');
      await refresh.call(this);
    });
    this.$.saveOrigins.addEventListener('confirm', async () => {
      const text = String(this.$.extraOrigins.value ?? '');
      const origins = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      await Editor.Message.request(PKG, 'set-extra-origins', origins);
      await loadExtraOrigins.call(this);
      await refresh.call(this);
    });

    await loadExtraOrigins.call(this);
    await refresh.call(this);
  },
  close(this: PanelThis) {
    Editor.Message.removeBroadcastListener(`${PKG}:state`, this._onState);
  },
});
