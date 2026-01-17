# 采购执行 (PO Execution) - 开发者详尽指南

## 概述
采购执行是企业“花钱”的过程。在 ERP 开发中，采购单（PO）必须具备**全链路闭环**与**严密的版本控制**。每一张 PO 都是需求（PR/MRP）、物流（Receipt）与财务（AP）的交汇点。开发者应利用 PostgreSQL 的**版本化存储**、**精确数值计算**和**建议锁**，确保资金流向的每一分钱都可追溯。

---

## 1. 采购申请（PR）的智能聚合与预算控制

### 业务场景
防止“盲目采购”与“零散采购”。系统必须在前端拦截超预算行为，并在后端实现自动化的需求聚合。

### 开发规范
- **预算硬核拦截**: 提交 PR 时，必须实时校验该成本中心的剩余预算。
- **需求聚合算法**: 同一供应商、同一收货日期的多个 PR 行应自动合并。
- **技术实现建议**: 
    - **高并发预算扣减**: 利用 PostgreSQL 的 **Advisory Locks (建议锁)**。在扣减预算前锁定 `(CostCenter, Period)`，避免由于大量 PR 并发提交导致的行级锁竞争或死锁。
    - **聚合视图**: 使用 **Recursive CTE** 或复杂聚合函数，实时展示 PR 池中可合并的需求项，支持采购员一键生成聚合 PO。
    - **示例代码**:
      ```sql
      -- 使用建议锁进行预算检查
      SELECT pg_advisory_xact_lock(hashtext('budget_' || cost_center_id || '_' || period_id));
      -- 执行预算扣减逻辑...
      ```

---

## 2. PO 版本管理与变更控制 (Version Control)

### 业务场景
已下达给供应商的订单，任何字段修改都必须留痕，并重新触发审批。

### 开发规范
- **禁止原地修改**: 已核准的 PO 禁止直接 `UPDATE` 关键字段。必须走“变更”流程，递增版本号。
- **变更差异对比**: 系统需直观展示“变更前”与“变更后”的差异。
- **技术实现建议**: 
    - **快照化存储**: 每次变更时，将旧版本数据以 `JSONB` 格式存入 `PO_History` 表。
    - **差异计算**: 利用 PostgreSQL 的 `jsonb_diff` 或自定义函数，实时计算两个版本间的差异，仅对差异部分触发补差审批流。
    - **示例代码**:
      ```sql
      -- 记录 PO 变更快照
      INSERT INTO pur_order_history (po_id, version, content_snapshot)
      SELECT id, version, to_jsonb(pur_order.*) FROM pur_order WHERE id = :target_id;
      ```

---

## 3. 收货与三单匹配逻辑 (Three-way Match)

### 业务场景
确保“买多少、收多少、付多少”完全一致，严防供应商多送、财务多付。

### 开发规范
- **超收容差控制**: 允许在一定百分比（如 3%）内超收，超过则拒绝入库。
- **三单匹配引擎**: 建立 `PO` vs `Receipt` vs `Invoice` 的三方对账模型。
- **技术实现建议**: 
    - **高精度计算**: 数量、单价必须使用 `numeric(24, 12)`。在进行“三单匹配”校验时，利用数据库的 **Generated Columns** 自动计算差异率，提升查询效率。
    - **实时对账视图**: 利用 **LATERAL JOIN** 关联 PO 行与其对应的所有收货行及发票行，构建实时的“应收未收”、“应付未付”看板。
    - **示例代码**:
      ```sql
      -- 使用 LATERAL JOIN 进行三单实时比对
      SELECT po.line_id, po.qty AS po_qty, r.total_received, i.total_invoiced
      FROM pur_order_line po
      LEFT JOIN LATERAL (
          SELECT SUM(qty) AS total_received FROM pur_receipt_line WHERE po_line_id = po.line_id
      ) r ON true
      LEFT JOIN LATERAL (
          SELECT SUM(qty) AS total_invoiced FROM pur_invoice_line WHERE po_line_id = po.line_id
      ) i ON true;
      ```

---

## 4. 供应商协同与实时看板 (Collaboration)

### 业务场景
采购员需实时掌握供应商的发货动态，减少电话沟通成本。

### 开发规范
- **ASN（提前发货通知）**: 供应商在线填报 ASN 后，系统自动产生“在途库存”。
- **协同幂等性**: 对接供应商门户的 API 必须支持幂等。
- **技术实现建议**: 
    - **异步通知**: 当 PO 审核或 ASN 生成时，利用 PostgreSQL 的 **NOTIFY** 机制驱动外部推送服务（如邮件、短信、钉钉）。
    - **状态流转记录**: 使用 `JSONB` 存储单据的完整操作日志，确保协同过程中的每一跳都有据可查。

---

## 5. 开发者 Checklist

- [ ] **高精度换算**: 采购单位（如：吨）与库存单位（如：公斤）的换算率是否使用了 `numeric`？是否在数据库层做了 `CHECK` 约束防止零或负数？
- [ ] **并发安全**: 预算扣减是否考虑了并发提交时的原子性？
- [ ] **版本留痕**: PO 变更是否完整记录了历史版本，且 `JSONB` 快照是否配置了相应的压缩存储？
- [ ] **关联性**: 删除 PO 行时，是否通过外键约束（Foreign Key）或触发器（Trigger）同步处理了关联的 PR 占用状态？
- [ ] **接口幂等**: ASN 接收接口是否通过 `Supplier_ASN_No` 建立了唯一索引？
