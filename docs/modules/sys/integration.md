# 系统集成方案 (Integration) - 开发者详尽指南

## 概述
集成（Integration）是 ERP 系统的“血管”。开发者必须理解：集成不是简单的 API 对接，而是**业务状态的同步、数据一致性的维护以及错误补偿机制**。在一个典型的制造企业中，ERP 处于核心地位，上连 PLM（设计），下接 MES（执行）。

---

## 1. PLM 设计集成：研发到制造的桥梁 (PLM to ERP)

### 企业痛点
**“研发改了 BOM，生产还在按旧图纸做，最后成品全报废”**。

### 开发逻辑点
- **BOM 自动导入引擎**: 
    - 开发者需实现一个 `BOM_Parser`，支持 PLM 推送的 XML/JSON 格式数据。
    - **逻辑**: 
        - 1. 校验料品主档是否存在（不存在则自动创建 `Draft` 状态料品）。
        - 2. 建立 BOM 层次结构。
        - 3. 触发“成本重算”信号。
- **变更同步 (ECN Sync)**: 
    - 开发者需确保 PLM 的变更单（ECN）核准后，自动在 ERP 生成 `Engineering_Change_Order`，并触发 WIP（在制品）影响分析。

### PostgreSQL 实现建议
- **JSONB 解析与验证**: 利用 PG 的 `jsonb_to_recordset` 函数高效解析 PLM 推送的批量 BOM 数据，并结合 `CHECK` 约束和 `JSON Schema` 验证，确保数据的严谨性。
- **递归 CTE 结构校验**: 在导入新 BOM 前，利用递归 CTE 检查是否存在循环嵌套，防止逻辑死循环。
- **物化视图预存影响分析**: 针对 ECN 变更，使用物化视图缓存 WIP 影响分析结果，减少实时计算对主流程的阻塞。

---

## 2. MES/IoT 现场集成：执行数据的实时反馈 (ERP to MES)

### 企业痛点
“仓库发了多少料、车间做了多少货，全靠月底人工补单，账面库存永远不准”。

### 开发逻辑点
- **下发指令接口**: 
    - 开发者需将 ERP 的生产订单（MO）实时下推到 MES。
    - **逻辑**: `On_MO_Release -> Push_to_MES_Queue`。
- **实时报工与倒冲 (Backflush)**: 
    - 开发者需提供 `Production_Report_API` 给 MES。
    - **逻辑**: MES 扫码报工 -> ERP 自动扣减线边库库存（倒冲） -> 自动增加成品库存。
- **IoT 边缘接入**: 
    - 对于自动化设备，开发者可设计 `Sensor_Data_Gateway`，将设备的“心跳”和“产出计数”直接转化为 ERP 的 `Equipment_OEE` 统计数据。

### PostgreSQL 实现建议
- **LISTEN/NOTIFY 即时下发**: MO 审核后，通过 `NOTIFY mes_sync_channel, 'MO_ID_XYZ'` 立即唤醒集成 Worker，实现秒级的订单下发。
- **行级锁与库存原子更新**: 在处理 MES 报工倒冲时，使用 `UPDATE ... RETURNING` 结合 `FOR UPDATE`，确保库存扣减的原子性与高并发下的准确性。
- **时序数据存储 (TimescaleDB 扩展)**: 对于 IoT 设备产生的大量传感器数据，可以集成 `TimescaleDB` 插件，利用其自动分区和高效压缩特性，实现对设备状态的长周期监控。

---

## 3. 分布式事务、最终一致性与可视化监控 (Consistency & Monitor)

### 企业痛点
- **数据失步**: “MES 报工成功，但 ERP 单据未生成”。
- **不可见性**: 开发者不知道哪些集成任务失败了，只能查日志，效率极低。

### 开发逻辑点
- **本地事务表模式 (Transactional Outbox)**: 
    - 开发者在 ERP 执行业务逻辑时，同步在 `Integration_Task` 表插入一条记录。
- **可视化重试机制 (Manual Retry)**: 
    - 开发者需提供 `Integration_Monitor` 界面。
    - **功能**: 展示任务状态（成功/失败/重试中）、错误堆栈、原始报文。
    - **操作**: 支持“手动重试”或“一键冲销（Compensate）”。
- **补偿事务 (Saga Pattern)**: 如果重试多次失败，执行反向冲销逻辑。

### PostgreSQL 实现建议
- **SKIP LOCKED 任务抓取**: 
  ```sql
  WITH task AS (
    SELECT id FROM integration_task 
    WHERE status = 'Pending' AND next_retry_at < now()
    FOR UPDATE SKIP LOCKED 
    LIMIT 10
  )
  UPDATE integration_task SET status = 'Processing' FROM task WHERE integration_task.id = task.id;
  ```
- **JSONB 记录任务全貌**: 存储 `Request_Payload`、`Response_Payload` 和 `Error_Trace`。
- **示例代码**:
  ```sql
  -- 手动重试：将状态重置为 Pending 并更新重试时间
  UPDATE integration_task 
  SET status = 'Pending', retry_count = retry_count + 1, next_retry_at = now()
  WHERE id = :task_id;
  ```

---

## 4. 开发者 Checklist

- [ ] **接口协议**: 建议统一使用 RESTful + JSON，严禁使用过时的 SOAP/XML（除非对方系统强制要求）。
- [ ] **版本控制**: 接口 URL 必须携带版本号（如 `/api/v1/mo/create`），防止升级破坏旧系统。
- [ ] **限流保护**: 面对 MES 高频的报工请求，开发者需实现 `Buffer_Queue` 进行削峰填谷。
- [ ] **数据清洗**: 集成接口必须对传入的 `Item_Code`、`Wh_Code` 进行合法性强校验。
- [ ] **可视化监控**: 开发者需提供一个 `Integration_Monitor` 界面，让运维人员能一眼看到哪些集成任务失败了。
