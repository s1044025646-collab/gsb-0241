# HF1 字节级 Huffman 无损压缩实验后端

在 Windows 本地运行的字节流 Huffman 压缩实验服务，提供 **HTTP API** 与 **CLI** 两种入口。
使用 TypeScript + Node.js（内置 `node:sqlite`）实现，零第三方运行时依赖，不需要 Docker、WSL、付费服务或在线 API。

> 本项目的容器格式（魔数 `HF1`，见下）是自行定义的实验格式，**不兼容也不声称兼容** ZIP、gzip、deflate 或任何其他标准压缩格式。
> Huffman 建码、位级编码与解码全部自行实现，未使用 zlib、现成 Huffman 库或外部压缩程序。

## 环境要求

- Windows 10/11，PowerShell 5.1 或 PowerShell 7
- Node.js **22.5+**（开发与验证使用 Node 25.5；需要内置 `node:sqlite`）

检查版本：

```powershell
node --version
```

## 快速开始

```powershell
npm install        # 仅安装 typescript 与 @types/node（开发依赖）
npm run build      # TypeScript 编译到 dist/
npm test           # 构建并运行 29 个测试
npm run demo       # 生成三类样例，完成导入/压缩/验证/独立解码/逐字节比较
npm start          # 启动 HTTP API（默认自动选择空闲端口）
```

指定端口与数据目录：

```powershell
node --no-warnings dist/src/server/index.js --port 8080 --data-dir ./data
# 或
$env:PORT=8080; npm start
```

也可直接使用 CLI：

```powershell
node dist/src/cli/index.js --help
# npm 安装 bin 后可用 hf1，或手动 New-Alias
```

## CLI 命令

所有命令输出 JSON，方便脚本处理；可加 `--data-dir <目录>` 改变数据目录（默认 `./data`）。

| 命令 | 说明 |
| --- | --- |
| `samples` | 生成三类样例到 `data/samples` |
| `import <文件>` | 导入本地文件，原文件不修改，副本存入 `data/inputs` |
| `text <文本>` | 导入内联 UTF-8 文本 |
| `inputs` | 列出输入记录（摘要、大小、来源） |
| `table <inputId>` | 查看字节频率表与 Huffman 码字 |
| `compress <inputId>` | 压缩，写出 `.hf1` 到 `data/artifacts` |
| `artifacts` | 列出压缩产物记录 |
| `verify <file.hf1 或 id>` | 验证结构、码表、填充位、校验和 |
| `decode <file.hf1 或 id> [输出名]` | **仅依赖容器自身**解码到 `data/outputs` |
| `compare <inputId> <解码文件>` | 输入与解码文件逐字节比较 |
| `history` | 查询操作历史（成功与失败分别记录） |
| `serve [--port 端口]` | 启动 HTTP API |

## HTTP API

请求与响应均为 JSON（`POST /inputs/raw` 例外，直接接收任意二进制请求体）。错误响应形如：

```json
{ "ok": false, "error": { "code": "BAD_CODETABLE", "message": "..." } }
```

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/inputs/raw` | body 为原始字节，直接入库 |
| POST | `/inputs/text` | `{ "text": "..." }`，按 UTF-8 编码 |
| POST | `/inputs/import-file` | `{ "path": "C:\\..." }` 导入服务器本地文件 |
| GET | `/inputs?limit=50` | 输入列表 |
| GET | `/inputs/:id` | 输入详情 |
| GET | `/inputs/:id/table` | 频率表 + 码字 |
| POST | `/compress` | `{ "inputId": 1 }` |
| GET | `/artifacts` | 产物列表 |
| GET | `/artifacts/:id` | 产物元数据 |
| POST | `/artifacts/:id/verify` | 验证数据库登记的产物 |
| POST | `/artifacts/:id/decode` | 解码登记产物，可带 `{ "outputName": "x.bin" }` |
| POST | `/verify-file` | `{ "path": "..." }` 验证任意 `.hf1`（不依赖数据库） |
| POST | `/decode-file` | `{ "path": "...", "outputName": "..." }` 独立解码任意 `.hf1` |
| POST | `/compare` | `{ "inputId": 1, "decodedPath": "..." }` 逐字节比较 |
| GET | `/operations?limit=50` | 操作历史 |
| POST | `/samples/generate` | 生成样例 |
| GET | `/samples` | 列出样例 |

### 错误码

| 错误码 | 含义 |
| --- | --- |
| `INVALID_ARG` | 参数缺失或类型错误（HTTP 400） |
| `NOT_FOUND` | 输入/产物/文件不存在（HTTP 404） |
| `BAD_HEADER_MAGIC` / `BAD_HEADER_VERSION` | 魔数或版本不匹配 |
| `TRUNCATED_HEADER` / `TRUNCATED_PAYLOAD` | 头部或载荷被截断 |
| `BAD_CODETABLE` | 码表非法：重复符号、码长越界、非 Huffman/Kraft 可行、与长度声明矛盾 |
| `BAD_PAYLOAD` | 出现码表外码字或载荷在码字中途结束 |
| `BAD_PAD_BITS` | 有效位数非法或末字节填充位不为 0 |
| `LENGTH_MISMATCH` | 解码长度与声明的原始字节数不一致 |
| `OUTPUT_TOO_LARGE` | 解码结果超过输出长度上限（默认 256 MiB） |
| `CHECKSUM_MISMATCH` | 解码结果 SHA-256 与容器内声明不一致 |
| `IO_ERROR` | 文件读写等系统错误（HTTP 500） |

## HF1 容器格式（版本 1，所有整数大端序）

```
偏移  长度  字段
0     4    魔数 'H' 'F' '1' 0x01（第 4 字节即格式版本 = 1）
4     4    originalSize：原始字节数 uint32
8     4    payloadBits：载荷有效位数 uint32
12    4    symbolCount：码表符号数 N（0..256）
16    2    codeSectionLength：码表段字节数，固定 = N*5
18    N*5  码表，每项 5 字节：
            1 字节 symbol（0..255，按字节升序存储）
            4 字节 codeLength（uint32，范围 1..32；N=0 时无此项）
18+5N 32   原始数据 SHA-256（32 原始字节，非 hex）
之后  ...  位打包载荷
```

- 总头部长度固定为 `18 + 5N + 32`，最终文件大小 = 头部 + `ceil(payloadBits/8)`。
- 统计中分别报告 **payloadBits（有效载荷位数）**、**headerBytes（头部开销）**、**payloadBytes（含填充的载荷字节数）** 与 **fileSize（最终文件大小）**；压缩后变大也如实报告（见“近似均匀”样例），不以理论码长冒充实际压缩率。

### 位序与填充

- 码字按 **MSB-first** 顺序打包进字节：一个码字从其最高位到最低位依次写入，字节内从最高位（bit7）向最低位排列。
- 最后一个字节若不足 8 位，低位补 **0**；填充位数 = `(8 - payloadBits mod 8) mod 8`，解码时强制校验这些位必须为 0，否则报 `BAD_PAD_BITS`。
- 解码严格只消费 `payloadBits` 个有效位：有效位在码字中途结束报 `BAD_PAYLOAD`；恰好解出 `originalSize` 个字节才成功，多解报 `LENGTH_MISMATCH`，少解同样报错。

### 码表与确定性规则

1. 频率：对输入逐字节计数，统计字节 0..255，只保留出现过的字节，按字节升序输出频率表。
2. 建树：使用两个有序队列的经典 Huffman 合并。每次取权重最小的两个节点作为左右子节点；**权重相同则取“子树内最小符号字节”更小的节点**。左子节点为取出的较小节点，右子节点为较大节点。因此同频率输入无论字节出现顺序如何，树结构完全一致。
3. 码长：树确定后只取各叶子的深度作为码长（左/右方向不直接决定 0/1，避免树内标号歧义）。
4. 码字：采用**规范 Huffman（Canonical Huffman）**从码长重新生成——码长升序、同长按字节升序，短码在前、码值连续递增并在码长增加时左移补齐。最终码字即实际写入位流的码字。
5. 特殊输入：
   - **空输入**：`symbolCount = 0`、`payloadBits = 0`、无码表项，仅头部 + SHA-256。
   - **单符号输入**：码表仅 1 项，码长规定为 1（码字 `0`），`payloadBits = originalSize`。
   - **所有字节频率相同**：由上述确定性平局规则得到等长码（符号数为 2 的幂时）或规范码给出的固定长度组合，同一输入产物逐字节相同。
6. 自包含与完整性：容器携带码长表、原始字节数、有效位数、原始数据 SHA-256；解码只读取 `.hf1` 文件本身，**不读取数据库或原输入**。SHA-256 用于检测载荷/码表损坏，不匹配报 `CHECKSUM_MISMATCH`。
7. 坏码表防御：解析时检查符号重复、码长 1..32、段长度一致、与 `originalSize/payloadBits` 的一致性，并验证码长组合满足 Kraft 不等式（拒绝无法构成合法前缀码的码表）。

## 数据目录

默认 `./data`（可用 `--data-dir` 覆盖）：

```
data/
  hf1.db             # SQLite（WAL 模式），三张表
  inputs/<sha>.bin   # 输入的不可变副本
  artifacts/<sha>.hf1# 压缩产物
  outputs/*.bin      # 解码导出
  samples/*          # 三类样例
```

SQLite 表：

- `inputs(id, sha256 UNIQUE, size_bytes, source_type, source_path, created_at)`：只保存摘要与定位，不含额外原文副本逻辑之外的数据。
- `artifacts(id, input_id, path, file_size, payload_bits, header_bytes, pad_bits, symbol_count, input_sha256, created_at)`。
- `operations(id, op, status CHECK(ok|error), input_id, artifact_id, detail, error_code, created_at)`：**输出或验证失败只记录 `status='error'` 与错误码，绝不记为成功**。

## 三类样例与压缩效果

`npm run demo` 实测（Node 25，Windows）：

| 样例 | 原始大小 | HF1 文件 | 头部 | 有效载荷位 | 比率 |
| --- | --- | --- | --- | --- | --- |
| 重复文本（UTF-8 中英混合循环 4096 B） | 4096 | 2751 | 240 | 20087 | 67.16% |
| 单字节序列（2048 个 `A`） | 2048 | 311 | 55 | 2048 | 15.19% |
| 近似均匀字节分布（0..255 循环 4096 B） | 4096 | 5426 | 1330 | 32768 | 132.47% |

均匀分布时每字节接近 8 位且码表头部开销固定存在，因此**如实报告变大 32.47%**。演示同时把 `.hf1` 复制语义下独立解码（`verify-file`/`decode-file` 不需要数据库登记），并逐字节比较确认与输入完全一致。

## 测试

`npm test`（共 29 个用例，位于 `test/unit/`，运行编译产物）覆盖：

- 手写短字节串的频率统计与字节升序输出；
- 确定性平局规则与规范码分配（等频率、码长连续性）；
- 位流往返，包含**空输入、单符号、非整字节结尾、二进制零字节、4KB 伪随机数据**；
- 魔数损坏、头部截断、载荷截断、错误填充位、重复符号、非 Kraft 码长、声明长度不符、载荷篡改；
- 输出长度上限强制；
- 服务层全流程、`.hf1` 脱离数据库独立解码、SQLite **重启后历史查询**、失败只记 `error`；
- HTTP API 的 `fetch` 端到端与参数错误码。

所有往返用例都做**逐字节比较**（不只比较大小或哈希）。

## 限制与合理假设

- 单次输入/请求体建议小于 64 MiB（API 请求体上限），解码输出上限默认 256 MiB（`DEFAULT_MAX_OUTPUT`，可在服务配置调整）。
- 非流式：整文件读入内存；未实现自适应 Huffman、多算法竞赛或目录归档。
- 码长上限 32 位（`uint32` 码值）。常规小文件的 Huffman 码长远低于此值；超长病态输入可能触发 `BAD_CODETABLE`（对真正由 Huffman 产生的码表不会发生）。
- `originalSize` 与 `payloadBits` 为 uint32，单文件上限约 4 GiB；本项目定位为小型二进制/文本实验。
- SHA-256 仅用于完整性自检，不提供加密或防篡改安全保证。
- 服务仅监听 `127.0.0.1`，面向本地实验，未实现鉴权、CORS 或多用户隔离。

## 复现步骤（最小）

```powershell
npm install
npm test
npm run demo
npm start                 # 看到 [hf1] 服务已启动: http://127.0.0.1:<空闲端口>
```
