using System.Collections.Generic;
using NUnit.Framework;
using RezonaLab.EngineBridge.Editor;
using UnityEditor;

namespace RezonaLab.EngineBridge.Editor.Tests
{
    /// <summary>
    /// 「高级 → 额外允许来源」那个输入框的保存路径。
    ///
    /// 窗口里的 TextArea 改动时直接调 <see cref="Bootstrap.SetExtraOrigins"/>，服务端启动时读
    /// <see cref="Bootstrap.GetExtraOrigins"/> 并追加进白名单。这条链此前没有任何测试，
    /// 而它是本机调试网页（http://localhost:3000）唯一的入口——断了就只能看到「未找到编辑器」。
    /// </summary>
    public class ExtraOriginsTests
    {
        private string _saved;

        [SetUp]
        public void SaveExisting() => _saved = EditorPrefs.GetString(Bootstrap.ExtraOriginsKey, "");

        [TearDown]
        public void RestoreExisting() => EditorPrefs.SetString(Bootstrap.ExtraOriginsKey, _saved);

        [Test]
        public void RoundTripsThroughEditorPrefs()
        {
            Bootstrap.SetExtraOrigins("http://localhost:3000");
            Assert.AreEqual(new List<string> { "http://localhost:3000" }, Bootstrap.GetExtraOrigins());
            // 面板存的是整块文本，读回来要按行拆开
            Assert.AreEqual("http://localhost:3000", EditorPrefs.GetString(Bootstrap.ExtraOriginsKey, ""));
        }

        [Test]
        public void SplitsLinesAndDropsBlanksAndWhitespace()
        {
            Bootstrap.SetExtraOrigins("  http://localhost:3000  \n\n\thttp://127.0.0.1:5173\n   \n");
            Assert.AreEqual(
                new List<string> { "http://localhost:3000", "http://127.0.0.1:5173" },
                Bootstrap.GetExtraOrigins());
        }

        [Test]
        public void EmptyOrNullClearsInsteadOfAddingABlankOrigin()
        {
            Bootstrap.SetExtraOrigins("http://localhost:3000");
            Bootstrap.SetExtraOrigins(null);
            Assert.IsEmpty(Bootstrap.GetExtraOrigins());
            Bootstrap.SetExtraOrigins("   \n  ");
            Assert.IsEmpty(Bootstrap.GetExtraOrigins());
        }

        [Test]
        public void SavedOriginIsAcceptedByTheOriginCheckWhileDefaultsStillApply()
        {
            Bootstrap.SetExtraOrigins("http://localhost:3000");
            // 服务端启动时就是这样拼白名单的：默认三个 lab 域 + 面板里存的那几行
            var allowlist = new List<string>(Origin.DefaultAllowlist);
            allowlist.AddRange(Bootstrap.GetExtraOrigins());

            Assert.IsTrue(Origin.IsAllowed("http://localhost:3000", allowlist), "面板里加的来源应当被放行");
            Assert.IsTrue(Origin.IsAllowed("https://devlab.rezona.ai", allowlist), "加了额外来源不该顶掉默认白名单");
            Assert.IsFalse(Origin.IsAllowed("http://localhost:3001", allowlist), "端口不同即不同来源");
            Assert.IsFalse(Origin.IsAllowed("https://evil.example", allowlist));
        }
    }
}
