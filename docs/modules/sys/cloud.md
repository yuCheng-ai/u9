# 云服务集成 (Cloud Services) - 开发者详尽指南

## 概述
ERP 不再是一个孤岛。云服务集成是 ERP 的“外交官”，负责将内部业务逻辑延伸到互联网。开发者必须理解：云集成不仅仅是调用一个 API，更涉及**网络稳定性、身份互认、以及异构数据的同步一致性**。

---

## 1. 电子税务与发票云 (E-Tax & Invoice Cloud)

### 企业痛点
**“财务每天要手工开几百张票，还得一张张去税局网站核销，效率低且容易错”**。

### 开发逻辑点
- **开票触发器**: 
    - 开发者需在销售出库或结算核准时，自动构造 `Tax_Invoice_Payload`。
    - **逻辑**: `JSON_Request -> Tax_Cloud_Gateway -> Return_Invoice_Number`。
- **状态回写**: 
    - 开票成功后，开发者必须将税控系统的“发票号码”和“开票状态”回写到 ERP 的 `AR_Invoice` 表中。
- **电子档案存储**: 
    - 开发者需实现一个 `PDF_Downloader`，将税局返回的电子发票 PDF 自动挂载到 ERP 的单据附件中。

### PostgreSQL 实现建议
- **JSONB 构造与解析**: 利用 PG 的 `jsonb_build_object` 函数直接在 SQL 层构造发票请求报文，并利用 `JSONB` 字段存储税局返回的完整原始响应，方便后期排查审计。
- **NOTIFY/LISTEN 异步触发**: 结算单审核后发出 `NOTIFY invoice_request`，后台任务捕获通知并执行云开票逻辑，实现业务与集成的物理隔离。
- **触发器维护状态**: 
  ```sql
  CREATE TRIGGER update_invoice_status AFTER UPDATE OF invoice_no ON ar_invoice
  FOR EACH ROW EXECUTE FUNCTION log_invoice_event();
  ```

---

## 2. 友云采：数字化采购协同 (Supplier Collaboration)

### 企业痛点
“采购员在 ERP 里下完单，还得在微信上发给供应商，供应商送没送货、到哪了，ERP 里全看不见”。

### 开发逻辑点
- **单据双向同步**: 
    - **ERP -> 云端**: PO 核准时，自动通过 `Cloud_Bus` 推送到友云采平台。
    - **云端 -> ERP**: 供应商在平台填写的 ASN（送货通知），自动在 ERP 生成 `ASN_Document`。
- **身份联邦 (SSO)**: 
    - 开发者需实现 OAuth2 或 OpenID 协议，确保企业用户从 ERP 点击按钮即可免密跳转到云采购平台。

### PostgreSQL 实现建议
- **外部数据源 (postgres_fdw)**: 如果云端中间库也是 PostgreSQL，可以使用 `postgres_fdw` 将其映射为本地外部表，像操作本地数据一样同步 ASN 信息。
- **行级安全策略 (RLS)**: 在同步表中应用 RLS，确保不同供应商的数据在数据库层实现逻辑隔离，防止越权访问。
- **GIN 索引优化**: 对存储 ASN 详情的 `JSONB` 字段建立 `GIN` 索引，加速对物料号、批次等关键信息的检索。

---

## 3. 集成安全性与容错 (Security & Resilience)

### 企业痛点
**“云服务宕机了，我的 ERP 跟着卡死，或者单据丢了”**。

### 开发逻辑点
- **异步消息队列 (MQ)**: 
    - 开发者严禁在主业务线程同步调用外部云接口。
    - **推荐做法**: 业务单据保存 -> 写入本地 `Outbox` 表 -> 后台线程异步发送 -> 收到确认后标记 `Sent`。
- **重试机制 (Retry Policy)**: 
    - 开发者需实现“指数退避”重试逻辑（1s, 2s, 4s...），处理暂时的网络抖动。
- **幂等校验 (Idempotency)**: 
    - 每一个上云的单据必须携带全局唯一的 `Request_ID`，防止网络重试导致云端产生重复记录。

### PostgreSQL 实现建议
- **SKIP LOCKED 并发处理**: 
  ```sql
  SELECT * FROM cloud_outbox 
  WHERE status = 'Pending' 
  FOR UPDATE SKIP LOCKED 
  LIMIT 10;
  ```
  多个后台 Worker 进程使用 `SKIP LOCKED` 语法并行抓取待发送任务，既能保证任务不重复，又能实现极高的吞吐量。
- **自定义序列号 (UUID)**: 强制使用 `UUID` 作为 `Request_ID`，并利用 PG 原生的 `uuid` 类型存储，确保全局唯一性。
- **pg_cron 定时重试**: 利用 `pg_cron` 插件定期扫描发送失败且未达到最大重试次数的任务，自动触发重试流程。

---

## 4. 开发者 Checklist

- [ ] **密钥管理**: 严禁在代码中硬编码 `API_Key` 和 `Secret`，必须存储在 ERP 的 `System_Vault` 或环境变量中。
- [ ] **日志追踪**: 所有的云调用必须记录 `Cloud_Log`，包含：请求参数、返回结果、耗时、HTTP 状态码。
- [ ] **白名单**: ERP 服务器是否已经放行了云服务商的 IP 范围？
- [ ] **限流保护**: 开发者需在出口处增加 `Rate_Limiter`，防止短时间内大量调用导致被云端封禁。
