# Plugins

`websocket-sharp.dll` 来自 NuGet `WebSocketSharp 1.0.3-rc11`（`lib/websocket-sharp.dll`，.NET 3.5 目标，
MIT，版权 sta.blockhead，见 `LICENSE.txt`）。重新获取：

```
curl -L -o wss.nupkg https://www.nuget.org/api/v2/package/WebSocketSharp/1.0.3-rc11
unzip wss.nupkg lib/websocket-sharp.dll
```

`.meta` 文件由 Unity 首次导入时自动生成后提交，不要手写。
