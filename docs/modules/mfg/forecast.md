# 销售预测与冲销 (Forecast) - 开发者详尽指南

## 概述
预测（Forecast）是制造企业的“望远镜”。开发者必须处理好**不确定性**。预测的核心逻辑不是简单的记录，而是如何通过**冲销（Consumption）**逻辑，确保计划系统（MRP）既不漏算需求，也不重复计算需求。

---

## 业务痛点与开发对策

| 业务痛点 | 技术对策 |
| :--- | :--- |
| **需求重复计算**：预测是 100，实际订单（SO）来了 20。若不冲销，MRP 会按 120 备料，导致库存积压。 | **预测冲销引擎 (Forecast_Consumption)**：在 SO 审核事务中，自动寻找对应时间桶（Bucket）的预测行进行数量抵扣。 |
| **预测“乐观与稳健”**：销售和财务给的预测版本不一致。 | **多版本模拟 (Multi-Version)**：支持多个 Forecast_Version，并允许在运行 MRP 时选择特定的版本快照作为需求源。 |
| **颗粒度断层**：销售只预测产品大类（如：笔记本电脑），生产需要具体型号（如：X1 Carbon）。 | **比例分摊引擎 (Pro-rata_Engine)**：利用历史销量比例，将产品族预测自动拆解为具体的 SKU 预测明细。 |
| **过期预测干扰**：上个月没跑完的预测，不应再干扰本月的生产计划。 | **自动过期清理 (Auto-Expiration)**：利用 `pg_cron` 定期清理或归档 `valid_to < CURRENT_DATE` 且未冲销的预测行。 |

---

## 1. 核心模型：时间桶与版本化 (Bucketing)

### 业务场景
预测通常按周（Week）或按月（Month）汇总。

### 技术实现建议
- **时间范围存储**: 使用 PostgreSQL 的 `daterange` 类型。
- **示例代码**:
  ```sql
  -- 创建带时间范围约束的预测表
  CREATE TABLE mfg_forecast (
    id serial PRIMARY KEY,
    item_id int,
    qty numeric(24, 12),
    consumed_qty numeric(24, 12) DEFAULT 0,
    valid_period daterange, -- [2024-01-01, 2024-02-01)
    version_id int
  );
  ```

---

## 2. 预测冲销算法 (Consumption Logic)

### 业务场景
当一个销售订单（SO）交期为 1月15日时，它应该冲销掉 1月份的预测量。

### 开发逻辑：前/后冲销策略
1. **匹配桶**: 找到 SO 交期所在的 `valid_period`。
2. **原子抵扣**: 使用 `UPDATE ... SET consumed_qty = consumed_qty + :so_qty`。
3. **溢出处理**: 如果当前桶不够冲，是否向后一个桶继续冲？（由 `consumption_policy` 决定）。

### 技术实现建议
- **并发控制**: 使用 `SELECT ... FOR UPDATE` 锁定预测行。
- **示例代码**:
  ```sql
  -- 预测冲销核心逻辑
  UPDATE mfg_forecast 
  SET consumed_qty = consumed_qty + :so_qty
  WHERE item_id = :item_id 
    AND valid_period @> :so_due_date -- SO 交期落在此区间内
    AND (qty - consumed_qty) >= :so_qty
  RETURNING id;
  ```

---

## 3. 比例分摊引擎 (Allocation Engine)

### 业务场景
将“手机产品族”的 10,000 台预测，按历史销量比例拆分给“黑色 128G”和“白色 256G”。

### 技术实现建议
- **窗口函数分摊**:
  ```sql
  -- 根据过去 3 个月的销量比例自动分摊预测
  WITH sales_history AS (
    SELECT item_id, sum(qty) as history_total 
    FROM sal_order_line 
    WHERE due_date > CURRENT_DATE - interval '3 months'
    GROUP BY item_id
  ),
  total_history AS (SELECT sum(history_total) as grand_total FROM sales_history)
  SELECT 
    sh.item_id,
    (:family_forecast_qty * sh.history_total / th.grand_total) as allocated_qty
  FROM sales_history sh, total_history th;
  ```

---

## 4. 预测准确率分析 (Accuracy & Bias)

### 业务场景
对比“月初预测”与“月末实际订单”，识别哪些销售在“乱报”。

### 技术实现建议
- **物化视图预计算**:
  ```sql
  -- 预测准确率看板
  CREATE MATERIALIZED VIEW mv_forecast_accuracy AS
  SELECT 
    item_id,
    sum(qty) as forecast_qty,
    sum(consumed_qty) as actual_qty,
    (1 - abs(sum(qty) - sum(consumed_qty)) / NULLIF(sum(qty), 0)) as accuracy_rate
  FROM mfg_forecast
  GROUP BY item_id;
  ```

---

## 5. 开发者 Checklist

- [ ] **高精度计算**: 冲销和分摊是否统一使用 `numeric(24, 12)`？
- [ ] **冲销策略**: 系统是否支持“前冲销”、“后冲销”以及“不冲销”的可配置开关？
- [ ] **并发性能**: 订单审核高峰期，冲销逻辑是否通过索引优化（GIST）避免了全表扫描？
- [ ] **反审核处理**: SO 弃审时，是否能正确回退 `consumed_qty` 并记录反冲销日志？
- [ ] **颗粒度对齐**: 预测是按周录入的，订单是按天录入的，冲销逻辑是否正确处理了日期重叠？
- [ ] **多租户隔离**: 预测数据是否正确应用了 RLS（行级安全）策略？
- [ ] **MRP 引用**: MRP 计划引擎在取需求时，是否使用的是 `(qty - consumed_qty)` 后的净需求？
