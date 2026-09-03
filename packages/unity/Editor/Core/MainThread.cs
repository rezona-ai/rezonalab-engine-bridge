using System;
using System.Collections.Concurrent;
using System.Threading;
using System.Threading.Tasks;

namespace RezonaLab.EngineBridge.Editor
{
    /// <summary>
    /// 主线程泵：纯队列，不引用 Unity。websocket-sharp 回调在后台线程，而 AssetDatabase / 场景 API 只能在主线程调；
    /// Bootstrap 把 Drain 挂到 EditorApplication.update 上，网络线程用 Enqueue / Run 把工作投递过来。
    /// </summary>
    public static class MainThread
    {
        private static readonly ConcurrentQueue<Action> Queue = new ConcurrentQueue<Action>();
        private static int _mainThreadId = -1;

        /// <summary>Drain 抛出的异常交给这里（Bootstrap 接到 Debug.LogException）；未设置则吞掉不影响后续项。</summary>
        public static Action<Exception> OnException;

        public static bool IsMainThread => _mainThreadId == Thread.CurrentThread.ManagedThreadId;
        public static int Pending => Queue.Count;

        /// <summary>记录当前线程为主线程；Run 在主线程上直接内联执行，避免自己等自己。</summary>
        public static void CaptureMainThread()
        {
            _mainThreadId = Thread.CurrentThread.ManagedThreadId;
        }

        public static void Enqueue(Action action)
        {
            if (action == null) return;
            Queue.Enqueue(action);
        }

        /// <summary>在主线程执行 fn 并把结果回给调用方；调用方通常在网络线程上 await。</summary>
        public static Task<T> Run<T>(Func<T> fn)
        {
            if (IsMainThread)
            {
                try { return Task.FromResult(fn()); }
                catch (Exception ex) { return FromException<T>(ex); }
            }
            var tcs = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
            Queue.Enqueue(() =>
            {
                try { tcs.TrySetResult(fn()); }
                catch (Exception ex) { tcs.TrySetException(ex); }
            });
            return tcs.Task;
        }

        /// <summary>每帧从 EditorApplication.update 调一次：把当前积压的全部执行完；单项异常不影响其余。</summary>
        public static void Drain()
        {
            var n = Queue.Count;
            for (var i = 0; i < n; i++)
            {
                Action a;
                if (!Queue.TryDequeue(out a)) break;
                try { a(); }
                catch (Exception ex) { OnException?.Invoke(ex); }
            }
        }

        private static Task<T> FromException<T>(Exception ex)
        {
            var tcs = new TaskCompletionSource<T>();
            tcs.SetException(ex);
            return tcs.Task;
        }
    }
}
