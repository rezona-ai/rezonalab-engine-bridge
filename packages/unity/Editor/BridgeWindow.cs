using System;
using System.Text;
using UnityEditor;
using UnityEditor.PackageManager.Requests;
using UnityEngine;

namespace RezonaLab.EngineBridge.Editor
{
    /// <summary>Tools → Rezona Bridge 面板：三态徽标、端口、工程、当前文件进度、日志、启停、高级来源、glTFast 黄条。</summary>
    public sealed class BridgeWindow : EditorWindow
    {
        private Vector2 _logScroll;
        private bool _advanced;
        private string _extraOrigins;
        private bool _gltfFastMissing;
        private AddRequest _addRequest;

        [MenuItem("Tools/Rezona Bridge")]
        public static void Open()
        {
            var w = GetWindow<BridgeWindow>("Rezona Bridge");
            w.minSize = new Vector2(360, 320);
        }

        private void OnEnable()
        {
            _extraOrigins = string.Join("\n", Bootstrap.GetExtraOrigins());
            Bootstrap.Changed += Repaint;
            UnityAdapter.GltfFastMissing += OnGltfFastMissing;
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

        private void OnGUI()
        {
            var server = Bootstrap.Server;
            var snap = server?.Snapshot();
            var state = snap?.State ?? ServerState.Stopped;

            using (new EditorGUILayout.HorizontalScope())
            {
                var badge = state == ServerState.Stopped ? "○ 已停止" : state == ServerState.Busy ? "● 传输中" : "● 监听中";
                var style = new GUIStyle(EditorStyles.boldLabel);
                style.normal.textColor = state == ServerState.Stopped ? Color.gray : state == ServerState.Busy ? new Color(1f, 0.6f, 0.1f) : new Color(0.2f, 0.75f, 0.3f);
                GUILayout.Label(badge + (snap?.Port != null ? " · 端口 " + snap.Port : ""), style);
                GUILayout.FlexibleSpace();
                if (Bootstrap.IsRunning)
                {
                    if (GUILayout.Button("停止", GUILayout.Width(70)))
                    {
                        Bootstrap.AutoStart = false;
                        Bootstrap.Stop();
                    }
                }
                else if (GUILayout.Button("启动", GUILayout.Width(70)))
                {
                    Bootstrap.AutoStart = true;
                    Bootstrap.Start();
                }
            }

            if (!string.IsNullOrEmpty(Bootstrap.LastStartError)) EditorGUILayout.HelpBox(Bootstrap.LastStartError, MessageType.Error);

            EditorGUILayout.LabelField("工程", Bootstrap.ProjectName);
            EditorGUILayout.LabelField("保存目录", "Assets/" + Protocol.AssetsSubdir);
            if (snap != null && snap.Connected) EditorGUILayout.LabelField("已连接", snap.ClientOrigin ?? "");

            var progress = snap?.Progress;
            if (progress != null)
            {
                var stageText = progress.Stage == "receiving" ? "接收中" : progress.Stage == "importing" ? "导入中" : progress.Stage == "done" ? "完成" : "失败";
                EditorGUILayout.LabelField("当前文件", progress.FileName + "（" + stageText + "）");
                var rect = EditorGUILayout.GetControlRect(false, 18);
                EditorGUI.ProgressBar(rect, progress.Percent / 100f, progress.Percent + "%");
            }

            if (_gltfFastMissing)
            {
                EditorGUILayout.HelpBox("需要 glTFast 包才能导入 glb（" + UnityAdapter.GltfFastPackage + "）", MessageType.Warning);
                using (new EditorGUI.DisabledScope(_addRequest != null && !_addRequest.IsCompleted))
                {
                    if (GUILayout.Button("添加 glTFast")) _addRequest = UnityAdapter.AddGltfFast();
                }
                if (_addRequest != null && _addRequest.IsCompleted)
                {
                    if (_addRequest.Status == UnityEditor.PackageManager.StatusCode.Success) _gltfFastMissing = false;
                    else EditorGUILayout.HelpBox("添加失败：" + _addRequest.Error?.message, MessageType.Error);
                    _addRequest = null;
                }
            }

            EditorGUILayout.Space();
            using (new EditorGUILayout.HorizontalScope())
            {
                GUILayout.Label("日志", EditorStyles.boldLabel);
                GUILayout.FlexibleSpace();
                if (GUILayout.Button("清空", GUILayout.Width(60))) server?.ClearLogs();
            }
            _logScroll = EditorGUILayout.BeginScrollView(_logScroll, GUILayout.MinHeight(120));
            if (snap != null)
            {
                var sb = new StringBuilder();
                foreach (var entry in snap.Logs)
                {
                    var prefix = entry.Level == LogLevel.Error ? "[ERR] " : entry.Level == LogLevel.Warn ? "[WARN] " : "";
                    sb.Append(entry.At.ToString("HH:mm:ss")).Append(' ').Append(prefix).Append(entry.Message).Append('\n');
                }
                var logStyle = new GUIStyle(EditorStyles.label) { wordWrap = true, richText = false };
                EditorGUILayout.SelectableLabel(sb.ToString(), logStyle, GUILayout.ExpandHeight(true));
            }
            EditorGUILayout.EndScrollView();

            _advanced = EditorGUILayout.Foldout(_advanced, "高级", true);
            if (_advanced)
            {
                EditorGUILayout.LabelField("额外允许来源（每行一个，如 http://localhost:5173）");
                var edited = EditorGUILayout.TextArea(_extraOrigins, GUILayout.MinHeight(48));
                if (edited != _extraOrigins)
                {
                    _extraOrigins = edited;
                    Bootstrap.SetExtraOrigins(edited);
                }
                EditorGUILayout.HelpBox("改动在下次启动监听时生效。", MessageType.None);
            }
        }
    }
}
