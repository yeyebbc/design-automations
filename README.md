# Design Automations

用于 Adobe Illustrator 与 Affinity Designer 批处理的自动化脚本集合。

## 脚本

- `批量背景适配.jsx`：按 `文件列表.txt` 批量调整 Illustrator 文件的背景对象，保存到新的输出目录，不覆盖源文件。
- `批量背景适配-分块启动器.command`：macOS 下分块处理数千文件的启动器。Illustrator 原生内存随每次打开/关闭累积且无法回收，约数百个文件后必然卡死；启动器循环拉起重启 Illustrator，配合脚本内进度标记持续续跑直至完成。
- `批量导出高度256.jsx`：将 Illustrator 画板批量导出为高度 256 px 的 PNG。
- `生成文件列表.ps1`：根据当前目录中的 `.ai` 文件生成 `文件列表.txt`。
- `Affinity_Stage_Source_Files.ps1`：根据文件列表分批准备 Affinity Designer 源文件。
- `准备Affinity批量源文件.cmd`：Windows 下调用 Affinity 准备脚本的入口。

## 使用说明

这些脚本依赖本机安装的设计应用，运行前请阅读对应脚本顶部的配置与行为说明。文件清单、设计源文件、输出文件、运行日志和完成记录均属于本地数据，默认不会提交到 Git。

> `批量背景适配.jsx` 会修改打开文档的内存副本，并另存为新文件；源文件会以“不保存更改”的方式关闭。正式批处理前仍建议备份并先用少量文件试跑。

> 处理文件数超过约 200 时请通过 `批量背景适配-分块启动器.command` 运行（通过 `batch-restart.txt` 标记协调重启）；直接在 Illustrator 里执行 `批量背景适配.jsx` 会因不重启而最终卡死。
