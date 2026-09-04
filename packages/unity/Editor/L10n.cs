using System.Collections.Generic;
using UnityEngine;

namespace RezonaLab.EngineBridge.Editor
{
    /// <summary>面板文案，跟随编辑器系统语言：中文环境用简体中文，其余用英文。键与 Cocos 扩展 i18n 保持同名，两边文案一致。</summary>
    internal static class L10n
    {
        private static readonly bool Zh =
            Application.systemLanguage == SystemLanguage.Chinese ||
            Application.systemLanguage == SystemLanguage.ChineseSimplified ||
            Application.systemLanguage == SystemLanguage.ChineseTraditional;

        private static readonly Dictionary<string, string> ZhCn = new Dictionary<string, string>
        {
            ["tagline"] = "画布资产直推本工程",
            ["state_stopped"] = "已停止", ["state_listening"] = "监听中", ["state_connected"] = "已连接", ["state_busy"] = "传输中", ["state_error"] = "出错",
            ["port"] = "端口", ["start"] = "启动", ["stop"] = "停止",
            ["project"] = "工程", ["save_dir"] = "保存目录", ["client"] = "已连接", ["current_file"] = "当前文件",
            ["stage_receiving"] = "接收中", ["stage_importing"] = "导入中", ["stage_done"] = "完成", ["stage_failed"] = "失败",
            ["logs"] = "日志", ["clear_logs"] = "清空",
            ["advanced"] = "高级", ["extra_origins_hint"] = "额外允许连接的网页来源，一行一个（如 http://localhost:3000）。下次启动监听时生效。", ["allowlist"] = "当前白名单",
            ["gltf_missing"] = "导入 glb 需要 glTFast 包（{0}）。", ["gltf_add"] = "添加 glTFast", ["gltf_add_failed"] = "添加失败：",
            ["docs"] = "安装与故障排查", ["foot_note"] = "只监听 127.0.0.1 · 只接受白名单来源",
        };

        private static readonly Dictionary<string, string> En = new Dictionary<string, string>
        {
            ["tagline"] = "Push canvas assets straight into this project",
            ["state_stopped"] = "Stopped", ["state_listening"] = "Listening", ["state_connected"] = "Connected", ["state_busy"] = "Transferring", ["state_error"] = "Error",
            ["port"] = "Port", ["start"] = "Start", ["stop"] = "Stop",
            ["project"] = "Project", ["save_dir"] = "Save dir", ["client"] = "Client", ["current_file"] = "Current file",
            ["stage_receiving"] = "receiving", ["stage_importing"] = "importing", ["stage_done"] = "done", ["stage_failed"] = "failed",
            ["logs"] = "Logs", ["clear_logs"] = "Clear",
            ["advanced"] = "Advanced", ["extra_origins_hint"] = "Extra allowed web origins, one per line (e.g. http://localhost:3000). Applies the next time listening starts.", ["allowlist"] = "Current allowlist",
            ["gltf_missing"] = "Importing glb needs the glTFast package ({0}).", ["gltf_add"] = "Add glTFast", ["gltf_add_failed"] = "Add failed: ",
            ["docs"] = "Install & troubleshooting", ["foot_note"] = "Listens on 127.0.0.1 only · allow-listed origins only",
        };

        public static string T(string key)
        {
            var d = Zh ? ZhCn : En;
            return d.TryGetValue(key, out var v) ? v : (En.TryGetValue(key, out var e) ? e : key);
        }
    }
}
