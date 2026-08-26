/* ============================================================
 * agent-message.js
 * Agent 流式消息渲染组件（配合 mock-agent-loop.js 使用）
 *
 * 实现需求文档核心规格：
 *  - 消息模型：text / thinking / toolCall / toolResult / agentSummary
 *  - 思考区：流式逐字、运行中锁定不可折叠、完成后显示「已思考 X.X 秒」
 *  - 工具卡片：状态（running / done / failed / warn，超时并入 failed）、
 *    参数与结果默认摘要展示、完成顺序重排、失败卡片保持展开
 *  - 最终回答：Markdown 实时渲染、流式光标、代码块复制
 *  - agentSummary：触发中间过程自动折叠，点击可重新展开
 *  - 停止生成、重新生成、工具重试、自动滚动跟随 + 跳转至最新
 * ============================================================ */

(function (global) {
  'use strict';

  /* ================= 基础工具 ================= */

  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // 参数/结果截断显示：≤10 行自适应，>10 行展示前 9 行 + 左对齐省略行 + 右侧复制按钮
  function fillClippedSection(container, copyBtn, fullText, copyText) {
    var text = String(fullText == null ? '' : fullText);
    var lines = text.split('\n');
    if (lines.length <= 10) {
      container.textContent = text;
    } else {
      var omitted = lines.length - 9;
      container.innerHTML = esc(lines.slice(0, 9).join('\n')) +
        '<div class="clip-more">… +' + omitted + ' more lines</div>';
    }
    if (copyBtn) {
      copyBtn.style.display = '';
      copyBtn._copyText = (copyText == null) ? text : copyText;
    }
  }

  // 参数名 → 中文标签（多字段参数渲染为「标签：值」，未知参数回退原 key）
  var PARAM_LABELS = {
    command: '命令', path: '路径', content: '内容', append: '追加',
    oldText: '查找内容', newText: '替换为', replaceAll: '全部替换',
    old_string: '查找内容', new_string: '替换为',
    pattern: '匹配模式', glob: '文件过滤', recursive: '递归',
    from: '源路径', to: '目标路径', dir: '目录', query: '查询',
    name: '名称', version: '版本', framework: '框架', language: '语言', lang: '语言',
    owner: '所有者', repo: '仓库', issue_number: '议题号', visibility: '可见性',
    uri: '地址', per_page: '每页数量', arguments: '参数', style: '风格'
  };

  // 复制用「原始参数」：未优化前的实际参数（保持原始 JSON / 原始字符串）
  function rawArgs(args) {
    if (args == null) return '';
    if (typeof args === 'string') return args;
    return JSON.stringify(args, null, 2);
  }

  // 参数格式化：单字段工具（如 bash 的 { command } / read 的 { path }）直接展示值本身；多字段渲染为「标签：值」
  function formatArgs(args, cfg) {
    if (args == null) return '';
    if (typeof args === 'string') return args;
    var keys = Object.keys(args);
    if (keys.length === 1 && typeof args[keys[0]] === 'string') {
      return args[keys[0]];
    }
    var labels = cfg.paramLabels;
    return keys.map(function (k) {
      var label = labels[k] || k;
      var v = args[k];
      var shown = (v == null) ? '' : (typeof v === 'string') ? v : JSON.stringify(v);
      return label + '：' + shown;
    }).join('\n');
  }

  // 结果流式打字：固定每秒 500 字匀速输出
  var RESULT_TICK_MS = 20;
  var RESULT_CHARS_PER_SEC = 500;

  function typewriter(text, onChunk, onComplete) {
    var total = text.length;
    if (total === 0) {
      if (onComplete) onComplete();
      return;
    }
    var batch = Math.max(1, Math.round(RESULT_CHARS_PER_SEC * RESULT_TICK_MS / 1000));
    var i = 0;
    function step() {
      if (i >= total) {
        if (onComplete) onComplete();
        return;
      }
      i = Math.min(total, i + batch);
      onChunk(text.slice(0, i));
      setTimeout(step, RESULT_TICK_MS);
    }
    step();
  }

  // 结果流式展示：截断到 ≤10 行后逐字打字（成功/错误/警告通用），固定每秒 500 字
  function fillClippedSectionStreaming(container, copyBtn, fullText, onComplete) {
    var text = String(fullText == null ? '' : fullText);
    var lines = text.split('\n');
    var clipped = lines.length > 10;
    var omitted = clipped ? lines.length - 9 : 0;

    if (copyBtn) {
      copyBtn.style.display = '';
      copyBtn._copyText = text;
    }

    if (!clipped) {
      typewriter(text, function (partial) {
        container.textContent = partial;
      }, onComplete);
      return;
    }

    var nine = lines.slice(0, 9).join('\n');
    var ellipsisText = '… +' + omitted + ' more lines';
    typewriter(nine, function (partial) {
      container.textContent = partial;
    }, function () {
      var ellipsisEl = document.createElement('div');
      ellipsisEl.className = 'clip-more';
      container.appendChild(ellipsisEl);
      typewriter(ellipsisText, function (partial) {
        ellipsisEl.textContent = partial;
      }, onComplete);
    });
  }

  // 工具名标签（有背景色的小徽标）
  function toolNameTag(name) {
    return '<span class="tool-name-tag">' + esc(name) + '</span>';
  }

  // 图片块 → <img> 标签（ImageContent：{ data: base64, mimeType }）
  function imageTag(image) {
    return '<img class="msg-image" src="data:' + image.mimeType + ';base64,' + image.data + '" alt="图片">';
  }

  function imagesHtml(images) {
    if (!images || !images.length) return '';
    var html = '<div class="msg-images">';
    images.forEach(function (img) { html += imageTag(img); });
    html += '</div>';
    return html;
  }

  // 文件下载：优先 showSaveFilePicker（弹出选择保存地址），否则回退 <a download>
  function downloadFile(name, content) {
    var blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    if (global.showSaveFilePicker) {
      global.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: 'Text', accept: { 'text/plain': ['.md', '.txt', '.json', '.ts', '.js', '.html', '.py'] } }]
      }).then(function (handle) {
        return handle.createWritable().then(function (w) {
          return w.write(blob).then(function () { return w.close(); });
        });
      }).catch(function () {});
    } else {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }
  }

  function fmtDuration(ms) {
    var s = ms / 1000;
    if (s < 60) return (Math.round(s * 10) / 10) + 's';
    var m = Math.floor(s / 60);
    var rs = Math.round(s % 60);
    return m + 'm' + rs + 's';
  }

  function copyText(text, cb) {
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
      document.body.removeChild(ta);
      cb(ok);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { cb(true); }, fallback);
    } else {
      fallback();
    }
  }

  /* ================= SVG 图标库（全站不使用 emoji） ================= */

  var SVG_ATTRS = 'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';

  var ICONS = {
    // 思考：中心节点 + 放射线（思考中时旋转）
    think: '<svg ' + SVG_ATTRS + '><circle cx="12" cy="12" r="3.4"/><path d="M12 2.8v2.6M12 18.6v2.6M2.8 12h2.6M18.6 12h2.6M5.5 5.5l1.9 1.9M16.6 16.6l1.9 1.9M18.5 5.5l-1.9 1.9M7.4 16.6l-1.9 1.9"/></svg>',
    // 思考完成：球
    ball: '<svg ' + SVG_ATTRS + '><circle cx="12" cy="12" r="7.5"/><path d="M8.2 8.4a5 5 0 0 1 4.4-3.4"/></svg>',
    // 完成态：实心圆点
    circle: '<svg ' + SVG_ATTRS + '><circle cx="12" cy="12" r="7" fill="currentColor" stroke="none"/></svg>',
    // 内置工具：扳手
    wrench: '<svg ' + SVG_ATTRS + '><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>',
    // 任务总结：列表 + 对勾
    summary: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20 3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2M4 19V5h16v14z"/><path d="M13 8h5v2h-5zm-5 .59L6.96 7.54L5.54 8.96L8 11.41l3.46-3.45l-1.42-1.42zM13 14h5v2h-5zm-5 .59l-1.04-1.05l-1.42 1.42L8 17.41l3.46-3.45l-1.42-1.42z"/></svg>',
    // 成功：实心圆 + 对勾镂空
    check: '<svg ' + SVG_ATTRS + '><path fill="currentColor" stroke="none" fill-rule="nonzero" d="M12,1 C18.0751322,1 23,5.92486775 23,12 C23,18.0751322 18.0751322,23 12,23 C5.92486775,23 1,18.0751322 1,12 C1,5.92486775 5.92486775,1 12,1 Z M18.1871843,8.71966991 C17.8942911,8.4267767 17.4194174,8.4267767 17.1265242,8.71966991 L11.5303301,14.315864 L11.4982689,14.3461246 C11.2037494,14.6083836 10.7521027,14.5982967 10.4696699,14.315864 L7.37347584,11.2196699 L7.34141465,11.1894093 C7.04689518,10.9271503 6.59524841,10.9372372 6.31281566,11.2196699 C6.17968238,11.3528032 6.10706423,11.5235358 6.0949612,11.6976864 L6.0949612,11.8023136 L6.10948484,11.9061203 C6.1385321,12.0432533 6.20630904,12.1738235 6.31281566,12.2803301 L9.76256313,15.7300776 L9.80582194,15.7719013 C10.4919646,16.4131984 11.5682572,16.3992572 12.2374369,15.7300776 L18.1871843,9.78033009 L18.217445,9.7482689 C18.479704,9.45374943 18.4696171,9.00210266 18.1871843,8.71966991 Z"/></svg>',
    // 错误：实心圆 + 白色 ×
    cross: '<svg ' + SVG_ATTRS + '><circle cx="12" cy="12" r="11" fill="currentColor" stroke="none"/><path fill="#FFFFFF" stroke="none" fill-rule="evenodd" d="M8.81801948,16.2426407 C8.52512627,16.5355339 8.05025253,16.5355339 7.75735931,16.2426407 C7.46446609,15.9497475 7.46446609,15.4748737 7.75735931,15.1819805 L10.9400469,11.9992929 L7.75735931,8.81801948 C7.46446609,8.52512627 7.46446609,8.05025253 7.75735931,7.75735931 C8.05025253,7.46446609 8.52512627,7.46446609 8.81801948,7.75735931 L12.0007071,10.9386327 L15.1819805,7.75735931 C15.4748737,7.46446609 15.9497475,7.46446609 16.2426407,7.75735931 C16.5355339,8.05025253 16.5355339,8.52512627 16.2426407,8.81801948 L8.81801948,16.2426407 Z M13.767767,12.7071068 L16.2426407,15.1819805 C16.5355339,15.4748737 16.5355339,15.9497475 16.2426407,16.2426407 C15.9497475,16.5355339 15.4748737,16.5355339 15.1819805,16.2426407 L12.7071068,13.767767 L13.767767,12.7071068 Z"/></svg>',
    // 告警：圆环 + 感叹号
    alert: '<svg ' + SVG_ATTRS + '><path fill="currentColor" stroke="none" fill-rule="nonzero" d="M12,0.999983593 L12.1815564,1.00145453 C18.0835105,1.09714557 22.8442179,5.83597302 22.9962538,11.7184846 L23,12.0086951 L22.9985643,12.1815573 C22.9028731,18.083502 18.1640381,22.8442018 12.281517,22.9962374 L11.9913061,22.9999836 L11.8184436,22.9985479 C5.91648945,22.9028568 1.15578206,18.1640294 1.00374622,12.2815178 L1,11.9913073 L1.00143573,11.8184451 C1.09712692,5.91650039 5.83596195,1.15576653 11.710203,1.00372984 L12,0.999983593 Z M11.994,2.499 L11.7279371,2.50380847 C6.7569636,2.64374211 2.72991179,6.60611289 2.50960807,11.5597393 L2.50138399,11.8309031 L2.5,11.9913073 C2.5,17.0940492 6.51492881,21.2660064 11.5596789,21.4903735 L11.8309016,21.4985996 L11.9913061,21.4999836 C17.0940585,21.4999836 21.2660225,17.4850612 21.4903899,12.4403214 L21.498616,12.1690993 L21.5,12.0086951 C21.5,6.90595322 17.4850712,2.73399601 12.4406109,2.50963127 L12.169404,2.50140531 L11.994,2.499 Z M12,15.5 C12.6903125,15.5 13.25,16.0596875 13.25,16.75 C13.25,17.4403125 12.6903125,18 12,18 C11.3096875,18 10.75,17.4403125 10.75,16.75 C10.75,16.0596875 11.3096875,15.5 12,15.5 Z M12,6 C12.6414582,6 13.1614628,6.5200046 13.1614628,7.16146279 C13.1614628,7.18988207 13.1604197,7.21829177 13.1583357,7.24663453 L12.6708322,13.8766827 C12.6449936,14.2280877 12.3523536,14.5 12,14.5 C11.6476464,14.5 11.3550064,14.2280877 11.3291678,13.8766827 L10.8416643,7.24663453 C10.7946252,6.60690339 11.2750971,6.05016615 11.9148283,6.00312709 C11.943171,6.00104307 11.9715807,6 12,6 Z"/></svg>',
    retry: '<svg ' + SVG_ATTRS + '><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>',
    copy: '<svg ' + SVG_ATTRS + '><rect x="8" y="8" width="13" height="13" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>',
    chevron: '<svg ' + SVG_ATTRS + '><path d="M6 9l6 6 6-6"/></svg>',
    down: '<svg ' + SVG_ATTRS + '><path d="M12 4v14"/><path d="M6 12.5l6 6 6-6"/></svg>',
    // 工具：读取文件（书）
    read: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" fill="currentColor" aria-hidden="true"><path d="M928 161H699.2c-49.1 0-97.1 14.1-138.4 40.7L512 233l-48.8-31.3A255.2 255.2 0 0 0 324.8 161H96c-17.7 0-32 14.3-32 32v568c0 17.7 14.3 32 32 32h228.8c49.1 0 97.1 14.1 138.4 40.7l44.4 28.6c1.3.8 2.8 1.3 4.3 1.3s3-.4 4.3-1.3l44.4-28.6C602 807.1 650.1 793 699.2 793H928c17.7 0 32-14.3 32-32V193c0-17.7-14.3-32-32-32M404 553.5c0 4.1-3.2 7.5-7.1 7.5H211.1c-3.9 0-7.1-3.4-7.1-7.5v-45c0-4.1 3.2-7.5 7.1-7.5h185.7c3.9 0 7.1 3.4 7.1 7.5v45zm0-140c0 4.1-3.2 7.5-7.1 7.5H211.1c-3.9 0-7.1-3.4-7.1-7.5v-45c0-4.1 3.2-7.5 7.1-7.5h185.7c3.9 0 7.1 3.4 7.1 7.5v45zm416 140c0 4.1-3.2 7.5-7.1 7.5H627.1c-3.9 0-7.1-3.4-7.1-7.5v-45c0-4.1 3.2-7.5 7.1-7.5h185.7c3.9 0 7.1 3.4 7.1 7.5v45zm0-140c0 4.1-3.2 7.5-7.1 7.5H627.1c-3.9 0-7.1-3.4-7.1-7.5v-45c0-4.1 3.2-7.5 7.1-7.5h185.7c3.9 0 7.1 3.4 7.1 7.5v45z"/></svg>',
    // 工具：编辑文件（文档 + 铅笔）
    edit: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8.586 18L12 21.414L15.414 18H19c1.103 0 2-.897 2-2V4c0-1.103-.897-2-2-2H5c-1.103 0-2 .897-2 2v12c0 1.103.897 2 2 2zM5 4h14v12h-4.414L12 18.586L9.414 16H5z"/><path d="m12.479 7.219l-4.977 4.969v1.799h1.8l4.975-4.969zm2.219-2.22l1.8 1.8l-1.37 1.37l-1.8-1.799z"/></svg>',
    // 工具：写入文件（铅笔）
    write: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 24 24" fill="currentColor" aria-hidden="true"><path d="m5.72 14.456l1.761-.508l10.603-10.73a.456.456 0 0 0-.003-.64l-.635-.642a.443.443 0 0 0-.632-.003L6.239 12.635zM18.703.664l.635.643c.876.887.884 2.318.016 3.196L8.428 15.561l-3.764 1.084a.9.9 0 0 1-1.11-.623a.9.9 0 0 1-.002-.506l1.095-3.84L15.544.647a2.215 2.215 0 0 1 3.159.016zM7.184 1.817c.496 0 .898.407.898.909a.903.903 0 0 1-.898.909H3.592c-.992 0-1.796.814-1.796 1.817v10.906c0 1.004.804 1.818 1.796 1.818h10.776c.992 0 1.797-.814 1.797-1.818v-3.635c0-.502.402-.909.898-.909s.898.407.898.91v3.634c0 2.008-1.609 3.636-3.593 3.636H3.592C1.608 19.994 0 18.366 0 16.358V5.452c0-2.007 1.608-3.635 3.592-3.635z"/></svg>',
    // 工具：删除文件（带叉的文档）
    'delete': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 56 56" fill="currentColor" aria-hidden="true"><path d="m9.965 49.574l20.344-.023c2.742 0 5.109-.844 7.03-2.86l13.829-14.273c1.547-1.57 2.227-3 2.227-4.453c0-1.477-.68-2.883-2.227-4.453L37.363 9.168c-1.922-2.04-4.289-2.742-7.031-2.742H9.965c-4.875 0-7.36 2.414-7.36 7.265V42.31c0 4.851 2.485 7.265 7.36 7.265m.07-3.773c-2.344 0-3.656-1.242-3.656-3.68V13.88c0-2.438 1.312-3.68 3.656-3.68h20.367c1.758 0 2.93.305 4.125 1.547l13.711 14.227c.774.82 1.055 1.383 1.055 1.992c0 .586-.258 1.148-1.055 1.969l-13.734 14.18c-1.219 1.265-2.344 1.687-4.125 1.687Zm5.86-8.203c.515 0 .913-.164 1.242-.492l6.609-6.633l6.61 6.633c.304.328.726.492 1.218.492c1.008 0 1.828-.797 1.828-1.782c0-.492-.21-.914-.562-1.265l-6.54-6.586l6.54-6.563c.351-.351.562-.797.562-1.265c0-1.008-.843-1.852-1.828-1.852c-.469 0-.89.211-1.242.563l-6.586 6.586l-6.586-6.586c-.352-.352-.773-.563-1.266-.563c-.984 0-1.804.844-1.804 1.852c0 .468.187.914.539 1.265l6.562 6.563l-6.562 6.586a1.74 1.74 0 0 0-.54 1.265c0 .985.798 1.782 1.805 1.782"/></svg>',
    // 工具：执行命令（终端）
    bash: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 7l1.227 1.057C8.742 8.502 9 8.724 9 9s-.258.498-.773.943L7 11m4 0h3"/><path d="M12 21c3.75 0 5.625 0 6.939-.955a5 5 0 0 0 1.106-1.106C21 17.625 21 15.749 21 12s0-5.625-.955-6.939a5 5 0 0 0-1.106-1.106C17.625 3 15.749 3 12 3s-5.625 0-6.939.955A5 5 0 0 0 3.955 5.06C3 6.375 3 8.251 3 12s0 5.625.955 6.939a5 5 0 0 0 1.106 1.106C6.375 21 8.251 21 12 21"/></svg>',
    // 工具：移动/重命名（文件夹+箭头）
    move: '<svg ' + SVG_ATTRS + '><path d="M7.37867966,3 C7.77650439,3 8.15803526,3.15803526 8.43933983,3.43933983 L11.7071068,6.70710678 C11.8946432,6.89464316 12.1489971,7 12.4142136,7 L19,7 C19.149679,7 19.2974379,7.00822125 19.4428497,7.02423682 C19.2349828,6.16929644 18.4757047,5.5288976 17.5622948,5.50095171 L17.5,5.5 L11.957,5.49986632 L10.45675,3.99986632 L17.5,4 C19.4329966,4 21,5.56700338 21,7.5 L21.0001204,7.53519846 C22.1956568,8.22683444 23,9.51948501 23,11 L23,17 C23,19.209139 21.209139,21 19,21 L5,21 C2.790861,21 1,19.209139 1,17 L1,7 C1,4.790861 2.790861,3 5,3 L7.37867966,3 Z M7.37867966,4.5 L5,4.5 C3.64269002,4.5 2.53801707,5.5816677 2.50096045,6.93002379 L2.5,17 C2.5,18.35731 3.5816677,19.4619829 4.93002379,19.4990396 L5,19.5 L19,19.5 C20.35731,19.5 21.4619829,18.4183323 21.4990396,17.0699762 L21.5,17 L21.5,11 C21.5,9.64269002 20.4183323,8.53801707 19.0699762,8.50096045 L12.4142136,8.5 C11.7787991,8.5 11.1683251,8.25809996 10.7059116,7.82529783 L10.6464466,7.76776695 L7.37867966,4.5 Z M13.3732689,10.2270987 L13.4053301,10.2573593 L15.9482233,12.8002525 C16.617403,13.4694322 16.6313442,14.5457248 15.990047,15.2318675 L15.9482233,15.2751263 L13.4053301,17.8180195 C13.1124369,18.1109127 12.6375631,18.1109127 12.3446699,17.8180195 C12.0622372,17.5355867 12.0521503,17.08394 12.3144093,16.7894205 L12.3446699,16.7573593 L14.312,14.7896894 L7.375,14.7892751 C6.96078644,14.7892751 6.625,14.4534886 6.625,14.0392751 C6.625,13.6250615 6.96078644,13.2892751 7.375,13.2892751 L14.315,13.2896894 L12.3446699,11.3180195 C12.0517767,11.0251263 12.0517767,10.5502525 12.3446699,10.2573593 C12.6271027,9.97492657 13.0787494,9.96483968 13.3732689,10.2270987 Z" fill="currentColor" stroke="none"/></svg>',
    // 工具：创建目录（文件夹 + 加号）
    mkdir: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20 6h-8l-2-2H4c-1.11 0-1.99.89-1.99 2L2 18c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V8c0-1.11-.89-2-2-2m-1 8h-3v3h-2v-3h-3v-2h3V9h2v3h3z"/></svg>',
    // 工具：列目录（列表）
    list: '<svg ' + SVG_ATTRS + '><path d="M3.5,17.5 C4.05228475,17.5 4.5,17.9477153 4.5,18.5 C4.5,19.0522847 4.05228475,19.5 3.5,19.5 C2.94771525,19.5 2.5,19.0522847 2.5,18.5 C2.5,17.9477153 2.94771525,17.5 3.5,17.5 Z M21.25,17.75 C21.6642136,17.75 22,18.0857864 22,18.5 C22,18.9142136 21.6642136,19.25 21.25,19.25 L7.75,19.25 C7.33578644,19.25 7,18.9142136 7,18.5 C7,18.0857864 7.33578644,17.75 7.75,17.75 L21.25,17.75 Z M3.5,11 C4.05228475,11 4.5,11.4477153 4.5,12 C4.5,12.5522847 4.05228475,13 3.5,13 C2.94771525,13 2.5,12.5522847 2.5,12 C2.5,11.4477153 2.94771525,11 3.5,11 Z M21.25,11.25 C21.6642136,11.25 22,11.5857864 22,12 C22,12.4142136 21.6642136,12.75 21.25,12.75 L7.75,12.75 C7.33578644,12.75 7,12.4142136 7,12 C7,11.5857864 7.33578644,11.25 7.75,11.25 L21.25,11.25 Z M3.5,4.5 C4.05228475,4.5 4.5,4.94771525 4.5,5.5 C4.5,6.05228475 4.05228475,6.5 3.5,6.5 C2.94771525,6.5 2.5,6.05228475 2.5,5.5 C2.5,4.94771525 2.94771525,4.5 3.5,4.5 Z M21.25,4.75 C21.6642136,4.75 22,5.08578644 22,5.5 C22,5.91421356 21.6642136,6.25 21.25,6.25 L7.75,6.25 C7.33578644,6.25 7,5.91421356 7,5.5 C7,5.08578644 7.33578644,4.75 7.75,4.75 L21.25,4.75 Z" fill="currentColor" stroke="none"/></svg>',
    // 工具：搜索内容（放大镜 + 文档）
    search: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M15.5 12c2.5 0 4.5 2 4.5 4.5c0 .88-.25 1.71-.69 2.4l3.08 3.1L21 23.39l-3.12-3.07c-.69.43-1.51.68-2.38.68c-2.5 0-4.5-2-4.5-4.5s2-4.5 4.5-4.5m0 2a2.5 2.5 0 0 0-2.5 2.5a2.5 2.5 0 0 0 2.5 2.5a2.5 2.5 0 0 0 2.5-2.5a2.5 2.5 0 0 0-2.5-2.5M5 3h14c1.11 0 2 .89 2 2v8.03c-.5-.8-1.19-1.49-2-2.03V5H5v14h4.5c.31.75.76 1.42 1.31 2H5c-1.11 0-2-.89-2-2V5c0-1.11.89-2 2-2m2 4h10v2H7zm0 4h5.03c-.8.5-1.49 1.19-2.03 2H7zm0 4h2.17c-.11.5-.17 1-.17 1.5v.5H7z"/></svg>',
    // 工具：当前目录（定位钉）
    cwd: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.02 14.73c-.4.64-.84 1.23-1.27 1.76C18.88 16.97 20 17.68 20 18c0 .51-2.75 2-8 2s-8-1.49-8-2c0-.32 1.12-1.03 3.25-1.51c-.43-.53-.86-1.12-1.27-1.76C3.66 15.37 2 16.44 2 18c0 2.75 5.18 4 10 4s10-1.25 10-4c0-1.56-1.67-2.63-3.98-3.27"/><path d="M6 8.44c-.02 5.1 5.17 9.18 5.39 9.35c.18.14.4.21.61.21s.43-.07.61-.21c.22-.17 5.41-4.25 5.39-9.35C18 4.89 15.31 2 12 2S6 4.89 6 8.44M14 8c0 1.1-.9 2-2 2s-2-.9-2-2s.9-2 2-2s2 .9 2 2"/></svg>',
    // Skill 完成：打开的书
    book: '<svg ' + SVG_ATTRS + '><path d="M12 6c-2-1.5-4.5-2-8-2v14c3.5 0 6 .5 8 2 2-1.5 4.5-2 8-2V4c-3.5 0-6 .5-8 2z"/><path d="M12 6v14"/></svg>',
    // Skill 徽标内联图标：带折角文档
    skill: '<svg xmlns="http://www.w3.org/2000/svg" width="15px" height="15px" viewBox="0 0 24 24" fill="none" stroke="var(--accent-3)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-0.125em"><path d="M4 4.222v15.556C4 21.005 5.023 22 6.286 22h11.428C18.977 22 20 21.005 20 19.778V8.444a2 2 0 0 0-2-2H6.286C5.023 6.444 4 5.45 4 4.222m0 0C4 2.995 5.023 2 6.286 2h9.143c1.262 0 2.285.995 2.285 2.222v2.222"/></svg>',
    // MCP 完成：USB 三叉
    usb: '<svg ' + SVG_ATTRS + '><circle cx="12" cy="6" r="1.8"/><path d="M12 7.8V12"/><path d="M9 12h6"/><path d="M9 12v3M12 12v4M15 12v3"/></svg>',
    // MCP 内层徽标图标（紫色）：工具 / 提示模板 / 资源
    mcpTool: '<svg xmlns="http://www.w3.org/2000/svg" width="15px" height="15px" viewBox="0 0 24 24" aria-hidden="true" style="vertical-align:-0.125em"><g fill="none" stroke="currentColor" stroke-linejoin="round" stroke-width="1.5"><path stroke-linecap="round" d="M8 15.889C8.15 16.42 8.455 17 9.25 17c1.375 0 1.719-1.111 2.75-5s1.375-5 2.75-5c.795 0 1.1.58 1.25 1.111m-5.667 2.5h4.417"/><path d="M2.5 12c0-4.478 0-6.718 1.391-8.109S7.521 2.5 12 2.5c4.478 0 6.718 0 8.109 1.391S21.5 7.521 21.5 12c0 4.478 0 6.718-1.391 8.109S16.479 21.5 12 21.5c-4.478 0-6.718 0-8.109-1.391S2.5 16.479 2.5 12Z"/></g></svg>',
    mcpPrompt: '<svg xmlns="http://www.w3.org/2000/svg" width="15px" height="15px" viewBox="0 0 32 32" aria-hidden="true" style="vertical-align:-0.125em"><path fill="currentColor" d="M31.5 23c-.827 0-1.5-.673-1.5-1.5V20c0-1.102-.897-2-2-2h-2v2h2v1.5c0 .98.407 1.864 1.058 2.5A3.5 3.5 0 0 0 28 26.5V28h-2v2h2c1.103 0 2-.897 2-2v-1.5c0-.827.673-1.5 1.5-1.5h.5v-2zM16 20v1.5c0 .827-.673 1.5-1.5 1.5H14v2h.5c.827 0 1.5.673 1.5 1.5V28c0 1.103.897 2 2 2h2v-2h-2v-1.5c0-.98-.407-1.864-1.058-2.5A3.5 3.5 0 0 0 18 21.5V20h2v-2h-2c-1.103 0-2 .898-2 2m12-5h2V5c0-1.103-.897-2-2-2h-3v2h3z"/><circle cx="23" cy="13" r="2" fill="currentColor"/><circle cx="16" cy="13" r="2" fill="currentColor"/><circle cx="9" cy="13" r="2" fill="currentColor"/><path fill="currentColor" d="M7 23H4c-1.103 0-2-.897-2-2V5c0-1.103.897-2 2-2h3v2H4v16h3z"/></svg>',
    mcpResource: '<svg xmlns="http://www.w3.org/2000/svg" width="15px" height="15px" viewBox="0 0 24 24" aria-hidden="true" style="vertical-align:-0.125em"><path fill="currentColor" fill-rule="evenodd" d="M14.25 2.5a.25.25 0 0 0-.25-.25H7A2.75 2.75 0 0 0 4.25 5v14A2.75 2.75 0 0 0 7 21.75h10A2.75 2.75 0 0 0 19.75 19V9.147a.25.25 0 0 0-.25-.25H15a.75.75 0 0 1-.75-.75zm-.219 10.664a.75.75 0 0 1 .938 1.172l-2.494 1.995a.75.75 0 0 1-.473.169h-.008a.75.75 0 0 1-.465-.166l-2.497-1.998a.75.75 0 0 1 .937-1.172l1.281 1.026v-3.44a.75.75 0 1 1 1.5 0v3.44z" clip-rule="evenodd"/><path fill="currentColor" d="M15.75 2.824c0-.184.193-.301.336-.186q.182.147.323.342l3.013 4.197c.068.096-.006.22-.124.22H16a.25.25 0 0 1-.25-.25z"/></svg>',
    // 链接
    link: '<svg ' + SVG_ATTRS + '><path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5"/></svg>'
  };

  function chevHtml() {
    return '<span class="chev">' + ICONS.chevron + '</span>';
  }

  // 思考中随机提示文案
  var THINKING_PHRASES = [
    '让我想一想', '答案在路上', '大脑在飞速运转中', '我想想',
    '琢磨一下', '捋捋思路', '我过一遍思路', '问题有点复杂，我想想',
    '正在整合有效信息', '正在脑中推演中', '我先理理头绪',
    '正在梳理', '思考中…', '正在拆解问题要素', '正在串联信息碎片',
    '推敲中…', '梳理线索…'
  ];

  var TOOL_META = {
    builtin: { icon: ICONS.wrench },
    skill: { icon: ICONS.book },
    mcp: { icon: ICONS.usb }
  };

  // 内置工具按名称 → 静态图标（执行结束时显示，代替统一扳手）
  var TOOL_ICONS = {
    read: ICONS.read,
    write: ICONS.write,
    edit: ICONS.edit,
    'delete': ICONS.delete,
    move: ICONS.move,
    mkdir: ICONS.mkdir,
    list: ICONS.list,
    search: ICONS.search,
    cwd: ICONS.cwd,
    bash: ICONS.bash
  };

  /* ================= 迷你 Markdown 渲染器 =================
   * 支持：标题 / 列表 / 表格 / 代码块 / 分隔线 / 引用 /
   *       加粗 / 斜体 / 行内代码 / 链接。按行解析，未闭合的
   *       代码块在流式过程中按已到达内容渲染。
   * ============================================================ */

  function mdInline(text) {
    var codes = [];
    text = String(text).replace(/`([^`]+)`/g, function (_, c) {
      codes.push(c);
      return '\u0000' + (codes.length - 1) + '\u0000';
    });
    var out = esc(text);
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (_, t, u) {
      return /^https?:\/\//i.test(u)
        ? '<a href="' + u + '" target="_blank" rel="noopener" class="md-link">' + ICONS.link + t + '</a>'
        : t;
    });
    out = out.replace(/\u0000(\d+)\u0000/g, function (_, i) {
      return '<code class="inline-code">' + esc(codes[+i]) + '</code>';
    });
    return out;
  }

  /* ================= 代码语法高亮 =================
   * 轻量正则高亮：按语言对代码块上色（关键字/字符串/注释/数字等）。
   * ================================================= */

  var HIGHLIGHT_RULES = {
    js: [
      { cls: 'comment', re: /\/\/[^\n]*|\/\*[\s\S]*?\*\// },
      { cls: 'string', re: /`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/ },
      { cls: 'keyword', re: /\b(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|super|this|typeof|instanceof|in|of|async|await|import|export|from|default|try|catch|finally|throw|void|delete|yield|static|get|set)\b/ },
      { cls: 'boolean', re: /\b(?:true|false|null|undefined|NaN|Infinity)\b/ },
      { cls: 'number', re: /\b\d+(?:\.\d+)?\b/ },
      { cls: 'function', re: /\b[A-Za-z_$][\w$]*(?=\s*\()/ }
    ],
    python: [
      { cls: 'comment', re: /#[^\n]*/ },
      { cls: 'string', re: /"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/ },
      { cls: 'decorator', re: /@\w+/ },
      { cls: 'keyword', re: /\b(?:def|return|import|from|as|class|if|elif|else|for|while|try|except|finally|with|lambda|global|nonlocal|pass|break|continue|raise|assert|del|yield|and|or|not|in|is|async|await)\b/ },
      { cls: 'boolean', re: /\b(?:None|True|False)\b/ },
      { cls: 'number', re: /\b\d+(?:\.\d+)?\b/ },
      { cls: 'function', re: /\b[A-Za-z_][\w]*(?=\s*\()/ }
    ],
    bash: [
      { cls: 'comment', re: /#[^\n]*/ },
      { cls: 'string', re: /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/ },
      { cls: 'variable', re: /\$\{?[A-Za-z_][\w]*\}?/ },
      { cls: 'keyword', re: /\b(?:if|then|else|elif|fi|for|while|do|done|case|esac|function|echo|cd|ls|return|exit|export|source|sudo)\b/ },
      { cls: 'number', re: /\b\d+\b/ }
    ],
    html: [
      { cls: 'comment', re: /<!--[\s\S]*?-->/ },
      { cls: 'string', re: /"[^"]*"/ },
      { cls: 'tag', re: /<\/?[A-Za-z][\w-]*|\/?>/ },
      { cls: 'attr', re: /\b[a-zA-Z-]+(?==)/ }
    ],
    json: [
      { cls: 'key', re: /"[^"]*"(?=\s*:)/ },
      { cls: 'string', re: /"(?:\\.|[^"\\])*"/ },
      { cls: 'boolean', re: /\b(?:true|false|null)\b/ },
      { cls: 'number', re: /\b\d+(?:\.\d+)?\b/ }
    ]
  };

  function highlightDiff(code) {
    return code.split('\n').map(function (line) {
      if (/^\+/.test(line)) return '<span class="tok-add">' + esc(line) + '</span>';
      if (/^-/.test(line)) return '<span class="tok-del">' + esc(line) + '</span>';
      if (/^(@@|diff|---|\+\+\+)/.test(line)) return '<span class="tok-meta">' + esc(line) + '</span>';
      return esc(line);
    }).join('\n');
  }

  function highlightCode(code, lang) {
    var l = String(lang || '').toLowerCase();
    if (l === 'js' || l === 'javascript' || l === 'ts' || l === 'tsx' || l === 'typescript') l = 'js';
    if (l === 'py') l = 'python';
    if (l === 'sh' || l === 'shell' || l === 'zsh') l = 'bash';
    if (l === 'htm' || l === 'xml') l = 'html';
    if (l === 'diff') return highlightDiff(code);

    var rules = HIGHLIGHT_RULES[l];
    if (!rules) return esc(code);

    var combined = new RegExp(rules.map(function (r) { return '(' + r.re.source + ')'; }).join('|'), 'g');
    var out = '';
    var last = 0;
    var m;
    while ((m = combined.exec(code)) !== null) {
      out += esc(code.slice(last, m.index));
      for (var i = 1; i < m.length; i++) {
        if (m[i] !== undefined) {
          out += '<span class="tok-' + rules[i - 1].cls + '">' + esc(m[0]) + '</span>';
          break;
        }
      }
      last = combined.lastIndex;
      if (m[0].length === 0) combined.lastIndex++;
    }
    out += esc(code.slice(last));
    return out;
  }

  function mdCodeBlock(lang, code) {
    return '<div class="code-block">' +
      '<div class="code-head"><span class="code-lang">' + esc(lang || 'text') + '</span>' +
      '<button type="button" class="code-copy">' + ICONS.copy + '</button></div>' +
      '<pre><code>' + highlightCode(code, lang) + '</code></pre></div>';
  }

  function splitRow(line) {
    var s = line.trim().replace(/^\|/, '').replace(/\|$/, '');
    return s.split('|').map(function (c) { return c.trim(); });
  }

  function mdTable(rows) {
    var head = rows[0];
    var body = rows.slice(1);
    var t = '<div class="md-table-wrap"><table><thead><tr>';
    head.forEach(function (c) { t += '<th>' + mdInline(c) + '</th>'; });
    t += '</tr></thead><tbody>';
    body.forEach(function (r) {
      t += '<tr>';
      for (var i = 0; i < head.length; i++) t += '<td>' + mdInline(r[i] || '') + '</td>';
      t += '</tr>';
    });
    t += '</tbody></table></div>';
    return t;
  }

  function renderMarkdown(src) {
    var lines = String(src).split('\n');
    var html = '';
    var para = [];
    var list = null;

    function flushPara() {
      if (para.length) {
        html += '<p>' + para.map(function (l) { return mdInline(l); }).join('<br>') + '</p>';
        para = [];
      }
    }
    function flushList() {
      if (list) {
        html += '<' + list.type + '>' + list.items.map(function (it) {
          return '<li>' + mdInline(it) + '</li>';
        }).join('') + '</' + list.type + '>';
        list = null;
      }
    }

    var i = 0;
    while (i < lines.length) {
      var line = lines[i];

      var fence = line.match(/^```\s*([\w+-]*)/);
      if (fence) {
        flushPara(); flushList();
        var lang = fence[1];
        var buf = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++;
        html += mdCodeBlock(lang, buf.join('\n'));
        continue;
      }

      if (/^\s*$/.test(line)) { flushPara(); flushList(); i++; continue; }

      var h = line.match(/^(#{1,6})\s+(.*)/);
      if (h) {
        flushPara(); flushList();
        html += '<h' + h[1].length + '>' + mdInline(h[2]) + '</h' + h[1].length + '>';
        i++; continue;
      }

      if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { flushPara(); flushList(); html += '<hr>'; i++; continue; }

      var bq = line.match(/^\s*>\s?(.*)/);
      if (bq) { flushPara(); flushList(); html += '<blockquote>' + mdInline(bq[1]) + '</blockquote>'; i++; continue; }

      var ul = line.match(/^\s*[-*+]\s+(.*)/);
      if (ul) {
        flushPara();
        if (!list || list.type !== 'ul') { flushList(); list = { type: 'ul', items: [] }; }
        list.items.push(ul[1]); i++; continue;
      }

      var ol = line.match(/^\s*\d+[.)]\s+(.*)/);
      if (ol) {
        flushPara();
        if (!list || list.type !== 'ol') { flushList(); list = { type: 'ol', items: [] }; }
        list.items.push(ol[1]); i++; continue;
      }

      if (/^\s*\|/.test(line)) {
        // 表格：以 | 开头的行即视为表格行（流式输出中提前识别，即使该行尚未结束也避免竖线闪成段落）
        flushPara(); flushList();
        var rows = [splitRow(line)];
        i++;
        // 跳过表头分隔行 |---|---|
        if (i < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i])) i++;
        while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(splitRow(lines[i])); i++; }
        html += mdTable(rows);
        continue;
      }

      para.push(line);
      i++;
    }
    flushPara(); flushList();
    return html;
  }

  /* ================= 折叠动画工具 ================= */

  function makeCollapsible(headerEl, bodyEl, opts) {
    opts = opts || {};
    var expanded = opts.expanded !== false;
    var animating = false;
    // 高度 + 上下 padding 一起线性过渡：border-box 下若只动 height，padding 会形成「收不拢」的底边，
    // 表现为快合上/刚展开时的速度突变。
    var SLIDE = 'height .3s linear, padding-top .3s linear, padding-bottom .3s linear';

    function applyStatic() {
      bodyEl.style.display = expanded ? '' : 'none';
      headerEl.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      headerEl.classList.toggle('is-collapsed', !expanded);
    }

    // 展开/折叠动画：用真实高度过渡（而非 scale/clip 的视觉裁切），并把上下 padding 一起过渡，
    // 避免 border-box 下 padding 形成「收不拢」的底边（快合上/刚展开时的速度突变）。
    function expand() {
      if (expanded || animating) return;
      expanded = true;
      animating = true;
      bodyEl.style.display = '';
      var cs = getComputedStyle(bodyEl);
      var padTop = parseFloat(cs.paddingTop) || 0;
      var padBottom = parseFloat(cs.paddingBottom) || 0;
      bodyEl.style.overflow = 'hidden';
      var target = bodyEl.offsetHeight;   // 自然高度（border-box，含 padding）
      bodyEl.style.height = '0px';
      bodyEl.style.paddingTop = '0px';
      bodyEl.style.paddingBottom = '0px';
      bodyEl.offsetHeight;                 // 强制回流，提交起始状态
      bodyEl.style.transition = SLIDE;
      bodyEl.style.height = target + 'px';
      bodyEl.style.paddingTop = padTop + 'px';
      bodyEl.style.paddingBottom = padBottom + 'px';
      setTimeout(function () {
        bodyEl.style.transition = '';
        bodyEl.style.height = '';
        bodyEl.style.paddingTop = '';
        bodyEl.style.paddingBottom = '';
        bodyEl.style.overflow = '';
        animating = false;
      }, 330);
      headerEl.setAttribute('aria-expanded', 'true');
      headerEl.classList.remove('is-collapsed');
      if (opts.onChange) opts.onChange(true);
    }

    function collapse() {
      if (!expanded || animating) return;
      if (opts.onBeforeCollapse) opts.onBeforeCollapse();
      expanded = false;
      animating = true;
      var cs = getComputedStyle(bodyEl);
      var padTop = parseFloat(cs.paddingTop) || 0;
      var padBottom = parseFloat(cs.paddingBottom) || 0;
      var start = bodyEl.offsetHeight;
      bodyEl.style.overflow = 'hidden';
      bodyEl.style.height = start + 'px';
      bodyEl.style.paddingTop = padTop + 'px';
      bodyEl.style.paddingBottom = padBottom + 'px';
      bodyEl.offsetHeight;                 // 强制回流，提交起始状态
      bodyEl.style.transition = SLIDE;
      bodyEl.style.height = '0px';
      bodyEl.style.paddingTop = '0px';
      bodyEl.style.paddingBottom = '0px';
      setTimeout(function () {
        bodyEl.style.display = 'none';
        bodyEl.style.transition = '';
        bodyEl.style.height = '';
        bodyEl.style.paddingTop = '';
        bodyEl.style.paddingBottom = '';
        bodyEl.style.overflow = '';
        animating = false;
      }, 330);
      headerEl.setAttribute('aria-expanded', 'false');
      headerEl.classList.add('is-collapsed');
      if (opts.onChange) opts.onChange(false);
    }

    // 瞬时折叠：不做动画，直接进入折叠态（用于大折叠展开前先把子折叠归位，避免「先展开再折叠」的闪现）
    function instantCollapse() {
      expanded = false;
      animating = false;
      bodyEl.style.transition = '';
      bodyEl.style.height = '';
      bodyEl.style.paddingTop = '';
      bodyEl.style.paddingBottom = '';
      bodyEl.style.overflow = '';
      applyStatic();
    }

    applyStatic();

    return {
      toggle: function () { if (expanded) collapse(); else expand(); },
      expand: expand,
      collapse: collapse,
      instantCollapse: instantCollapse,
      isExpanded: function () { return expanded; }
    };
  }

  function bindCollapseTrigger(headerEl, api, opts) {
    opts = opts || {};
    function act() {
      if (opts.isLocked && opts.isLocked()) return;
      api.toggle();
      if (opts.onUserToggle) opts.onUserToggle();
    }
    headerEl.addEventListener('click', act);
    headerEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        act();
      }
    });
  }

  /* ================= 各类消息渲染 ================= */

  function mountUser(chat, msg) {
    var row = el('div', 'msg msg-user-row');
    row.innerHTML =
      '<div class="user-meta"><span class="user-time">' + esc(msg.time || '') + '</span></div>' +
      '<div class="user-bubble">' + esc(msg.content).replace(/\n/g, '<br>') + imagesHtml(msg.images) + '</div>';
    chat.listEl.appendChild(row);
    chat.register(msg.id, { root: row, update: function () {} }, null);
    chat.lastUserText = msg.content;
    chat.closeRound();
  }

  // 思考动效已迁至 assets/liquid-orb.js（Liquid Glass Orb，WebGPU + canvas 回退），
  // 通过 window.makeLiquidOrb 调用。
  function mountThinking(chat, msg, round) {
    // 新一轮思考 = 上一阶段工具结束 → 折叠上一个工具块（用户未手动展开时）
    if (round.activeToolsBlock && !round.userTouched.has('tools')) {
      round.activeToolsBlock.api.collapse();
    }
    var root = el('div', 'msg msg-thinking');
    var header = el('div', 'think-header');
    header.setAttribute('role', 'button');
    header.setAttribute('tabindex', '0');
    var phrases = round.cfg.thinkingPhrases;
    var phrase = phrases[Math.floor(Math.random() * phrases.length)];
    header.innerHTML =
      '<span class="t-icon"></span>' +
      '<span class="t-title">' + esc(phrase) + '</span>' +
      '<span class="t-preview"></span>' +
      '<span class="t-meta"></span>' +
      chevHtml();
    var body = el('div', 'think-body');
    var content = el('div', 'think-content');
    body.appendChild(content);
    root.appendChild(header);
    root.appendChild(body);

    var api = makeCollapsible(header, body, {
      expanded: false,
      onUserToggle: function () { round.userTouched.add('thinking'); }
    });

    var ctrl = {
      root: root,
      api: api,
      start: Date.now(),
      done: false,
      update: function (m) {
        var t = m.thinking || {};
        var full = t.fullText || '';
        var segs = full.split('\n');
        var cur = segs.length ? segs[segs.length - 1] : '';
        var prev = segs.slice(0, -1);
        var html = '';
        prev.forEach(function (ln) {
          if (ln.trim()) html += '<div class="think-line">' + esc(ln) + '</div>';
        });
        if (cur || t.status === 'thinking') {
          html += '<div class="think-line think-cur">' + esc(cur) + '</div>';
        }
        content.innerHTML = html;
        content.scrollTop = content.scrollHeight;
        var preview = header.querySelector('.t-preview');
        preview.textContent = cur || (prev.length ? prev[prev.length - 1] : '');

        if (t.status === 'done' && !ctrl.done) {
          ctrl.done = true;
          header.querySelector('.t-title').textContent = round.cfg.text.thinkingSecs + ' ' + fmtDuration(Date.now() - ctrl.start);
          header.querySelector('.t-preview').style.display = 'none';
          header.querySelector('.t-meta').innerHTML = '';
          if (ctrl.orb) ctrl.orb.stop();
          header.querySelector('.t-icon').innerHTML = ICONS.circle;
          root.classList.add('is-done');
          if (!round.userTouched.has('thinking')) api.collapse();
        }
      }
    };
    ctrl.orb = (typeof window.makeLiquidOrb === 'function')
      ? window.makeLiquidOrb(header.querySelector('.t-icon'), 40)
      : null;

    ctrl.update(msg);
    bindCollapseTrigger(header, api, {});
    round.el.appendChild(root);
    round.thinkingCtrls.push(ctrl);
    // 新一轮思考开始后，后续工具调用将创建新的工具块
    round.activeToolsBlock = null;
    chat.register(msg.id, ctrl, round);
  }

  function mountAgentText(chat, msg, round) {
    // 正文到来（含最终回答）= 上一阶段工具结束 → 折叠上一个工具块
    if (round.activeToolsBlock && !round.userTouched.has('tools')) {
      round.activeToolsBlock.api.collapse();
    }
    var wrap = el('div', 'msg msg-text agent-text');
    var md = el('div', 'md-content');
    wrap.appendChild(md);
    round.el.appendChild(wrap);

    var ctrl = {
      root: wrap,
      md: md,
      raw: '',
      streaming: true,
      truncated: false,
      _lastRender: 0,
      update: function (m) {
        ctrl.raw = m.content || '';
        if (m.truncated) ctrl.truncated = true;
        // 流式期间节流：约 30ms 重渲染一次，避免每帧全量重跑 Markdown；最终态由 finish 兜底
        var now = Date.now();
        if (now - ctrl._lastRender >= 30) {
          ctrl._lastRender = now;
          md.innerHTML = ctrl.raw ? renderMarkdown(ctrl.raw) : '';
        }
      },
      finish: function (stopped) {
        ctrl.streaming = false;
        md.innerHTML = renderMarkdown(ctrl.raw);
        if (ctrl.truncated) {
          md.appendChild(el('div', 'stopped-note', round.cfg.text.truncated));
        } else if (stopped) {
          md.appendChild(el('div', 'stopped-note', round.cfg.text.stopped));
        }
      }
    };
    // 新一轮正文到来时，上一条正文降级为「中间说明」样式（并结束其流式光标）
    if (round.lastTextCtrl) {
      round.lastTextCtrl.root.classList.add('is-intermediate');
      round.lastTextCtrl.finish(false);
    }
    round.textCtrls.push(ctrl);
    round.lastTextCtrl = ctrl;
    ctrl.update(msg);
    chat.register(msg.id, ctrl, round);
  }

  // MCP 三种原语文案：工具（模型控制）/ 资源（应用控制，只读 URI）/ 提示模板（用户控制）
  var MCP_TYPE_LABELS = { tool: '工具', resource: '资源', prompt: '提示模板' };
  var MCP_TYPE_ICONS = { tool: ICONS.mcpTool, resource: ICONS.mcpResource, prompt: ICONS.mcpPrompt };

  /* ================= 默认配置（可被 opts 覆盖） =================
   * AgentChat 构造函数接收 opts.text / opts.paramLabels / opts.thinkingPhrases /
   * opts.toolIcons / opts.toolMeta / opts.mcpType，浅合并覆盖以下默认值。
   * DEFAULTS.text 是全部 UI 文案；其余是工具/参数/MCP 元信息映射。
   * ============================================================ */

  var DEFAULTS_TEXT = {
    thinkingSecs: '思考',               // 思考 X.Xs
    thinkingInterrupted: '思考已中断',
    truncated: '（输出已截断，达到 token 上限）',
    stopped: '（已停止生成）',
    interruptedTail: '（已中断）',
    calling: '正在调用',               // 正在调用工具… / 正在调用MCP工具…
    callBuiltin: '调用内置工具',
    callSkill: '载入技能',
    callMcp: '调用MCP',
    mcpPrefix: 'MCP',                  // 块标题里的 MCP 前缀（如「MCP工具」）
    builtinTool: '工具',
    execFailed: '执行失败',
    execWarn: '执行告警',
    warnFallback: '警告',              // 结果为空时的告警占位
    cost: '耗时',
    failed: '失败',                    // N 失败
    warn: '告警',                     // M 告警
    callCount: '调用',                // 调用 N 次…（已中断）
    params: '参数',
    result: '结果',
    retry: '重试',
    skillDesc: '技能描述',
    copy: '复制',
    copied: '已复制',
    copyFailed: '复制失败',
    nothingToCopy: '没有可复制的内容',
    download: '下载',
    regenerate: '重新生成',
    summaryLead: '处理 ',             // 处理 N 个任务，用时 X
    summaryTasks: ' 个任务，用时 '
  };

  var DEFAULTS = {
    text: DEFAULTS_TEXT,
    thinkingPhrases: THINKING_PHRASES,
    paramLabels: PARAM_LABELS,
    toolMeta: TOOL_META,
    toolIcons: TOOL_ICONS,
    mcpType: { labels: MCP_TYPE_LABELS, icons: MCP_TYPE_ICONS }
  };

  // 浅合并：把 src 的键覆盖到 target 上（映射按 key 合并；thinkingPhrases 整数组替换）
  function extend(target, src) {
    if (!src) return target;
    for (var k in src) {
      if (Object.prototype.hasOwnProperty.call(src, k)) target[k] = src[k];
    }
    return target;
  }

  // 由 opts 构建实例配置：各配置段分别浅合并，默认值不变
  function buildCfg(opts) {
    opts = opts || {};
    return {
      text: extend(extend({}, DEFAULTS_TEXT), opts.text),
      thinkingPhrases: opts.thinkingPhrases || DEFAULTS.thinkingPhrases,
      paramLabels: extend(extend({}, PARAM_LABELS), opts.paramLabels),
      toolMeta: extend(extend({}, TOOL_META), opts.toolMeta),
      toolIcons: extend(extend({}, TOOL_ICONS), opts.toolIcons),
      mcpType: {
        labels: extend(extend({}, MCP_TYPE_LABELS), opts.mcpType && opts.mcpType.labels),
        icons: extend(extend({}, MCP_TYPE_ICONS), opts.mcpType && opts.mcpType.icons)
      }
    };
  }

  // 块标题文案：内置工具「工具」，MCP 原语「MCP工具 / MCP资源 / MCP提示模板」
  function blockLabel(kind, cfg) {
    var isMcp = (kind === 'tool' || kind === 'resource' || kind === 'prompt');
    return isMcp ? (cfg.text.mcpPrefix + cfg.mcpType.labels[kind]) : cfg.text.builtinTool;
  }

  // MCP 服务名 / 短名：github/list_repos → github / list_repos；filesystem/file:///…README.md → filesystem / README.md
  function mcpServerName(name) {
    var idx = name.indexOf('/');
    return idx >= 0 ? name.slice(0, idx) : name;
  }
  function shortToolName(name) {
    var idx = name.lastIndexOf('/');
    return idx >= 0 ? name.slice(idx + 1) : name;
  }

  function ensureToolsBlock(round, kind) {
    if (round.activeToolsBlock) return round.activeToolsBlock;
    var isMcp = (kind === 'tool' || kind === 'resource' || kind === 'prompt');
    var block = el('div', 'msg tools-block' + (isMcp ? ' is-mcp' : ''));
    var header = el('div', 'tools-header');
    header.setAttribute('role', 'button');
    header.setAttribute('tabindex', '0');
    header.innerHTML =
      '<span class="t-icon tools-icon"><span class="t-spinner"></span></span>' +
      '<span class="tools-title">' + round.cfg.text.calling + blockLabel(kind, round.cfg) + '…</span>' +
      chevHtml();
    var cardsWrap = el('div', 'tools-cards');
    block.appendChild(header);
    block.appendChild(cardsWrap);
    round.el.appendChild(block);

    var toolsBlock = { root: block, header: header, cardsWrap: cardsWrap, api: null, count: 0, startTime: Date.now(), kind: kind, runOrb: null };

    var api = makeCollapsible(header, cardsWrap, {
      expanded: true,
      onUserToggle: function () { round.userTouched.add('tools'); },
      onBeforeCollapse: function () {
        // 先折叠块内所有卡片，再折叠整个块
        round.toolCards.forEach(function (c) { if (c.block === toolsBlock) c.api.collapse(); });
      }
    });
    toolsBlock.api = api;

    bindCollapseTrigger(header, api, {
      isLocked: function () {
        var running = false;
        round.toolCards.forEach(function (c) { if (c.block === toolsBlock && c.status === 'running') running = true; });
        return running;
      }
    });

    round.toolsBlocks.push(toolsBlock);
    round.activeToolsBlock = toolsBlock;
    return toolsBlock;
  }

  function updateToolsHeader(round, block) {
    var b = block || round.activeToolsBlock;
    if (!b) return;
    var title = b.header.querySelector('.tools-title');
    var iconEl = b.header.querySelector('.tools-icon');
    var anyRunning = false;
    var anyErr = false;
    var anyWarn = false;
    var errCount = 0;
    var warnCount = 0;
    var names = [];
    var serverName = '';
    round.toolCards.forEach(function (c) {
      if (c.block !== b) return;
      if (c.name) {
        var short = shortToolName(c.name);
        if (short && names.indexOf(short) === -1) names.push(short);
        if (!serverName) serverName = mcpServerName(c.name);
      }
      if (c.status === 'running') anyRunning = true;
      else if (c.status === 'failed') { anyErr = true; errCount++; }
      else if (c.status === 'warn') { anyWarn = true; warnCount++; }
    });
    var cfg = round.cfg;
    var isMcp = (b.kind === 'tool' || b.kind === 'resource' || b.kind === 'prompt');
    var prefix = isMcp
      ? (cfg.text.callMcp + ' ' + serverName + ' ' + cfg.mcpType.labels[b.kind])
      : cfg.text.callBuiltin;
    var namesText = names.join(' | ');
    b.root.classList.remove('status-err', 'status-warn');
    if (anyRunning) {
      title.textContent = prefix + ' ' + namesText;
      // 运行态：小液态球（表示运行围绕思考展开）+ 彩色外圈
      if (!b.runOrb) {
        iconEl.innerHTML = '<span class="run-orb"><span class="comet-ring"><span class="comet-head"></span></span></span>';
        b.runOrb = (typeof window.makeLiquidOrb === 'function')
          ? window.makeLiquidOrb(iconEl.querySelector('.run-orb'), 20)
          : null;
      }
    } else {
      var statusText = '';
      if (errCount > 0) statusText += ' · ' + errCount + ' ' + cfg.text.failed;
      if (warnCount > 0) statusText += ' · ' + warnCount + ' ' + cfg.text.warn;
      title.textContent = prefix + ' ' + namesText + statusText + ' · ' + cfg.text.cost + ' ' + fmtDuration(Date.now() - b.startTime);
      if (b.runOrb) {
        b.runOrb.stop();
        b.runOrb = null;
      }
      // 聚合内层状态：错误（failed）> 告警（warn）> 成功（类型色圆点）
      if (anyErr) {
        iconEl.innerHTML = ICONS.cross;
        b.root.classList.add('status-err');
      } else if (anyWarn) {
        iconEl.innerHTML = ICONS.alert;
        b.root.classList.add('status-warn');
      } else {
        iconEl.innerHTML = ICONS.circle;
      }
    }
    b.root.classList.toggle('is-running', anyRunning);
  }

  // 工具卡正文（参数区 + 结果区 + 重试按钮），builtin 与 MCP 卡共用
  function toolCardBodyHtml(cfg) {
    return '<div class="tool-sec">' +
        '<div class="tool-subhead">' + cfg.text.params +
          '<button type="button" class="clip-copy" title="' + cfg.text.copy + '" style="display:none">' + ICONS.copy + '</button>' +
        '</div>' +
        '<div class="tool-json"></div>' +
      '</div>' +
      '<div class="tool-sec tool-result-sec" style="display:none">' +
        '<div class="tool-subhead">' + cfg.text.result +
          '<span class="result-status-icon"></span>' +
          '<button type="button" class="clip-copy" title="' + cfg.text.copy + '" style="display:none">' + ICONS.copy + '</button>' +
        '</div>' +
        '<div class="tool-result-text"></div>' +
        '<div class="tool-result-images"></div>' +
        '<div class="tool-error" style="display:none"></div>' +
        '<button type="button" class="retry-btn" style="display:none">' + ICONS.retry + '<span>' + cfg.text.retry + '</span></button>' +
      '</div>';
  }

  // 结果区展示（成功 / 失败 / 警告通用）：流式打字 + 复制按钮
  function makeToolResultShower(body, cfg) {
    return function showResult(text, kind, onComplete) {
      var sec = body.querySelector('.tool-result-sec');
      sec.style.display = '';
      var pre = body.querySelector('.tool-result-text');
      var errEl = body.querySelector('.tool-error');
      var copyBtn = sec.querySelector('.clip-copy');
      if (kind === 'ok') {
        pre.style.display = '';
        errEl.style.display = 'none';
        copyBtn.style.display = '';
        fillClippedSectionStreaming(pre, copyBtn, text || '', onComplete);
      } else {
        pre.style.display = 'none';
        copyBtn.style.display = 'none';
        errEl.style.display = '';
        errEl.className = 'tool-error' + (kind === 'warn' ? ' warn' : '');
        fillClippedSectionStreaming(errEl, null, text || (kind === 'warn' ? cfg.text.warnFallback : cfg.text.execFailed), onComplete);
      }
    };
  }

  function mountToolCall(chat, msg, round) {
    // 工具开始调用时，结束上一条正文的流式光标
    if (round.lastTextCtrl && round.lastTextCtrl.streaming) round.lastTextCtrl.finish(false);
    var block = ensureToolsBlock(round);

    var tc = msg.toolCall;
    var meta = round.cfg.toolMeta[tc.toolType || 'builtin'] || round.cfg.toolMeta.builtin;

    var root = el('div', 'msg tool-card status-running');
    root.dataset.toolId = tc.toolCallId;
    var header = el('div', 'tool-header');
    header.setAttribute('role', 'button');
    header.setAttribute('tabindex', '0');
    header.innerHTML =
      '<span class="tool-icon"><span class="t-spinner-sm"></span></span>' +
      '<span class="tool-title"></span>' +
      '<span class="tool-ind"></span>' +
      chevHtml();
    var body = el('div', 'tool-body');
    body.innerHTML = toolCardBodyHtml(round.cfg);
    fillClippedSection(body.querySelector('.tool-json'), body.querySelector('.tool-sec .clip-copy'), formatArgs(tc.args, round.cfg), rawArgs(tc.args));
    root.appendChild(header);
    root.appendChild(body);

    var api = makeCollapsible(header, body, {
      expanded: false,
      onUserToggle: function () { round.userTouched.add('tools'); }
    });

    var ctrl = {
      root: root,
      api: api,
      block: block,
      status: '',
      startTime: Date.now(),
      order: round.toolSeq++,
      _lastArgsJson: null,
      _lastImagesKey: null,
      ingestResult: function (text) {
        var pre = body.querySelector('.tool-result-text');
        if (!pre.textContent && text) pre.textContent = text;
      },
      update: function (m) { updateToolCall(m.toolCall); }
    };

    var showResult = makeToolResultShower(body, round.cfg);

    // 执行中部分结果：running 态快照覆盖写「结果」区（不流式，避免频繁更新抖动）
    function showPartialResult(text) {
      var sec = body.querySelector('.tool-result-sec');
      sec.style.display = '';
      var pre = body.querySelector('.tool-result-text');
      pre.style.display = '';
      body.querySelector('.tool-error').style.display = 'none';
      var copyBtn = sec.querySelector('.clip-copy');
      fillClippedSection(pre, copyBtn, text || '');
    }

    // 工具结果图片：images 变化时渲染到结果区
    function renderToolImages(images) {
      var wrap = body.querySelector('.tool-result-images');
      if (!wrap) return;
      if (images && images.length) {
        wrap.style.display = '';
        wrap.innerHTML = images.map(imageTag).join('');
      } else {
        wrap.style.display = 'none';
        wrap.innerHTML = '';
      }
    }

    function updateToolCall(t) {
      // 参数流式：args 存在时才重新填（tool_execution_end 不带 args，避免把参数清空）
      if (t.args != null) {
        var argsJson = formatArgs(t.args, round.cfg);
        if (argsJson !== ctrl._lastArgsJson) {
          ctrl._lastArgsJson = argsJson;
          fillClippedSection(body.querySelector('.tool-json'), body.querySelector('.tool-sec .clip-copy'), argsJson, rawArgs(t.args));
        }
      }
      // 结果图片：images 变化时渲染
      var imgsKey = JSON.stringify(t.images || null);
      if (imgsKey !== ctrl._lastImagesKey) {
        ctrl._lastImagesKey = imgsKey;
        renderToolImages(t.images);
      }
      // 执行中部分结果：running 态且有 resultText 时，快照覆盖结果区
      if (t.status === 'running' && t.resultText != null) {
        showPartialResult(t.resultText);
      }
      setStatus(t);
    }

    function reorderCard() {
      var wrap = block.cardsWrap;
      var cards = Array.prototype.slice.call(wrap.children);
      var firstPending = null;
      for (var i = 0; i < cards.length; i++) {
        if (cards[i].getAttribute('data-status') === 'running') { firstPending = cards[i]; break; }
      }
      if (firstPending && firstPending !== root) wrap.insertBefore(root, firstPending);
    }

    function setStatus(t) {
      var st = t.status;
      if (st === ctrl.status) return;
      ctrl.status = st;
      root.className = 'msg tool-card status-' + st;
      root.setAttribute('data-status', st);
      var title = header.querySelector('.tool-title');
      var ind = header.querySelector('.tool-ind');
      var iconEl = header.querySelector('.tool-icon');
      var name = t.toolName;
      ctrl.name = name;
      var toolIcon = round.cfg.toolIcons[t.toolName] || meta.icon;

      if (st === 'running') {
        title.innerHTML = round.cfg.text.callBuiltin + ' ' + '<span class="tool-inline-icon">' + toolIcon + '</span>' + toolNameTag(name);
        iconEl.innerHTML = '<span class="t-spinner-sm"></span>';
        ind.innerHTML = '';
      } else if (st === 'done') {
        title.innerHTML = round.cfg.text.callBuiltin + ' ' + '<span class="tool-inline-icon">' + toolIcon + '</span>' + toolNameTag(name) + ' · ' + round.cfg.text.cost + ' ' + fmtDuration(Date.now() - ctrl.startTime);
        iconEl.innerHTML = ICONS.circle;
        ind.innerHTML = '<span class="status-badge ok">' + ICONS.check + esc(t.summary || '') + '</span>';
        reorderCard();
        showResult(t.resultText, 'ok', function () {
          // 工具执行完成 → 自动折叠该卡片（用户手动操作过则不折叠）
          if (!round.userTouched.has('tools')) api.collapse();
        });
      } else if (st === 'failed') {
        title.innerHTML = round.cfg.text.callBuiltin + ' ' + '<span class="tool-inline-icon">' + toolIcon + '</span>' + toolNameTag(name) + ' ' + round.cfg.text.execFailed;
        iconEl.innerHTML = ICONS.circle;
        ind.innerHTML = '<span class="status-cross">' + ICONS.cross + '</span>';
        showResult(t.resultText, 'error');
        reorderCard();
      } else if (st === 'warn') {
        title.innerHTML = round.cfg.text.callBuiltin + ' ' + '<span class="tool-inline-icon">' + toolIcon + '</span>' + toolNameTag(name) + ' ' + round.cfg.text.execWarn;
        iconEl.innerHTML = ICONS.circle;
        ind.innerHTML = '<span class="status-alert">' + ICONS.alert + '</span>';
        showResult(t.resultText, 'warn');
        reorderCard();
      }
      updateToolsHeader(round, block);
    }

    body.querySelector('.retry-btn').addEventListener('click', function (e) {
      e.stopPropagation();
      if (chat.opts.onRetry) chat.opts.onRetry(round);
    });

    bindCollapseTrigger(header, api, {});
    ctrl.update(msg);
    block.cardsWrap.appendChild(root);
    block.count++;
    round.toolCards.set(tc.toolCallId, ctrl);
    chat.register(msg.id, ctrl, round);
    updateToolsHeader(round, block);
  }

  // Skill 载入：可折叠卡片（展开显示「结果」模块，内为 skill 的 description），样式对齐内置工具卡
  function mountSkill(chat, msg, round) {
    if (round.lastTextCtrl && round.lastTextCtrl.streaming) round.lastTextCtrl.finish(false);
    var root = el('div', 'msg skill-bar status-running');
    var header = el('div', 'tool-header');
    header.setAttribute('role', 'button');
    header.setAttribute('tabindex', '0');
    header.innerHTML =
      '<span class="tool-icon"><span class="t-spinner-sm"></span></span>' +
      '<span class="tool-title"></span>' +
      '<span class="tool-ind"></span>' +
      chevHtml();
    var body = el('div', 'tool-body');
    body.innerHTML =
      '<div class="tool-sec tool-result-sec" style="display:none">' +
        '<div class="tool-subhead">' + round.cfg.text.skillDesc +
          '<span class="result-status-icon"></span>' +
          '<button type="button" class="clip-copy" title="复制" style="display:none">' + ICONS.copy + '</button>' +
        '</div>' +
        '<div class="tool-result-text"></div>' +
        '<div class="tool-error" style="display:none"></div>' +
      '</div>';
    root.appendChild(header);
    root.appendChild(body);
    round.el.appendChild(root);

    var api = makeCollapsible(header, body, {
      expanded: false,
      onUserToggle: function () { round.userTouched.add('skill'); }
    });
    bindCollapseTrigger(header, api, {});

    var ctrl = {
      root: root,
      api: api,
      status: '',
      startTime: Date.now(),
      update: function (m) { setStatus(m.toolCall); }
    };

    var showResult = makeToolResultShower(body, round.cfg);

    function setStatus(t) {
      var st = t.status;
      if (st === ctrl.status) return;
      ctrl.status = st;
      root.className = 'msg skill-bar status-' + st;
      var title = header.querySelector('.tool-title');
      var iconEl = header.querySelector('.tool-icon');
      var ind = header.querySelector('.tool-ind');
      var name = t.toolName;
      if (st === 'running') {
        title.innerHTML = round.cfg.text.callSkill + ' ' + ICONS.skill + toolNameTag(name);
        iconEl.innerHTML = '<span class="t-spinner-sm"></span>';
      } else if (st === 'done') {
        title.innerHTML = round.cfg.text.callSkill + ' ' + ICONS.skill + toolNameTag(name) + ' · ' + round.cfg.text.cost + ' ' + fmtDuration(Date.now() - ctrl.startTime);
        iconEl.innerHTML = ICONS.circle;
        ind.innerHTML = '<span class="status-check">' + ICONS.check + '</span>';
        showResult(t.resultText, 'ok');
      } else if (st === 'failed') {
        title.innerHTML = round.cfg.text.callSkill + ' ' + ICONS.skill + toolNameTag(name);
        iconEl.innerHTML = ICONS.cross;
        showResult(t.resultText, 'error');
      } else if (st === 'warn') {
        title.innerHTML = round.cfg.text.callSkill + ' ' + ICONS.skill + toolNameTag(name);
        iconEl.innerHTML = ICONS.alert;
        showResult(t.resultText, 'warn');
      }
    }

    ctrl.update(msg);
    round.auxCtrls.push(ctrl);
    chat.register(msg.id, ctrl, round);
  }

  // MCP 调用：独立卡片（含参数/结果正文，默认展开），执行结束静态显示 USB 图标
  function mountMcp(chat, msg, round) {
    if (round.lastTextCtrl && round.lastTextCtrl.streaming) round.lastTextCtrl.finish(false);
    var tc = msg.toolCall;
    var block = ensureToolsBlock(round, tc.mcpType || 'tool');
    var root = el('div', 'msg mcp-card status-running');
    root.dataset.toolId = tc.toolCallId;
    var header = el('div', 'tool-header');
    header.setAttribute('role', 'button');
    header.setAttribute('tabindex', '0');
    header.innerHTML =
      '<span class="tool-icon"><span class="t-spinner-sm"></span></span>' +
      '<span class="tool-title"></span>' +
      '<span class="tool-ind"></span>' +
      chevHtml();
    var body = el('div', 'tool-body');
    body.innerHTML = toolCardBodyHtml(round.cfg);
    fillClippedSection(body.querySelector('.tool-json'), body.querySelector('.tool-sec .clip-copy'), formatArgs(tc.args, round.cfg), rawArgs(tc.args));
    root.appendChild(header);
    root.appendChild(body);
    block.cardsWrap.appendChild(root);

    var api = makeCollapsible(header, body, {
      expanded: false,
      onUserToggle: function () { round.userTouched.add('tools'); }
    });
    bindCollapseTrigger(header, api, {});

    var ctrl = {
      root: root,
      api: api,
      block: block,
      status: '',
      startTime: Date.now(),
      update: function (m) { setStatus(m.toolCall); }
    };

    var showResult = makeToolResultShower(body, round.cfg);

    function reorderCard() {
      var wrap = block.cardsWrap;
      var cards = Array.prototype.slice.call(wrap.children);
      var firstPending = null;
      for (var i = 0; i < cards.length; i++) {
        if (cards[i].getAttribute('data-status') === 'running') { firstPending = cards[i]; break; }
      }
      if (firstPending && firstPending !== root) wrap.insertBefore(root, firstPending);
    }

    function setStatus(t) {
      var st = t.status;
      if (st === ctrl.status) return;
      ctrl.status = st;
      root.className = 'msg mcp-card status-' + st;
      root.setAttribute('data-status', st);
      var title = header.querySelector('.tool-title');
      var iconEl = header.querySelector('.tool-icon');
      var ind = header.querySelector('.tool-ind');
      var name = t.toolName;
      ctrl.name = name;
      var typeLabel = round.cfg.mcpType.labels[t.mcpType] || round.cfg.text.builtinTool;
      var typeIcon = round.cfg.mcpType.icons[t.mcpType] || ICONS.mcpTool;
      var typeIconTag = '<span class="tool-inline-icon">' + typeIcon + '</span>';
      if (st === 'running') {
        title.innerHTML = round.cfg.text.callMcp + typeLabel + ' ' + typeIconTag + toolNameTag(name);
        iconEl.innerHTML = '<span class="t-spinner-sm"></span>';
        ind.innerHTML = '';
      } else if (st === 'done') {
        title.innerHTML = round.cfg.text.callMcp + typeLabel + ' ' + typeIconTag + toolNameTag(name) + ' · ' + round.cfg.text.cost + ' ' + fmtDuration(Date.now() - ctrl.startTime);
        iconEl.innerHTML = ICONS.circle;
        ind.innerHTML = '<span class="status-check">' + ICONS.check + '</span>';
        reorderCard();
        showResult(t.resultText, 'ok', function () {
          if (!round.userTouched.has('tools')) api.collapse();
        });
      } else if (st === 'failed') {
        title.innerHTML = round.cfg.text.callMcp + typeLabel + ' ' + typeIconTag + toolNameTag(name) + ' ' + round.cfg.text.execFailed;
        iconEl.innerHTML = ICONS.circle;
        ind.innerHTML = '<span class="status-cross">' + ICONS.cross + '</span>';
        showResult(t.resultText, 'error');
        reorderCard();
      } else if (st === 'warn') {
        title.innerHTML = round.cfg.text.callMcp + typeLabel + ' ' + typeIconTag + toolNameTag(name) + ' ' + round.cfg.text.execWarn;
        iconEl.innerHTML = ICONS.circle;
        ind.innerHTML = '<span class="status-alert">' + ICONS.alert + '</span>';
        showResult(t.resultText, 'warn');
        reorderCard();
      }
      updateToolsHeader(round, block);
    }

    body.querySelector('.retry-btn').addEventListener('click', function (e) {
      e.stopPropagation();
      if (chat.opts.onRetry) chat.opts.onRetry(round);
    });

    ctrl.update(msg);
    block.count++;
    round.toolCards.set(tc.toolCallId, ctrl);
    chat.register(msg.id, ctrl, round);
    updateToolsHeader(round, block);
  }

  // 文件卡片：全宽、显示文件名、右下角下载按钮
  function mountFile(chat, msg, round) {
    var f = msg.file || {};
    var name = f.name || 'file';
    var root = el('div', 'msg file-card');
    root.innerHTML =
      '<div class="file-row">' +
        '<span class="file-icon">' + ICONS.read + '</span>' +
        '<span class="file-name">' + esc(name) + '</span>' +
      '</div>' +
      '<button type="button" class="file-download" title="' + round.cfg.text.download + '">' + ICONS.down + '<span>' + round.cfg.text.download + '</span></button>';
    round.el.appendChild(root);
    root.querySelector('.file-download').addEventListener('click', function (e) {
      e.stopPropagation();
      downloadFile(name, f.content || '');
    });
    chat.register(msg.id, { root: root, update: function () {} }, round);
  }

  function linkToolResult(chat, msg, round) {
    var card = round.toolCards.get(msg.toolResult.toolCallId);
    var ctrl = {
      root: null,
      update: function (m) {
        if (card && card.ingestResult) card.ingestResult(m.toolResult.content);
      }
    };
    if (card && card.ingestResult) card.ingestResult(msg.toolResult.content);
    chat.register(msg.id, ctrl, round);
  }

  // 把「中间过程」所有块收进一个容器，便于对整段做统一的推拉门高度动画。
  // 只跳过总结栏（顶部）与最终回答（底部），其余（思考/工具块/中间说明/辅助）按原 DOM 顺序搬入。
  function wrapRoundMiddle(round) {
    if (round.middle) return round.middle;
    var middle = el('div', 'round-middle');
    var summaryBar = round.summaryBar;
    var finalRoot = round.lastTextCtrl ? round.lastTextCtrl.root : null;
    var children = Array.prototype.slice.call(round.el.children);
    children.forEach(function (child) {
      if (child === summaryBar || child === finalRoot) return;
      middle.appendChild(child);
    });
    // 插到总结栏之后、最终回答之前
    if (summaryBar && summaryBar.parentNode === round.el) {
      round.el.insertBefore(middle, summaryBar.nextSibling);
    } else if (finalRoot && finalRoot.parentNode === round.el) {
      round.el.insertBefore(middle, finalRoot);
    } else {
      round.el.appendChild(middle);
    }
    round.middle = middle;
    return middle;
  }

  function foldRoundMiddle(round) {
    round.finished = true;
    // 执行完成后只展示「任务总结栏（上）+ 最终回答（下）」：整段中间过程折叠，由总结栏点击展开
    wrapRoundMiddle(round);
    // 归档时停掉仍在转的思考动效，避免隐藏后继续空转
    round.thinkingCtrls.forEach(function (c) { if (c.orb) c.orb.stop(); });
    round.toolsBlocks.forEach(function (b) { updateToolsHeader(round, b); });
    if (round.middleApi) round.middleApi.collapse();
  }

  function mountSummary(chat, msg, round) {
    var s = msg.agentSummary;
    var bar = el('div', 'summary-bar');
    bar.setAttribute('role', 'button');
    bar.setAttribute('tabindex', '0');
    bar.setAttribute('aria-expanded', 'false');
    bar.innerHTML =
      '<span class="s-icon">' + ICONS.summary + '</span>' +
      '<span class="s-text">' + round.cfg.text.summaryLead + s.taskCount + round.cfg.text.summaryTasks + fmtDuration(s.durationMs) + '</span>' +
      chevHtml();
    // 总结栏固定在最顶部，最终回答与中间过程都在其下方
    round.el.insertBefore(bar, round.el.firstChild);
    round.summaryBar = bar;

    // 中间过程整段用推拉门动画折叠/展开
    var middle = wrapRoundMiddle(round);
    var middleApi = makeCollapsible(bar, middle, { expanded: true });
    round.middleApi = middleApi;

    // 展开前把内部各层子折叠「瞬时」归位，避免「先展开再折叠」的闪现
    function resetInnerCollapse() {
      round.thinkingCtrls.forEach(function (c) { c.api.instantCollapse(); });
      round.toolsBlocks.forEach(function (b) {
        b.api.instantCollapse();
        round.toolCards.forEach(function (c) { if (c.block === b) c.api.instantCollapse(); });
      });
      round.auxCtrls.forEach(function (c) { if (c.api) c.api.instantCollapse(); });
    }

    function toggleMiddle() {
      if (middleApi.isExpanded()) {
        middleApi.collapse();
      } else {
        resetInnerCollapse();
        middleApi.expand();
      }
    }
    bar.addEventListener('click', toggleMiddle);
    bar.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        toggleMiddle();
      }
    });

    chat.register(msg.id, { root: bar, update: function () {} }, round);
    foldRoundMiddle(round);
  }

  /* ================= AgentChat 主控制器 ================= */

  function AgentChat(listEl, opts) {
    this.listEl = listEl;
    this.opts = opts || {};
    this.cfg = buildCfg(this.opts);
    this.controllers = new Map();
    this.rounds = [];
    this.currentRound = null;
    this.pending = new Map();
    this._rafScheduled = false;
    this.follow = true;
    this.lastUserText = '';

    var self = this;
    listEl.addEventListener('scroll', function () {
      var nearBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 120;
      if (self.follow !== nearBottom) {
        self.follow = nearBottom;
        if (self.opts.onFollowChange) self.opts.onFollowChange(nearBottom);
      }
    });

    // 复制按钮（事件委托）：代码块复制 + 截断区静默复制，共用一个监听器
    document.addEventListener('click', function (e) {
      var t = e.target;
      var codeBtn = t.closest ? t.closest('.code-copy') : null;
      if (codeBtn) {
        var pre = codeBtn.closest('.code-block').querySelector('pre');
        copyText(pre.textContent, function (ok) {
          if (ok) {
            var span = codeBtn.querySelector('span');
            if (span) span.textContent = self.cfg.text.copied;
            setTimeout(function () { if (span) span.textContent = self.cfg.text.copy; }, 2000);
          }
        });
        return;
      }
      var clipBtn = t.closest ? t.closest('.clip-copy') : null;
      if (clipBtn) {
        copyText(clipBtn._copyText || '', function () {});
      }
    });
  }

  AgentChat.prototype.register = function (id, ctrl, round) {
    ctrl.round = round || null;
    this.controllers.set(id, ctrl);
  };

  AgentChat.prototype.enqueue = function (msg) {
    this.pending.set(msg.id, msg);
    if (!this._rafScheduled) {
      this._rafScheduled = true;
      var self = this;
      requestAnimationFrame(function () {
        self._rafScheduled = false;
        self.flush();
      });
    }
  };

  AgentChat.prototype.flush = function () {
    if (this.pending.size === 0) return;
    var msgs = Array.from(this.pending.values());
    this.pending.clear();
    for (var i = 0; i < msgs.length; i++) this.upsert(msgs[i]);
    this.requestScroll();
  };

  AgentChat.prototype.closeRound = function () {
    this.currentRound = null;
  };

  AgentChat.prototype.ensureRound = function () {
    if (this.currentRound) return this.currentRound;
    var root = el('div', 'agent-round');
    this.listEl.appendChild(root);

    var round = {
      id: 'r' + Date.now() + Math.random().toString(36).slice(2, 6),
      el: root,
      userText: this.lastUserText || '',
      cfg: this.cfg,
      toolCards: new Map(),
      toolSeq: 0,
      toolsBlocks: [],
      activeToolsBlock: null,
      thinkingCtrls: [],
      auxCtrls: [],
      textCtrls: [],
      lastTextCtrl: null,
      summaryBar: null,
      toolbar: null,
      userTouched: new Set(),
      finished: false
    };
    this.currentRound = round;
    this.rounds.push(round);
    return round;
  };

  AgentChat.prototype.upsert = function (msg) {
    var ctrl = this.controllers.get(msg.id);
    if (ctrl) {
      ctrl.update(msg);
      return;
    }
    if (msg.isSelf && msg.type === 'text') {
      mountUser(this, msg);
      return;
    }
    var round = this.ensureRound();

    switch (msg.type) {
      case 'thinking': mountThinking(this, msg, round); break;
      case 'text': mountAgentText(this, msg, round); break;
      case 'toolCall':
        if (msg.toolCall && msg.toolCall.toolType === 'skill') mountSkill(this, msg, round);
        else if (msg.toolCall && msg.toolCall.toolType === 'mcp') mountMcp(this, msg, round);
        else mountToolCall(this, msg, round);
        break;
      case 'toolResult': linkToolResult(this, msg, round); break;
      case 'file': mountFile(this, msg, round); break;
      case 'agentSummary': mountSummary(this, msg, round); break;
    }
  };

  AgentChat.prototype.showToolbar = function (round) {
    if (round.toolbar) return;
    var bar = el('div', 'msg-toolbar');
    bar.innerHTML =
      '<button type="button" class="tb-btn" data-act="copy" title="' + this.cfg.text.copy + '" aria-label="' + this.cfg.text.copy + '">' + ICONS.copy + '</button>' +
      '<button type="button" class="tb-btn" data-act="regen" title="' + this.cfg.text.regenerate + '" aria-label="' + this.cfg.text.regenerate + '">' + ICONS.retry + '</button>';
    var chat = this;
    bar.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.tb-btn') : null;
      if (!btn) return;
      var act = btn.dataset.act;
      if (act === 'copy') {
        var text = round.lastTextCtrl ? round.lastTextCtrl.raw : '';
        if (!text) {
          if (chat.opts.toast) chat.opts.toast(chat.cfg.text.nothingToCopy);
          return;
        }
        copyText(text, function (ok) {
          if (chat.opts.toast) chat.opts.toast(ok ? chat.cfg.text.copied : chat.cfg.text.copyFailed);
        });
      } else if (act === 'regen') {
        if (chat.opts.onRegenerate) chat.opts.onRegenerate(round);
      }
    });
    round.el.appendChild(bar);
    round.toolbar = bar;
  };

  AgentChat.prototype.completeCurrentRound = function () {
    this.flush();
    var round = this.currentRound;
    if (!round) return;
    if (round.lastTextCtrl) round.lastTextCtrl.finish(false);
    this.showToolbar(round);
    this.currentRound = null;
    this.requestScroll();
  };

  AgentChat.prototype.abortCurrentRound = function () {
    this.flush();
    var round = this.currentRound;
    if (!round) return;
    if (round.lastTextCtrl) {
      round.lastTextCtrl.finish(true);
    } else {
      round.el.appendChild(el('div', 'stopped-note', this.cfg.text.stopped));
    }
    round.thinkingCtrls.forEach(function (c) {
      if (!c.done) {
        c.done = true;
        if (c.orb) c.orb.stop();
        var title = c.root.querySelector('.t-title');
        if (title) title.textContent = this.cfg.text.thinkingInterrupted;
        var meta = c.root.querySelector('.t-meta');
        if (meta) meta.innerHTML = '';
        c.root.classList.add('is-done');
      }
      c.api.collapse();
    });
    round.toolsBlocks.forEach(function (b) {
      // 停掉外层液态球，图标换成普通圆点
      if (b.runOrb) {
        b.runOrb.stop();
        b.runOrb = null;
      }
      var iconEl = b.header.querySelector('.tools-icon');
      if (iconEl) iconEl.innerHTML = ICONS.circle;
      var anyRunning = false;
      round.toolCards.forEach(function (c) {
        if (c.block === b && c.status === 'running') anyRunning = true;
      });
      if (anyRunning) {
        var tt = b.header.querySelector('.tools-title');
        if (tt) tt.textContent = this.cfg.text.callCount + ' ' + b.count + ' 次' + blockLabel(b.kind, this.cfg) + this.cfg.text.interruptedTail;
      }
      b.api.collapse();
    });
    this.showToolbar(round);
    this.currentRound = null;
    this.requestScroll();
  };

  AgentChat.prototype.removeRound = function (round) {
    var self = this;
    this.controllers.forEach(function (ctrl, id) {
      if (ctrl.round === round) self.controllers.delete(id);
    });
    if (round.el && round.el.parentNode) round.el.parentNode.removeChild(round.el);
    var i = this.rounds.indexOf(round);
    if (i !== -1) this.rounds.splice(i, 1);
    if (this.currentRound === round) this.currentRound = null;
  };

  AgentChat.prototype.clearAll = function () {
    this.controllers.clear();
    this.rounds = [];
    this.currentRound = null;
    this.pending.clear();
    this.listEl.innerHTML = '';
  };

  AgentChat.prototype.requestScroll = function () {
    if (this.follow) this.listEl.scrollTop = this.listEl.scrollHeight;
  };

  AgentChat.prototype.scrollToBottom = function () {
    this.follow = true;
    this.listEl.scrollTop = this.listEl.scrollHeight;
    if (this.opts.onFollowChange) this.opts.onFollowChange(true);
  };

  global.AgentChat = AgentChat;
})(window);
