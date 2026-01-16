import { defineConfig } from 'vitepress'

export default defineConfig({
  title: "自研 ERP 产品规格文档",
  description: "对标 U9 的自研 ERP 产品细节与业务逻辑指南",
  themeConfig: {
    nav: [
      { text: '首页', link: '/' },
      { text: '核心架构', link: '/guide/introduction' },
      { text: '功能模块', link: '/modules/cbo' }
    ],

    sidebar: [
      {
        text: '产品指南',
        items: [
          { text: '核心业务架构', link: '/guide/introduction' },
          { text: '产品概览', link: '/index' }
        ]
      },
      {
        text: '功能模块 (Modules)',
        items: [
          { text: 'CBO 基础设置', link: '/modules/cbo' },
          { text: 'FI 财务管理', link: '/modules/fi' },
          { text: 'SCM 供应链管理', link: '/modules/scm' },
          { text: 'MFG 生产制造', link: '/modules/mfg' },
          { text: 'COST 成本管理', link: '/modules/cost' },
          { text: 'PBM 项目制造', link: '/modules/pbm' }
        ]
      }
    ]
  }
})
