# 客供档案与信用控制 (Partner & Credit) - 开发者详尽指南

## 概述
合作伙伴（Partner）是企业价值链的延伸。在开发逻辑中，合作伙伴不仅是“通讯录”，更是**风控引擎**的核心输入。开发者必须处理好“一实体多角色”的业务模型，并利用数据库的**并发控制**和**地理空间特性**，确保信用拦截的严密性与物流计算的准确性。

---

## 1. 角色化模型：一实体多角色 (Entity-Role Model)

### 业务场景
大型集团通常具有双重身份：既是买你产品的“客户”，又是卖你原材料的“供应商”。系统必须支持**全口径对账**（即：往来款项抵消）。

### 技术实现建议
    - 使用 **JSONB** 存储不同角色下的差异化属性（如客户的偏好物流、供应商的免检协议）。
    - 建立统一的 `Partner_Balance` 视图，利用数据库的 `UNION ALL` 实时汇总同一实体在不同角色下的应收/应付账款。
    - **示例代码**:
      ```sql
      -- 使用 JSONB 存储角色差异化属性
      UPDATE partner_role SET ext_props = ext_props || '{"logistics_pref": "SF Express"}'::jsonb 
      WHERE partner_id = :id AND role_type = 'Customer';
      ```

---

## 2. 严密的信用控制逻辑 (Credit Control)

### 业务场景
信用控制是 ERP 的安全红线。必须确保在高并发下单（如双十一或大客户抢货）时，信用额度不会被“超卖”。

### 开发规范
- **实时预占**: 在销售订单审核时，必须实时计算并预占信用额度。
- **拦截时机**: `保存`时警告，`提交/审核`时强拦截。
- **技术实现建议**: 
    - **行级锁保证**: 计算信用额度前，必须使用 `SELECT ... FOR UPDATE` 锁定合作伙伴余额记录，确保并发下的原子性。
    - **性能优化**: 避免在下单时扫描海量历史单据。推荐维护一张 `Credit_Summary` 增量统计表，利用数据库 **Trigger (触发器)** 在单据过账时自动更新余额。
    - **示例代码**:
      ```sql
      -- 原子性扣减信用额度
      UPDATE partner_credit 
      SET used_amount = used_amount + :order_amount 
      WHERE partner_id = :id AND (credit_limit - used_amount) >= :order_amount
      RETURNING used_amount;
      ```

---

## 3. 结算协议与支付计划 (Payment Terms)

### 业务场景
结算规则往往涉及多个时间节点：如“30% 订金，60% 发货款，10% 质保金”。

### 开发规范
- **分期计算**: 系统必须根据协议模板自动生成单据的应付/应收计划表。
- **逾期预警**: 自动计算 `DueDate`（到期日），并根据当前日期标识 `OverdueStatus`。
- **技术实现建议**: 
    - 使用 `JSONB` 存储复杂的支付计划模板，支持动态调整比例或金额。
    - 利用 PostgreSQL 的 **Generated Columns** 自动计算逾期天数，减少应用层计算压力。
    - **示例代码**:
      ```sql
      -- 使用生成的列计算逾期天数
      ALTER TABLE fi_payment_plan ADD COLUMN overdue_days int 
      GENERATED ALWAYS AS (GREATEST(0, CURRENT_DATE - due_date)) STORED;
      ```

---

## 4. 准入合规与位置服务 (Compliance & Location)

### 业务场景
供应商资质（如医疗器械许可证）过期后必须自动禁采。同时，为了物流成本优化，需要精准的经纬度数据。

### 开发规范
- **合规强校验**: 在所有采购 API 入口，强制校验供应商状态及证书有效期。
- **位置感知**: 存储合作伙伴的多个收货地址，并标注默认地址。
- **技术实现建议**: 
    - **范围校验**: 使用 `daterange` 存储资质有效期，利用 `&&` 操作符快速判定当前业务日期是否在合规范围内。
    - **地理空间**: 使用 PostgreSQL 的 `point` 类型或 **PostGIS** 扩展存储经纬度，利用 `st_distance` 函数计算最优配送路径或运费。
    - **示例代码**:
      ```sql
      -- 检查资质是否在有效期内
      SELECT * FROM partner_cert 
      WHERE partner_id = :id AND validity_period @> CURRENT_DATE;
      ```

---

## 5. 开发者 Checklist

- [ ] **并发安全**: 信用额度扣减是否使用了 `FOR UPDATE` 或乐观锁校验？
- [ ] **合规拦截**: 采购/销售 API 是否在后端强校验了合作伙伴的有效性（`daterange` 判定）？
- [ ] **扩展属性**: 合作伙伴的特殊协议是否使用了 `JSONB` 存储并配置了相应的 GIN 索引？
- [ ] **数据脱敏**: 手机号、银行卡号等敏感信息是否在数据库层或 API 返回时进行了脱敏处理？
- [ ] **位置数据**: 地址表是否支持坐标存储，并考虑了后续的物流距离计算逻辑？
