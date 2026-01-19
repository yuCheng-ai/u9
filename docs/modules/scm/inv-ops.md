# 调拨与形态转换 (Inventory Ops) - 开发者详尽指南

## 概述
库存移动不只是位置的变化，更是**资产权属与价值形态**的流转。开发者必须理解：每一次 `Move` 都可能触发财务过账、税路切换、甚至组织间的结算。

---

## 业务痛点与开发对策

| 业务痛点 | 技术对策 |
| :--- | :--- |
| **跨组织“黑洞”**：总公司发了货，分公司没收到，中间状态没人管。 | **在途库存（In-Transit）模型**：发货即减发货方库存，增“在途虚拟仓”，收货后再转正式仓。 |
| **形态转换成本乱**：1 吨原材料拆成 3 种成品，成本只会平均摊，导致高毛利低毛利假象。 | **多维价值分摊引擎**：支持按重量、体积、甚至市场价值（Sales Value）比例自动分摊投入成本。 |
| **PDA 扫码卡顿**：仓库作业高峰期，扫码过账事务太重，PDA 经常超时。 | **异步过账队列**：PDA 接口只做“数据暂存 + 幂等校验”，后端通过 `LISTEN/NOTIFY` 异步执行扣减库存事务。 |
| **追溯断层**：转换后的新批次找不到老批次的影子。 | **批次血缘链条**：在库存交易明细中记录 `Parent_Batch_ID`，并使用递归 CTE 实现全链路追溯。 |

---

## 1. 跨组织调拨逻辑 (Inter-Org Transfer)

### 业务场景
总公司调拨给子公司，涉及两个法律实体的账务切换。

### 开发规范
- **两阶段事务 (Two-Step)**: 
    1. **Step 1 (Ship)**: 发货组织扣库存，借：在途物资，贷：库存商品。
    2. **Step 2 (Receive)**: 接收组织增库存，借：库存商品，贷：应付账款（内部往来）。
- **内部结算**: 必须从 `Inter_Company_Price_List` 自动带出结算单价。

### 技术实现建议
- **在途管理**: 
  ```sql
  -- 调拨发货时，将库存转移到“虚拟在途仓”
  UPDATE inv_stock SET bin_id = :transit_bin WHERE batch_id = :id;
  ```

---

## 2. 形态转换与价值分摊 (Transformation & Value Allocation)

### 业务场景
“一堆原材料加工成了边角料，或者 A 等品降级成了 B 等品”。

### 技术实现建议
- **价值分摊模型**: 
  - **按市值分摊**: 适用于食品、电子行业（CPU 降级）。
- **示例代码**:
  ```sql
  -- 按市场价值比例计算分摊成本
  WITH total_market_value AS (
      SELECT sum(qty * market_price) as total_val 
      FROM trans_output_lines WHERE parent_id = :trans_id
  )
  UPDATE trans_output_lines 
  SET allocated_cost = (:total_input_cost * (qty * market_price) / tmv.total_val)
  FROM total_market_value tmv
  WHERE parent_id = :trans_id;
  ```

---

## 3. 批次血缘与质量追溯 (Batch Lineage)

### 业务场景
发现一批成品质量有问题，需要立刻查出它们是由哪些原材料批次转换而来的。

### 技术实现建议
- **递归血缘查询**:
  ```sql
  -- 向上追溯源头批次
  WITH RECURSIVE lineage AS (
      SELECT parent_batch_id FROM inv_batch_trans WHERE child_batch_id = :target_batch
      UNION
      SELECT bt.parent_batch_id FROM inv_batch_trans bt 
      JOIN lineage l ON bt.child_batch_id = l.parent_batch_id
  )
  SELECT * FROM lineage;
  ```

---

## 4. 条码与 PDA 异步处理 (Barcode Integration)

### 业务场景
仓库现场作业要求毫秒级响应，不能等待繁重的 ERP 财务过账。

### 开发逻辑
- **前端暂存**: PDA 扫描后将数据写入 `stg_scan_log`。
- **后台异步**: 启用后台进程轮询或监听信号，逐单执行库存扣减。

### 技术实现建议
- **LISTEN/NOTIFY**:
  ```sql
  -- 数据库端信号触发
  CREATE TRIGGER trg_pda_scan AFTER INSERT ON stg_scan_log
  FOR EACH ROW EXECUTE FUNCTION notify_inventory_process();
  ```

---

## 5. 开发者 Checklist

- [ ] **精度控制**: 价值分摊计算是否使用了 `numeric(38, 12)` 且保证了分摊后的 `Sum(Allocated_Cost) == Total_Input_Cost`？
- [ ] **反审核拦截**: 形态转换单对应的输出批次若已发生后续交易（如已销售），是否禁止了该转换单的反审核？
- [ ] **库存锁定**: 调拨出库时是否正确处理了 `Reserved_Qty`（预留数量）的扣减？
- [ ] **多币种**: 跨组织调拨是否处理了两个组织的本位币汇率转换？
- [ ] **幂等性**: PDA 接口是否通过 `Device_ID + Scan_Timestamp` 实现了幂等，防止重复过账？
