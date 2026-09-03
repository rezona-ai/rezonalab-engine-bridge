using System;
using System.IO;
using System.IO.Compression;
using NUnit.Framework;

namespace RezonaLab.EngineBridge.Editor.Tests
{
    public sealed class ZipSafeTests
    {
        private string _tmp;

        [SetUp]
        public void SetUp()
        {
            _tmp = Path.Combine(Path.GetTempPath(), "rezona-zipsafe-" + Guid.NewGuid().ToString("N").Substring(0, 8));
            Directory.CreateDirectory(_tmp);
        }

        [TearDown]
        public void TearDown()
        {
            if (Directory.Exists(_tmp)) Directory.Delete(_tmp, true);
        }

        private string MakeZip(params string[] entryNames)
        {
            var zip = Path.Combine(_tmp, "in.zip");
            using (var fs = new FileStream(zip, FileMode.Create))
            using (var za = new ZipArchive(fs, ZipArchiveMode.Create))
            {
                foreach (var name in entryNames)
                {
                    using (var w = new StreamWriter(za.CreateEntry(name).Open())) w.Write("payload");
                }
            }
            return zip;
        }

        [Test]
        public void SanitizeRejectsTraversalAndAbsolute()
        {
            Assert.IsNull(ZipSafe.SanitizeEntryName("../evil.txt"));
            Assert.IsNull(ZipSafe.SanitizeEntryName("a/../../evil.txt"));
            Assert.IsNull(ZipSafe.SanitizeEntryName("/etc/passwd"));
            Assert.IsNull(ZipSafe.SanitizeEntryName("\\windows\\x"));
            Assert.IsNull(ZipSafe.SanitizeEntryName("C:evil"));
            Assert.IsNull(ZipSafe.SanitizeEntryName("a\0b"));
            Assert.AreEqual("a/b.png", ZipSafe.SanitizeEntryName("a\\b.png"));
            Assert.AreEqual("a/b.png", ZipSafe.SanitizeEntryName("./a//b.png"));
        }

        [Test]
        public void TraversalEntryRejectedAndNothingWrittenOutside()
        {
            var zip = MakeZip("ok.txt", "../evil.txt");
            var dest = Path.Combine(_tmp, "out", "hero");
            var ex = Assert.Throws<BridgeException>(() => ZipSafe.Extract(zip, dest));
            Assert.AreEqual("ZIP_UNSAFE_ENTRY", ex.Code);
            Assert.IsFalse(Directory.Exists(dest), "解压目录必须被整体删除");
            Assert.IsFalse(File.Exists(Path.Combine(_tmp, "out", "evil.txt")));
            Assert.IsFalse(File.Exists(Path.Combine(_tmp, "evil.txt")));
        }

        [Test]
        public void TooManyEntriesRejected()
        {
            var names = new string[3];
            for (var i = 0; i < names.Length; i++) names[i] = "f" + i + ".txt";
            var zip = MakeZip(names);
            var dest = Path.Combine(_tmp, "out");
            var ex = Assert.Throws<BridgeException>(() => ZipSafe.Extract(zip, dest, maxEntries: 2));
            Assert.AreEqual("ZIP_TOO_MANY_ENTRIES", ex.Code);
            Assert.IsFalse(Directory.Exists(dest));
        }

        [Test]
        public void TooLargeRejected()
        {
            var zip = MakeZip("a.txt", "b.txt");
            var dest = Path.Combine(_tmp, "out");
            var ex = Assert.Throws<BridgeException>(() => ZipSafe.Extract(zip, dest, maxTotalBytes: 10));
            Assert.AreEqual("ZIP_TOO_LARGE", ex.Code);
            Assert.IsFalse(Directory.Exists(dest));
        }

        [Test]
        public void SafeZipExtracts()
        {
            var zip = MakeZip("hero.png", "sub/hero.json");
            var dest = Path.Combine(_tmp, "out");
            ZipSafe.Extract(zip, dest);
            Assert.IsTrue(File.Exists(Path.Combine(dest, "hero.png")));
            Assert.IsTrue(File.Exists(Path.Combine(dest, "sub", "hero.json")));
        }
    }
}
