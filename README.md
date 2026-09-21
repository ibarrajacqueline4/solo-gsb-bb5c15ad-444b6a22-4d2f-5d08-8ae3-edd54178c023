# 条文变更审阅台

一个用于**规范 / 制度文本版本审阅**的网页应用：粘贴同一规范的前后版本，系统按段落自动计算差异（新增 / 删除 / 修改），审阅人员可在差异片段上创建带作者与状态的批注；当后续版本再次导入时，系统基于**文本锚点**把未解决的批注自动迁移到最相近的新片段，无法匹配的批注标记为「待复核」。支持批注筛选、状态流转，每个差异片段必须作出「接受变更 / 拒绝变更 / 暂缓」结论（暂缓须填理由），全部片段有结论且批注全部关闭后可**审阅封存**，封存即锁定；全部片段有结论后即可一键**生成决议稿**（接受项采用新版、拒绝项恢复旧版、暂缓项保留新版并列入待办清单），支持 JSON / CSV / Markdown 审阅结果导出与 UTF-8 Markdown 决议稿下载。

## 技术栈

- **后端**：Node.js 20 + TypeScript + Express
- **数据库**：SQLite（better-sqlite3，WAL 模式，文件持久化）
- **前端**：原生 HTML / CSS / JavaScript 单页应用（无需构建）
- **部署**：Docker + Docker Compose，一键启动

## 快速开始（Docker Compose）

```bash
docker compose up --build
```

启动后访问 **http://localhost:3000**。

- 首次进入可点击「⚡ 载入示例数据」，自动创建一个包含三个版本、两轮比对的示例项目，直接体验差异比对与批注迁移。
- 停止：`docker compose down`（数据保留在命名卷 `review-data` 中；加 `-v` 可连同数据一起删除）。

### 修改端口

```bash
APP_PORT=8080 docker compose up --build   # 访问 http://localhost:8080
```

### 在容器中选择比对基线

界面操作：进入任一项目页，「导入新版本」表单中的**比对基线**下拉框默认选中最新版本，改选任意历史版本后再导入，即按该基线生成差异；比对卡片会标注「🧭 指定基线：跳过 N 个中间版本」。导入完成后的浮层提示给出差异数与批注迁移 / 待复核数，未迁移时说明原因。

也可直接调用容器内接口验证（默认把容器 3000 端口映射到宿主机）：

```bash
# 1) 查看项目下的历史版本，拿到要作为基线的版本 ID
curl -s http://localhost:3000/api/projects/1 | python3 -m json.tool

# 2) 导入新版本并显式指定基线（不指定 baseline_version_id 即默认最新版本）
curl -s -X POST http://localhost:3000/api/projects/1/versions \
  -H 'Content-Type: application/json' \
  -d '{"label":"v4.0","content":"第一条 ……\n\n第二条 ……","baseline_version_id":2}'
```

响应中：

- `baselineSeq / baselineLabel / baselineExplicit`：实际使用的基线（`baselineExplicit:true` 表示显式指定）；
- `fragmentCount`：本次差异片段数；
- `migration.migrated / pending`：迁移与待复核批注数；
- `migration.source_comparison_id`：批注迁移实际取自哪一轮比对；
- `migration.skip_reason`：`no_baseline_comparison` 表示该基线没有对应的历史比对、**未迁移任何批注**（首版为 `first_version`）；
- 基线不存在 / 属于其他项目 / 晚于新版本时返回 `400` 且中文错误信息，事务整体回滚。

容器日志可通过 `docker compose logs -f` 查看；数据库位于命名卷 `review-data`（容器内 `/data/review.db`），升级镜像后旧库会自动平滑增补列，基线信息直接通过版本与比对的关联关系展示，无需额外迁移。

## 配置项

| 环境变量   | 默认值            | 说明                                       |
| ---------- | ----------------- | ------------------------------------------ |
| `APP_PORT` | `3000`            | 宿主机映射端口（仅 docker-compose 使用）   |
| `PORT`     | `3000`            | 容器 / 进程内服务监听端口                  |
| `DB_PATH`  | 容器：`/data/review.db`<br>本地：`./data/review.db` | SQLite 数据库文件路径 |

## 本地开发

```bash
npm install        # 安装依赖（better-sqlite3 为原生模块，需编译环境）
npm run dev        # 编译并启动，默认 http://localhost:3000
npm test           # 编译并运行单元测试（差异引擎 + 批注迁移 + 比对基线 + 封存 + 决议稿）
npm start          # 仅启动（需先 npm run build）
```

## 使用流程

1. **新建项目**：一个项目对应一份规范（如《数据安全管理办法》）。
2. **导入版本**：粘贴规范全文并填写版本标签。段落之间用空行分隔；若全文无空行，则每行视为一条。首个版本仅存档。
   - **选择比对基线**：从第二个版本起，导入表单会出现「比对基线」选择框——**默认取项目最新版本**（与旧行为一致），也可改选本项目**任一历史版本**作为基线，直接与该版本计算差异（跳过中间版本）。
   - 后端在同一事务内校验：基线必须**属于当前项目**、且**严格早于本次新版本**；基线不存在 / 跨项目 / 非正整数 ID 均返回 `400`，版本与比对都不会被部分写入。
3. **查看差异**：导入后按所选基线自动生成比对，片段按「新增 / 删除 / 修改」着色展示。项目页的版本记录标注每个版本「作为新版 / 作为比对基线」的轮次；比对卡片与比对详情页顶部显示基线关系（相邻版本或「跳过 N 个中间版本」）。
4. **创建批注**：在片段上填写作者与审阅意见，状态流转为 `待处理 → 已解决`，也可手动标记 `待复核`。
5. **逐片段下结论**：每个差异片段必须在「接受变更 / 拒绝变更 / 暂缓」中选择一个结论；选择「暂缓」时**必须填写暂缓理由**，点击「保存结论」后生效（结论提出人自动取最近一次批注作者）。页面统计条实时显示「未作结论片段、未解决批注、待复核批注」数量。
6. **生成决议稿**：全部片段均有结论后（无需先封存），点击比对详情页的「📄 生成决议稿」：
   - **接受**的片段采用新版内容；**拒绝**的片段恢复旧版内容（新增被剔除、删除在原位置恢复、修改回旧文）；**暂缓**的片段暂保留新版状态，并连同暂缓理由列入独立的「暂缓待办清单」。
   - 后端依据段落序列与片段记录的新 / 旧段落序号重建完整正文（重放与导入时同一套 LCS 对齐，全程按段落位置落地，不做全局字符串替换），相邻新增 / 删除 / 修改与重复段落均能正确处理；返回的每一段都带来源标记（未变更 / 采用新版 / 恢复旧版）与对应片段编号。
   - 页面展示正文预览、逐段来源标记与暂缓待办清单，并可下载 **UTF-8 Markdown** 决议稿（含正文、来源标记表与待办清单）。
7. **审阅封存**：
   - 只有**所有片段均已有结论**、且**不存在未解决（open）或待复核（pending_review）批注**时，封存按钮才可用；封存需填写封存人姓名。
   - 服务端在数据库事务内再次校验，不满足条件时返回 HTTP `409` 与具体阻塞项（含片段序号、批注 ID 与说明），界面会就地列出。
   - **封存后**：禁止修改任何片段结论；禁止新增、编辑、变更状态或删除批注（服务端同样强制，返回 `409`），且不可重复封存。已封存的比对仍可随时生成 / 下载决议稿（只读操作）。
8. **导入后续版本**：未解决批注按文本锚点自动迁移到最相近的新片段；无法匹配的进入页面顶部「待复核」区域。迁移**只从「以所选基线为新版的最近一轮比对」取批注**——若该基线从未作为新版参与过比对（例如直接拿很老的版本做基线），则明确不迁移任何批注（响应 `migration.skip_reason = "no_baseline_comparison"`），绝不会从项目最新一轮比对误带批注。导入完成后的提示会给出差异数以及批注迁移 / 待复核数；未迁移时会说明原因。已封存的历史比对保持锁定，迁移复制出来的批注可在新一轮比对中继续处理。
9. **筛选与导出**：按状态 / 作者筛选批注，一键导出 JSON / CSV / Markdown 审阅报告；导出内容包含每个片段的结论、暂缓理由、结论提出人 / 时间以及封存状态、封存人和封存时间。
10. **状态标识**：项目页的每轮比对卡片标注「📝 草稿」或「🔒 已封存」（已封存卡片另显示封存人与封存时间）；比对详情页顶部同样显示状态横幅。

## 决议稿生成规则

- **入口**：比对详情页「📄 生成决议稿」按钮（全部片段有结论后可用）；接口为 `GET /api/comparisons/:id/resolution`。页面访问地址为 **http://localhost:3000**（`APP_PORT` 修改后为 `http://localhost:<APP_PORT>`）。
- **前置条件**：仅当比对中**所有差异片段均已有结论**（接受 / 拒绝 / 暂缓）时可生成；否则接口返回 `409` 及未结论片段序号列表 `undecided[]`，页面按钮同步禁用。批注是否关闭、比对是否封存均不影响生成（决议稿为只读操作）。
- **落地规则**：
  - `accepted`（接受）→ 采用新版内容；
  - `rejected`（拒绝）→ 恢复旧版内容：新增段剔除、删除段在原位置恢复、修改段回退为旧文本；
  - `deferred`（暂缓）→ 正文暂保留新版状态（暂缓的删除维持删除），并把片段、暂缓理由、提出人列入独立「暂缓待办清单」。
- **重建方式**：依据段落序列与片段位置（`old_start` / `new_start`）重放段落级 LCS 对齐逐段落地，不依赖任何全局字符串替换；相邻新增 / 删除 / 修改及重复段落均按位置正确处理。响应中每段含 `source`（`unchanged` / `new` / `old`）与 `fragment_ord`（对应片段编号）。
- **下载**：`GET /api/comparisons/:id/resolution?format=md` 返回 `text/markdown; charset=utf-8` 的附件，包含正文、逐段来源标记表与暂缓待办清单。

## 批注迁移规则

- **迁移来源与比对基线绑定**：一轮比对只从「**以该比对基线（旧版）为新版的最近一轮比对**」迁移批注（`comparisons.new_version_id = baseline_version_id`，取 ID 最大的一轮）。找不到这样的比对时明确不迁移（`migration.skip_reason` 为 `first_version` / `no_baseline_comparison`，计数均为 0，`source_comparison_id` 为 `null`），**禁止回退到项目最新比对**，避免跨基线误带批注。
- 仅迁移**未解决**（待处理、待复核）的批注；已解决的批注保留在原比对中归档。
- 批注创建时保存**锚点文本**（所属片段的新文本）；迁移时与新一轮比对的全部片段（新旧两侧文本）逐一计算字符 bigram 的 Dice 相似度。
- 最高相似度 **≥ 0.4** → 批注挂载到该片段（界面显示「⤳ 迁移 · 相似度 xx%」）；原为「待复核」的自动恢复为「待处理」。
- 低于阈值 → 批注不挂片段，状态置为「待复核」，等待人工确认或关闭。
- 迁移在新比对中生成批注副本（`migrated_from` 指向**来源轮次**中的原始批注），历史比对中的批注保持不动，可全程追溯。

## 比对基线规则

- 导入接口 `POST /api/projects/:id/versions` 接受可选字段 `baseline_version_id`：
  - 缺省：首版仅存档；之后默认以项目内 `seq` 最大的版本（最新版本）为基线；
  - 显式指定：必须是**本项目**且 `seq` 严格小于新版本的历史版本。
- 校验失败均返回 `400`：`指定的比对基线版本不存在` / `比对基线必须属于当前项目` / `比对基线必须早于本次导入的新版本` / `比对基线版本 ID 非法`；项目不存在为 `404`。
- 版本插入、比对生成、片段落地与批注迁移在**同一数据库事务**内完成，校验失败整体回滚。
- 成功响应新增 `baselineVersionId / baselineSeq / baselineLabel / baselineExplicit`，`migration` 中新增 `source_comparison_id / skip_reason`。
- 项目详情接口的版本项含 `baseline_count`（作为新版的轮数）/ `compared_count`（作为基线的轮数）；比对项含 `old_seq / new_seq / skipped_version_count`（>0 即跨版本基线比对）。

## 审阅封存规则

- 结论维度：片段结论为 `accepted` / `rejected` / `deferred`；暂缓必须填写非空理由（接口与界面双重校验）。
- 封存前置条件（客户端实时统计，服务端在**单个事务内再次校验**）：
  - 不存在结论为空的片段；
  - 不存在 `open`（未解决）或 `pending_review`（待复核）的批注（含未匹配到片段的待复核批注）。
- 校验失败返回 `409 Conflict`，响应体 `blockers` 数组逐项给出 `kind`（`undecided_fragment` / `open_annotation` / `pending_review_annotation`）、片段序号或批注 ID 及中文说明；封存不会被部分写入。
- 封存成功后写入封存人与封存时间，此后片段结论、批注的任何写操作（新增 / 编辑内容 / 改状态 / 删除）均返回 `409`；重复封存同样返回 `409`。
- 升级提示：旧版本数据库首次启动时会自动为 `fragments` 增补 `decision / decision_reason / decided_by / decided_at`、为 `comparisons` 增补 `sealed_by / sealed_at` 列，历史数据视为草稿，无需手工迁移。

## API 一览

| 方法 | 路径 | 说明 |
| ---- | ---- | ---- |
| GET | `/api/health` | 健康检查 |
| GET / POST | `/api/projects` | 项目列表 / 新建项目 `{name}` |
| GET / DELETE | `/api/projects/:id` | 项目详情（含版本与比对）/ 删除项目 |
| POST | `/api/projects/:id/versions` | 导入版本 `{label, content, baseline_version_id?}`；默认基线为最新版本，可指定本项目历史版本；同事务校验基线并生成差异、按基线迁移批注 |
| GET | `/api/comparisons/:id` | 比对详情（片段 + 批注 + 结论 + 封存信息 + 统计） |
| GET | `/api/comparisons/:id/annotations?status=&author=` | 批注筛选 |
| POST | `/api/fragments/:id/annotations` | 新建批注 `{author, content}`（已封存返回 `409`） |
| PATCH / DELETE | `/api/annotations/:id` | 更新状态或内容 `{status?, content?}` / 删除（已封存返回 `409`） |
| PATCH | `/api/fragments/:id/decision` | 保存片段结论 `{decision: accepted\|rejected\|deferred, reason?, decided_by?}`；暂缓必填理由（`400`）；已封存返回 `409` |
| GET | `/api/comparisons/:id/seal/blockers` | 封存前阻塞项预览（未结论片段 / 未解决 / 待复核批注） |
| POST | `/api/comparisons/:id/seal` | 封存 `{sealed_by}`；服务端事务内再次校验，存在阻塞项返回 `409` 及 `blockers[]` |
| GET | `/api/comparisons/:id/resolution?format=json\|md` | 生成决议稿（全部片段有结论后才可用，否则 `409` 及 `undecided[]`）；`md` 下载 UTF-8 Markdown |
| GET | `/api/comparisons/:id/export?format=json\|csv\|md` | 导出审阅结果（含片段结论、暂缓理由、封存人 / 封存时间） |
| POST | `/api/demo` | 载入示例数据 |

批注状态：`open`（待处理）、`resolved`（已解决）、`pending_review`（待复核）。
片段结论：`accepted`（接受变更）、`rejected`（拒绝变更）、`deferred`（暂缓，须附理由）。
封存状态：比对记录上的 `sealed_at` 为空即**草稿**，非空即**已封存**（同时含 `sealed_by`）。

## 目录结构

```
├── docker-compose.yml   # 一键启动
├── Dockerfile           # 多阶段构建（编译 TS → 精简运行时）
├── src/
│   ├── server.ts        # Express 入口与路由
│   ├── db.ts            # SQLite 连接与建表
│   ├── diff.ts          # 段落切分、相似度、LCS 差异引擎
│   ├── migrate.ts       # 批注锚点迁移
│   ├── service.ts       # 版本导入 / 批注 / 比对组装
│   ├── resolution.ts    # 决议稿重建（段落序列 + 片段位置）与 Markdown 渲染
│   ├── exporter.ts      # CSV / Markdown 导出
│   ├── demo.ts          # 示例数据
│   └── test/            # 单元测试（node:test）
├── public/              # 前端单页应用（原生 JS）
└── data/                # SQLite 数据（本地运行时生成）
```
