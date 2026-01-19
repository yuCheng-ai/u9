# 工艺路线与资源 (Routing) - 开发者详尽指南

## 概述
如果说 BOM 是“配方”，那么工艺路线（Routing）就是“烹饪步骤”。开发者必须理解：工艺路线是**工序、工时、工作中心、设备资源**的四维坐标系。它是生产排产（APS）和工序成本（Costing）的底层骨架。

---

## 1. 工序与时间模型 (Operation & Time Model)

### 企业痛点
**“算出来的生产工期永远不准，不是早了就是晚了”**。

### 开发逻辑点
- **精密工时模型**: 开发者需支持以下四种时间维度的累加：
    - `Setup_Time` (准备时间): 与批量无关（如：洗锅、调机）。
    - `Run_Time` (运行时间): 与批量正相关（如：炒菜）。
    - `Wait_Time` (等待时间): 工序内必须的物理等待（如：冷却、发酵）。
    - `Move_Time` (移动时间): 工序间的转运时间。
- **排程公式**: `Total_Operation_Time = Setup_Time + (Run_Time * Order_Qty) + Wait_Time + Move_Time`。
- **开发注意**: 所有的工时必须支持“秒/分/时”的单位转换，且精度至少保留 4 位小数。

### PostgreSQL 实现建议
- **数值类型精度 (NUMERIC)**: 使用 `NUMERIC(20, 4)` 存储工时，确保在进行单位换算（如：秒转时）时不会出现浮点数精度丢失。
- **时间跨度计算 (INTERVAL)**: 利用 PG 的 `INTERVAL` 类型处理工序间的等待和移动时间，方便进行日期加减运算：`plan_finish_date = plan_start_date + (total_time * interval '1 second')`。
- **自定义函数封装**: 编写 `PL/pgSQL` 函数统一计算总工时，方便在视图和触发器中复用排程公式。

---

## 2. 工作中心与共享资源冲突 (Work Center & Shared Resources)

### 企业痛点
- **能力建模 (Capacity)**: “明明只有 3 台机器，系统却排了 5 个人的活”。
- **共享资源冲突**: 当多个工作中心共用同一台关键设备（如大型烘箱）时，排程算法如何处理资源抢占？

### 开发逻辑点
- **资源抽象**: 设备应作为独立资源（Resource）被多个工作中心引用。
- **有限能力校验 (Finite Capacity)**: 
    - 在排产接口中，开发者需增加“超载拦截”逻辑。
    - **排程算法**: `Next_Available_Start_Date = MAX(Resource_Busy_Until, Material_Ready_Date)`。

### PostgreSQL 实现建议
- **GIST 索引与排除约束 (Exclusion Constraints)**: 
  ```sql
  -- 强制设备资源在时间轴上不重叠
  ALTER TABLE resource_allocation ADD EXCLUDE USING gist (
    resource_id WITH =,
    busy_period WITH &&
  );
  ```
- **咨询锁 (Advisory Locks)**: 在进行高频排产模拟时，利用 `pg_try_advisory_lock` 快速锁定资源，防止并发排程冲突。

---

## 3. 委外工序的逻辑穿透 (Subcontracting Operation)

### 企业痛点
**“中间有一道电镀工序是外协的，系统里就断档了，根本不知道货在哪”**。

### 开发逻辑点
- **逻辑跳变**: 
    - 当工序属性 `Is_Subcontracted == True` 时，开发者需触发“采购逻辑”。
    - **自动触发**: 生产订单下达到该工序时，自动生成 `Subcontract_Purchase_Request`。
- **物流跟踪**: 
    - 开发者需设计 `Operation_Transfer_Out`（发出给委外商）和 `Operation_Transfer_In`（从委外商收回）事务，确保 WIP 价值链不断裂。

### PostgreSQL 实现建议
- **触发器联动**: 在工序流转表上设置 `AFTER UPDATE` 触发器，当委外工序状态变为“待发出”时，自动向 `purchase_request` 表插入记录。
- **JSONB 记录物流轨迹**: 
  ```jsonb
  {
    "subcontractor": "Vendor_A",
    "shipped_at": "2023-10-01",
    "expected_back": "2023-10-05",
    "tracking_no": "SF123456"
  }
  ```
  利用 `JSONB` 存储动态的外协物流信息，无需为每种外协业务修改表结构。
- **外部数据源 (postgres_fdw)**: 如果委外商使用了独立的协作系统，可以通过 `postgres_fdw` 直接在 ERP 中查询外协进度。

---

## 4. 关键工序与移动控制 (Move Control)

### 企业痛点
“前面的工序还没干完，后面的就报工了，导致报表上的在制品数量是负数”。

### 开发逻辑点
- **移动策略 (Move Policy)**: 
    - 开发者需在工序定义中增加 `Move_Point_Flag`。
    - **逻辑**: 只有在 `Qualified_Qty` 产生后，才允许调用 `Operation_Move_API`。
- **关键路径 (Critical Path)**: 
    - 开发者需支持“里程碑汇报”。只有关键工序汇报了，才更新 MO 的整体百分比进度。

### PostgreSQL 实现建议
- **递归 CTE 路径检查**: 
  ```sql
  WITH RECURSIVE op_path AS (
    SELECT id, next_op_id, is_completed FROM routing WHERE mo_id = ? AND op_seq = 1
    UNION ALL
    SELECT r.id, r.next_op_id, r.is_completed FROM routing r JOIN op_path p ON r.id = p.next_op_id
  )
  SELECT bool_and(is_completed) FROM op_path WHERE id < current_op_id;
  ```
  使用递归查询确保当前工序之前的所有必要步骤均已完成。
- **触发器维护进度**: 在汇报表上设置触发器，实时累加关键工序产出，并更新 MO 主表的 `completion_percentage` 字段。
- **布尔索引**: 对 `is_critical_path` 字段建立索引，加速进度看板的查询性能。

---

## 5. 开发者 Checklist

- [ ] **递归路径**: 复杂的工艺路线可能包含分支（并行工序），排程算法是否支持“同步开始”或“同步结束”？
- [ ] **成本中心关联**: 每一个工作中心是否都正确映射到了财务的 `Cost_Center`？
- [ ] **版本切换**: 正在生产的订单是否支持“在线切换”工艺路线？（涉及 WIP 重算）。
- [ ] **效率系数**: 开发者是否预留了“设备稼动率”和“人员熟练度”对工时的修正系数接口？
