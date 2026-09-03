using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using UnityEditor;
using UnityEngine;

namespace RezonaLab.EngineBridge.Editor
{
    /// <summary>
    /// 编辑器启动即监听（KTD-12），偏好记在 EditorPrefs。域重载会打掉所有静态状态，
    /// 所以在 beforeAssemblyReload 主动 Stop 释放端口，重载后 [InitializeOnLoad] 再按偏好重建。
    /// </summary>
    [InitializeOnLoad]
    public static class Bootstrap
    {
        public const string PluginVersion = "0.1.0";
        public const string AutoStartKey = "RezonaBridge.AutoStart";
        public const string ExtraOriginsKey = "RezonaBridge.ExtraOrigins";

        public static BridgeServer Server { get; private set; }
        /// <summary>上次 Start 失败的原因（如端口段全被占用）；成功后清空。</summary>
        public static string LastStartError { get; private set; }

        public static event Action Changed;

        static Bootstrap()
        {
            MainThread.CaptureMainThread();
            MainThread.OnException = Debug.LogException;
            EditorApplication.update += MainThread.Drain;
            AssemblyReloadEvents.beforeAssemblyReload += Stop;
            EditorApplication.quitting += Stop;
            if (AutoStart) EditorApplication.delayCall += () => Start();
        }

        public static bool AutoStart
        {
            get => EditorPrefs.GetBool(AutoStartKey, true);
            set => EditorPrefs.SetBool(AutoStartKey, value);
        }

        public static bool IsRunning => Server != null && Server.IsRunning;

        public static List<string> GetExtraOrigins()
        {
            var list = new List<string>();
            foreach (var line in EditorPrefs.GetString(ExtraOriginsKey, "").Split('\n'))
            {
                var t = line.Trim();
                if (t.Length > 0) list.Add(t);
            }
            return list;
        }

        public static void SetExtraOrigins(string newlineSeparated)
        {
            EditorPrefs.SetString(ExtraOriginsKey, newlineSeparated ?? "");
        }

        public static string ProjectName => Path.GetFileName(Path.GetDirectoryName(Application.dataPath));

        /// <summary>工程 id：dataPath 的 SHA1 前 8 位 hex，同一工程稳定、不同工程几乎不撞。</summary>
        public static string ProjectId
        {
            get
            {
                using (var sha1 = SHA1.Create())
                {
                    var digest = sha1.ComputeHash(Encoding.UTF8.GetBytes(Application.dataPath));
                    var sb = new StringBuilder();
                    for (var i = 0; i < 4; i++) sb.Append(digest[i].ToString("x2"));
                    return sb.ToString();
                }
            }
        }

        public static bool Start()
        {
            if (IsRunning) return true;
            Stop();
            var server = new BridgeServer(new BridgeServerConfig
            {
                Engine = "unity",
                EngineVersion = Application.unityVersion,
                PluginVersion = PluginVersion,
                Project = new ProjectInfo(ProjectName, ProjectId),
                AssetsRoot = Application.dataPath,
                PortStart = Protocol.UnityPortStart,
                PortEnd = Protocol.UnityPortEnd,
                Adapter = new UnityAdapter(),
                ExtraOrigins = GetExtraOrigins(),
            });
            server.Logged += entry =>
            {
                if (entry.Level == LogLevel.Error) Debug.LogError("[Rezona Bridge] " + entry.Message);
            };
            server.StateChanged += _ => Changed?.Invoke();
            server.ProgressChanged += _ => Changed?.Invoke();
            server.Logged += _ => Changed?.Invoke();
            server.ConnectionChanged += (_, __) => Changed?.Invoke();
            try
            {
                server.Start();
                Server = server;
                LastStartError = null;
            }
            catch (PortsExhaustedException ex)
            {
                LastStartError = ex.Start + " 到 " + ex.End + " 全部被占用";
                Debug.LogWarning("[Rezona Bridge] " + LastStartError);
                server.Dispose();
            }
            catch (Exception ex)
            {
                LastStartError = ex.Message;
                Debug.LogException(ex);
                server.Dispose();
            }
            Changed?.Invoke();
            return Server != null;
        }

        public static void Stop()
        {
            var s = Server;
            Server = null;
            if (s != null)
            {
                try { s.Stop(); }
                catch (Exception ex) { Debug.LogException(ex); }
            }
            Changed?.Invoke();
        }
    }
}
