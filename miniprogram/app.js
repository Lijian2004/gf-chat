/* AI 女友小程序 · 全局入口
   后端复用项目根目录的 Flask 服务（app.py），开发时在开发者工具里
   勾选「不校验合法域名」即可直连 http://127.0.0.1:5000 */
App({
  globalData: {
    // 开发者工具里连本机 Flask；上线时换成 https 备案域名
    baseUrl: "http://127.0.0.1:5000",
    model: "",
  },
});
