using System;
using System.Collections.Generic;
using System.IO;
using NUnit.Framework;
using UnityEditor.PackageManager;

namespace RezonaLab.EngineBridge.Editor.Tests
{
    /// <summary>
    /// 跑 protocol/fixtures 的全部夹具（scripts/test-unity.mjs 复制到包内 Tests/Fixtures/）。
    /// 与 core-ts 共用同一批夹具，是 C# 移植与 TypeScript 内核行为一致的唯一保障。
    /// </summary>
    public sealed class FixtureTests
    {
        public const int ExpectedFixtureCount = 11;

        public static string FixturesDir()
        {
            var env = Environment.GetEnvironmentVariable("REZONA_BRIDGE_FIXTURES");
            if (!string.IsNullOrEmpty(env) && Directory.Exists(env)) return env;
            var info = PackageInfo.FindForAssembly(typeof(FixtureTests).Assembly);
            if (info != null)
            {
                var dir = Path.Combine(info.resolvedPath, "Tests", "Fixtures");
                if (Directory.Exists(dir)) return dir;
            }
            throw new InvalidOperationException("找不到夹具目录：请经 `npm run test:unity` 运行（它会复制 protocol/fixtures 到包内 Tests/Fixtures/），或设置 REZONA_BRIDGE_FIXTURES");
        }

        public static IEnumerable<TestCaseData> Cases()
        {
            foreach (var f in Directory.GetFiles(FixturesDir(), "*.json"))
            {
                yield return new TestCaseData(f).SetName("Fixture_" + Path.GetFileNameWithoutExtension(f));
            }
        }

        [Test]
        public void FixtureCountIsEleven()
        {
            Assert.AreEqual(ExpectedFixtureCount, Directory.GetFiles(FixturesDir(), "*.json").Length);
        }

        [TestCaseSource(nameof(Cases))]
        public void FixtureMatches(string path)
        {
            var fixture = FixtureRunner.Load(path);
            var actual = FixtureRunner.Run(fixture);
            var diff = FixtureRunner.Diff(fixture, actual);
            Assert.IsNull(diff, fixture.Name + "\n" + diff);
        }
    }
}
