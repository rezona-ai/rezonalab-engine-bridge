using System.Text;
using UnityEditor;
using UnityEditor.PackageManager.Requests;
using UnityEngine;

namespace RezonaLab.EngineBridge.Editor
{
    /// <summary>
    /// Tools → Rezona Bridge 窗口。布局与 Cocos 扩展面板同构：品牌区（R 标 + 名称 + 版本 + 状态胶囊 + 启停）→ 连接卡片
    /// （端口 / 工程 / 保存目录 / 客户端 / 当前文件 + 进度）→ 日志卡片 → 高级（额外来源）→ 页脚（说明 + 文档链接）。
    /// IMGUI 画不出圆角，胶囊与卡片用纯色背景 + 内边距近似；唯一强调色是品牌橙。
    /// </summary>
    public sealed class BridgeWindow : EditorWindow
    {
        private const string DocsUrl = "https://github.com/rezona-ai/rezonalab-engine-bridge/blob/main/docs/install-unity.md";
        private const string LogoPath = "Packages/com.rezonalab.engine-bridge/Editor/Resources/RezonaBridgeLogo.png";

        private static readonly Color Accent = new Color(1f, 0.435f, 0.012f);       // #FF6F03
        private static readonly Color Ok = new Color(0.133f, 0.647f, 0.349f);        // #22a559
        private static readonly Color Err = new Color(0.839f, 0.271f, 0.271f);       // #d64545
        private static readonly Color Muted = new Color(1f, 1f, 1f, 0.55f);
        private static readonly Color Stopped = new Color(0.42f, 0.42f, 0.42f);

        private Vector2 _logScroll;
        private bool _advanced;
        private string _extraOrigins;
        private bool _gltfFastMissing;
        private AddRequest _addRequest;

        private Texture2D _logo;
        private GUIStyle _title, _sub, _label, _value, _pill, _section, _log, _foot, _link;
        private Texture2D _pillTex;
        private Color _pillTexColor;

        [MenuItem("Tools/Rezona Bridge")]
        public static void Open()
        {
            var w = GetWindow<BridgeWindow>("Rezona Bridge · Unity");
            w.minSize = new Vector2(380, 420);
        }

        private void OnEnable()
        {
            _extraOrigins = string.Join("\n", Bootstrap.GetExtraOrigins());
            Bootstrap.Changed += Repaint;
            UnityAdapter.GltfFastMissing += OnGltfFastMissing;
            _logo = AssetDatabase.LoadAssetAtPath<Texture2D>(LogoPath);
        }

        private void OnDisable()
        {
            Bootstrap.Changed -= Repaint;
            UnityAdapter.GltfFastMissing -= OnGltfFastMissing;
        }

        private void OnGltfFastMissing()
        {
            _gltfFastMissing = true;
            Repaint();
        }

        private void EnsureStyles()
        {
            if (_title != null) return;
            _title = new GUIStyle(EditorStyles.boldLabel) { fontSize = 14 };
            _sub = new GUIStyle(EditorStyles.miniLabel); _sub.normal.textColor = Muted;
            _label = new GUIStyle(EditorStyles.label); _label.normal.textColor = Muted;
            _value = new GUIStyle(EditorStyles.label) { alignment = TextAnchor.MiddleRight, clipping = TextClipping.Clip };
            _section = new GUIStyle(EditorStyles.miniBoldLabel); _section.normal.textColor = Muted;
            _pill = new GUIStyle(EditorStyles.miniBoldLabel) { alignment = TextAnchor.MiddleCenter, padding = new RectOffset(10, 10, 3, 3), fontSize = 11 };
            _pill.normal.textColor = Color.white;
            // 不换等宽字体：IMGUI 的可选文本走 TextCore，动态 OS 字体在这里会抛异常；用时间戳灰色 + 级别着色区分即可。
            _log = new GUIStyle(EditorStyles.label) { wordWrap = true, richText = true, fontSize = 11 };
            _foot = new GUIStyle(EditorStyles.miniLabel); _foot.normal.textColor = Muted;
            _link = new GUIStyle(EditorStyles.miniLabel); _link.normal.textColor = Accent; _link.hover.textColor = Accent;
        }

        private Texture2D PillTexture(Color c)
        {
            if (_pillTex == null || _pillTexColor != c)
            {
                _pillTex = new Texture2D(1, 1) { hideFlags = HideFlags.HideAndDontSave };
                _pillTex.SetPixel(0, 0, c);
                _pillTex.Apply();
                _pillTexColor = c;
            }
            return _pillTex;
        }

        private static void Row(GUIStyle label, GUIStyle value, string k, string v)
        {
            using (new EditorGUILayout.HorizontalScope())
            {
                GUILayout.Label(k, label, GUILayout.Width(96));
                GUILayout.FlexibleSpace();
                GUILayout.Label(v ?? "-", value);
            }
        }

        private void OnGUI()
        {
            EnsureStyles();
            var server = Bootstrap.Server;
            var snap = server?.Snapshot();
            var state = snap?.State ?? ServerState.Stopped;
            var hasError = !string.IsNullOrEmpty(Bootstrap.LastStartError) && state == ServerState.Stopped;

            GUILayout.Space(6);
            // ── 品牌区 ──（固定高度，右侧胶囊与按钮垂直居中；不能用 FlexibleSpace，否则整块被拉满窗口）
            using (new EditorGUILayout.HorizontalScope(EditorStyles.helpBox, GUILayout.Height(52)))
            {
                GUILayout.Space(4);
                using (new EditorGUILayout.VerticalScope(GUILayout.Width(30)))
                {
                    GUILayout.Space(6);
                    if (_logo != null) GUILayout.Label(_logo, GUILayout.Width(28), GUILayout.Height(28));
                }
                GUILayout.Space(6);
                using (new EditorGUILayout.VerticalScope())
                {
                    GUILayout.Space(5);
                    GUILayout.Label("Rezona Bridge <size=11><color=#9a9a9a>for Unity</color></size>  <size=10><color=#8a8a8a>v" + Bootstrap.PluginVersion + "</color></size>", new GUIStyle(_title) { richText = true });
                    GUILayout.Label(L10n.T("tagline"), _sub);
                }
                GUILayout.FlexibleSpace();
                using (new EditorGUILayout.VerticalScope())
                {
                    GUILayout.Space(12);
                    using (new EditorGUILayout.HorizontalScope())
                    {
                        var pillColor = hasError ? Err : state == ServerState.Stopped ? Stopped : state == ServerState.Busy ? Accent : Ok;
                        var pillText = hasError ? L10n.T("state_error") : state == ServerState.Stopped ? L10n.T("state_stopped")
                            : state == ServerState.Busy ? L10n.T("state_busy") : (snap != null && snap.Connected ? L10n.T("state_connected") : L10n.T("state_listening"));
                        _pill.normal.background = PillTexture(pillColor);
                        GUILayout.Label("● " + pillText, _pill, GUILayout.Height(22));
                        GUILayout.Space(6);
                        if (Bootstrap.IsRunning)
                        {
                            if (GUILayout.Button(L10n.T("stop"), GUILayout.Width(64), GUILayout.Height(22))) { Bootstrap.AutoStart = false; Bootstrap.Stop(); }
                        }
                        else
                        {
                            var prev = GUI.backgroundColor; GUI.backgroundColor = new Color(1f, 0.62f, 0.32f); // 编辑器深色皮肤会把 backgroundColor 乘暗，取亮一档才落到品牌橙
                            if (GUILayout.Button(L10n.T("start"), GUILayout.Width(64), GUILayout.Height(22))) { Bootstrap.AutoStart = true; Bootstrap.Start(); }
                            GUI.backgroundColor = prev;
                        }
                    }
                }
                GUILayout.Space(4);
            }
            GUILayout.Space(4);
            if (!string.IsNullOrEmpty(Bootstrap.LastStartError)) EditorGUILayout.HelpBox(Bootstrap.LastStartError, MessageType.Error);

            // ── 连接卡片 ──
            GUILayout.Space(2);
            using (new EditorGUILayout.VerticalScope(EditorStyles.helpBox))
            {
                Row(_label, _value, L10n.T("port"), snap?.Port != null ? snap.Port.ToString() : "-");
                Row(_label, _value, L10n.T("project"), Bootstrap.ProjectName);
                Row(_label, _value, L10n.T("save_dir"), "Assets/" + Protocol.AssetsSubdir);
                if (snap != null && snap.Connected) Row(_label, _value, L10n.T("client"), snap.ClientOrigin ?? "");
                var progress = snap?.Progress;
                var stage = progress == null ? "" : L10n.T("stage_" + (progress.Stage == "receiving" || progress.Stage == "importing" || progress.Stage == "done" ? progress.Stage : "failed"));
                Row(_label, _value, L10n.T("current_file"), progress == null ? "-" : progress.FileName + "  ·  " + stage + "  " + progress.Percent + "%");
                GUILayout.Space(2);
                var rect = EditorGUILayout.GetControlRect(false, 6);
                EditorGUI.DrawRect(rect, new Color(1f, 1f, 1f, 0.08f));
                if (progress != null) EditorGUI.DrawRect(new Rect(rect.x, rect.y, rect.width * Mathf.Clamp01(progress.Percent / 100f), rect.height), Accent);
            }

            if (_gltfFastMissing)
            {
                EditorGUILayout.HelpBox(string.Format(L10n.T("gltf_missing"), UnityAdapter.GltfFastPackage), MessageType.Warning);
                using (new EditorGUI.DisabledScope(_addRequest != null && !_addRequest.IsCompleted))
                {
                    if (GUILayout.Button(L10n.T("gltf_add"))) _addRequest = UnityAdapter.AddGltfFast();
                }
                if (_addRequest != null && _addRequest.IsCompleted)
                {
                    if (_addRequest.Status == UnityEditor.PackageManager.StatusCode.Success) _gltfFastMissing = false;
                    else EditorGUILayout.HelpBox(L10n.T("gltf_add_failed") + _addRequest.Error?.message, MessageType.Error);
                    _addRequest = null;
                }
            }

            // ── 日志卡片 ──
            using (new EditorGUILayout.VerticalScope(EditorStyles.helpBox, GUILayout.ExpandHeight(true)))
            {
                using (new EditorGUILayout.HorizontalScope())
                {
                    GUILayout.Label(L10n.T("logs"), _section);
                    GUILayout.FlexibleSpace();
                    if (GUILayout.Button(L10n.T("clear_logs"), EditorStyles.miniButton, GUILayout.Width(56))) server?.ClearLogs();
                }
                _logScroll = EditorGUILayout.BeginScrollView(_logScroll, GUILayout.MinHeight(110), GUILayout.ExpandHeight(true));
                if (snap != null)
                {
                    var sb = new StringBuilder();
                    foreach (var entry in snap.Logs)
                    {
                        var color = entry.Level == LogLevel.Error ? "#ff7b7b" : entry.Level == LogLevel.Warn ? "#ffb15c" : "#cfcfcf";
                        var tag = entry.Level == LogLevel.Error ? "E" : entry.Level == LogLevel.Warn ? "W" : "I";
                        sb.Append("<color=#8a8a8a>").Append(entry.At.ToString("HH:mm:ss")).Append("</color> <color=").Append(color).Append(">[")
                          .Append(tag).Append("] ").Append(entry.Message.Replace("<", "&lt;")).Append("</color>\n");
                    }
                    EditorGUILayout.SelectableLabel(sb.ToString(), _log, GUILayout.ExpandHeight(true));
                }
                EditorGUILayout.EndScrollView();
            }

            // ── 高级 ──
            _advanced = EditorGUILayout.Foldout(_advanced, L10n.T("advanced"), true);
            if (_advanced)
            {
                using (new EditorGUILayout.VerticalScope(EditorStyles.helpBox))
                {
                    GUILayout.Label(L10n.T("extra_origins_hint"), EditorStyles.wordWrappedMiniLabel);
                    var edited = EditorGUILayout.TextArea(_extraOrigins, GUILayout.MinHeight(48));
                    if (edited != _extraOrigins) { _extraOrigins = edited; Bootstrap.SetExtraOrigins(edited); }
                    if (snap != null) GUILayout.Label(L10n.T("allowlist") + ": " + string.Join("  ", snap.OriginAllowlist), EditorStyles.wordWrappedMiniLabel);
                }
            }

            // ── 页脚 ──
            GUILayout.Space(4);
            using (new EditorGUILayout.HorizontalScope())
            {
                GUILayout.Label(L10n.T("foot_note"), _foot);
                GUILayout.FlexibleSpace();
                if (GUILayout.Button(L10n.T("docs") + " ↗", _link)) Application.OpenURL(DocsUrl);
            }
            GUILayout.Space(4);
        }
    }
}
