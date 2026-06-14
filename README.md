# aether

## PWA 使用

这个项目已经包含基础 PWA 文件：

- `manifest.webmanifest`
- `service-worker.js`
- `assets/aether-icon-192.png`
- `assets/aether-icon-512.png`

本地电脑验证：

```powershell
python -m http.server 8765 --bind 127.0.0.1
```

然后打开：

```text
http://127.0.0.1:8765/aether.html
```

也可以直接打开站点根路径，`index.html` 会自动跳转到聊天页：

```text
http://127.0.0.1:8765/
```

安卓手机安装：

PWA 的 Service Worker 需要 HTTPS，手机也不能直接使用电脑的 `127.0.0.1`。要在安卓上添加到主屏幕，建议把这些静态文件部署到 HTTPS 站点，例如 GitHub Pages、Cloudflare Pages、Netlify 或 Vercel，然后用安卓 Chrome 打开部署后的 `aether.html`，选择“添加到主屏幕”。

注意：当前应用仍然在前端直接调用 DeepSeek API。个人自用可以继续使用浏览器内保存 Key 的方式；如果要公开部署给别人使用，应先增加后端代理或安全的 Key 管理方案。

## 联网功能

本地服务提供联网辅助接口：

- `/api/web/search?q=关键词`
- `/api/web/read?url=网页地址`
- `/api/web/context?q=用户问题`

前端设置中可以选择联网模式：

- 自动判断
- 手动触发（输入 `/web` 或 `#联网`）
- 关闭

搜索提供方通过环境变量配置。默认没有 Key 时会尝试 DuckDuckGo HTML 备用搜索；推荐配置 Tavily 或 Brave：

```powershell
$env:WEB_SEARCH_PROVIDER="tavily"
$env:TAVILY_API_KEY="你的 Tavily Key"
python .\launch_server.py
```

或：

```powershell
$env:WEB_SEARCH_PROVIDER="brave"
$env:BRAVE_SEARCH_API_KEY="你的 Brave Search Key"
python .\launch_server.py
```

网页读取只允许公网 `http/https` 地址，会拒绝 localhost、内网和保留地址。
