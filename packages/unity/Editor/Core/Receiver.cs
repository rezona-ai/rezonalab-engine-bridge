using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace RezonaLab.EngineBridge.Editor
{
    /// <summary>transfer_begin 阶段的校验结果：先限额（4413 类）再一致性（4400 类）再文件名 / 格式（应用层错误，连接保持）。</summary>
    public sealed class BeginRejection
    {
        public enum RejectionKind { Limit, BadFrame, AppError }

        public RejectionKind Kind;
        public string Code;
        public string Message;

        public static BeginRejection Limit(string code, string message) => new BeginRejection { Kind = RejectionKind.Limit, Code = code, Message = message };
        public static BeginRejection BadFrame(string message) => new BeginRejection { Kind = RejectionKind.BadFrame, Message = message };
        public static BeginRejection AppError(string code, string message) => new BeginRejection { Kind = RejectionKind.AppError, Code = code, Message = message };
    }

    public sealed class FrameOrderException : Exception
    {
        public FrameOrderException(string message) : base(message) { }
    }

    public sealed class LimitException : Exception
    {
        public LimitException(string message) : base(message) { }
    }

    /// <summary>
    /// 单次传输的接收器：分块追加写入 &lt;tmpDir&gt;/&lt;transferId&gt;.part，边写边算 sha256，内存占用与文件大小无关；
    /// 全部到齐并校验后原子搬进工程目录。任何失败路径都删 .part。
    /// </summary>
    public sealed class TransferReceiver : IDisposable
    {
        // 文件名里不允许出现路径分隔符、NUL 与其它控制字符、`..`
        private static readonly Regex FileNameForbidden = new Regex(@"[\\/\x00-\x1f\x7f]|\.\.", RegexOptions.Compiled);
        private static readonly Regex UnsafeIdChars = new Regex("[^A-Za-z0-9._-]", RegexOptions.Compiled);

        public string TransferId { get; }
        public string FileName { get; }
        public long ByteSize { get; }
        public long ChunkCount { get; }
        public string PartPath { get; }

        private readonly string _expectedSha;
        private readonly long _chunkBytes;
        private IncrementalHash _hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        private FileStream _stream;
        private long _received;
        private long _nextIndex;
        private bool _finalized;

        public TransferReceiver(TransferBegin begin, string tmpDir)
        {
            TransferId = begin.TransferId;
            FileName = begin.FileName;
            ByteSize = begin.ByteSize;
            ChunkCount = begin.ChunkCount;
            _chunkBytes = begin.ChunkBytes;
            _expectedSha = begin.Sha256.ToLowerInvariant();
            // transferId 已由 Schema 限制长度；这里再剥掉一切非安全字符，临时文件名不信任任何外部输入
            PartPath = Path.Combine(tmpDir, UnsafeIdChars.Replace(begin.TransferId, "_") + ".part");
        }

        public long BytesReceived => _received;
        public long ExpectedIndex => _nextIndex;
        public int Percent => ByteSize == 0 ? 100 : (int)Math.Floor(_received * 100.0 / ByteSize);

        public static BeginRejection ValidateBegin(TransferBegin msg, Limits limits, string[] formats)
        {
            if (msg.ByteSize > limits.MaxFileBytes)
                return BeginRejection.Limit("TOO_LARGE", "byteSize " + msg.ByteSize + " exceeds maxFileBytes " + limits.MaxFileBytes);
            if (msg.ChunkCount > limits.MaxChunks)
                return BeginRejection.Limit("TOO_MANY_CHUNKS", "chunkCount " + msg.ChunkCount + " exceeds maxChunks " + limits.MaxChunks);
            if (msg.ChunkBytes != limits.ChunkBytes) return BeginRejection.BadFrame("chunkBytes must equal " + limits.ChunkBytes);
            var expectedCount = (msg.ByteSize + msg.ChunkBytes - 1) / msg.ChunkBytes;
            if (msg.ChunkCount != expectedCount) return BeginRejection.BadFrame("chunkCount inconsistent with byteSize");
            if (FileNameForbidden.IsMatch(msg.FileName) || msg.FileName.Trim() != msg.FileName || msg.FileName.StartsWith(".", StringComparison.Ordinal))
                return BeginRejection.BadFrame("fileName contains path separators or control characters");
            var ext = ExtensionOf(msg.FileName);
            if (ext.Length == 0 || Array.IndexOf(formats, ext) < 0)
                return BeginRejection.AppError("UNSUPPORTED_FORMAT", "format ." + (ext.Length == 0 ? "?" : ext) + " not accepted");
            if (msg.Kind == "sprite" && ext != "zip") return BeginRejection.AppError("UNSUPPORTED_FORMAT", "sprite must be a zip");
            return null;
        }

        /// <summary>小写扩展名（不带点）；与 Node 的 extname 一致：以点开头的名字不算有扩展名。</summary>
        public static string ExtensionOf(string fileName)
        {
            var dot = fileName.LastIndexOf('.');
            if (dot <= 0 || dot == fileName.Length - 1) return "";
            return fileName.Substring(dot + 1).ToLowerInvariant();
        }

        public void Open()
        {
            Directory.CreateDirectory(Path.GetDirectoryName(PartPath));
            _stream = new FileStream(PartPath, FileMode.Create, FileAccess.Write, FileShare.None);
        }

        /// <summary>严格顺序：index 必须等于期待的下一块；块大小必须符合计划。违反即抛 FrameOrderException（4400）/ LimitException（4413）。</summary>
        public void WriteChunk(long index, byte[] data, int offset, int length)
        {
            if (_stream == null) throw new InvalidOperationException("receiver not open");
            if (index != _nextIndex) throw new FrameOrderException("expected chunk " + _nextIndex + ", got " + index);
            if (index >= ChunkCount) throw new FrameOrderException("chunk " + index + " beyond chunkCount " + ChunkCount);
            var isLast = index == ChunkCount - 1;
            var expectedLen = isLast ? ByteSize - _chunkBytes * index : _chunkBytes;
            if (length != expectedLen) throw new FrameOrderException("chunk " + index + " has " + length + " bytes, expected " + expectedLen);
            if (_received + length > ByteSize) throw new LimitException("received bytes exceed byteSize");
            _stream.Write(data, offset, length);
            _hash.AppendData(data, offset, length);
            _received += length;
            _nextIndex += 1;
        }

        /// <summary>关闭写流并校验字节数与 sha256。不通过时删 .part 并返回失败原因（null 表示通过）。</summary>
        public string Finish()
        {
            if (_finalized) return "already finalized";
            _finalized = true;
            CloseStream();
            if (_received != ByteSize || _nextIndex != ChunkCount)
            {
                Abort();
                return "byte count mismatch";
            }
            var digest = ToHex(_hash.GetHashAndReset());
            if (digest != _expectedSha)
            {
                Abort();
                return "sha256 mismatch";
            }
            return null;
        }

        /// <summary>把校验过的 .part 搬到 &lt;destDir&gt;/&lt;fileName&gt;；同名存在则加 -2、-3 后缀。File.Move 跨卷时自动退化为 copy + delete。</summary>
        public string MoveTo(string destDir)
        {
            Directory.CreateDirectory(destDir);
            var target = UniquePath(destDir, FileName);
            File.Move(PartPath, target);
            return target;
        }

        /// <summary>删除临时文件（幂等）。连接断开 / 任何失败都要调。</summary>
        public void Abort()
        {
            CloseStream();
            try { if (File.Exists(PartPath)) File.Delete(PartPath); }
            catch (IOException) { /* 尽力而为 */ }
            catch (UnauthorizedAccessException) { /* 尽力而为 */ }
        }

        public void Dispose()
        {
            CloseStream();
            _hash?.Dispose();
            _hash = null;
        }

        /// <summary>&lt;dir&gt;/&lt;name&gt; 不存在则原样返回；否则依次试 &lt;stem&gt;-2&lt;ext&gt;、&lt;stem&gt;-3&lt;ext&gt;…（目录名也适用）。</summary>
        public static string UniquePath(string dir, string name)
        {
            var ext = Path.GetExtension(name);
            var stem = name.Substring(0, name.Length - ext.Length);
            for (var n = 1; n < 10_000; n++)
            {
                var candidate = Path.Combine(dir, n == 1 ? name : stem + "-" + n + ext);
                if (!File.Exists(candidate) && !Directory.Exists(candidate)) return candidate;
            }
            throw new BridgeException("INTERNAL", "cannot find a free name for " + name);
        }

        private void CloseStream()
        {
            if (_stream == null) return;
            var s = _stream;
            _stream = null;
            s.Dispose();
        }

        private static string ToHex(byte[] bytes)
        {
            var sb = new StringBuilder(bytes.Length * 2);
            foreach (var b in bytes) sb.Append(b.ToString("x2"));
            return sb.ToString();
        }
    }
}
