/**
 * 客户端 bundle 的源码模板。
 *
 * DSH 的 web 客户端 bundle 不是 ES module：它由 `window.__ModuleLoader__.load`
 * 注册，factory 在浏览器里被当成普通脚本执行，所以这里不能出现 `import` / `export`。
 * `tools/build.mjs` 把 src/codec.js 与 src/bridge.js 去掉模块语法后内联到这个位置。
 */

window.__ModuleLoader__.load({
  id: 'dsh-image-import',
  factory() {
    /* @@INLINE:src/codec.js@@ */

    /* @@INLINE:src/bridge.js@@ */

    /**
     * 占位组件：真正的按钮是 DOM 注入的，这个座位只负责让插件在 Slot 树里可见、
     * 并在会话切换时跟着重新挂载。
     * @returns {null} 不渲染任何东西。
     */
    function ImageImportAnchor() {
      return null
    }

    return {
      /**
       * 插件入口：挂上 DOM 桥，卸载时把它连监听器一起摘掉。
       * @param {object} ctx - Cordis 上下文。
       */
      apply(ctx) {
        if (ctx && typeof ctx.slots === 'object' && ctx.slots !== null && typeof ctx.slots.inject === 'function') {
          try {
            ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
              name: 'conversation.input.left',
              id: 'image-import',
              order: 900,
            }, ImageImportAnchor))
          } catch (error) {
            // 座位形状若变了，按钮仍然可用，不该因此让整块插件加载失败。
            console.debug('[dsh-image-import] slot registration skipped', error)
          }
        }

        if (ctx && typeof ctx.effect === 'function') {
          ctx.effect(() => {
            const dispose = installImageBridge()
            return () => dispose()
          }, 'image-import')
          return
        }
        installImageBridge()
      },
    }
  },
})
