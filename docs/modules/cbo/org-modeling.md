# 企业建模 (Organization Modeling) - 开发者详尽指南

## 概述
企业建模（Org Modeling）是 ERP 的“灵魂”。在多组织架构下，组织不仅仅是一个 `ID`，它是一组**职能开关**。开发者必须理解如何处理组织职能的解耦、数据的强隔离以及组织间的业务协同，以确保系统能够支撑复杂的集团化运作。

---

## 1. 职能建模：组织的“基因”定义

### 业务场景
在集团企业中，一个组织（地点）可能同时承担多种角色：它既是生产货物的“工厂”，又是存放货物的“仓库”，还可能是对外开票的“会计主体”。

### 开发规范
- **职能解耦**: 严禁在代码中硬编码“如果是 A 组织就执行销售逻辑”。应判断“当前组织是否具备销售职能”。
- **动态控制**: UI 菜单和业务按钮必须基于 `Org.Functions` 动态渲染。
- **技术实现建议**: 
    - 推荐使用**枚举数组 (Enum Array)** 存储职能。这种方式比增加几十个布尔字段更易于扩展。
    - 在数据库层面，可以使用 `GIN 索引` 确保在成千上万个组织中秒级筛选出具备特定职能（如 `Mfg`）的实体。
    - **示例代码**:
      ```sql
      -- 使用枚举数组定义职能
      CREATE TYPE org_func AS ENUM ('Sales', 'Mfg', 'Inv', 'Fi');
      ALTER TABLE org_master ADD COLUMN functions org_func[];
      -- 创建 GIN 索引优化职能检索
      CREATE INDEX idx_org_functions ON org_master USING GIN (functions);
      -- 查询具备生产职能的组织
      SELECT * FROM org_master WHERE functions @> ARRAY['Mfg'::org_func];
      ```

---

## 2. 数据隔离与 RBAC 权限继承 (Isolation & RBAC)

### 业务场景
- **行级隔离**: 分公司 A 的业务员绝对不能查看到分公司 B 的库存或单据。
- **权限继承**: 集团管理员在“集团”维度分配的权限，应能自动下发到所有子公司；但子公司管理员只能管理本公司的权限。

### 开发规范
- **权限向下继承**: 
    - 权限分配表 `sys_permission` 需包含 `org_id` 和 `is_inherit` 标志。
    - 当 `is_inherit = true` 时，该权限对当前组织及其所有下级子组织生效。
- **上下文透明**: 每一个 API 请求都必须携带 `OrgID`。开发者应通过 `Context` 对象获取当前操作组织。

### 技术实现建议
- **递归权限判定**: 利用 PostgreSQL 的 **Recursive CTE** 向上查找当前用户在当前组织及其父级组织（带继承标志）的所有权限并取并集。
- **行级安全 (RLS)**: 
    - 开发者只需在会话开始时设置 `SET LOCAL app.current_org_id = '...'`。
    - **示例代码**:
      ```sql
      -- 递归查询权限（考虑继承）
      WITH RECURSIVE org_tree AS (
          SELECT id, parent_id FROM org_master WHERE id = :current_org
          UNION ALL
          SELECT o.id, o.parent_id FROM org_master o JOIN org_tree ot ON o.id = ot.parent_id
      )
      SELECT p.* FROM sys_permission p
      JOIN org_tree ot ON p.org_id = ot.id
      WHERE p.user_id = :user_id AND (p.org_id = :current_org OR p.is_inherit = true);
      ```

---

## 3. 组织协同：内部交易与“抛单”

### 业务场景
**“左手卖给右手”**。总公司卖给分公司，分公司录入《内部采购单》后，系统应自动在总公司生成《销售订单》，并保持两者价格和状态的同步。

### 开发规范
- **协议驱动**: 组织间的交易规则（如内部协议价、自动审核逻辑）应参数化配置。
- **异步链路**: 协同单据的生成应避免阻塞主业务流程。
- **技术实现建议**: 
    - 使用 `JSONB` 字段存储灵活的协同协议参数。
    - 利用数据库的**逻辑日志 (Logical Decoding)** 或事件总线监听单据状态，实现跨组织的异步单据抛转。
    - **示例代码**:
      ```sql
      -- 使用 JSONB 存储组织协同协议
      SELECT * FROM org_inter_rules 
      WHERE source_org = :src AND target_org = :dest
        AND config @> '{"auto_approve": true}';
      ```

---

## 4. 严谨性校验：有效期与业务冲突

### 业务场景
一个物料在同一个组织下，不能在同一时间段内有两个不同的“默认供应商”或“核算价格”。

### 开发规范
- **时段闭环**: 所有的分配关系（如物料分配给组织）必须包含有效期（开始日期/结束日期）。
- **重叠校验**: 在保存时，必须校验新时段与已有时段是否冲突。
- **技术实现建议**: 
    - 使用 **Range Types (范围类型)** 存储有效期。
    - 在表结构上应用 **排除约束 (Exclusion Constraints)**。这能确保数据库在物理层面拦截任何时间重叠的错误数据，比在 Java/C# 代码中写循环校验更安全高效。
    - **示例代码**:
      ```sql
      -- 使用范围类型和排除约束防止时间重叠
      ALTER TABLE item_org_price ADD COLUMN validity tstzrange;
      ALTER TABLE item_org_price ADD CONSTRAINT price_time_no_overlap 
      EXCLUDE USING gist (item_id WITH =, org_id WITH =, validity WITH &&);
      ```

---

## 5. 开发者 Checklist

- [ ] **职能判断**: 业务逻辑是否基于 `Org.Functions` 数组判断，而非硬编码 ID？
- [ ] **隔离透传**: 是否在数据库连接初始化时正确设置了组织上下文（如 RLS 上下文）？
- [ ] **性能优化**: 涉及组织职能或 JSON 协议的查询，是否创建了对应的 GIN 索引？
- [ ] **冲突拦截**: 涉及有效期的配置表，是否在 DB 层配置了防止时段重叠的约束？
- [ ] **数据合规**: 所有的更新和删除操作，是否确保无法越权修改非当前组织的数据？
