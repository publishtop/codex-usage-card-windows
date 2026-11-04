# 上传 GitHub 的步骤

建议仓库名：codex-usage-card-windows。描述：Community Windows port of Lorie7813/codex-usage-card with native startup and fresh quota rings.

1. GitHub右上角＋ → New repository，选择你的账号与Public，创建仓库。当前副本已含README、LICENSE、.gitignore，可不勾选在线自动生成。
2. 用GitHub网页上传本文件所在目录的全部内容，让README.md和manage.cjs位于仓库根目录。文件夹结构（tests、windows、docs）需要保留；不要只上传一个ZIP到代码页。
3. 提交到main后，打开Releases → Draft a new release。Tag填写v0.9.4-win.10，Target选main。
4. 标题填写Codex Usage Card Windows 0.9.4-win.10 — Preview，正文复制RELEASE_NOTES.md。勾选This is a pre-release。
5. 附件上传整理后的Windows社区版ZIP及它的.sha256文件。先Save draft检查源码、图片和附件，确认后Publish release。
6. 分享仓库链接和Releases链接。可在仓库About里添加codex、windows、usage-monitor等主题。若以后向上游介绍或提交PR，请明确说明社区移植及测试范围。

请上传此公开副本；不要上传自己的.codex目录、认证文件、安装目录或原始诊断日志。

此文件只是发布操作说明，当前整理步骤没有创建远程仓库，也没有执行GitHub上传。

官方文档：
- https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-new-repository
- https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository
