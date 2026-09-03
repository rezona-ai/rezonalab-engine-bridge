using System;
using System.IO;
using System.IO.Compression;

namespace RezonaLab.EngineBridge.Editor
{
    /// <summary>
    /// 安全解压：条目名校验 + GetFullPath 前缀断言 + 条目数 / 总量限额；解压时按实际字节计数（不信头里的 uncompressedSize）。
    /// 任一失败会删掉整个 destDir 后抛 BridgeException。
    /// </summary>
    public static class ZipSafe
    {
        public const int MaxEntries = 500;
        public const long MaxTotalBytes = 1024L * 1024 * 1024;

        /// <summary>
        /// 条目名安全性：拒绝绝对路径、反斜杠开头、盘符、`..` 段、NUL、空名；反斜杠统一视为分隔符（Windows 打的包）。
        /// 返回规范化后的相对路径（正斜杠），不安全返回 null。
        /// </summary>
        public static string SanitizeEntryName(string name)
        {
            if (string.IsNullOrEmpty(name) || name.IndexOf('\0') >= 0) return null;
            if (name[0] == '/' || name[0] == '\\') return null;
            if (name.Length >= 2 && char.IsLetter(name[0]) && name[1] == ':') return null;
            var segments = name.Replace('\\', '/').Split('/');
            var kept = new System.Collections.Generic.List<string>();
            foreach (var seg in segments)
            {
                if (seg == "..") return null;
                if (seg.Length > 0 && seg != ".") kept.Add(seg);
            }
            return kept.Count == 0 ? null : string.Join("/", kept);
        }

        /// <summary>ZIP 外部属性高 16 位是 Unix mode；S_IFLNK 表示符号链接，整包拒绝。</summary>
        public static bool IsSymlink(int externalAttributes)
        {
            return (((uint)externalAttributes >> 16) & 0xF000) == 0xA000;
        }

        public static void Extract(string zipPath, string destDir, int maxEntries = MaxEntries, long maxTotalBytes = MaxTotalBytes)
        {
            Directory.CreateDirectory(destDir);
            var destFull = Path.GetFullPath(destDir).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            var prefix = destFull + Path.DirectorySeparatorChar;
            try
            {
                using (var archive = ZipFile.OpenRead(zipPath))
                {
                    var count = 0;
                    long total = 0;
                    foreach (var entry in archive.Entries)
                    {
                        count += 1;
                        if (count > maxEntries) throw new BridgeException("ZIP_TOO_MANY_ENTRIES", "zip has more than " + maxEntries + " entries");
                        var rawName = entry.FullName;
                        var rel = SanitizeEntryName(rawName);
                        if (rel == null) throw new BridgeException("ZIP_UNSAFE_ENTRY", "unsafe zip entry: " + rawName);
                        if (IsSymlink(entry.ExternalAttributes)) throw new BridgeException("ZIP_UNSAFE_ENTRY", "symlink zip entry: " + rawName);
                        var target = Path.GetFullPath(Path.Combine(destFull, rel.Replace('/', Path.DirectorySeparatorChar)));
                        if (!target.StartsWith(prefix, StringComparison.Ordinal)) throw new BridgeException("ZIP_UNSAFE_ENTRY", "zip entry escapes target dir: " + rawName);
                        var isDir = rawName.EndsWith("/", StringComparison.Ordinal) || rawName.EndsWith("\\", StringComparison.Ordinal);
                        if (isDir)
                        {
                            Directory.CreateDirectory(target);
                            continue;
                        }
                        if (total + entry.Length > maxTotalBytes) throw new BridgeException("ZIP_TOO_LARGE", "zip expands beyond " + maxTotalBytes + " bytes");
                        var parent = Path.GetDirectoryName(target);
                        Directory.CreateDirectory(parent);
                        // 写之前再确认父目录仍在 dest 内（符号链接已整包拒绝，这是双保险）
                        var parentFull = Path.GetFullPath(parent);
                        if (parentFull != destFull && !parentFull.StartsWith(prefix, StringComparison.Ordinal))
                            throw new BridgeException("ZIP_UNSAFE_ENTRY", "zip entry parent escapes target dir: " + rawName);
                        using (var input = entry.Open())
                        using (var output = new FileStream(target, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                        {
                            var buf = new byte[64 * 1024];
                            int n;
                            while ((n = input.Read(buf, 0, buf.Length)) > 0)
                            {
                                total += n;
                                if (total > maxTotalBytes) throw new BridgeException("ZIP_TOO_LARGE", "zip expands beyond " + maxTotalBytes + " bytes");
                                output.Write(buf, 0, n);
                            }
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                try { if (Directory.Exists(destDir)) Directory.Delete(destDir, true); }
                catch (Exception) { /* 尽力而为 */ }
                if (ex is BridgeException) throw;
                throw new BridgeException("ZIP_UNSAFE_ENTRY", "zip could not be read: " + ex.Message);
            }
        }
    }
}
