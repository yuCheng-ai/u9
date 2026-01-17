# 生产订单管理 (MO) - 开发者详尽指南

## 概述
生产订单（MO）是 ERP 系统的“施工单”。开发者必须理解：MO 是 **BOM + 工艺路线 + 成本中心** 的聚合体。它的核心逻辑在于：将“静态的定义”转化为“动态的执行”，并在这个过程中严格控制**料、工、费**的流向。

---

## 1. 订单类型与逻辑路由 (MO Types & Routing)

### 企业痛点
**“返工领的料全算进了标准成本，导致成本分析全乱了”**。

### 开发逻辑点
- **类型路由**: 开发者需通过 `MO_Type` 驱动不同的业务逻辑。
    - **标准订单**: 严格校验 BOM，自动生成领料明细。
    - **返工订单**: 允许空 BOM 启动，支持手动录入 `Rework_Material`。
    - **改制订单**: 需处理“旧品退库”与“新品入库”的价值转换。
- **成本隔离**: 开发者在设计数据库索引时，必须确保 `Cost_Center` 和 `MO_Type` 是核心查询维度，防止不同类型的订单成本混淆。

### PostgreSQL 实现建议
- **枚举类型 (ENUM)**: 使用 `CREATE TYPE mo_type AS ENUM ('Standard', 'Rework', 'Refurbish')` 提高数据存储效率和可读性，并配合 `CHECK` 约束实现业务逻辑分支。
- **部分索引 (Partial Index)**: 针对不同类型的订单创建部分索引，例如：`CREATE INDEX idx_rework_mo ON mo_header (id) WHERE mo_type = 'Rework'`，加速特定业务场景的检索。
- **视图解耦**: 创建 `v_standard_mo`, `v_rework_mo` 等视图，将不同类型订单的特有逻辑封装在视图中，简化应用层开发。

---

## 2. 备料明细的动态生成 (Component List Logic)

### 企业痛点
**“BOM 改了，已经开工的订单没跟着改，结果领错了料”**。

### 开发逻辑点
- **快照机制**: 
    - 当 MO 审核时，开发者需将当前的 BOM 结构**持久化**到 `MO_Component_List` 表中。
    - **不要**直接在 UI 上展示主 BOM 关联查询，因为主 BOM 会变，而生产现场必须按“开工那一刻”的版本执行。
- **同步引擎**: 
    - 如果用户确实想同步最新 BOM，开发者需提供一个 `Update_Component_List` 接口。
    - **开发注意**: 必须检查“已领料量”，如果已领料，则不允许随意删除备料行。

### PostgreSQL 实现建议
- **JSONB 存储快照**: 将审核时的完整 BOM 树以 `JSONB` 格式存储在 `mo_header.bom_snapshot` 中，既保留了原始结构，又方便进行版本比对。
- **触发器保护数据**: 
  ```sql
  CREATE OR REPLACE FUNCTION check_material_issued() RETURNS TRIGGER AS $$
  BEGIN
    IF EXISTS (SELECT 1 FROM mo_material_issue WHERE component_id = OLD.id AND issued_qty > 0) THEN
      RAISE EXCEPTION 'Cannot delete component that has already been issued.';
    END IF;
    RETURN OLD;
  END;
  $$ LANGUAGE plpgsql;
  ```
- **批量插入优化**: 同步 BOM 时，使用 `INSERT INTO ... SELECT` 结合 `ON CONFLICT` 语法，实现高效的增量更新。

---

## 3. 状态机的原子性切换 (State Machine)

### 企业痛点
“订单显示已结案，但仓库还在给它发料”。

### 开发逻辑点
- **硬性约束**: 
    - 开发者需在领料、报工、完工入库的 API 入口处增加 `Status_Check`。
    - **逻辑**: `IF (MO.Status NOT IN ('Approved', 'Released')) THEN REJECT_TRANSACTION`。
- **状态回滚**: 
    - 结案（Close）是一个复杂的事务，涉及 WIP 结转。开发者必须确保该操作的幂等性，并支持在特定条件下的“反结案”操作。

### PostgreSQL 实现建议
- **行级安全策略 (RLS)**: 
  ```sql
  CREATE POLICY mo_status_control ON mo_component_list
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM mo_header WHERE id = mo_id AND status IN ('Approved', 'Released'))
  );
  ```
- **状态变更记录 (Audit Table)**: 使用触发器自动将状态变更记录到 `mo_status_history` 表中，包含操作人、时间、旧状态、新状态，利用 `JSONB` 记录变更上下文。
- **事务保存点 (SAVEPOINT)**: 在结案等复杂事务中，利用 `SAVEPOINT` 实现局部回滚，提高系统的容错能力。

---

## 4. 关键指标计算 (KPI Calculation)

### 企业痛点
**“经理问我生产进度是多少，我算不出来”**。

### 开发算法
- **进度百分比**: `Progress = (已完工入库量 / 订单计划量) * 100%`。
- **料品齐套率**: `Kitting_Rate = (已领料项数 / 总备料项数) * 100%`。
- **损耗率异常报警**: `IF (实际领料 > 标准用量 * (1 + 预设损耗率)) THEN 发送消息通知 QC`。

### PostgreSQL 实现建议
- **生成列 (Generated Columns)**: 对于简单的进度计算，可以使用存储生成的列：`progress NUMERIC GENERATED ALWAYS AS (completed_qty / plan_qty) STORED`。
- **窗口函数汇总**: 使用 `SUM(...) OVER(PARTITION BY ...)` 实时计算各车间、各生产线的累计产出与达成率。
- **异步报警机制**: 配合 `pg_cron` 或外部监控工具，定期扫描损耗异常记录，并通过 `NOTIFY` 触发即时通讯提醒。

---

## 5. 开发者 Checklist

- [ ] **多单位换算**: MO 计划单位（件）与库存单位（公斤）不一致时，是否处理了精度丢失问题？
- [ ] **并发锁**: 在执行“下达”操作（占用库存）时，是否对涉及的物料使用了行级锁？
- [ ] **变更记录**: MO 的每一次手动修改（加料、减料、改期）是否都记录了 `Change_Log`？
- [ ] **自动排产接口**: 接口是否预留了对接 APS（高级排程系统）的字段（如：优先级、排程 ID）？
