# Codex Usage Card for Windows

基于 [Lorie7813/codex-usage-card](https://github.com/Lorie7813/codex-usage-card) 的社区 Windows 移植，保留原版侧栏双圆环外观。当前版本：**0.9.4-win.9（Windows 公开测试版）**。

本项目由社区维护，与 OpenAI 及上游作者的官方 Windows 发行无关。首次公开发布建议使用 GitHub Pre-release，便于收集不同电脑上的兼容性反馈。

## 效果示例

下图来自独立测试页面，显示示例数据，不是任何用户的真实额度。

| 浅色模式 | 深色模式 |
| --- | --- |
| ![浅色双圆环](docs/images/card-light.png) | ![深色双圆环](docs/images/card-dark.png) |

- 侧栏展示五小时与每周剩余额度，悬浮查看重置时间与最近成功读取时间。
- 每10秒主动读取，收到额度变化通知时立即更新。查询不调用模型推理。
- 读取失败或连续30秒未更新时显示未知，避免长期保留过期百分比。
- 支持原有 GPT / Codex 桌面、开始菜单及任务栏入口，不创建独立桌面图标。
- 启动接管重新发现当前商店包和受管 CLI，兼容版本目录更新。

## 安装前提

- Windows x64；核心侧栏已在一台Windows11 x64电脑完成真实验证；公开安装器另做了隔离安装检查，其他电脑配置仍需社区测试。
- [Node.js](https://nodejs.org/) **24或更高版本**，在终端运行 `node --version` 可以查看。
- Windows .NET Framework 编译器，用于本机生成启动助手。
- 已安装并登录 OpenAI.Codex 商店桌面版，且包含可用的原生 Codex CLI。

ZIP 不包含 Node.js、Codex 桌面版、OpenAI 二进制文件或任何登录信息。

## 安装

1. 从本仓库 Releases 下载 Windows ZIP。确认来源后，在ZIP属性中勾选“解除锁定”（如有），再完整解压。此社区源码包未购买代码签名证书；工具不会自动关闭系统脚本策略。
2. 双击 `Check.cmd` 可只做依赖和登录检查；双击 `Install.cmd` 会先检查再安装。也可在解压目录运行：

```powershell
node .\manage.cjs install
```

3. 安装器确认后台真正启动后，会询问是否立即正常重启Codex。保存工作并选择Y，可直接启用；应用拒绝时不会强制终止。选择N可稍后启用。
4. 以后直接使用原来的应用图标打开。首次启动接管可能增加一次短暂重开。若只运行命令行安装，可在保存工作后执行 `node manage.cjs restart-now --confirm-work-saved` 启用。

公开版只管理自己的后台与侧栏，不自动移除其他额度插件。无窗口后台由本机编译的.NET宿主运行，不依赖VBScript。

安装目录：`%USERPROFILE%\.codex\addons\codex-usage-card`。登录后台任务：`\CodexUsageCard\Agent`。安装为当前用户配置后台任务；受管电脑的权限或策略可能限制安装。

## 检查与排障

```powershell
node .\manage.cjs probe
node .\manage.cjs status
node .\manage.cjs verify
```

- `probe`：测试真实额度读取，不发起模型推理。
- `verify`：当前真实侧栏的位置、唯一性和新鲜数值都通过时返回0，否则返回2。
- 若关闭窗口后未自动重开，应用可能仍在后台运行；先检查 `status` 的阶段。
- 诊断文件位于安装目录。提交 Issue 时只提供必要错误信息，先移除账户信息、会话内容、令牌和个人路径。

后台不会接管安装前已经打开的工作窗口。新启动时，后台在原生窗口准备好且尚未进入工作前尝试正常退出与重开；应用拒绝、已开始输入、观察不可靠、多实例或端口冲突等情况会跳过，不强制结束进程。

## 卸载

双击 `Uninstall.cmd` 或运行：

```powershell
node .\manage.cjs uninstall
```

卸载后正常完全退出一次，再从原图标打开。工具保留源码和诊断文件，不卸载 GPT / Codex。

## 连接方式与已知限制

工具通过 `127.0.0.1:39222` 的本机调试接口加载侧栏，只读查询额度。不要把此端口转发到公网。它不修改签名应用安装包，不改变系统安全策略，也不读取聊天内容或消费重置券。

这是对内部界面的集成；未来应用结构、窗口类型或协议变化仍可能需要适配。每10秒刷新表示本地读取周期，服务端自身的统计延迟仍以其返回值为准。没有承诺任意未来版本或所有Windows环境都已验证。

## 开发与验证

```powershell
node --test tests/core.test.cjs tests/native-startup.test.cjs tests/distribution.test.cjs
```

浏览器测试需自行安装 Playwright 与 Edge；原生生命周期测试应使用 `TEST_BRIDGE` 隔离构建，只识别测试程序。详见 [验证范围](TEST-RESULTS.md)。

## 许可与致谢

采用 MIT 许可证，保留上游贡献者的版权和许可声明。感谢 [Lorie7813/codex-usage-card](https://github.com/Lorie7813/codex-usage-card)。上游版本及修改说明见 [UPSTREAM.md](UPSTREAM.md)，完整许可见 [LICENSE](LICENSE)。
