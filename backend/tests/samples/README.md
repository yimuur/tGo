# 测试样本目录

存放**录制**的真实引擎响应 / WebSocket 报文切片（JSON），供各层测试作为输入数据。

约定（遵循 AGENTS.md §7 硬件隔离）：

- 严禁在此存放真实 KataGo 权重文件（`.bin.gz`）或 GPU 依赖；
- 样本为文本 JSON，随代码提交版本库，命名 `xxx.sample.json`；
- 新增样本须在 TESTING.md 对应模块登记用途。

当前 Phase 0 尚无样本；Phase 2（引擎响应预处理）与 Phase 4（WS 报文）将在此添加。
