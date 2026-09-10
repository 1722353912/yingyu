/**
 * ============================================================
 *  应用插件下载站 · 启动入口
 * ============================================================
 *  职责：
 *   1. 展示 1 秒炫酷加载动画后淡出
 *   2. 初始化主题（记住用户上次选择）
 *   3. 绑定顶部搜索框
 *   4. 首次渲染页面
 * ============================================================
 */

document.addEventListener('DOMContentLoaded', () => {
  /* ---------- 1. 加载动画：1 秒后淡出移除 ---------- */
  setTimeout(() => {
    const loading = document.getElementById('loading');
    if (loading) {
      loading.classList.add('hide'); // 触发 CSS 淡出
      setTimeout(() => loading.remove(), 650); // 淡出动画结束后移除节点
    }
  }, 1000); // 只展示 1 秒

  /* ---------- 2. 主题初始化与切换 ---------- */
  initTheme();

  function initTheme() {
    const saved = localStorage.getItem('theme') || 'purple';
    document.body.dataset.theme = saved;
    syncThemeDots();
  }

  function syncThemeDots() {
    const current = document.body.dataset.theme;
    document.querySelectorAll('.theme-dot').forEach((dot) => {
      dot.classList.toggle('active', dot.dataset.theme === current);
    });
  }

  // 点击色块切换主题（记住选择，下次进入生效）
  document.getElementById('theme-switch').addEventListener('click', (e) => {
    const dot = e.target.closest('.theme-dot');
    if (!dot) return;
    document.body.dataset.theme = dot.dataset.theme;
    localStorage.setItem('theme', dot.dataset.theme);
    syncThemeDots();
  });

  /* ---------- 3. 顶部搜索框 ---------- */
  document.getElementById('search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = document.getElementById('search-input').value.trim();
    if (!q) {
      toast('请输入搜索关键词');
      return;
    }
    location.hash = '#/search?q=' + encodeURIComponent(q);
  });

  /* ---------- 4. 首次渲染 ---------- */
  render();
});
