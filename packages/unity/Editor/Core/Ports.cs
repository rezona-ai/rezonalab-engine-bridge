using System;
using System.Net;
using System.Net.Sockets;

namespace RezonaLab.EngineBridge.Editor
{
    public sealed class PortsExhaustedException : Exception
    {
        public int Start { get; }
        public int End { get; }

        public PortsExhaustedException(int start, int end) : base("ports " + start + "-" + end + " are all in use")
        {
            Start = start;
            End = end;
        }
    }

    /// <summary>
    /// 端口段顺延：从段首逐个尝试在 127.0.0.1 上 bind，返回第一个成功的端口。
    /// 探测与真正监听之间有极小竞争窗口，Server 在 Start 失败时会从下一个端口继续。
    /// </summary>
    public static class Ports
    {
        public static bool IsFree(int port)
        {
            TcpListener listener = null;
            try
            {
                listener = new TcpListener(IPAddress.Loopback, port);
                listener.ExclusiveAddressUse = true;
                listener.Start();
                return true;
            }
            catch (SocketException)
            {
                return false;
            }
            finally
            {
                try { listener?.Stop(); } catch (Exception) { /* 已停 */ }
            }
        }

        /// <summary>返回 [start, end] 内第一个空闲端口（从 from 起，含）；全占则抛 PortsExhaustedException。</summary>
        public static int FindFirstFree(int start, int end, int from = -1)
        {
            for (var port = Math.Max(start, from); port <= end; port++)
            {
                if (IsFree(port)) return port;
            }
            throw new PortsExhaustedException(start, end);
        }
    }
}
