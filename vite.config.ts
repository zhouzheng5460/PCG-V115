import { defineConfig } from 'vite';

export default defineConfig({
  /**
   * poly2tri 是 UMD 包，源码里直接引用 Node 的 `global`。
   * 浏览器没有这个全局，一 import 就抛 "global is not defined"，
   * 整个 app 连带挂掉（3D 一片全黑）。这里给个别名。
   */
  define: {
    global: 'globalThis',
  },
  // 只扫 index.html。
  //
  // 之前没配这个，vite 会把项目里**所有** .html 当入口去扫依赖 ——
  // 而 tmp/ 下面堆着早期 CDP 调试留下的浏览器用户目录（Edge Shopping /
  // Edge Wallet / 扩展页面……），里面有大量 vite 解析不了的动态 import，
  // 于是依赖扫描直接失败，dev server 起不来（报的是 "Could not resolve
  // import("./json/i18n-ec/**/*/strings.json)"，跟本项目毫无关系）。
  optimizeDeps: {
    entries: ['index.html'],
  },
  build: {
    // tmp/ 与 out/ 是脚本产物与截图，不参与打包
    rollupOptions: {
      input: 'index.html',
    },
  },
});
