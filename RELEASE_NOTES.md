# Codex Usage Card Windows 0.9.4-win.9 — 公开测试版

基于 Lorie7813/codex-usage-card 的社区 Windows 移植，MIT许可，保留原版双圆环外观。

本版支持原生应用入口自动接管、更新后的路径重新发现、每10秒只读刷新、额度变化通知、读取时间提示和30秒过期保护。不创建额外桌面图标。

增加首次下载依赖/登录检查、后台实际启动检查、用户明确同意后的正常重启按钮流程、中文路径兼容；移除私人迁移清理逻辑，改用不依赖VBScript的无窗口.NET后台宿主。

需要 Windows x64、Node.js24+、.NET Framework，以及已登录且带原生CLI的OpenAI.Codex商店桌面版。已完成一台Windows11 x64电脑上的真实启动与连续刷新验证；首次发布请标记Pre-release，欢迎反馈其他配置。

下载ZIP并完整解压，运行Install.cmd，通过检查后安装。保存工作并选择Y，可让安装器正常重启Codex并启用卡片。卸载运行Uninstall.cmd。详细前提、启动保护和已知限制见README。

附件同时提供SHA-256校验文件。示例截图使用测试数据。原作者及许可见UPSTREAM.md和LICENSE。
