# 完工入库与结案 (MO Complete) - 开发者详尽指南

## 概述
完工入库（Completion）是制造流程的“终点线”，也是财务核算的“起跑线”。开发者必须理解：这不仅仅是将库存数量加 1，更涉及**WIP 结转、质量判定、成本差异挤入**以及**需求关闭**的复杂逻辑。

---

## 1. 完工申报与质量判定 (Declaration & Inspection)

### 企业痛点
**“明明还没检完，仓库就给入库了，结果发货发了次品”**。

### 开发逻辑点
- **质量锁 (Quality Gate)**: 
    - 开发者需实现“报检-检验-入库”的严格流水线。
    - **逻辑**: `IF (Item.Is_Inspection_Required == True AND MO_Report.Inspect_Status != 'Qualified') THEN BLOCK_INVENTORY_IN`。
- **自动触发入库**: 
    - 对于免检物料，开发者应提供“一键完工”接口，同时完成汇报与入库事务。
    - **事务处理**: 必须确保 MO 状态更新与库存增加的原子性。

### PostgreSQL 实现建议
- **原子事务控制**: 使用 `BEGIN` ... `COMMIT` 包裹申报与入库逻辑，利用 `EXCEPTION` 捕获库存不足或状态冲突，确保数据一致性。
- **行级锁 (FOR UPDATE)**: 在更新 MO 状态前，使用 `SELECT * FROM MO WHERE ID = ? FOR UPDATE` 锁定记录，防止并发完工导致的数据错乱。
- **触发器校验**: 可在 `inventory_transaction` 表上设置 `BEFORE INSERT` 触发器，强制校验关联 MO 的检验状态，作为数据库层的最后一道防线。

---

## 2. 在制品 (WIP) 结转与清理 (WIP Clearing)

### 企业痛点
“订单入库了，但车间里还剩了 3 个螺丝没用完，账上挂着一笔烂账”。

### 开发逻辑点
- **余料自动退库/核销**: 
    - 在 MO 结案（Close）时，开发者需扫描 `MO_Component_List`。
    - **逻辑**: `Remaining_Qty = Issued_Qty - Standard_Required_Qty`。
    - **处理**: 提示用户进行“余料退库”或自动生成“损耗核销凭证”。
- **WIP 清零算法**: 
    - 开发者需将该 MO 对应的 `WIP_Account` 余额全额结转至 `Finished_Goods_Inventory_Account`。

### PostgreSQL 实现建议
- **批量物料处理**: 使用 `INSERT INTO ... SELECT` 结合 `JOIN` 一次性生成所有余料的核销或退库草案，减少应用层循环调用。
- **JSONB 存储 WIP 详情**: 将 MO 的组件消耗快照存储在 `JSONB` 字段中，方便后续进行成本追溯和差异分析。
- **窗口函数计算差异**: 
  ```sql
  SELECT component_id, 
         issued_qty, 
         SUM(issued_qty) OVER(PARTITION BY mo_id) as total_issued
  FROM mo_material_issue;
  ```

---

## 3. 生产订单结案逻辑 (MO Closing)

### 企业痛点
**“订单都入库一年了，居然还能往里面领料”**。

### 开发逻辑点
- **硬性结案约束**: 
    - 结案后，开发者必须在所有相关的增删改 API 中增加拦截：`IF (MO.Status == 'Closed') THEN REJECT`。
- **成本结平校验**: 
    - 开发者在执行结案事务前，必须校验：`SUM(Input_Cost) - SUM(Output_Value) ≈ 0`。
    - 如果差异超过阈值，必须强制要求用户录入“差异原因代码”。

### PostgreSQL 实现建议
- **行级安全策略 (RLS)**: 对已结案的 MO 及其关联表应用 RLS 策略，直接在数据库层禁止 `UPDATE` 和 `INSERT`。
  ```sql
  CREATE POLICY mo_closed_readonly ON mo_issue_record
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM production_order WHERE id = mo_id AND status != 'Closed')
  );
  ```
- **布尔索引优化**: 对 `status` 字段建立部分索引（Partial Index），加速对进行中订单的查询。
  ```sql
  CREATE INDEX idx_active_mo ON production_order (id) WHERE status != 'Closed';
  ```

---

## 4. 关键绩效指标 (KPI Tracking)

### 企业痛点
“老板想知道这个月的生产合格率和按期完工率，系统算不出来”。

### 开发算法
- **直通率 (FPY)**: `FPY = (一次性合格量 / 总申报量) * 100%`。
- **按期完工率**: `On_Time_Rate = (Actual_Finish_Date <= Plan_Finish_Date ? 1 : 0)`。
- **成本偏差率**: `Cost_Variance = (实际成本 - 标准成本) / 标准成本`。

### PostgreSQL 实现建议
- **物化视图 (Materialized View)**: 对于复杂的 KPI 计算（如 FPY），建议使用物化视图定时刷新，避免实时查询对生产库造成的压力。
- **时序数据处理**: 利用 PG 的 `DATE_TRUNC` 进行按月/按周的 KPI 聚合分析。
- **自定义聚合**: 使用 `FILTER` 子句简化 SQL 编写：
  ```sql
  SELECT 
    COUNT(*) FILTER (WHERE actual_date <= plan_date) * 100.0 / COUNT(*) as on_time_rate
  FROM mo_completion;
  ```

---

## 5. 开发者 Checklist

- [ ] **多单位处理**: 完工申报单位与入库单位不一致时的浮点数精度处理。
- [ ] **倒冲物料**: 完工入库时，是否成功触发了“拉式（Pull）”物料的自动扣减？
- [ ] **反审核控制**: 如果成品已经销售出库，是否禁止了完工入库单的反审核？
- [ ] **批次/序列号**: 入库时是否强制要求生成或录入生产批次号？
