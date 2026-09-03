using System;
using System.Collections.Generic;
using System.Globalization;

namespace RezonaLab.EngineBridge.Editor
{
    /// <summary>
    /// Origin 白名单校验：精确匹配 scheme + host + port。缺 Origin 头视为拒绝。
    /// 浏览器保证页面脚本改不了 Origin 头，因此这是「恶意网页写用户工程」的唯一也是足够的闸。
    /// </summary>
    public static class Origin
    {
        /// <summary>默认允许的网页来源：三套 lab 环境。开发者可在面板「高级」追加 localhost 一类地址。</summary>
        public static readonly string[] DefaultAllowlist =
        {
            "https://lab.rezona.ai",
            "https://stalab.rezona.ai",
            "https://devlab.rezona.ai",
        };

        /// <summary>规范化成 scheme://host[:port]（去默认端口与尾部斜杠，小写）；非法返回 null。</summary>
        public static string Normalize(string raw)
        {
            if (raw == null) return null;
            Uri url;
            if (!Uri.TryCreate(raw.Trim(), UriKind.Absolute, out url)) return null;
            if (url.Scheme != "http" && url.Scheme != "https") return null;
            // 与 WHATWG URL 一致：只接受纯 origin（路径为 / 且无 query / fragment）
            if (url.AbsolutePath != "/" || !string.IsNullOrEmpty(url.Query) || !string.IsNullOrEmpty(url.Fragment)) return null;
            if (string.IsNullOrEmpty(url.Host)) return null;
            var host = url.Host.ToLowerInvariant();
            if (url.HostNameType == UriHostNameType.IPv6) host = "[" + host.Trim('[', ']') + "]";
            var port = url.IsDefaultPort ? "" : ":" + url.Port.ToString(CultureInfo.InvariantCulture);
            return url.Scheme + "://" + host + port;
        }

        public static bool IsAllowed(string originHeader, IEnumerable<string> allowlist)
        {
            if (string.IsNullOrEmpty(originHeader)) return false;
            var origin = Normalize(originHeader);
            if (origin == null) return false;
            foreach (var allowed in allowlist)
            {
                var n = Normalize(allowed);
                if (n != null && n == origin) return true;
            }
            return false;
        }
    }
}
