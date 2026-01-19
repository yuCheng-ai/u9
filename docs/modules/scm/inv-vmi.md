# VMI 库存与第三方代管 - 开发者详尽指南

## 概述
VMI（Vendor Managed Inventory）和第三方代管库存是“物理位置”与“所有权”分离的典型场景。开发者必须解决的核心逻辑是：**如何在库存表里区分“谁的货”以及“谁来付钱”**。

---

## 业务痛点与开发对策

| 业务痛点 | 技术对策 |
| :--- | :--- |
| **资金占用假象**：货在仓库里，但权属归供应商。若不区分，财务报表会虚增资产。 | **权属隔离维度 (Ownership Dimension)**：在库存主表 `inv_onhand` 中增加 `owner_type`（自有/供应商）和 `owner_id` 字段，作为主键或索引的核心维度。 |
| **消耗结算滞后**：生产领用了 VMI 的料，却忘了给供应商结算。 | **消耗触发引擎 (Consumption_Trigger)**：在库存扣减（领料出库）的原子事务中，自动识别 `owner_type = 'Supplier'`，并同步插入“待结算 VMI 记录表（v_vmi_settle_pending）”。 |
| **委外库存“失控”**：原材料发给委外商加工，库存查不到，MRP 还会重复买。 | **虚拟外委仓 (Subcontracting_Wh)**：为每个委外商建立虚拟仓库。发料即为“调拨（Transfer）”，库存所有权仍为“自有”，确保 MRP 计算时可用。 |
| **对账“罗生门”**：供应商说用了 100 个，系统说用了 80 个。 | **三方快照对账 (Snapshot_Reconciliation)**：定期生成 VMI 库存流水快照，并利用 `JSONB` 记录每一笔消耗的原始单据（MO/SO）ID，确保账账相符。 |

---

## 1. 供应商寄售逻辑 (Consignment Management)

### 业务场景
“货在我的仓库里，但我只有在用掉它的时候才产生财务负债”。

### 技术实现建议
- **库存双维度查询**: 开发者必须确保库存查询接口支持按权属聚合。
- **示例代码**:
  ```sql
  -- 查询自有库存 vs 寄售库存
  SELECT 
    item_id, 
    sum(qty) FILTER (WHERE owner_type = 'Self') as self_qty,
    sum(qty) FILTER (WHERE owner_type = 'Supplier') as vmi_qty
  FROM inv_onhand 
  GROUP BY item_id;
  ```

---

## 2. 消耗即结算机制 (Consumption-to-Pay)

### 业务场景
生产车间从 VMI 货位领走 10 个轴承，系统应立即感知并准备付款。

### 开发逻辑：同步捕获与异步结算
- **同步记录**: 在 `BeforeUpdate` 触发器中捕获 VMI 扣减。
- **示例代码**:
  ```sql
  -- 捕获 VMI 消耗的触发器逻辑
  IF (OLD.owner_type = 'Supplier' AND NEW.qty < OLD.qty) THEN
      INSERT INTO vmi_settle_pending (item_id, vendor_id, qty, source_doc_id)
      VALUES (OLD.item_id, OLD.owner_id, (OLD.qty - NEW.qty), :current_doc_id);
  END IF;
  ```

---

## 3. 外委加工库存可见性 (Subcontracting Visibility)

### 业务场景
原材料在委外商厂里，仍是企业的资产，应参与 MRP 计算。

### 开发规范
- **调拨即监控**: 原材料发往委外商不走“出库”，走“库间调拨”。
- **MRP 逻辑**: MRP 引擎在计算可用量时，必须包含 `wh_type = 'Subcontracting'` 的仓库。
- **示例代码**:
  ```sql
  -- MRP 可用量计算（包含委外仓）
  SELECT item_id, sum(qty) as available_qty 
  FROM inv_onhand 
  WHERE wh_id IN (SELECT id FROM cfg_warehouse WHERE is_mrp_included = true);
  ```

---

## 4. VMI 对账与差异处理 (Reconciliation)

### 业务场景
月末与供应商对账，处理损益差异。

### 技术实现建议
- **快照比对**: 使用 PostgreSQL 的 `EXCEPT` 或 `FULL JOIN` 对比系统记录与供应商报表。
- **示例代码**:
  ```sql
  -- 对账差异发现
  SELECT 
    COALESCE(sys.item_id, vendor.item_id) as item_id,
    sys.total_consumed as sys_qty,
    vendor.total_consumed as vendor_qty,
    (sys.total_consumed - vendor.total_consumed) as diff
  FROM v_vmi_consumed_summary sys
  FULL JOIN vendor_report_table vendor ON sys.item_id = vendor.item_id;
  ```

---

## 5. 开发者 Checklist

- [ ] **权属标识**: `inv_onhand` 表是否已包含 `owner_type` 和 `owner_id` 字段？
- [ ] **结算触发**: 所有的出库单据（领料单、销售出库）是否都实现了 VMI 消耗识别逻辑？
- [ ] **高精度结算**: 结算单价是否取自最新的“寄售协议价”并使用 `numeric(24,12)` 计算？
- [ ] **反审核拦截**: 若 VMI 记录已生成结算单，则对应的领料单是否已被锁定？
- [ ] **MRP 兼容**: MRP 存储过程是否正确处理了委外仓和寄售仓的逻辑开关？
- [ ] **库龄分析**: 寄售库存的库龄计算是否从“入库日”开始，而非“结算日”？
- [ ] **库存分配**: 自动分配逻辑（ATP）是否支持配置“优先消耗 VMI 库存”策略？
