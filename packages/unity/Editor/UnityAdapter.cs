using System;
using System.IO;
using System.Threading.Tasks;
using UnityEditor;
using UnityEditor.PackageManager;
using UnityEditor.PackageManager.Requests;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace RezonaLab.EngineBridge.Editor
{
    /// <summary>
    /// Unity 适配层：内核把文件落到 Assets/RezonaAssets/ 后，这里负责导入资产库并（glb）实例化到场景。
    /// 内核在网络线程上调 ImportFile；所有 AssetDatabase / 场景 API 经 MainThread.Run 切回主线程。
    /// 只做 glb（KTD-5），依赖 glTFast；缺包时抛 IMPORT_FAILED 并抬 GltfFastMissing 事件让面板显示黄条。
    /// </summary>
    public sealed class UnityAdapter : IEngineAdapter
    {
        public const string GltfFastPackage = "com.unity.cloud.gltfast";

        /// <summary>主线程触发；面板据此显示「需要 glTFast 包」黄条。</summary>
        public static event Action GltfFastMissing;

        private static ListRequest _listRequest;
        private static bool? _gltfFastFromPackageList;

        public bool IsProjectOpen() => true; // Unity 编辑器进程必然打开着一个工程

        public Task<ImportOutcome> ImportFile(string absPath, ImportMeta meta)
        {
            return MainThread.Run(() => ImportOnMainThread(absPath, meta));
        }

        private static ImportOutcome ImportOnMainThread(string absPath, ImportMeta meta)
        {
            var relPath = ToAssetPath(absPath);
            if (relPath == null) throw new BridgeException("IMPORT_FAILED", "path is outside Assets/: " + absPath);

            var isGltf = relPath.EndsWith(".glb", StringComparison.OrdinalIgnoreCase) || relPath.EndsWith(".gltf", StringComparison.OrdinalIgnoreCase);
            if (meta.Kind == "model3d" && isGltf && !IsGltfFastPresent()) // fbx 走 Unity 自带的 ModelImporter，不需要 glTFast
            {
                GltfFastMissing?.Invoke();
                throw new BridgeException("IMPORT_FAILED", "需要 glTFast 包（" + GltfFastPackage + "）才能导入 glb");
            }

            var isDir = Directory.Exists(absPath);
            AssetDatabase.StartAssetEditing();
            try
            {
                var options = ImportAssetOptions.ForceUpdate;
                if (isDir) options |= ImportAssetOptions.ImportRecursive;
                AssetDatabase.ImportAsset(relPath, options);
            }
            finally
            {
                AssetDatabase.StopAssetEditing();
            }
            AssetDatabase.Refresh();

            var outcome = new ImportOutcome { SavedPath = relPath };
            if (meta.Kind == "model3d" && !isDir)
            {
                var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(relPath);
                if (prefab == null) throw new BridgeException("IMPORT_FAILED", (isGltf ? "glTFast" : "ModelImporter") + " 未从 " + relPath + " 产出 GameObject");
                var scene = EditorSceneManager.GetActiveScene();
                var instance = PrefabUtility.InstantiatePrefab(prefab, scene) as GameObject;
                if (instance == null) throw new BridgeException("IMPORT_FAILED", "无法实例化 " + relPath);
                instance.transform.position = Vector3.zero;
                if (!string.IsNullOrEmpty(meta.DisplayName)) instance.name = meta.DisplayName;
                Selection.activeGameObject = instance;
                EditorSceneManager.MarkSceneDirty(scene);
                outcome.SceneNode = instance.name;
            }
            return outcome;
        }

        /// <summary>绝对路径 → "Assets/..." 相对路径（正斜杠）；不在 Assets 下返回 null。</summary>
        public static string ToAssetPath(string absPath)
        {
            var dataPath = Path.GetFullPath(Application.dataPath).Replace('\\', '/').TrimEnd('/');
            var full = Path.GetFullPath(absPath).Replace('\\', '/');
            if (!full.StartsWith(dataPath + "/", StringComparison.Ordinal)) return null;
            return "Assets" + full.Substring(dataPath.Length);
        }

        /// <summary>先看类型是否已加载（最快、最准），再退回 Package Manager 列表（缓存，异步补齐）。</summary>
        public static bool IsGltfFastPresent()
        {
            if (Type.GetType("GLTFast.Editor.GltfImporter, glTFast.Editor") != null) return true;
            foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                if (asm.GetName().Name.StartsWith("glTFast", StringComparison.Ordinal)) return true;
            }
            if (_gltfFastFromPackageList.HasValue) return _gltfFastFromPackageList.Value;
            if (_listRequest == null) _listRequest = Client.List(true);
            if (_listRequest.IsCompleted)
            {
                var found = false;
                if (_listRequest.Status == StatusCode.Success)
                {
                    foreach (var p in _listRequest.Result)
                    {
                        if (p.name == GltfFastPackage) { found = true; break; }
                    }
                }
                _gltfFastFromPackageList = found;
                return found;
            }
            return false;
        }

        /// <summary>面板「添加 glTFast」按钮。</summary>
        public static AddRequest AddGltfFast()
        {
            _gltfFastFromPackageList = null;
            _listRequest = null;
            return Client.Add(GltfFastPackage);
        }
    }
}
