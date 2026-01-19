# 客供档案与信用控制 (Partner & Credit) - 开发者详尽指南

## 概述
合作伙伴（Partner）是企业价值链的延伸。在开发逻辑中，合作伙伴不仅是“通讯录”，更是**风控引擎**的核心输入。开发者必须处理好“一实体多角色”的业务模型，并利用数据库的**并发控制**和**地理空间特性**，确保信用拦截的严密性与物流计算的准确性。

---

## 业务痛点与开发对策

| 业务痛点 | 技术对策 |
| :--- | :--- |
| **一实体多角色**：既是客户又是供应商，往来款项碎片化。 | **实体-角色模型 (Entity-Role)**：底层表按实体（Partner_Main）存储，业务层按角色（Customer/Supplier）通过 JSONB 扩展属性。利用 `UNION ALL` 视图实现全口径对账。 |
| **信用“超卖”**：高并发下单导致信用额度被击穿。 | **行级锁 + 增量控制 (Pessimistic Control)**：使用 `FOR UPDATE` 锁定信用余额行，并采用 `used = used + delta` 的增量扣减逻辑，严禁“先读后写”的非原子操作。 |
| **资质过期风险**：供应商证照过期却依然产生了采购订单。 | **时效性硬约束**：利用 PostgreSQL 的 `daterange` 类型对资质有效期进行存储，并在订单保存事务中利用 `@>` 操作符进行 API 级拦截。 |
| **地址库混乱**：多个收货地址缺乏地理坐标，运费核算不准。 | **PostGIS 地理空间索引**：引入 `geometry(Point)` 存储经纬度，利用 `ST_Distance` 自动化计算物流半径，支持精准的阶梯运费核算。 |

---

## 1. 核心模型：一实体多角色与全口径对账

### 业务场景
大型集团通常具有双重身份：既买产品（客户），又卖原材料（供应商）。财务需要“一键抵消”双向往来款。

### 技术实现建议
- **统一余额视图**:
  ```sql
  -- 实时汇总同一实体在不同角色下的应收/应付
  CREATE VIEW v_partner_net_balance AS
  SELECT 
    p.id as partner_id,
    p.name,
    COALESCE(c.ar_balance, 0) as ar_amount, -- 应收
    COALESCE(s.ap_balance, 0) as ap_amount, -- 应付
    (COALESCE(c.ar_balance, 0) - COALESCE(s.ap_balance, 0)) as net_amount -- 净往来
  FROM partner_main p
  LEFT JOIN customer_ext c ON p.id = c.partner_id
  LEFT JOIN supplier_ext s ON p.id = s.partner_id;
  ```

---

## 2. 严密的信用控制引擎 (Credit Engine)

### 业务场景
信用控制是 ERP 的安全红线。必须确保在高并发下单（如双十一）时，信用额度不会被击穿。

### 开发规范
- **原子性扣减**: 严禁在应用层做加减法。必须在数据库层通过一个 `UPDATE` 语句完成。
- **示例代码**:
  ```sql
  -- 原子性信用扣减（带超限拦截）
  UPDATE partner_credit 
  SET used_amount = used_amount + :order_amount 
  WHERE partner_id = :id 
    AND (credit_limit - used_amount) >= :order_amount -- 核心：在 SQL 层做余量校验
  RETURNING used_amount;
  -- 如果执行返回的行数为 0，立即抛出“信用额度不足”异常并回滚事务。
  ```

---

## 3. 地址库与物流半径计算 (PostGIS Integration)

### 业务场景
根据收货地址的坐标，自动计算工厂到客户的距离，从而匹配不同的运费策略。

### 技术实现建议
- **地理坐标存储**: 使用 `geometry(Point, 4326)`。
- **距离计算**:
  ```sql
  -- 计算工厂（Point A）到收货地址（Point B）的球面距离（单位：米）
  SELECT ST_Distance(
    ST_MakePoint(116.40, 39.90)::geography, -- 工厂坐标
    delivery_point::geography -- 客户坐标
  ) as distance_meters
  FROM partner_address WHERE id = :address_id;
  ```

---

## 4. 准入合规与快照审计 (Audit Trail)

### 业务场景
合作伙伴的关键信息（如信用等级、银行账号）变更必须可追溯。

### 技术实现建议
- **JSONB 变更审计**: 在 Trigger 中记录变更快照。
  ```sql
  -- 记录合作伙伴档案变更足迹
  INSERT INTO partner_audit_log (partner_id, changed_by, old_data, new_data)
  VALUES (NEW.id, :current_user, to_jsonb(OLD), to_jsonb(NEW));
  ```
- **资质校验**: 订单保存时拦截。
  ```sql
  -- 校验供应商资质是否覆盖订单日期
  SELECT 1 FROM partner_cert 
  WHERE partner_id = :vendor_id AND validity_range @> :order_date;
  ```

---

## 5. 开发者 Checklist

- [ ] **并发安全**: 信用额度预占是否使用了行级锁或原子 `UPDATE`？
- [ ] **一实体多角色**: 是否通过统一的 `partner_id` 关联了客户与供应商角色？
- [ ] **资质拦截**: 采购单/销售单的 `BeforeSave` 是否包含了资质有效期的强制校验？
- [ ] **地址规范**: 是否为每一个收货地址预留了经纬度字段，并考虑了 PostGIS 扩展？
- [ ] **黑名单控制**: 合作伙伴状态为 `Blacklisted` 时，是否在全局范围（采购/销售/物流）内被拦截？
- [ ] **结算协议**: 是否支持“分期付款”模板，并能自动生成 `Payment_Plan` 明细？
- [ ] **审计留痕**: 银行账号、纳税人识别号等关键敏感字段的修改是否记录了审计日志？
