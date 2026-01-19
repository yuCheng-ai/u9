# 采购执行 (PO Execution) - 开发者详尽指南

## 概述
采购执行是企业“花钱”的过程。在 ERP 开发中，采购单（PO）必须具备**全链路闭环**与**严密的版本控制**。每一张 PO 都是需求（PR/MRP）、物流（Receipt）与财务（AP）的交汇点。开发者应利用 PostgreSQL 的**版本化存储**、**精确数值计算**和**建议锁**，确保资金流向的每一分钱都可追溯。

---

## 业务痛点与开发对策

| 业务痛点 | 技术对策 |
| :--- | :--- |
| **盲目采购**：PR（申请）到 PO（订单）过程脱节，预算失控。 | **需求池锁定 (PR_Pool_Lock)**：在 PR 转 PO 的原子事务中，通过 `FOR UPDATE` 锁定申请行，防止重复转化与超量下单。 |
| **变更无痕**：PO 修改后，供应商和财务看到的版本不一致。 | **JSONB 全文快照**：禁止原地修改已核准单据。变更时生成新版本，并利用 `jsonb_diff` 记录字段级变动足迹。 |
| **超收/乱收**：供应商多发货，仓库照单全收，导致库存积压。 | **容差校验引擎**：在收货 API 强制执行 `numeric(24,12)` 精度的 `qty_ordered * (1 + tolerance_rate)` 阈值拦截。 |
| **质量争议**：货收了但质量不合格，财务却已走付款流程。 | **IQC 状态机协同**：入库单行项目需挂接 `inspect_status`。只有状态为 `Passed` 的行才能被 AEP 引擎抛送到应付账簿。 |

---

## 1. 采购需求池与版本化 (PR & Revision)

### 业务场景
采购申请（PR）是所有采购行为的起点。由于生产计划（MRP）的波动，PR 可能会频繁调整。

### 开发规范
- **全量版本化 (Full Versioning)**: 采购申请 (PR) 与 采购订单 (PO) 必须支持版本追踪。
- **禁止物理删除**: 任何变更必须通过“版本升迁”实现，旧版本进入 `pur_order_history`。
- **技术实现建议**: 
    - 利用 `JSONB` 存储单据快照，确保变更前后可进行差异对比（Diff）。
    - **示例代码**:
      ```sql
      -- 记录 PO 变更历史
      INSERT INTO pur_order_history (po_id, version, snapshot)
      SELECT id, version, to_jsonb(pur_order.*) FROM pur_order WHERE id = :id;
      ```

---

## 2. 采购需求池锁定与转化 (PR-to-PO Conversion)

### 业务场景
防止“零散采购”导致的成本上升。系统需支持将多个 PR 合并为一张 PO，并确保需求来源（PR）与执行（PO）的强关联。

### 开发逻辑：需求池锁定 (Requirement Pooling)
- **原子化转化**: 在 PR 生成 PO 的存储过程中，必须锁定 PR 行。
- **示例代码**:
  ```sql
  -- PR 转 PO 的核心事务片段
  BEGIN;
  -- 1. 锁定并校验 PR 行（防止他人同时转化）
  SELECT id FROM pur_req_line 
  WHERE id IN (:pr_line_ids) AND status = 'Approved' AND (qty - qty_ordered) > 0
  FOR UPDATE;

  -- 2. 插入 PO 头与行，并回填 PR 的已订货数量
  UPDATE pur_req_line 
  SET qty_ordered = qty_ordered + :convert_qty,
      status = CASE WHEN (qty_ordered + :convert_qty) >= qty THEN 'Closed' ELSE 'Partial' END
  WHERE id = :pr_line_id;
  COMMIT;
  ```

---

## 3. PO 版本管理与变更控制 (JSONB Snapshots)

### 业务场景
已下达给供应商的订单，任何价格或数量的修改都可能引发法律风险。

### 技术实现建议
- **禁止原地更新**: 如果 `status = 'Approved'`，更新操作应被触发器（Trigger）拦截，引导用户走“变更申请（CO）”。
- **版本快照**: 每次核准时，将单据全量转为 JSONB 存入 `pur_order_history`。
- **差异审计**:
  ```sql
  -- 利用 jsonb_each_text 对比版本差异
  SELECT 
    old.key as field_name, 
    old.value as original_val, 
    new.value as current_val
  FROM jsonb_each_text(:old_snapshot) old
  FULL OUTER JOIN jsonb_each_text(:new_snapshot) new ON old.key = new.key
  WHERE old.value IS DISTINCT FROM new.value;
  ```

---

## 4. 受控收货与容差校验 (Tolerance Engine)

### 业务场景
采购 100 吨钢材，供应商发了 101 吨。企业通常允许 5% 以内的误差。

### 开发规范
- **容差逻辑**: `ReceivedQty <= OrderedQty * (1 + UpperTolerance)`。
- **精度陷阱**: 严禁使用 `float/double`。必须使用 `numeric` 类型进行乘法运算后再对比。
- **示例代码**:
  ```sql
  -- 收货接口中的硬核校验
  SELECT 
    CASE 
      WHEN :receive_qty > (l.qty * (1 + l.upper_tolerance_rate)) THEN 
        RAISE EXCEPTION 'ERR_OVER_RECEIPT: 收货数量超过订单允许的最大容差范围'
    END
  FROM pur_order_line l WHERE l.id = :po_line_id;
  ```

---

## 5. IQC 协同与质量追溯 (Quality Gates)

### 业务场景
物料入库后处于“待检”状态，不能立即被领用，且不能进行财务结算。

### 开发逻辑
- **库存状态隔离**: 收货后，库存记录的 `is_available` 标记设为 `false`，`status` 设为 `Wait_Inspect`。
- **财务对账关口**: AEP 凭证生成引擎在扫描入库单时，必须过滤 `inspect_status = 'Passed'` 的记录。
- **追溯链条**: 入库批次（Lot）必须物理存储 `po_id` 和 `vendor_id`，实现从成品缺陷到供应商原材料的秒级回溯。

---

## 6. 开发者 Checklist

- [ ] **数值精度**: 采购单位换算、单价计算是否使用了 `numeric(24, 12)`？
- [ ] **需求闭环**: PR 行的 `qty_ordered` 回填是否在同一事务内完成，并处理了超订货校验？
- [ ] **变更升版**: 已核准单据的修改是否强制触发了版本快照记录？
- [ ] **质量关口**: 入库单是否支持检验策略判断？未检物资是否正确设置了库存可用性标记？
- [ ] **反审核拦截**: PO 已产生入库单或发票时，是否在后端代码级禁止了弃审操作？
- [ ] **多币种处理**: 涉及外币采购时，是否在单据行记录了交易汇率（TransRate）与本币金额（LocalAmount）？
- [ ] **建议锁**: 在进行大批量 PR 聚合时，是否使用了 `pg_advisory_xact_lock` 防止死锁？
