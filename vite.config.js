import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [
    vue(),
    tailwindcss(),
    {
      name: 'html-transform-rocket-loader',
      transformIndexHtml(html) {
        // 自动为所有 module script 添加 data-cfasync="false" 以防止 Cloudflare Rocket Loader 破坏加载
        return html.replace(/<script type="module"/g, '<script type="module" data-cfasync="false"');
      }
    }
  ],
  // 性能优化构建配置
  build: {
    // 启用CSS代码分割
    cssCodeSplit: true,
    // 优化依赖预构建
    commonjsOptions: {
      include: [/node_modules/]
    },
    rollupOptions: {
      output: {
        // 手动代码分割（保守策略，避免循环依赖导致空白页）
        manualChunks: {
          vue: ['vue'],
          router: ['vue-router'],
          pinia: ['pinia']
        },
        // 优化文件名
        chunkFileNames: 'assets/js/[name]-[hash].js',
        entryFileNames: 'assets/js/[name]-[hash].js',
        assetFileNames: (assetInfo) => {
          const info = assetInfo.name.split('.')
          const ext = info[info.length - 1]
          if (/\.(mp4|webm|ogg|mp3|wav|flac|aac)(\?.*)?$/i.test(assetInfo.name)) {
            return `assets/media/[name]-[hash][extname]`
          }
          if (/\.(png|jpe?g|gif|svg)(\?.*)?$/i.test(assetInfo.name)) {
            return `assets/img/[name]-[hash][extname]`
          }
          if (/\.(woff2?|eot|ttf|otf)(\?.*)?$/i.test(assetInfo.name)) {
            return `assets/fonts/[name]-[hash][extname]`
          }
          return `assets/${ext}/[name]-[hash][extname]`
        }
      }
    },
    // 压缩配置
    minify: 'terser',

    // terserOptions removed for debugging
  },
  // 开发服务器配置
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
      '/sub/': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
      // 订阅链接 /{token}/{profile} 反代到后端。
      //
      // 这条规则按“两段式路径”匹配，因此任何同形的**前端**路径都必须显式排除，
      // 否则会被转给后端、按未知 token 返回 404：
      //   dashboard/ —— /dashboard/settings 等前端路由。表现为点设置页没反应、
      //                 多点几次跳 404 页。
      //   shared/    —— /shared/dns-template-validation.js，被 DnsTemplateManager.vue
      //                 静态引入。它 404 会让整条 SettingsView → ServiceSettings →
      //                 TransformCard → DnsTemplateManager 的模块链断掉，
      //                 路由报 "Failed to fetch dynamically imported module"，
      //                 设置页渲染成空白 <main>。
      //
      // 仅影响 vite dev；生产由 Pages 直接托管这些静态资源并兜 SPA fallback。
      '^/(?!@|api/|sub/|assets/|@vite/|src/|icons/|images/|dashboard/|shared/)[^/]+/[^/]+$': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
      // Catch-all proxy removed to fix SPA fallback
    }
  },
  // 依赖优化
  optimizeDeps: {
    include: [
      'vue',
      'pinia'
    ]
  },
  // 路径解析
  resolve: {
    alias: {
      '@': '/src'
    }
  }
})
