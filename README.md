# HUF1 字节级 Huffman 无损压缩实验服务

本项目是一个本地可运行的字节流无损压缩实验后端（TypeScript + Node.js + SQLite，仅 API 与 CLI）。
核心 Huffman 建树、位级编解码全部手写实现，**不调用 zlib、现成编解码库或外部压缩程序**。

## 容器格式 HUF1（自定义，不兼容 ZIP/gzip 等任何标准格式）

全部小端序：

| 偏移 | 长度 | 含义 |
|------|------|------|
| 0    | 4    | 魔数 `HUF1` |
| 4    | 1    | 版本 = 1 |
| 5    | 1    | 保留 = 0 |
| 6    | 8    | 原始字节数 u64 |
| 14   | 8    | 载荷有效位数 u64 |
| 22   | 256  | 码长表（每符号 1 字节，0=未使用） |
| 278  | -    | 载荷字节 |

- 位序：MSB 优先写入；最后一个字节不足 8 位时**低位补 0**，补位数量 = `载荷字节数*8 - 有效位数`（0..7）。
- 码字分配：由码长表按 **(码长, 符号) 升序** 规范分配（canonical），天然满足前缀性质。
- 平局规则（建树时）：频率小者优先；频率相同则子树内最小符号小者优先；再相同则先创建的节点优先。同一输入必得同一码表与产物。
- 特殊情况：空输入码长表全 0、有效位数 0、无载荷；单符号输入该符号码长为 1（码字 `0`）；全字节等频时每个符号都是 8 位码（此时压缩后必然变大，如实报告）。

## 运行环境

- Windows 本地，Node.js >= 22（使用内置 `node:sqlite`，无原生依赖、无 Docker/WSL/在线服务）。
- 当前实验使用 Node v25；启动时可能打印 SQLite experimental 警告，不影响功能。

## 命令

```powershell
npm install        # 安装 devDependencies（typescript、@types/node）
npm run build      # 编译到 dist/
npm test           # 构建并运行全部测试
npm start          # 启动 API（PORT 环境变量指定端口，默认 0=自动选空闲端口）
npm run demo       # 生成三类样例并演示压缩/验证/解码
node dist/src/cli.js <命令>   # CLI（先 npm run build）
```

CLI 命令：`import <文件> [名称]`、`compress <输入ID>`、`freq <输入ID>`、`codes <产物ID>`、
`verify <产物ID>`、`decode <产物ID> [--out 文件] [--max-len N]`、`summary <产物ID>`、
`history`、`inputs`、`artifacts`、`sample`、`serve [--port N]`。

## HTTP API

统一错误格式：`{"error":{"code":"...","message":"..."}}`，错误码包括
`BAD_PARAM`(400)、`NOT_FOUND`(404)、`COMPRESS_FAILED`/`VERIFY_FAILED`/`DECODE_FAILED`(422)、`INTERNAL`(500)。

- `POST /api/inputs?name=xxx`（body 为原始字节）导入
- `GET /api/inputs` / `GET /api/artifacts` 列表
- `POST /api/compress` `{inputId}` 压缩，返回载荷位数、头部字节、文件大小、比率
- `GET /api/inputs/:id/freq` 频率表
- `GET /api/artifacts/:id/codes` 码字表
- `POST /api/artifacts/:id/verify` 解码并与原输入逐字节比对
- `POST /api/artifacts/:id/decode` `{outPath?, maxLen?}` 解码导出（默认上限 64MiB）
- `GET /api/artifacts/:id/summary` 摘要（区分载荷位数/头部开销/文件大小）
- `GET /api/history` 操作历史

## 数据与持久化

项目内 `data/` 目录：`huffman.db`（SQLite：inputs/artifacts/ops 三表）、`inputs/`（原输入只读保存，不修改）、
`artifacts/`（.huf1 产物）、`outputs/`（解码导出）、`samples/`（演示样例）。
解码完全依赖产物文件内的码表与长度字段，不读取数据库中的原文；输出失败只记录失败操作，不会记为成功。

## 解码安全校验

拒绝：坏魔数/版本/保留字节、Kraft 和不成立的码表、载荷字节数与有效位数不符（截断）、
补位超过 7 位、解码超出声明长度、声明长度超过 `maxLen` 上限。

## 限制

- 非流式：整个文件读入内存，适合小型文件（建议 < 64MiB）。
- 静态 Huffman，无自适应、无多算法；压缩后变大属正常结果，如实报告。
- 单实例本地服务，无鉴权，请勿暴露到公网。

## 复现演示效果

```powershell
npm run demo
# repeated-text.txt : 9000B -> 5303B (比率 0.589)
# single-byte.bin   : 4096B ->  790B (比率 0.193)
# uniform-bytes.bin : 4096B -> 4374B (比率 1.068, 变大)
```
