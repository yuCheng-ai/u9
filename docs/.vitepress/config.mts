import { defineConfig } from 'vitepress'

export default defineConfig({
  base: '/u9/',
  title: "自研 ERP 产品规格文档",
  description: "对标 U9 的自研 ERP 产品细节与业务逻辑指南",
  cleanUrls: true,
  themeConfig: {
    nav: [
      { text: '首页', link: '/' },
      { text: '核心架构', link: '/guide/introduction' },
      { text: '功能模块', link: '/modules/cbo/org-modeling' }
    ],

    sidebar: [
      {
        text: '产品入门',
        items: [
          { text: '产品概览', link: '/' },
          { text: '核心理念 (多组织/多核算)', link: '/guide/introduction' }
        ]
      },
      {
        text: 'CBO 公共基础 (Base)',
        items: [
          { text: '企业建模 (组织/职能/业务关系)', link: '/modules/cbo/org-modeling' },
          { text: '料品全生命周期管理', link: '/modules/cbo/item-master' },
          { text: '客供档案与信用控制', link: '/modules/cbo/partner' },
          { text: '公共基础 (币种/汇率/日历/税制)', link: '/modules/cbo/common-base' },
          { text: '业务流与工作流引擎', link: '/modules/cbo/workflow' }
        ]
      },
      {
        text: '供应链管理 (SCM)',
        items: [
          {
            text: '销售管理 (Sales)',
            items: [
              { text: '销售价格体系 (价表/折扣/取价)', link: '/modules/scm/sales-price' },
              { text: '销售订单执行 (RMA/出货申请)', link: '/modules/scm/sales-process' },
              { text: '可用量检查 (ATP/预留)', link: '/modules/scm/sales-atp' }
            ]
          },
          {
            text: '采购管理 (Purchase)',
            items: [
              { text: '货源管理 (配额/货源清单)', link: '/modules/scm/pur-source' },
              { text: '采购询比价与合同', link: '/modules/scm/pur-price' },
              { text: '采购执行 (申请/订单/收货/入库)', link: '/modules/scm/pur-process' },
              { text: 'VMI 业务管理', link: '/modules/scm/pur-vmi' }
            ]
          },
          {
            text: '库存管理 (Inventory)',
            items: [
              { text: '动态预留与可用量 (PAB)', link: '/modules/scm/inv-atp' },
              { text: '调拨与形态转换', link: '/modules/scm/inv-ops' },
              { text: '库存盘点与差异处理', link: '/modules/scm/inv-count' },
              { text: 'VMI 库存与第三方代管', link: '/modules/scm/inv-vmi' }
            ]
          }
        ]
      },
      {
        text: '生产制造 (Manufacturing)',
        items: [
          {
            text: '工程数据 (Engineering)',
            items: [
              { text: 'BOM 维护与多版本控制', link: '/modules/mfg/bom-manage' },
              { text: '工艺路线与资源 (Routing)', link: '/modules/mfg/routing' },
              { text: 'ECN 工程变更申请/执行', link: '/modules/mfg/ecn' }
            ]
          },
          {
            text: '计划管理 (Planning)',
            items: [
              { text: 'MRP/MPS 运算与平衡', link: '/modules/mfg/mrp' },
              { text: 'LRP 批次需求计划 (核心)', link: '/modules/mfg/lrp' },
              { text: '生产预测与冲销', link: '/modules/mfg/forecast' }
            ]
          },
          {
            text: '生产执行 (Execution)',
            items: [
              { text: '生产订单 (标准/返工/改制)', link: '/modules/mfg/mo-types' },
              { text: '齐套分析与生产备料', link: '/modules/mfg/mo-prepare' },
              { text: '工序汇报与移动点管理', link: '/modules/mfg/mo-report' },
              { text: '完工入库与质量检验', link: '/modules/mfg/mo-complete' }
            ]
          }
        ]
      },
      {
        text: '财务会计与管理会计',
        items: [
          {
            text: '财务会计',
            items: [
              { text: '多账簿核算体系', link: '/modules/fi/multi-book' },
              { text: '总账/应收/应付/固定资产', link: '/modules/fi/gl-ar-ap' },
              { text: '智能凭证与报表', link: '/modules/fi/reporting' }
            ]
          },
          {
            text: '成本管理 (Costing)',
            items: [
              { text: '实际成本核算 (生产/外协)', link: '/modules/fi/cost-actual' },
              { text: '标准成本与差异分析', link: '/modules/fi/cost-std' },
              { text: '阿米巴经营会计', link: '/modules/fi/amoeba' }
            ]
          }
        ]
      },
      {
        text: '多组织协同与项目制造',
        items: [
          { text: '组织间协同 (抛单/结算/直运)', link: '/modules/feature/collab' },
          { text: '项目制造 (PJM 四算)', link: '/modules/feature/pjm' },
          { text: '集团管控与合并报表', link: '/modules/feature/group-control' }
        ]
      },
      {
        text: '系统支撑与数智集成',
        items: [
          { text: 'UAP 业务开发平台', link: '/modules/sys/uap' },
          { text: 'PLM/MES/IoT 集成方案', link: '/modules/sys/integration' },
          { text: '云服务集成 (税务/友云采)', link: '/modules/sys/cloud' }
        ]
      }
    ]
  }
})
