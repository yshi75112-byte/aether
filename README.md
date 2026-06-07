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

安卓手机安装：

PWA 的 Service Worker 需要 HTTPS，手机也不能直接使用电脑的 `127.0.0.1`。要在安卓上添加到主屏幕，建议把这些静态文件部署到 HTTPS 站点，例如 GitHub Pages、Cloudflare Pages、Netlify 或 Vercel，然后用安卓 Chrome 打开部署后的 `aether.html`，选择“添加到主屏幕”。

注意：当前应用仍然在前端直接调用 DeepSeek API。个人自用可以继续使用浏览器内保存 Key 的方式；如果要公开部署给别人使用，应先增加后端代理或安全的 Key 管理方案。
