# 实际成本核算 (Actual Costing) - 开发者详尽指南

## 概述
实际成本（Actual Costing）是 ERP 中逻辑最复杂、计算量最大的模块。它不是简单的“加减法”，而是对企业**价值流**的全面还原。对于开发者来说，这不仅是写 SQL，而是要通过代码实现一个**多级卷积运算引擎**。

---

## 业务痛点与开发对策

| 业务痛点 | 技术对策 |
| :--- | :--- |
| **计算“死循环”**：辅助车间（如动力、机修）互相服务，费用摊不过去。 | **迭代分配算法（Iterative Method）**：在存储过程中实现多次循环分摊，直到余额小于 0.01 元的精度阈值。 |
| **卷积失序**：BOM 层级深，先算成品还是先算零件？算错了会导致单价剧烈波动。 | **低层码（LLC）驱动引擎**：利用递归 CTE 计算 LLC，强制系统按“零件 -> 半成品 -> 成品”的顺序逐层卷积。 |
| **分摊动因僵化**：有的想按工时摊，有的想按产量摊。 | **可配置动因引擎**：基于 `JSONB` 定义分摊因子，支持动态读取 `Worker_Hours` 或 `Output_Qty` 作为分摊权重。 |
| **尾差“炸弹”**：四舍五入导致月末总账不平，差一分钱对不上。 | **尾差自动补差逻辑**：在最后一张订单结算时，执行 `Total - Sum(Previous) = Final`，将精度误差强制吸收到最后一行。 |

---

## 1. 成本域与核算口径 (Cost Domain)

### 业务场景
有些工厂很大，但财务只想按车间核算成本；有些企业有多个工厂，但想共用一套料品单价。

### 开发逻辑
- **成本域 (Cost Domain)**: 核算的物理/逻辑边界。单价计算必须按 `CostDomainID + ItemID` 分组。

---

## 2. 费用归集与分摊引擎 (Allocation Engine)

### 业务场景
“100 万电费怎么摊？”、“动力车间和机修车间互相服务怎么摊？”。

### 技术实现建议
- **迭代分摊算法**: 预设收敛精度（如 0.01）。
- **示例代码**:
  ```sql
  -- 迭代分摊核心逻辑（伪代码）
  WHILE (SELECT max(unallocated_amount) FROM tmp_dept_costs) > 0.01 LOOP
      -- 执行一轮分摊：将 A 部门费用按比例分给 B/C...
      PERFORM fn_execute_allocation_round();
  END LOOP;
  ```

---

## 3. 多级卷积计算 (Multi-level Rollup)

### 核心算法：低层码 (Low Level Code)
开发者必须先计算物料在所有 BOM 中的最低层级。
- **计算顺序**: 从低层码大（底层零件）到小（顶层成品）卷积。

### 技术实现建议
- **低层码计算**:
  ```sql
  WITH RECURSIVE bom_levels AS (
    SELECT child_id, 1 as level FROM bom_struct WHERE parent_id IS NULL
    UNION ALL
    SELECT b.child_id, bl.level + 1 FROM bom_struct b JOIN bom_levels bl ON b.parent_id = bl.child_id
  )
  SELECT child_id, MAX(level) as llc FROM bom_levels GROUP BY child_id;
  ```

---

## 4. 联产品与副产品分摊 (Joint Products)

### 业务场景
一个生产订单产出 A 产品的同时，顺带产出了 B（副产品）。

### 开发规范
- **分摊规则**: 
    - **副产品**: 通常按固定单价（扣除法）从总成本中剔除。
    - **联产品**: 按市场价值比例分摊剩余成本。

---

## 5. 开发者 Checklist

- [ ] **性能优化**: 卷积涉及海量计算，是否使用了 `LOCAL TEMPORARY TABLE` 缓存中间结果？
- [ ] **异常监控**: 是否捕获了“无单价原材料”异常？核算日志是否清晰记录了每个料品的成本构成（料、工、费）？
- [ ] **数据快照**: 核算开始前是否“封单”？（禁止修改核算月份的收发货单据）。
- [ ] **尾差平衡**: 是否实现了“最后一行自动挤平”逻辑，确保 `Input = Output`？
- [ ] **精度控制**: 计算过程是否全程使用 `numeric(38, 12)`？
- [ ] **追溯性**: 分摊后的每一笔凭证是否都保留了 `Cost_Center_ID` 和 `Source_Voucher_ID`？
- [ ] **弃审拦截**: 成本已核算的月份，是否强制禁止了该月份内所有单据的反审核？
