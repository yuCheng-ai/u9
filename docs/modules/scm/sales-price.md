# 销售价格体系 - 开发者详尽指南

## 概述
销售价格是企业的“盈利边界”。开发者必须理解：销售价格模型是一个**多因子复合逻辑**。它不是从数据库取一个 `Price` 字段那么简单，而是通过一系列**路由规则、优先级、阶梯算法、以及折扣叠加**最终计算出的结果。

---

## 业务痛点与开发对策

| 业务痛点 | 技术对策 |
| :--- | :--- |
| **价格记忆混乱**：同一个客户，销售员录入的价格每次都不一样，缺乏基准。 | **瀑布式取价引擎 (Waterfall Engine)**：实现一套基于优先级（客户特价 > 客户等级价 > 全局标准价）的自动寻价逻辑，利用 `UNION ALL` + `LIMIT 1` 确保性能。 |
| **量大从优难以落地**：阶梯价计算复杂，录单员手动算容易出错。 | **Range 区间匹配**：利用 PostgreSQL 的 `numrange` 实现阶梯区间的秒级检索，避免繁琐的 `IF-ELSE` 逻辑。 |
| **折扣“罗生门”**：多种促销折扣叠加（满减、折上折），财务核算困难。 | **折扣栈 (Discount Stack)**：定义严格的计算序列（减法 -> 比例 -> 取整），并利用 JSONB 记录完整的“折扣分摊足迹”。 |
| **亏本卖货风险**：销售为保单随意降价，缺乏底线拦截。 | **最低限价硬拦截**：在单据 `BeforeSave` 钩子中，强制校验 `ActualPrice < Cost * (1 + MinMargin)`，非授权禁止通过。 |

---

## 1. 取价引擎算法 (Waterfall Search)

### 业务场景
系统需根据“客户、料品、数量、日期、币种”自动从成千上万条价格记录中找到那唯一正确的价格。

### 开发逻辑：优先级匹配
开发者需实现一个寻价链条，优先级由高到低：
1. **特价协议**: `Customer_ID + Item_ID` 唯一匹配。
2. **客户等级价**: `Customer_Grade + Item_ID` 匹配。
3. **全局基准价**: `Item_ID` 匹配。

### 技术实现建议
- **GIST 索引**: 对于包含有效期的价格表，务必对 `(item_id, validity_period)` 建立 GIST 索引。
- **示例代码**:
  ```sql
  -- 高效取价逻辑
  WITH price_candidates AS (
      -- 优先级 10：客户特价
      SELECT unit_price, 10 as priority FROM sal_price_special 
      WHERE customer_id = :cust AND item_id = :item AND validity @> :order_date
      UNION ALL
      -- 优先级 20：等级价
      SELECT unit_price, 20 as priority FROM sal_price_grade 
      WHERE grade_id = :grade AND item_id = :item AND validity @> :order_date
      UNION ALL
      -- 优先级 30：基准价
      SELECT unit_price, 30 as priority FROM sal_price_standard 
      WHERE item_id = :item AND validity @> :order_date
  )
  SELECT unit_price FROM price_candidates ORDER BY priority ASC LIMIT 1;
  ```

---

## 2. 阶梯价格与区间查找 (Volume Tiering)

### 业务场景
“1-99 个：10元；100-499 个：9.5元；500个以上：9元”。

### 技术实现建议
- **避免多行 Join**: 将阶梯区间存储为 `numrange`。
- **示例代码**:
  ```sql
  -- 利用 @> 操作符秒级匹配数量区间
  SELECT tiered_price FROM sal_price_tier 
  WHERE price_list_id = :id 
    AND qty_range @> :current_qty; -- 例如 [100, 500) @> 250
  ```

---

## 3. 折扣叠加与足迹追踪 (Discount Stacking)

### 业务场景
一个订单可能同时应用：渠道折扣（95折）、限时立减（-10元）、新客返利（2%）。

### 开发规范
- **折扣序列化**: 必须在数据库中定义 `discount_sequence`（如：10-减法，20-比例）。
- **足迹存储**: 在订单行中使用 JSONB 记录应用过程：`[{"type": "minus", "val": 10}, {"type": "ratio", "val": 0.95}]`。
- **精度控制**: 每一层折扣计算后的中间值必须使用 `ROUND(val, 4)` 或更高精度。

---

## 4. 价格硬拦截与审计 (Price Guard)

### 业务场景
防止销售人员由于误操作或恶意竞争，以低于成本的价格销售。

### 技术实现建议
- **动态底价**: 底价 = `最新入库成本 * (1 + 利润率参数)`。
- **授权重写**: 如果确实需要亏本销售，必须关联一个“特批流程 ID (Workflow_ID)”。
- **示例代码**:
  ```sql
  -- 触发器中的底价校验
  IF (NEW.unit_price < (SELECT min_allowed_price FROM v_item_cost WHERE id = NEW.item_id)) 
     AND (NEW.special_approve_id IS NULL) THEN
      RAISE EXCEPTION 'ERR_PRICE_VIOLATION: 成交价低于系统底线且未经过特批';
  END IF;
  ```

---

## 5. 开发者 Checklist

- [ ] **数值精度**: 所有的单价、折扣、总额计算是否统一使用 `numeric(24, 12)`？
- [ ] **寻价性能**: 价格表记录过万时，是否通过 GIST 索引优化了日期范围检索？
- [ ] **重定价触发**: 订单日期、客户、数量发生变化时，是否触发了“自动重新寻价”？
- [ ] **手动改价标记**: 如果用户手动修改了自动取出的价格，是否在 `price_source` 标记为 `Manual`？
- [ ] **币种汇率**: 价格表币种与订单币种不一致时，是否正确应用了 `TransRate` 进行折算？
- [ ] **缓存策略**: 对于频繁读取的全局基准价，是否考虑在应用层缓存或使用 PostgreSQL 的 `Materialized View`？
