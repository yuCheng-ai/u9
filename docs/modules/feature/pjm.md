# 项目制造 (PJM) - 开发者详尽指南

## 概述
项目制造（Project Manufacturing）是 ERP 里的“特种作战”。开发者必须理解：在 PJM 模式下，**项目号 (Project_ID)** 是比料号更高的维度。每一颗螺丝钉、每一分钱的成本都必须打上项目的烙印，实现“专料专用、专款专用”。

---

## 1. 项目“四算”体系与预算控制 (Project Budgeting)

### 企业痛点
**“项目做完了，财务才发现超支了 20%，根本不知道钱花在哪了”**。

### 开发逻辑点
- **四算数据链**: 
    - 开发者需构建 `概算 (Estimation) -> 预算 (Budget) -> 核算 (Actual) -> 决算 (Closing)` 的闭环。
- **实时预警接口**: 
    - 开发者需在采购（PO）和领料（Issue）API 中接入 `PJM_Budget_Check`。
    - **逻辑**: `IF (Project_Actual + Current_Apply > Project_Budget) THEN SET Status = 'Warning/Block'`。
- **动态决算引擎**: 
    - 开发者需实现“完工百分比 (POC)”算法。
    - **公式**: `POC = 实际发生额 / 预计总成本`。根据 POC 自动触发收入确认凭证。

---

## 2. 硬关联与软关联逻辑 (Hard/Soft Pegging)

### 企业痛点
“项目 A 的货到了，结果被项目 B 的领料员顺手领走了，导致项目 A 停工待料”。

### 开发逻辑点
- **硬关联 (Hard Pegging)**: 
    - 开发者需在库存表（Stock）中强制增加 `Project_ID` 索引字段。
    - **逻辑拦截**: `WIP_Issue_API` 必须校验 `Demand.Project_ID == Stock.Project_ID`。如果不匹配，严禁出库。
- **虚拟项目池 (Project Pool)**: 
    - 对于通用件，开发者可设计“虚拟项目 000”。
    - **逻辑**: 当特定项目缺货时，允许自动从“000 池”进行 `Stock_Reassignment`（库存重分配）。

---

## 3. 项目借调与成本补偿 (Project Borrowing)

### 企业痛点
**“项目 A 借了项目 B 的料，财务账怎么平？以后怎么还？”**。

### 开发逻辑点
- **借调事务处理器 (Borrow/Loan Handler)**: 
    - 开发者需设计 `Project_Transfer_Doc`。
    - **财务逻辑**: 
        - 借出方：`DR 待补偿项目款 (Org_A) CR 库存 (Project_B)`。
        - 借入方：`DR 库存 (Project_A) CR 待支付项目款 (Org_B)`。
- **归还提醒 Job**: 
    - 开发者需写一个 Job，当项目 A 的补货采购单到货时，自动弹出“归还项目 B”的提醒。

---

## 4. WBS 任务分解与排程 (WBS Integration)

### 企业痛点
“项目计划在 Excel 里，生产计划在 ERP 里，两边根本对不上”。

### 开发逻辑点
- **WBS 与 MO 联动**: 
    - 开发者需实现 WBS 节点与生产订单 (MO) 的 `1:N` 关联。
    - **逻辑**: WBS 节点的 `Start_Date` 自动约束 MO 的 `Earliest_Start_Date`。
- **进度自动反馈**: 
    - 开发者需确保 MO 完工入库后，自动更新 WBS 任务的 `Progress_Percentage`。

---

## 5. 开发者 Checklist

- [ ] **多项目成本卷归**: 一个 MO 同时为三个项目产出时，开发者是否实现了按 `BOM 比例` 或 `手动比例` 的成本拆分逻辑？
- [ ] **项目属性透传**: 从 `销售订单 -> LRP 计划 -> 采购/生产 -> 入库 -> 出货`，开发者必须确保 `Project_ID` 在全链路单据中完整透传。
- [ ] **项目专用库位**: 是否在仓库建模中支持了“项目库位”的自动过滤？
- [ ] **报表维度**: 项目损益表是否能实时穿透到每一笔 `Project_Task` 级别的支出？
