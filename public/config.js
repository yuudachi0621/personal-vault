/**
 * ============================================================================
 *  public/config.js —— 前端部署配置
 * ============================================================================
 *
 *  这个文件在 app.js 之前加载，作用是告诉前端「后端在哪」。
 *  为什么单独放一个文件？因为部署环境不同，这个值就不同，
 *  单独拎出来就不用在业务代码里到处改地址了。
 *
 *  【一体部署（默认）】保持 apiBase 为空字符串。
 *    前端与后端由同一个程序提供，请求走相对路径，天然同源。
 *    浏览器把 '/api/files' 理解成「当前网站下的 /api/files」。
 *
 *  【分离部署】把 apiBase 填成后端的完整地址：
 *    window.VAULT_CONFIG = { apiBase: 'https://api.example.com' }
 *    此时 '/api/files' 会被拼成 'https://api.example.com/api/files'。
 *    后端需要同时设置 ALLOWED_ORIGINS 为本页面的来源，并部署在 HTTPS 下
 *    —— 跨站的会话 Cookie 要求 SameSite=None 与 Secure 同时成立。
 *
 *  不要把配置写成 index.html 里的内联 <script>。
 *  服务端 HTML CSP 只允许 script-src 'self'，内联脚本会被浏览器拒绝；
 *  部署时应修改本文件，或由静态托管环境单独生成/替换 config.js。
 */
window.VAULT_CONFIG = {
  apiBase: '',
}
