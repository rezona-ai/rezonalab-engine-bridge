using System.Threading.Tasks;

namespace RezonaLab.EngineBridge.Editor
{
    /// <summary>内核交给适配层的元数据：文件已在工程目录内落好，适配层只负责「导入资产库 + 实例化到场景」。</summary>
    public sealed class ImportMeta
    {
        public string Kind;
        /// <summary>落盘后的文件名（zip 解压时为目录名）。</summary>
        public string FileName;
        public string ItemId;
        public string DisplayName;
        public string TransferId;
    }

    public sealed class ImportOutcome
    {
        /// <summary>工程内路径（Unity 为 Assets/ 相对路径）。</summary>
        public string SavedPath;
        /// <summary>实例化到场景的节点名；未实例化则为 null。</summary>
        public string SceneNode;
    }

    /// <summary>
    /// 引擎适配层接口。接第 N 个引擎只需实现这一层：
    /// ImportFile 拿到的是已校验、已落在 &lt;assetsRoot&gt;/RezonaAssets/ 下的绝对路径（zip 时为解压目录），
    /// 返回工程内路径或抛出带 Code 的 BridgeException。适配层不碰网络与文件接收；内核不引用任何引擎 API。
    /// </summary>
    public interface IEngineAdapter
    {
        Task<ImportOutcome> ImportFile(string absPath, ImportMeta meta);
        bool IsProjectOpen();
    }
}
