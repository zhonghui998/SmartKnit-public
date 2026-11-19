// 模板驱动定制器：按 /api/product/<id>/template 自动渲染控件
(function () {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  let products = [];
  let currentTemplate = null;
  let currentPid = null;
  let bagBackPanel = 'plain';   // 袋类背面織片：plain=淨色袋身 / pattern=與正面相同圖案
  let taOrder = 'image_top';    // 相片+文字袋（myo_art_tote）：image_top=相片在文字上 / text_top=文字在相片上
  let linkedSel = null;         // 聯動顏色選中值（模板 color_link：登機牌「文字+條碼」、吊牌「左右欄文字」共用一色）
  let linkedKeysCached = null;  // 聯動 key 集合（renderControls 時刷新，供 collectParams/designColors 判斷）
  let currentDesign = null; // AI 生图后得到的 base64 针织化设计图
  let sketchOrder = { text: '', shapes: [], mode: 'standard' }; // 手繪匙扣識別確認後的內容（進生產郵件；mode: standard=黑體豎排 / ai=AI重繪）
  let currentView = null;   // 多视图产品（MYO）当前视图 id
  let lockedPid = null;     // 锁定模式（产品页 Customize 进入）下强制使用的产品 id

  // 文字色撞色即時檢查用：承印部件（tag）的 code→hex 映射，renderControls 時填充
  let _textColorTargetHexes = {};
  let _textColorBaseKey = 'tag';

  // demo2 渲染器（W&C vertical tote）：实时预览 + 三组色板（Bag / Strap / Text）
  // Bag / Strap 的色源 = 产品 JSON 里 components[].type === "color_variant" 的 variants
  //（每项含 code/hex/file），不再在前端硬编码 hex（旧实现固定 8 色，与后端不一致）。
  const DEMO2_TEXT_COLORS = ["#FDFEFE", "#1F1B16", "#E2B862", "#A72D29", "#E6AEC1", "#5E96C4", "#4A8155", "#B0B3B7"]; // 另有 AUTO（null）
  // artwork 區默認上傳文案（非手繪類產品恢復用）
  const DEFAULT_ARTWORK_HINT = '我們會把你的相片重繪成適合針織的清晰圖案。JPG 或 PNG，最大 10MB。 We&rsquo;ll redraw your photo into a clean, knit-friendly design. JPG or PNG, up to 10&nbsp;MB.';
  const demo2State = {
    bagColor: null,   // null = 未选色，交由后端默认色处理
    strapColor: null,
    textColor: null,  // null = AUTO（按提手深浅自动适配）
    view: 'front',    // front/back 同图
  };

  // ── 嵌入（Shopify iframe）模式：确认设计后回传父页面的契约 ──
  // 面向香港客户：彈層文案一律「繁體中文 English」雙語（提示類已有繁體）
  const LK_MESSAGE_TYPE = 'LK_DESIGN_READY';
  const CONFIRM_LABEL = '確認設計 Confirm design';
  const CONFIRM_LABEL_LOADING = '正在儲存設計… Saving…';
  const CONFIRM_LABEL_DONE = '設計已儲存 ✓ Saved ✓';
  // postMessage 的 targetOrigin：来自 ?parent=<origin>，缺省回退 '*'
  let parentOrigin = '*';
  // 确认中标记，防止重复点击
  let confirming = false;

  // 该模板是否走 demo2 渲染器（仅 wct_v_tote）
  function isDemo2() {
    return !!(currentTemplate && currentTemplate.renderer === 'demo2');
  }

  // ── 可織文字：清洗規則集中在 /static/js/lk-text.js（與後端 normalize_text 逐字一致）──
  // 綁定（含輸入法保護）也在 lk-text.js，這裡只傳入欄位設定，避免兩處各寫一份而走樣。
  // 防禦：若 lk-text.js 未載入，退回最小實作（僅轉大寫），不讓整個定制器崩掉。
  const LK = window.LKText || {
    clean: (v) => ({ value: String(v || '').trim().toUpperCase(), hadApostrophe: false, hadOther: false }),
    hint: (len, max) => `${len} / ${max} 個字`,
    bindText: null,
  };
  /**
   * 綁定單一文字輸入框：清洗 + 繁體提示 + 延遲預覽。
   * 中文輸入法合成期間不改寫 input.value（見 lk-text.js 的說明）。
   */
  function lkBindTextInput(input, ta, hintEl, onInput) {
    const max = ta.maxlen || 21;
    const onHint = (len, result) => {
      if (hintEl) hintEl.textContent = LK.hint(len, max, result, ta.charset === 'cjk', ta.charset);
    };
    if (LK.bindText) {
      LK.bindText(input, { charset: ta.charset, maxlen: max, onHint, onInput });
      return;
    }
    // 降級路徑（lk-text.js 未載入）：至少不要在合成期間改值
    const handler = (e) => {
      if (e && (e.isComposing || input._lkComposing)) return;
      const result = LK.clean(input.value, ta.charset);
      input.value = result.value;
      onHint(input.value.length, result);
      if (onInput) onInput();
    };
    input.addEventListener('compositionstart', () => { input._lkComposing = true; });
    input.addEventListener('compositionend', () => { input._lkComposing = false; handler(); });
    input.addEventListener('input', handler);
    onHint(input.value.length, null);
  }

  /**
   * 取模板中指定 target 的 color_variant 变体列表。
   * @param {string} target 组件 target 名，如 'bag' / 'strap'
   * @returns {Array<Object>} variants 数组，元素形如 {code, hex, file}；无则空数组
   */
  function getVariants(target) {
    const comps = (currentTemplate && currentTemplate.components) || [];
    const comp = comps.find(c => c && c.type === 'color_variant' && c.target === target);
    return (comp && comp.variants) || [];
  }

  /**
   * 取 demo2 某一组色板的 hex 列表：优先 color_variant.variants，回退 palette[key]。
   * @param {string} target 组件 target 名
   * @returns {Array<string>} hex 字符串数组
   */
  function getDemo2Colors(target) {
    const hexes = getVariants(target).map(v => v && v.hex).filter(Boolean);
    if (hexes.length) return hexes;
    const palette = (currentTemplate && currentTemplate.palette) || {};
    return (palette[target] || []).slice();
  }

  // 初始化：拉产品列表
  async function init() {
    try {
      const qs = new URLSearchParams(location.search);
      // 嵌入模式（产品页 Customize 弹层内 iframe 加载）：隐藏站头/面包屑/页脚
      if (qs.get('embed') === '1') {
        document.body.classList.add('embed');
        setupConfirmButton();
      }
      // 回传父页面的目标 origin：?parent=https%3A%2F%2Fxxx.myshopify.com
      // URLSearchParams.get 已解一层码，这里再 decodeURIComponent 兜底二次编码的情况。
      parentOrigin = resolveParentOrigin(qs.get('parent'));
      // 锁定模式（产品页 Customize 进入）：隐藏产品选择器，直接定制当前产品；非锁定模式则显示供自由切换
      const selWrap = document.getElementById('product-select-wrap');
      if (qs.get('lock') === '1') {
        if (selWrap) selWrap.style.display = 'none';
      } else if (selWrap) {
        selWrap.style.display = 'block';
      }
      const res = await fetch('/api/products');
      const data = await res.json();
      products = data.products || [];
      const sel = $('#product-select');
      sel.innerHTML = products.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
      sel.addEventListener('change', () => loadTemplate(sel.value));
      const pre = qs.get('product');
      // 锁定模式下：强制使用 URL 指定的产品，并让下拉框也反映该值（否则预览会回退到第一项）
      if (pre && products.find(p => p.id === pre)) {
        lockedPid = pre;
        sel.value = pre;
      }
      // 锁定模式但产品缺失/未知：说明商品页的 handle → pid 映射没配置
      // （lk-customizer-config.liquid 缺 when 行）。绝不能静默兜底到 products[0]，
      // 否则客户在横款托特页点 Customize 打开的却是别的产品（2026-11-01 实例）。
      if (qs.get('lock') === '1' && !lockedPid) {
        const card = document.getElementById('preview-card');
        if (card) {
          card.innerHTML =
            '<div style="padding:48px 24px;text-align:center;font-size:15px;line-height:1.9;color:#666">' +
            '此商品的定制器尚未綁定，請聯絡店家。<br>' +
            'This product is not linked to the customiser yet — please contact the store.</div>';
        }
        return;
      }
      const preId = lockedPid || (products[0] && products[0].id);
      const atc = $('#add-to-cart-btn');
      if (atc) atc.onclick = addToCart;
      if (products.length) await loadTemplate(preId);
    } catch (e) {
      console.error(e);
    }
  }

  async function loadTemplate(pid) {
    try {
      currentPid = pid;
      bagBackPanel = 'plain';   // 切换产品重置背面織片选择
      taOrder = 'image_top';    // 切换产品重置图文层级
      const res = await fetch(`/api/product/${pid}/template`);
      const data = await res.json();
      currentTemplate = data.template;
      // 填充产品标题 / 价格 / 面包屑（让定制页长得像原站产品页）
      const nm = currentTemplate.name || '';
      const nmEl = $('#product-name'); if (nmEl) nmEl.textContent = nm;
      const bcEl = $('#product-name-bc'); if (bcEl) bcEl.textContent = nm;
      const prEl = $('#product-price');
      if (prEl) {
        // Shopify 传入的实付价（iframe URL &price=）优先于引擎 JSON 价格，防止两侧漂移
        const urlPrice = new URLSearchParams(location.search).get('price');
        const shown = urlPrice ? '$' + urlPrice : currentTemplate.price;
        if (shown) { prEl.textContent = shown; prEl.style.display = 'block'; }
        else { prEl.style.display = 'none'; }
      }
      // L2 产品信息区：描述 + 主图（克隆站原图；无则隐藏主图区）
      const descEl = $('#product-desc');
      if (descEl && currentTemplate.description) {
        descEl.textContent = currentTemplate.description;
      }
      const heroWrap = $('#product-hero-wrap');
      const heroImg = $('#product-hero');
      if (heroWrap && heroImg) {
        // hide_hero（方案 X 产品：登机牌/吊牌/WCT 三件套，保留 color_variant 管线但隐藏 og:image
        // 成品主图，预览区直接显示实时设计视图）与 demo2 一样不显示 hero。
        if (!isDemo2() && !currentTemplate.hide_hero && currentTemplate.image) {
          heroImg.src = currentTemplate.image;
          heroImg.alt = nm || 'Product image';
          heroWrap.classList.remove('hidden');
        } else {
          // demo2 / hide_hero：不显示 og:image 成品主图，只用实时预览
          heroWrap.classList.add('hidden');
          heroImg.removeAttribute('src');
        }
      }
      // 多视图产品：默认视图（front）或模板 default_view
      const vnames = Object.keys(currentTemplate.views || {});
      currentView = (vnames.length && currentTemplate.default_view && vnames.includes(currentTemplate.default_view))
        ? currentTemplate.default_view : (vnames[0] || null);
      currentDesign = null;
      renderControls();
      autoPreview();
    } catch (e) {
      console.error(e);
    }
  }

  function renderControls() {
    const t = currentTemplate;
    const defs = t.defaults || {};

    // demo2 渲染器（wct_v_tote）：独立的 Bag/Strap/Text 三组 swatch + Front/Back 视图，
    // 完全不触碰其他产品的通用渲染逻辑
    if (isDemo2()) {
      renderDemo2Controls();
      return;
    }

    // 多视图产品：合并当前视图的组件/文字区到顶层，其余逻辑完全复用
    const views = t.views || {};
    const vnames = Object.keys(views);
    if (currentView && views[currentView]) {
      t.components = views[currentView].components || t.components || [];
      if (views[currentView].text_areas) t.text_areas = views[currentView].text_areas;
    }
    // 全部视图组件（用于 color_variant / artwork 扫描，避免只扫当前视图漏掉面板）
    const allComps = (t.components || []).concat(
      ...Object.values(views).map(v => (v && v.components) || [])
    );

    // 视图切换栏（仅多视图产品显示）
    const viewSec = $('#view-sections');
    const viewNote = $('#view-note');
    const hasArtAny = allComps.some(c => c.artwork);
    if (vnames.length) {
      viewSec.classList.remove('hidden');
      viewNote.classList.add('hidden');
      const tabs = $('#view-tabs');
      tabs.innerHTML = vnames.map(v => {
        const vobj = views[v] || {};
        const label = vobj.label || v;
        return `<button type="button" class="view-tab${v === currentView ? ' active' : ''}"
                 data-view="${v}">${label}</button>`;
      }).join('');
      tabs.querySelectorAll('.view-tab').forEach(btn => {
        btn.onclick = () => {
          if (btn.dataset.view === currentView) return;
          currentView = btn.dataset.view;
          renderControls();
          autoPreview();
        };
      });
    } else if (hasArtAny) {
      // 袋类：有正反面（背面为净色袋身）；挂画/杯垫/鼠标垫：单面产品，不分正反面
      const isBag = /_(tote|crossbody)$/.test(currentPid || '');
      if (isBag) {
        viewSec.classList.remove('hidden');
        // 背面織片选项：淨色袋身（默认）/ 與正面相同圖案
        const backOpts = [['plain', '淨色袋身 Plain'], ['pattern', '與正面相同圖案 Same as front']];
        $('#view-tabs').innerHTML = backOpts.map(([v, l]) =>
          `<button type="button" class="view-tab${v === bagBackPanel ? ' active' : ''}" data-back="${v}">${l}</button>`
        ).join('');
        $('#view-tabs').querySelectorAll('.view-tab').forEach(btn => {
          btn.onclick = () => {
            if (btn.dataset.back === bagBackPanel) return;
            bagBackPanel = btn.dataset.back;
            renderControls();
          };
        });
        viewNote.textContent = bagBackPanel === 'pattern'
          ? '相片圖案會織在袋身正面及背面。 Your photo is knitted on both the front and the back panel.'
          : '相片圖案織在袋身正面；背面為淨色袋身，不顯示圖案。 Your photo is knitted on the front panel; the back of the bag is plain, with no image.';
        viewNote.classList.remove('hidden');
      } else {
        // 单面产品（挂画 A3/A4/A5、杯垫、鼠标垫）：不谈正反面
        viewSec.classList.add('hidden');
      }
    } else {
      viewSec.classList.add('hidden');
    }

    // 哪些组件是 color_variant？按 target 建立映射（如 bag/strap）
    const variantMap = {};
    allComps.forEach(c => {
      if (c.type === 'color_variant' && c.target) {
        variantMap[c.target] = c.variants || [];
      }
    });

    // 顏色聯動（模板 color_link）：客戶只選一次，多個部位共用同一色。
    // 登機牌：條碼 + 全部文字欄一色；basic tag：左右欄文字一色。
    // 聯動的 key 不再各自渲染色卡行，只渲染一行（見下方 buildLinkedColorRow），
    // 提交時由 collectParams / designColors 統一取 linkedSel。
    const cl = (t.color_link && t.color_link.keys && t.color_link.keys.length) ? t.color_link : null;
    const linkedKeys = cl ? new Set(cl.keys) : null;
    linkedKeysCached = linkedKeys;
    linkedSel = cl ? ((t.defaults || {})[cl.keys[0]] || 'AUTO') : null;
    // 文字色撞色檢查用：承印部件（第一欄文字的 auto_color_target，缺省 tag）code→hex
    _textColorTargetHexes = {};
    const t0 = (t.text_areas || [])[0];
    _textColorBaseKey = (t0 && (t0.auto_color_target || 'tag')) || 'tag';
    const baseTarget = _textColorBaseKey;
    (variantMap[baseTarget] || []).forEach(v => {
      _textColorTargetHexes[v.code || v.file] = v.hex || '#FFFFFF';
    });

    // 颜色区：color_variant 用其 variants，其它继续用 palette。
    // 渲染 key 集 = palette keys ∪ variantMap keys（去重）：即使 palette 值为空数组
    // （如 wct_computer 的 {"bag":[],"flap":[],"strap":[]}），也能按 color_variant 色卡渲染。
    const colorWrap = $('#color-sections');
    colorWrap.innerHTML = '';
    const palette = t.palette || {};
    const colorKeys = Array.from(new Set([...Object.keys(palette), ...Object.keys(variantMap)]));
    colorKeys.forEach((key) => {
      // 聯動部位（如登機牌條碼）不單獨渲染色卡行，併入聯動行
      if (cl && key === cl.zone) return;
      const colors = palette[key] || [];
      const group = document.createElement('div');
      group.className = 'color-group';
      group.innerHTML = `<label>${labelFor(key)}</label><div class="swatch-list" data-key="${key}"></div>`;
      const list = group.querySelector('.swatch-list');
      const variants = variantMap[key];
      if (variants && variants.length) {
        variants.forEach(v => {
          const code = v.code || v.file;
          const s = document.createElement('span');
          s.className = 'swatch' + (code === defs[key + '_color'] ? ' active' : '');
          s.style.backgroundColor = v.hex || '#ccc';
          s.dataset.color = code;
          s.title = code + (v.hex ? ' ' + v.hex : '');
          s.addEventListener('click', () => selectColor(key, code));
          list.appendChild(s);
        });
      } else {
        colors.forEach(c => {
          const isAuto = c === 'AUTO';
          const s = document.createElement('span');
          s.className = 'swatch' + (c === defs[key + '_color'] ? ' active' : '')
            + (isAuto ? ' swatch--auto' : '');
          if (!isAuto) s.style.backgroundColor = c;
          s.dataset.color = c;
          s.title = isAuto ? '自動 Auto（按底色自動選黑白）' : c;
          if (isAuto) s.textContent = 'A';
          s.addEventListener('click', () => selectColor(key, c));
          list.appendChild(s);
        });
      }
      colorWrap.appendChild(group);
    });

    // 針織上限提示：工廠每件最多 5 種紗線色——在色卡區就先講明，別等客戶選完才攔
    const maxC = Number(t.max_colors) || 0;
    if (maxC) {
      const note = document.createElement('div');
      note.className = 'color-max-note';
      note.textContent = `🧶 提醒：全件最多可織 ${maxC} 種顏色（各部位＋文字合計）。 Tip: up to ${maxC} yarn colours can be knitted per piece (all parts + wording combined).`;
      colorWrap.appendChild(note);
    }
    // 手繪匙扣：本體／圖案互斥規則先講明 + 一鍵互換出口
    // （嚴格禁用會出現「想用的色兩行都被佔」的死鎖，互換按鈕是唯一出口）
    if (t.palette && t.palette.ink) {
      const inkFixed = (t.palette.ink || []).length <= 1;
      const xnote = document.createElement('div');
      xnote.className = 'color-max-note';
      if (inkFixed) {
        xnote.textContent = '🧶 圖案（織字）固定用白色紗，本體可選紅／綠／灰。 Pattern & wording are knitted in white yarn; body: red / green / grey.';
      } else {
        xnote.textContent = '🔒 本體與圖案不能同色（同色圖案會看不見）：選了一邊，另一邊同色會變灰不可選。 '
          + 'Body and pattern can’t share a colour — the same swatch greys out on the other row.';
      }
      colorWrap.appendChild(xnote);
      if (!inkFixed) {
        const swapBtn = document.createElement('button');
        swapBtn.type = 'button';
        swapBtn.id = 'sketch-swap-colors';
        swapBtn.className = 'btn-secondary sketch-swap-btn';
        swapBtn.textContent = '⇄ 互換本體與圖案顏色 Swap body / pattern colours';
        swapBtn.addEventListener('click', swapSketchColors);
        colorWrap.appendChild(swapBtn);
      }
    }
    sketchColorSync();       // 手繪匙扣：套用兩行互斥（雙向禁用）

    // 文字区（支持多个文字字段：主文字 + From/To 等附加字段）
    const textSec = $('#text-section');
    const textAreas = t.text_areas || [];
    const extraWrap = $('#text-extra');
    if (extraWrap) extraWrap.innerHTML = '';
    if (textAreas.length) {
      textSec.classList.remove('hidden');
      const ta = textAreas[0];
      const mainKey = ta.param_key || 'text';
      const input = $('#text-input');
      const mainLabel = $('#text-main-label');
      if (mainLabel) mainLabel.textContent = ta.label || 'Your text';
      // 预填模板默认文字（如 KNIT TRIP / KNIT LOVER）
      input.value = (t.defaults && t.defaults[mainKey]) ? t.defaults[mainKey] : '';
      if (ta.charset === 'digits') input.inputMode = 'numeric';
      // 純字母欄（登機牌 To/From）：手機軟鍵盤直接給大寫、關掉自動更正／拼字建議，
      // 免得鍵盤把 "hkg" 改成別的字；實際內容仍由 lk-text.js 的 alpha 清洗兜底。
      if (ta.charset === 'alpha') {
        input.setAttribute('autocapitalize', 'characters');
        input.setAttribute('autocorrect', 'off');
        input.setAttribute('autocomplete', 'off');
        input.spellcheck = false;
      }
      // 不設 HTML maxlength：輸入法合成中途會被截斷（中文打不出來），長度改由 bindText 控
      input.removeAttribute('maxlength');
      // 清洗 + 提示與後端同一白名單（支援數字與常用標點；撇號自動移除並提示）
      lkBindTextInput(input, ta, $('#text-hint'), () => {
        clearTimeout(input._lkGenericTimer);
        input._lkGenericTimer = setTimeout(autoPreview, 300);
      });
      // 附加文字字段（boarding_pass 的 To/From 等，param_key 各自独立）
      if (extraWrap) {
        // 共用：每欄獨立文字顏色色卡行（basic tag 左右欄 / boarding pass 四欄）
        const buildColorRow = (eta) => {
          const crow = document.createElement('div');
          crow.className = 'text-extra-row text-color-row';
          const clab = document.createElement('span');
          clab.className = 'opt-label';
          clab.textContent = eta.color_label || '文字顏色 Text colour';
          const list = document.createElement('span');
          list.className = 'swatch-list swatch-list--inline';
          list.dataset.key = eta.color_key;
          const defSel = (t.defaults && t.defaults[eta.color_key]) || 'AUTO';
          eta.color_choices.forEach(ch => {
            const s = document.createElement('span');
            s.className = 'swatch' + (ch.code === defSel ? ' active' : '')
              + (ch.code === 'AUTO' ? ' swatch--auto' : '');
            s.style.backgroundColor = ch.hex || 'transparent';
            s.dataset.color = ch.code;
            s.title = ch.label || ch.code;
            s.addEventListener('click', () => {
              list.querySelectorAll('.swatch').forEach(x => x.classList.remove('active'));
              s.classList.add('active');
              updateTextColorHint(crow);
              updateColorCount();
              autoPreview();
            });
            list.appendChild(s);
          });
          const warn = document.createElement('small');
          warn.className = 'text-color-warn hidden';
          crow.appendChild(clab);
          crow.appendChild(list);
          crow.appendChild(warn);
          return crow;
        };
        // 聯動顏色行：客戶選一次色，多個部位（條碼＋文字欄／左右欄）共用同一色。
        // 選項取第一個聯動文字欄的 color_choices（AUTO + 色卡）。
        const buildLinkedColorRow = (clk, tpl) => {
          const ta0 = (tpl.text_areas || []).find(x => x.color_key === clk.keys[0]) || {};
          const choices = ta0.color_choices || [];
          if (!choices.length) return null;
          const crow = document.createElement('div');
          crow.className = 'text-extra-row text-color-row';
          const clab = document.createElement('span');
          clab.className = 'opt-label';
          clab.textContent = clk.label || '文字顏色 Text colour';
          const list = document.createElement('span');
          list.className = 'swatch-list swatch-list--inline';
          list.dataset.key = '__linked_color__';
          choices.forEach(ch => {
            const s = document.createElement('span');
            s.className = 'swatch' + (ch.code === linkedSel ? ' active' : '')
              + (ch.code === 'AUTO' ? ' swatch--auto' : '');
            s.style.backgroundColor = ch.hex || 'transparent';
            s.dataset.color = ch.code;
            s.title = ch.label || ch.code;
            s.addEventListener('click', () => {
              linkedSel = ch.code;
              list.querySelectorAll('.swatch').forEach(x => x.classList.remove('active'));
              s.classList.add('active');
              updateTextColorHint(crow);
              updateColorCount();
              autoPreview();
            });
            list.appendChild(s);
          });
          const warn = document.createElement('small');
          warn.className = 'text-color-warn hidden';
          crow.appendChild(clab);
          crow.appendChild(list);
          crow.appendChild(warn);
          return crow;
        };
        // 主文字欄也可自訂顏色（boarding pass 的 To）：色卡行放最前
        // 聯動 key 不單獨渲染（由 buildLinkedColorRow 統一出一行）
        if (ta.color_key && ta.color_choices && !(linkedKeys && linkedKeys.has(ta.color_key))) {
          extraWrap.appendChild(buildColorRow(ta));
        }
        textAreas.slice(1).forEach((eta) => {
          const key = eta.param_key || 'text_extra';
          const row = document.createElement('div');
          row.className = 'text-extra-row';
          const lab = document.createElement('span');
          lab.className = 'opt-label';
          lab.textContent = eta.label_zh ? `${eta.label_zh} ${eta.label || key}` : (eta.label || key);
          const inp = document.createElement('input');
          inp.type = 'text';
          inp.dataset.paramKey = key;
          if (eta.charset === 'digits') inp.inputMode = 'numeric';
          if (eta.charset === 'alpha') {
            inp.setAttribute('autocapitalize', 'characters');
            inp.setAttribute('autocorrect', 'off');
            inp.setAttribute('autocomplete', 'off');
            inp.spellcheck = false;
          }
          inp.value = (t.defaults && t.defaults[key]) ? t.defaults[key] : '';
          // 同上：不設 maxlength，避免輸入法合成被截斷
          inp.removeAttribute('maxlength');
          const hint = document.createElement('small');
          lkBindTextInput(inp, eta, hint, () => {
            clearTimeout(inp._lkTimer);
            inp._lkTimer = setTimeout(autoPreview, 300);
          });
          row.appendChild(lab);
          row.appendChild(inp);
          row.appendChild(hint);
          extraWrap.appendChild(row);
          // 每欄獨立文字顏色：色卡 + 撞色即時提示（聯動 key 除外）
          if (eta.color_key && eta.color_choices && !(linkedKeys && linkedKeys.has(eta.color_key))) {
            extraWrap.appendChild(buildColorRow(eta));
          }
        });
        // 聯動顏色行（模板 color_link）：一次選色，多個部位共用
        // 登機牌＝條碼＋全部文字欄；basic tag＝左右欄文字
        if (cl && extraWrap) {
          const lrow = buildLinkedColorRow(cl, t);
          if (lrow) extraWrap.appendChild(lrow);
        }
        // 溫馨提示（有顏色選擇時顯示；承印部件按 auto_color_target 動態措辭）
        if (extraWrap.querySelector('.text-color-row')) {
          const targetName = { tag: '吊牌', body: '牌身', strap: '肩帶' }[ta.auto_color_target || 'body'] || '產品';
          const targetNameEn = { tag: 'tag', body: 'body', strap: 'strap' }[ta.auto_color_target || 'body'] || 'product';
          const tip = document.createElement('div');
          tip.className = 'text-color-tip';
          tip.textContent = `💡 溫馨提示：文字顏色請與${targetName}顏色保持強對比（深色配淺色字、淺色配深色字），否則織出來會看不清；選「自動 Auto」我們會按${targetName}顏色幫你配黑或白。 Tip: choose a wording colour that contrasts strongly with the ${targetNameEn} — or leave it on Auto and we’ll pick black/white for you.`;
          extraWrap.appendChild(tip);
        }
      }
      // 固定字号提示（登机牌/吊牌：字型字号锁定，仅可改内容）—— 繁體+英文，對象為香港客戶
      const lockHint = $('#text-lock-hint');
      if (ta.fixed || ta.scale_mode === 'fixed') {
        lockHint.textContent = `字款與大小已固定，只可更改文字內容（最多 ${ta.maxlen || 21} 個字） Fixed size & font — content only (max ${ta.maxlen || 21})`;
        lockHint.classList.remove('hidden');
      } else {
        lockHint.classList.add('hidden');
      }
    } else {
      textSec.classList.add('hidden');
    }

    // 相片+文字袋（text_art 配置）：文字大小 / 文字角度 / 圖文層級
    if (t.text_art && extraWrap) {
      const mkRow = (labelText) => {
        const row = document.createElement('div');
        row.className = 'text-extra-row ta-row';
        const lab = document.createElement('span');
        lab.className = 'opt-label';
        lab.textContent = labelText;
        row.appendChild(lab);
        return row;
      };
      // 文字大小滑桿
      const sc = t.text_art.scale || {};
      const rowS = mkRow('文字大小 Text size');
      const sIn = document.createElement('input');
      sIn.type = 'range'; sIn.id = 'ta-scale'; sIn.className = 'ta-slider';
      sIn.min = sc.min != null ? sc.min : 0.4; sIn.max = sc.max != null ? sc.max : 2.0;
      sIn.step = sc.step != null ? sc.step : 0.05; sIn.value = sc.default != null ? sc.default : 1.0;
      const sVal = document.createElement('span');
      sVal.className = 'ta-val'; sVal.textContent = Math.round(sIn.value * 100) + '%';
      sIn.addEventListener('input', () => { sVal.textContent = Math.round(sIn.value * 100) + '%'; });
      sIn.addEventListener('change', autoPreview);
      rowS.appendChild(sIn); rowS.appendChild(sVal);
      extraWrap.appendChild(rowS);
      // 文字角度滑桿
      const ag = t.text_art.angle || {};
      const rowA = mkRow('文字角度 Text angle');
      const aIn = document.createElement('input');
      aIn.type = 'range'; aIn.id = 'ta-angle'; aIn.className = 'ta-slider';
      aIn.min = ag.min != null ? ag.min : -90; aIn.max = ag.max != null ? ag.max : 90;
      aIn.step = ag.step != null ? ag.step : 5; aIn.value = ag.default != null ? ag.default : 0;
      const aVal = document.createElement('span');
      aVal.className = 'ta-val'; aVal.textContent = aIn.value + '°';
      aIn.addEventListener('input', () => { aVal.textContent = aIn.value + '°'; });
      aIn.addEventListener('change', autoPreview);
      rowA.appendChild(aIn); rowA.appendChild(aVal);
      extraWrap.appendChild(rowA);
      // 圖文層級：相片在文字上（預設，參考款）或文字在相片上
      const rowZ = mkRow('圖文層級 Layering');
      const zWrap = document.createElement('span');
      zWrap.className = 'ta-zwrap';
      [['image_top', '相片在上 Photo on top'], ['text_top', '文字在上 Text on top']].forEach(([v, lab]) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'view-tab ta-zbtn' + (v === taOrder ? ' active' : '');
        b.dataset.order = v; b.textContent = lab;
        b.addEventListener('click', () => {
          if (taOrder === v) return;
          taOrder = v;
          zWrap.querySelectorAll('.ta-zbtn').forEach(x => x.classList.remove('active'));
          b.classList.add('active');
          autoPreview();
        });
        zWrap.appendChild(b);
      });
      rowZ.appendChild(zWrap);
      extraWrap.appendChild(rowZ);
    }

    // AI 生图区
    const artSec = $('#artwork-section');
    let hasArt = false;
    allComps.forEach(c => { if (c.artwork) hasArt = true; });
    if (hasArt) {
      artSec.classList.remove('hidden');
      const styles = [];
      allComps.forEach(c => {
        if (c.artwork && c.artwork.style_templates) styles.push(...c.artwork.style_templates);
      });
      // 默认 Auto：后端自动判断人物/动物/风景/物件，用户可下拉覆盖
      // 風格名雙語：模板 label 為英文，這裡補上繁體（香港客戶）
      const STYLE_ZH = {
        'Standard knit': '標準針織', 'Cartoon flat': '卡通平塗', 'Illustration': '插畫風',
        'Portrait': '人像', 'Landscape': '風景', 'Comic line art': '漫畫線稿',
        'Hand-drawn sketch': '手繪原樣'
      };
      const artConf = (allComps.find(c => c.artwork) || {}).artwork || null;
      const forceStyle = artConf && artConf.force_style;
      const styleField = $('#style-select').closest('.field');
      if (forceStyle) {
        // 模板指定唯一風格（手繪匙扣 = sketch 保真提取）：隱藏下拉，鎖定風格
        const forced = styles.find(s => s.key === forceStyle) || { key: forceStyle, label: forceStyle };
        const zh = STYLE_ZH[forced.label] || '';
        $('#style-select').innerHTML = `<option value="${forced.key}" selected>${forced.label}${zh ? ' ' + zh : ''}</option>`;
        if (styleField) styleField.classList.add('hidden');
      } else {
        const opts = ['<option value="auto" selected>自動——最適合你的相片（推薦） Auto — best for my photo (recommended)</option>'];
        styles.forEach(s => {
          const zh = STYLE_ZH[s.label] || '';
          opts.push(`<option value="${s.key}">${s.label}${zh ? ' ' + zh : ''}</option>`);
        });
        $('#style-select').innerHTML = opts.join('');
        if (styleField) styleField.classList.remove('hidden');
      }
      // 上傳文案：手繪匙扣換成拍照指引（模板 artwork.upload_hint_key）
      const artLabel = artSec.querySelector('.field .opt-label');
      const artHint = $('#artwork-hint');
      const isSketch = artConf && artConf.force_style === 'sketch';
      if (isSketch) {
        if (artLabel) artLabel.textContent = '上載你的手繪圖 Upload your drawing';
        if (artHint) artHint.innerHTML = '拍下你畫在紙上的字和圖案上載——我們會自動讀出內容，用清晰字體和圖案重新排版織出來（可修改）。JPG 或 PNG，最大 10MB。 Upload a photo of your drawing — we read it automatically and re-typeset it in a crisp font for knitting (you can edit it). JPG or PNG, up to 10&nbsp;MB.';
      } else {
        if (artLabel) artLabel.textContent = '上載相片 Upload a photo';
        if (artHint) artHint.innerHTML = DEFAULT_ARTWORK_HINT;
      }
      // 手繪匙扣：識別確認條（先出圖後確認）替代表單——上傳後自動識別+渲染上圖
      const aiBtn = $('#ai-btn');
      const oldRow = $('#sketch-strength-row');
      if (oldRow) oldRow.remove();
      if (isSketch) {
        if (aiBtn) aiBtn.remove();         // AI 生圖按鈕移除（方案 B：識別 + 重排）
        const ICONS = ['笑脸', '爱心', '星星', '月亮', '太阳', '彩虹',
                       '花', '猫', '狗', '音符', '云', '树'];
        const row = document.createElement('div');
        row.className = 'field';
        row.id = 'sketch-form';
        row.innerHTML = '<div id="sketch-bar" class="hidden">'
          + '<span class="opt-label">我們讀到 We read:</span>'
          + '<div class="sketch-read-line"><b id="sketch-read">—</b></div>'
          + '<div class="view-tabs sketch-actions">'
          + '<button type="button" id="sketch-edit">✏️ 改一下 Edit</button>'
          + '<button type="button" id="sketch-direct">🧵 直接針織預覽 Knit preview</button>'
          + '<button type="button" id="sketch-ai">✨ AI 重繪 Redraw</button>'
          + '<button type="button" id="sketch-std" class="hidden">黑體版 Bold font</button>'
          + '</div>'
          + '<div id="sketch-editor" class="hidden">'
          + '<input id="sketch-text" type="text" maxlength="32" autocomplete="off" '
          + 'placeholder="例如：世一 / 一生一世 / HAPPYBIRTHDAY">'
          + '<div id="sketch-subject-row" class="hidden" style="margin-top:8px">'
          + '<span class="opt-label">我們認出你畫的是 We recognised:</span>'
          + '<input id="sketch-subject" type="text" maxlength="12" autocomplete="off" '
          + 'placeholder="例如：恐龙 / 柴犬 / 咖啡杯">'
          + '<small style="display:block;margin-top:4px;opacity:.7">'
          + '認錯了可以直接改，我們會按你寫的重新畫。 Not right? Just type what it is.</small>'
          + '</div>'
          + '<div class="view-tabs" id="sketch-icons">'
          + ICONS.map(i => `<button type="button" class="view-tab ta-zbtn" data-icon="${i}">${i}</button>`).join('')
          + '</div>'
          + '<small id="sketch-len-hint">最多 16 個字母／數字；中文 5 個字以內最清楚（靠近金屬環要留 2.5cm 空白）。 Up to 16 letters/digits; up to 5 Chinese characters.</small>'
          + '</div>'
          + '<small id="sketch-note"></small>'
          + '</div>';
        const anchor = $('#image-input');
        if (anchor) anchor.closest('.field').insertAdjacentElement('afterend', row);
        // 立刻按模板实际针数刷新一次提示（静态文案只是兜底，避免首次显示旧数字）
        updateSketchLenHint();
        // 編輯器：字/圖形變更 → 自動重渲染（標準版）
        $('#sketch-text').addEventListener('input', () => updateSketchLenHint());
        $('#sketch-text').addEventListener('input', debounceSketchRerender);
        row.querySelectorAll('#sketch-icons button').forEach(btn => btn.addEventListener('click', () => {
          btn.classList.toggle('active');
          const sel = row.querySelectorAll('#sketch-icons button.active');
          if (sel.length > 2) btn.classList.remove('active');   // 最多 2 個
          updateSketchLenHint();     // 圖標也佔 1 格，需重算
          debounceSketchRerender();
        }));
        $('#sketch-edit').onclick = () => $('#sketch-editor').classList.toggle('hidden');
        // 客戶改圖案名 → 按新名字重新生成（只有文生圖路徑吃這個欄位）
        const subjInput = $('#sketch-subject');
        if (subjInput) {
          let _subjTimer = null;
          subjInput.addEventListener('input', () => {
            _sketchSubject = subjInput.value.trim();
            _sketchKind = _sketchSubject ? 'common' : 'custom';
            clearTimeout(_subjTimer);
            _subjTimer = setTimeout(() => { if (_sketchSubject) runSketchRedraw(); }, 900);
          });
        }
        $('#sketch-direct').onclick = runSketchDirect;
        $('#sketch-ai').onclick = runSketchRedraw;
        $('#sketch-std').onclick = runSketchRender;
      } else if (aiBtn) {
        aiBtn.textContent = '重新繪製我的相片 Redraw my photo';
        $('#ai-btn').onclick = runAiRedraw;
      }
      setupPhotoInput();
    } else {
      artSec.classList.add('hidden');
    }

    updateColorCount();
    $('#preview-btn').onclick = preview;
  }

  // ── demo2 渲染器（仅 wct_v_tote）：Bag/Strap/Text 三组 swatch + Front/Back 视图 ──
  function renderDemo2ColorGroup(wrap, key, label, colors, withAuto) {
    const group = document.createElement('div');
    group.className = 'color-group';
    const cur = demo2State[key];
    let html = `<label>${label}</label><div class="swatch-list" data-key="${key}">`;
    colors.forEach(c => {
      html += `<span class="swatch${c === cur ? ' active' : ''}" style="background:${c}" data-color="${c}" title="${c}"></span>`;
    });
    if (withAuto) {
      html += `<span class="swatch swatch--auto${cur === null ? ' active' : ''}" data-color="" title="Auto">A</span>`;
    }
    html += '</div>';
    group.innerHTML = html;
    group.querySelectorAll('.swatch').forEach(s => {
      s.addEventListener('click', () => {
        demo2State[key] = s.dataset.color || null;
        group.querySelectorAll('.swatch').forEach(x => x.classList.remove('active'));
        s.classList.add('active');
        updateColorCount();
        autoPreview();
      });
    });
    wrap.appendChild(group);
  }

  function renderDemo2Controls() {
    const t = currentTemplate;
    const defs = t.defaults || {};

    // 视图：Front / Back 两个 tab（素材只有一套，正背面同一外观）
    const viewSec = $('#view-sections');
    viewSec.classList.remove('hidden');
    const tabs = $('#view-tabs');
    tabs.innerHTML = ['front', 'back'].map(v =>
      `<button type="button" class="view-tab${v === demo2State.view ? ' active' : ''}" data-view="${v}">${v === 'front' ? '正面 Front' : '背面 Back'}</button>`
    ).join('');
    tabs.querySelectorAll('.view-tab').forEach(btn => {
      btn.onclick = () => {
        if (btn.dataset.view === demo2State.view) return;
        demo2State.view = btn.dataset.view;
        renderControls();
        autoPreview();
      };
    });
    const viewNote = $('#view-note');
    viewNote.textContent = '正背面圖案相同。 Front and back are identical.';
    viewNote.classList.remove('hidden');

    // 三组 swatch：Bag / Strap / Text（Text 组带 AUTO）
    // Bag / Strap 的色源来自模板 components[].color_variant.variants（与后端支持的色一致）
    const colorWrap = $('#color-sections');
    colorWrap.innerHTML = '';
    renderDemo2ColorGroup(colorWrap, 'bagColor', '袋身顏色 Bag colour', getDemo2Colors('bag'), false);
    renderDemo2ColorGroup(colorWrap, 'strapColor', '肩帶顏色 Strap colour', getDemo2Colors('strap'), false);
    renderDemo2ColorGroup(colorWrap, 'textColor', '文字顏色 Text colour', DEMO2_TEXT_COLORS, true);

    // 文字区（复用现有 #text-section；输入变化防抖 300ms 实时刷新预览）
    const textSec = $('#text-section');
    const extraWrapDemo2 = $('#text-extra');
    if (extraWrapDemo2) extraWrapDemo2.innerHTML = '';
    const ta = (t.text_areas || [])[0];
    if (ta) {
      textSec.classList.remove('hidden');
      const mainLabelD2 = $('#text-main-label');
      if (mainLabelD2) mainLabelD2.textContent = '你的文字 Your text';
      const input = $('#text-input');
      if (!input.value) input.value = (defs.text || '');
      // 不設 HTML maxlength：輸入法合成中途會被截斷（中文打不出來），長度改由 bindText 控
      input.removeAttribute('maxlength');
      // demo2（W&C 提手）同樣走統一清洗 + 繁體提示
      lkBindTextInput(input, ta, $('#text-hint'), () => {
        clearTimeout(input._lkDemo2Timer);
        input._lkDemo2Timer = setTimeout(autoPreview, 300);
      });
      const lockHint = $('#text-lock-hint');
      if (ta.fixed || ta.scale_mode === 'fixed') {
        lockHint.textContent = `字款與大小已固定，只可更改文字內容（最多 ${ta.maxlen || 21} 個字） Fixed size & font — content only (max ${ta.maxlen || 21})`;
        lockHint.classList.remove('hidden');
      } else {
        lockHint.classList.add('hidden');
      }
    } else {
      textSec.classList.add('hidden');
    }

    // demo2 不需要 AI 生图区
    const artSec = $('#artwork-section');
    if (artSec) artSec.classList.add('hidden');

    updateColorCount();
    $('#preview-btn').onclick = preview;
  }

  /* ── 手繪匙扣：本體色與圖案色互斥（雙向禁用）───────────────────
     同色＝圖案織在本體上完全看不見，所以兩行互為約束：
       · 本體選了 X → 圖案行的 X 禁用
       · 圖案選了 Y → 本體行的 Y 禁用
     禁用色塊是「真的點不動」，但會給明確提示（不會靜默無反應）：
     狀態欄說明原因並指引先改另一行。 */
  const _isHex = (v) => /^#[0-9A-Fa-f]{6}$/.test(String(v || ''));
  const _sameHex = (a, b) => String(a || '').toUpperCase() === String(b || '').toUpperCase();

  /** 直接設定某色卡行的選中項（不觸發重繪）。 */
  function setActiveColor(key, hex) {
    if (!_isHex(hex)) return;
    document.querySelectorAll(`.swatch-list[data-key="${key}"] .swatch`)
      .forEach(s => s.classList.toggle('active', _sameHex(s.dataset.color, hex)));
  }

  /** 兩行互斥：把「另一行已選的顏色」在本行標為禁用。 */
  function sketchColorSync() {
    const t = currentTemplate;
    if (!t || !t.palette || !t.palette.ink || !t.palette.body) return;
    let body = getParamColor('body'), ink = getParamColor('ink');
    // 異常態兜底（歷史狀態／默認配置同色）：圖案色回落到第一個不同色
    if (_sameHex(body, ink)) {
      const alt = (t.palette.ink || []).find(c => !_sameHex(c, body));
      if (alt) { setActiveColor('ink', alt); ink = alt; }
    }
    [['body', ink], ['ink', body]].forEach(([k, conflict]) => {
      document.querySelectorAll(`.swatch-list[data-key="${k}"] .swatch`).forEach(s => {
        const hit = _sameHex(s.dataset.color, conflict);
        s.classList.toggle('disabled', hit);
        s.setAttribute('aria-disabled', hit ? 'true' : 'false');
        s.title = hit
          ? (k === 'body'
              ? '此色現為圖案顏色——點擊會互換兩邊顏色 (in use by pattern; tap to swap)'
              : '此色現為本體顏色——點擊會互換兩邊顏色 (in use by body; tap to swap)')
          : s.dataset.color;
      });
    });
  }

  /** 一鍵互換本體色 ↔ 圖案色（嚴格禁用模式下的唯一出口，避免死鎖）。 */
  function swapSketchColors() {
    const t = currentTemplate;
    if (!t || !t.palette || !t.palette.ink) return;
    const body = getParamColor('body'), ink = getParamColor('ink');
    if (_sameHex(body, ink)) return;
    setActiveColor('body', ink);
    setActiveColor('ink', body);
    sketchColorSync();
    refreshAllTextColorHints();
    updateColorCount();
    $('#ai-status').textContent = '已互換本體與圖案顏色。 Body and pattern colours swapped.';
    if (_sketchLastLine) {
      runSketchReink({});   // 互換後圖案色變了，必須重織設計稿
    } else {
      autoPreview();
    }
  }

  function selectColor(key, color) {
    // 手繪匙扣：點到「另一行正在用的顏色」→ 兩邊互換。
    // 色塊雖然顯示為禁用（同色會看不見），但點擊必須有結果——
    // 死攔會讓「本體紅/圖案白」這類互換意圖永遠達不到（兩邊都被佔用）。
    let swapped = false;
    const el = document.querySelector(`.swatch-list[data-key="${key}"] .swatch[data-color="${color}"]`);
    const tplInk = currentTemplate && currentTemplate.palette && currentTemplate.palette.ink;
    if (el && el.classList.contains('disabled') && tplInk && (key === 'body' || key === 'ink')) {
      const other = key === 'body' ? 'ink' : 'body';
      const mine = getParamColor(key);
      setActiveColor(key, color);        // 我拿到想選的色
      if (_isHex(mine)) setActiveColor(other, mine);   // 對方拿我原本的色
      swapped = _isHex(mine);
    }
    if (!swapped) {
      $(`.swatch-list[data-key="${key}"] .swatch.active`)?.classList.remove('active');
      $(`.swatch-list[data-key="${key}"] .swatch[data-color="${color}"]`)?.classList.add('active');
    }
    sketchColorSync();
    if (swapped) {
      $('#ai-status').textContent = '已互換本體與圖案顏色（同色會看不見，所以自動對調）。 '
        + 'Body and pattern colours swapped automatically.';
    }
    // 換承印部件顏色（如吊牌）→ 文字色撞色提示要即時重算
    refreshAllTextColorHints();
    updateColorCount();
    // 手繪匙扣：圖案紗色織進設計圖 → 換 ink 必須重織；
    // 換本體只要重跑合成（底色被鏤空，視覺即時正確），設計圖底色在後台同步。
    if (_sketchLastLine && (key === 'ink' || key === 'body')) {
      // 互換時 ink 一定變了 → 必須重織；單純換本體可先出即時預覽，再後台同步底色
      const inkChanged = (key === 'ink') || swapped;
      if (inkChanged) {
        runSketchReink({});
      } else {
        preview();                          // 本體換色不必等重織
        runSketchReink({ silent: true });   // 後台補上新底色，供生產 BMP
      }
      return;
    }
    autoPreview();
  }

  // 未染色的原始線稿（白底黑字，PNG base64）。
  // 換色必須從它重新染色：拿已染色的圖再染一次會二次退化——
  // 淺色圖案（白/灰）亮度接近底色，會被當成背景塗成本體色，圖案直接消失。
  let _sketchLastLine = null;
  let _reinkSeq = 0;            // 併發防護：只採納最後一次換色的結果

  /** 換圖案色：用緩存線稿只重織不重排（約 1 秒）。
      opts.silent：只更新設計稿底色，不覆蓋狀態提示；
      opts.swapNote：本次是兩色互換，給一句明確反饋。 */
  async function runSketchReink(opts) {
    if (!_sketchLastLine) return;
    opts = opts || {};
    const seq = ++_reinkSeq;
    const pid = lockedPid || $('#product-select').value;
    const ink = getParamColor('ink'), body = getParamColor('body');
    setLoading(true);
    try {
      const res = await fetch(`/api/product/${pid}/sketch-render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          line: _sketchLastLine, ink, body_color: body,
          mode: (sketchOrder && sketchOrder.mode) || 'standard'
        })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (seq !== _reinkSeq) return;            // 已有更新的換色請求 → 丟棄舊結果
      // 防呆：返回時客戶又改過色 → 這個結果已經過時
      if (!_sameHex(getParamColor('ink'), ink) || !_sameHex(getParamColor('body'), body)) return;
      currentDesign = data.design;
      if (!opts.silent) {
        $('#ai-status').textContent = opts.swapNote
          ? '已互換本體與圖案顏色。 Body and pattern colours swapped.'
          : '圖案顏色已更新。 Pattern colour updated.';
      }
      await preview();
    } catch (e) {
      console.error(e);
      if (seq === _reinkSeq && !opts.silent) {
        $('#ai-status').textContent = '⚠️ ' + (e.message || '換色失敗，請再試一次。 Colour change failed — try again.');
      }
    } finally {
      setLoading(false);
    }
  }

  function labelFor(key) {
    // 繁體中文 + 英文雙語（彈層對象為香港客戶）
    const map = {
      bag: '袋身顏色 Bag colour', strap: '肩帶顏色 Strap colour', text: '文字顏色 Text colour',
      body: '本體顏色 Body colour', barcode: '條碼顏色 Barcode colour', deco: '裝飾線顏色 Deco colour',
      tag: '吊牌顏色 Tag colour', flap: '袋蓋顏色 Flap colour', fabric: '織物底色 Fabric colour',
      slogan: '文字顏色 Text colour', ink: '圖案顏色 Pattern colour'
    };
    return map[key] || key;
  }

  function getParamColor(key) {
    const active = $(`.swatch-list[data-key="${key}"] .swatch.active`);
    return active ? active.dataset.color : (currentTemplate.defaults[key + '_color'] || '#FFFFFF');
  }

  /* ── 顏色聯動（模板 color_link）─────────────────────────────────────
     登機牌：條碼 + 全部文字欄一色；basic tag：左右欄文字一色。
     聯動部位的色值在提交／計色時由 linkedSel 統一計出：
     - 文字欄直接用 linkedSel（hex 或 AUTO，後端 _resolve_text_color 原生支持 hex）
     - 條碼是 color_variant（只收 code），把 hex 映射到最接近的 variant code；
       AUTO 時按本體深淺配黑/白（與後端文字自動配色同一規則）。────── */
  function _rgbDist(h1, h2) {
    const p = (h) => [parseInt(h.substr(1, 2), 16), parseInt(h.substr(3, 2), 16), parseInt(h.substr(5, 2), 16)];
    const a = p(h1), b = p(h2);
    return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  }

  /** 當前聯動選中值（未選過時回退模板默認）。 */
  function linkedValue() {
    const cl = currentTemplate && currentTemplate.color_link;
    if (!cl) return null;
    return linkedSel != null ? linkedSel : ((currentTemplate.defaults || {})[cl.keys[0]] || 'AUTO');
  }

  /** 聯動部位（如條碼）應使用的 color_variant code。 */
  function linkedZoneCode() {
    const cl = currentTemplate && currentTemplate.color_link;
    if (!cl || !cl.zone) return null;
    const variants = getVariants(cl.zone);
    if (!variants.length) return null;
    let want = linkedValue();
    if (want === 'AUTO' || !_HEX_RE.test(want)) {
      const ta0 = (currentTemplate.text_areas || []).find(x => x.color_key === cl.keys[0]) || {};
      const ac = ta0.auto_color || { dark: '#1F1B16', light: '#FFFFFF', luma: 128 };
      const tgt = ta0.auto_color_target || 'body';
      const map = colorHexMap(currentTemplate);
      const baseHex = _hexOrNull(getParamColor(tgt), map, tgt) || '#FFFFFF';
      want = _lumaJs(baseHex) >= (ac.luma || 128) ? ac.dark : ac.light;
    }
    let best = null, bd = Infinity;
    variants.forEach(v => {
      if (!v.hex || !_HEX_RE.test(v.hex)) return;
      const d = _rgbDist(v.hex.toUpperCase(), want.toUpperCase());
      if (d < bd) { bd = d; best = v.code || v.file; }
    });
    return best || variants[0].code;
  }

  /** 部位取色：聯動部位走聯動值，其餘照舊讀色卡行。 */
  function zoneColorCode(key) {
    const cl = currentTemplate && currentTemplate.color_link;
    if (cl && key === cl.zone) return linkedZoneCode() || getParamColor(key);
    return getParamColor(key);
  }

  /* ──────────────────────────────────────────────────────────────────────
     顏色數量上限：工廠每件成品最多接受 5 種不同紗線顏色。
     逐個收集「本體 / 條碼 / 裝飾線 / 袋身 / 肩帶 / 文字」等實際用色
     （代號如 B/Br/DB 先按 color_variant 解析成 #RRGGBB；AUTO 文字按
     承印部件亮度解析成黑或白，與後端 _resolve_text_color 同一規則）。
     ────────────────────────────────────────────────────────────────────── */
  var MAX_DESIGN_COLORS = 5;
  var _HEX_RE = /^#[0-9A-Fa-f]{6}$/;

  /** 組件 variants 的 代號→顏色 映射（target/id → {code: hex}）。 */
  function colorHexMap(t) {
    var map = {};
    ((t && t.components) || []).forEach(function (c) {
      if (!c.variants || !c.variants.length) return;
      var k = c.target || c.id;
      map[k] = map[k] || {};
      c.variants.forEach(function (v) { if (v.code && v.hex) map[k][v.code] = v.hex; });
    });
    return map;
  }

  function _hexOrNull(val, map, key) {
    if (!val || val === 'AUTO') return null;
    var s = String(val).trim();
    if (_HEX_RE.test(s)) return s.toUpperCase();
    var m = map && map[key];
    return (m && m[s]) ? String(m[s]).toUpperCase() : null;
  }

  function _lumaJs(hex) {
    if (!hex || !_HEX_RE.test(hex)) return 255;
    var h = hex.replace('#', '');
    return 0.299 * parseInt(h.substr(0, 2), 16) + 0.587 * parseInt(h.substr(2, 2), 16) + 0.114 * parseInt(h.substr(4, 2), 16);
  }

  /**
   * 當前設計實際用到的不同顏色。
   * @returns {{colors: string[], count: number, max: number, ok: boolean}}
   */
  function designColors() {
    var t = currentTemplate;
    var fallback = { colors: [], count: 0, max: MAX_DESIGN_COLORS, ok: true };
    if (!t) return fallback;
    var map = colorHexMap(t);
    var set = {};
    function add(hex) { if (hex) set[hex] = true; }
    var max = Number(t.max_colors) || MAX_DESIGN_COLORS;

    if (isDemo2()) {
      // 未选色时按模板默认色计（后端同样回落到 defaults）
      var defsD2 = t.defaults || {};
      var bagHex = demo2State.bagColor || defsD2.bag_color;
      var strapHex = demo2State.strapColor || defsD2.strap_color;
      add(_hexOrNull(bagHex, map, 'bag'));
      add(_hexOrNull(strapHex, map, 'strap'));
      if (demo2State.textColor) add(_hexOrNull(demo2State.textColor, map, 'text'));
      else add(_lumaJs(_hexOrNull(strapHex, map, 'strap') || '#FFFFFF') > 128 ? '#1F1B16' : '#FFFFFF');
    } else {
      // 1) 色卡區（本體 / 袋身 / 肩帶 / 袋蓋 / 吊牌 / 條碼 / 裝飾線…）
      Object.keys(t.palette || {}).forEach(function (k) { add(_hexOrNull(zoneColorCode(k), map, k)); });
      (t.components || []).forEach(function (c) {
        if (c.type !== 'color_variant') return;
        var k = c.target || c.id;
        add(_hexOrNull(zoneColorCode(k), map, k));
      });
      // 2) 文字顏色（每欄獨立；聯動欄取 linkedSel；AUTO → 按承印部件深淺配黑/白）
      (t.text_areas || []).forEach(function (ta) {
        if (!ta.color_key) return;
        var act = document.querySelector('.swatch-list[data-key="' + ta.color_key + '"] .swatch.active');
        var defV = (t.defaults || {})[ta.color_key] || 'AUTO';
        var val = act ? act.dataset.color
          : (linkedKeysCached && linkedKeysCached.has(ta.color_key) ? (linkedValue() || defV) : defV);
        if (val && val !== 'AUTO') { add(_hexOrNull(val, map, ta.color_key)); return; }
        var ac = ta.auto_color || { dark: '#1F1B16', light: '#FFFFFF', luma: 128 };
        var target = ta.auto_color_target || 'strap';
        var targetHex = _hexOrNull(getParamColor(target), map, target) || '#FFFFFF';
        add(_lumaJs(targetHex) >= (ac.luma || 128) ? (ac.dark || '#1F1B16') : (ac.light || '#FFFFFF'));
      });
    }
    var colors = Object.keys(set);
    return { colors: colors, count: colors.length, max: max, ok: colors.length <= max };
  }

  /** 刷新「已用顏色 x/y」提示條；超限時轉為紅色警示。 */
  function updateColorCount() {
    var note = $('#color-count-note');
    if (!note) return;
    var info = designColors();
    if (!info.count) { note.classList.add('hidden'); return; }
    var over = !info.ok;
    note.classList.toggle('over', over);
    note.classList.remove('hidden');
    note.textContent = over
      ? '⚠️ 已用 ' + info.count + ' 種顏色，超出上限 ' + info.max + ' 種——請改用與其他部件相同的顏色，減至 ' + info.max + ' 種以內才可確認下單。 '
        + info.count + ' colours used, over the limit of ' + info.max + ' — please reuse colours so the design uses ' + info.max + ' or fewer.'
      : '🎨 已用 ' + info.count + ' / ' + info.max + ' 種顏色 Colours used ' + info.count + ' / ' + info.max;
  }

  function collectParams() {
    const t = currentTemplate;
    if (isDemo2()) {
      return {
        bag_color: demo2State.bagColor,
        strap_color: demo2State.strapColor,
        text: $('#text-input').value,
        text_color: demo2State.textColor,
        view: demo2State.view,
      };
    }
    const params = {};
    Object.keys(t.palette || {}).forEach(k => params[k + '_color'] = zoneColorCode(k));
    (t.components || []).forEach(c => {
      if (c.type === 'color_variant' && (c.target || c.id) && params[c.target + '_color'] === undefined) {
        params[(c.target || c.id) + '_color'] = zoneColorCode(c.target || c.id);
      }
    });
    if ((t.text_areas || []).length) {
      // 主文字欄按模板 param_key 提交（登機牌第一欄是 text_to，不再是寫死的 text）
      const mainTa = t.text_areas[0];
      params[mainTa.param_key || 'text'] = $('#text-input').value;
      // 附加文字字段（text_from / text_to 等）
      (t.text_areas || []).slice(1).forEach(ta => {
        const key = ta.param_key || 'text_extra';
        const inp = document.querySelector(`#text-extra input[data-param-key="${key}"]`);
        if (inp) params[key] = inp.value;
      });
      // 每欄獨立文字顏色（basic tag 左右欄：text_left_color / text_right_color）
      // 聯動欄（模板 color_link）沒有自己的色卡行，取 linkedSel 統一值
      (t.text_areas || []).forEach(ta => {
        if (!ta.color_key) return;
        const act = document.querySelector(`.swatch-list[data-key="${ta.color_key}"] .swatch.active`);
        if (act) { params[ta.color_key] = act.dataset.color; return; }
        if (linkedKeysCached && linkedKeysCached.has(ta.color_key)) {
          params[ta.color_key] = linkedValue();
        }
      });
    }
    if (currentDesign) params.design = currentDesign;
    // 手繪匙扣：識別確認後的織字內容（進 spec → 生產郵件正文）
    if (currentPid && /^myo_keychain_art/.test(currentPid) && (sketchOrder.text || sketchOrder.shapes.length)) {
      params.sketch_text = sketchOrder.text;
      params.sketch_shapes = sketchOrder.shapes;
      params.sketch_mode = sketchOrder.mode || 'standard';
    }
    if (currentView) params.view = currentView;
    // 袋类背面織片选择（myo_*_tote / myo_*_crossbody / knit_tote）
    if (/_(tote|crossbody)$/.test(currentPid || '')) params.back_panel = bagBackPanel;
    // 相片+文字袋：文字尺寸 / 角度 / 圖文層級
    if (t.text_art) {
      const sc = $('#ta-scale'); if (sc) params.slogan_scale = parseFloat(sc.value);
      const ag = $('#ta-angle'); if (ag) params.slogan_angle = parseFloat(ag.value);
      params.art_order = taOrder;
    }
    return params;
  }

  /**
   * 拉取合成图。
   * 默认返回预览：后端已缩到 ≤720px 的 JPEG（换色/改字体积与耗时大幅下降）；
   * opts.full=true 返回全分辨率 PNG（成品/生产用，提交 save-image）。
   * 兼容两种响应：
   *   - 二进制图片（Content-Type: image/jpeg|image/png）→ 转 dataURL；
   *   - 旧 JSON 契约 {composite, mime, meta}（向后兼容，逻辑测试桩走此分支）。
   * @param {string} pid 产品 id
   * @param {Object} params 定制参数（collectParams() 结果）
   * @param {?Object} opts 可选：{full: boolean}
   * @returns {Promise<{dataUrl: string, meta: ?Object}>}
   */
  async function fetchComposite(pid, params, opts) {
    const full = !!(opts && opts.full);
    const body = Object.assign({}, params);
    if (full) body.full = true;
    const res = await fetch(`/api/product/${pid}/composite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error('composite HTTP ' + res.status);
    const ct = (res.headers && typeof res.headers.get === 'function')
      ? (res.headers.get('content-type') || '') : '';
    if (ct.indexOf('image/') === 0) {
      // 二進制圖片（預覽 image/jpeg，成品 image/png）；meta 從回應頭取
      // （選色對比警告 warnings 就放在裡面，見 product_engine.contrast_warnings）
      let meta = null;
      try {
        const raw = res.headers.get('X-Composite-Meta');
        if (raw) meta = JSON.parse(raw);
      } catch (_) { /* 頭損毀不影響圖片 */ }
      const dataUrl = await blobToDataUrl(await res.blob());
      return { dataUrl: dataUrl, meta: meta };
    }
    // 旧 JSON 契约兜底（例如逻辑测试桩）
    const data = await res.json();
    const mime = data.mime || 'image/png';
    return { dataUrl: 'data:' + mime + ';base64,' + (data.composite || ''), meta: data.meta || null };
  }

  /**
   * Blob → dataURL（不依赖 FileReader，纯 arrayBuffer + base64，环境无关）。
   * @param {Blob} blob
   * @returns {Promise<string>} 形如 data:image/png;base64,...
   */
  async function blobToDataUrl(blob) {
    const buf = await blob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    const CHUNK = 0x8000; // 分块拼接，避免超长参数栈溢出
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return 'data:' + (blob.type || 'image/png') + ';base64,' + btoa(binary);
  }

  // ── 文字色撞色即時檢查（basic tag 左右欄自訂顏色用）──
  // WCAG 對比度：與後端 contrast_warnings 同一標準（< 2.0 視為太接近）
  function _hexLuma(hex) {
    const m = /^#?([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})$/.exec(hex || '');
    if (!m) return 1;
    const f = (v) => { const c = parseInt(v, 16) / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(m[1]) + 0.7152 * f(m[2]) + 0.0722 * f(m[3]);
  }
  function _contrastRatioHex(h1, h2) {
    const a = _hexLuma(h1), b = _hexLuma(h2);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }

  /**
   * 刷新某一「文字顏色」行的撞色提示：選中色 vs 當前吊牌色。
   * AUTO 不提示（後端會按牌色自動配黑/白，永不撞色）。
   */
  function updateTextColorHint(row) {
    if (!row) return;
    const warn = row.querySelector('.text-color-warn');
    const active = row.querySelector('.swatch-list .swatch.active');
    if (!warn || !active) return;
    const code = active.dataset.color || 'AUTO';
    if (code === 'AUTO' || code.charAt(0) !== '#') {
      warn.classList.add('hidden'); warn.textContent = ''; return;
    }
    // 承印部件名稱按 auto_color_target 動態（吊牌/牌身/肩帶）
    const _bn = { tag: ['吊牌', 'tag'], body: ['牌身', 'body'], strap: ['肩帶', 'strap'] }[_textColorBaseKey] || ['產品', 'product'];
    const tagSw = document.querySelector(`.swatch-list[data-key="${_textColorBaseKey}"] .swatch.active`);
    const tagHex = tagSw ? (_textColorTargetHexes[tagSw.dataset.color] || '#FFFFFF') : '#FFFFFF';
    if (_contrastRatioHex(code, tagHex) < 2.0) {
      warn.textContent = `⚠️ 此顏色與${_bn[0]}顏色太接近，織出來會看不清，建議換對比強的顏色。 This colour is too close to the ${_bn[1]} colour and may be hard to read — try a stronger contrast.`;
      warn.classList.remove('hidden');
    } else {
      warn.classList.add('hidden'); warn.textContent = '';
    }
  }

  /** 刷新頁面上全部文字顏色行的撞色提示（換吊牌顏色後調用）。 */
  function refreshAllTextColorHints() {
    $$('.text-color-row').forEach(updateTextColorHint);
  }

  /**
   * 顯示／隱藏「選色對比」警告（後端 contrast_warnings 生成）。
   * 客戶把文字/條碼選成與底色同色時，織出來會看不清 —— 提示但不攔截下單。
   */
  function renderContrastWarnings(warnings) {
    const box = $('#contrast-warn');
    if (!box) return;
    if (warnings && warnings.length) {
      box.innerHTML = warnings.map(w => `<div>${w}</div>`).join('');
      box.classList.remove('hidden');
    } else {
      box.innerHTML = '';
      box.classList.add('hidden');
    }
  }

  let _previewSeq = 0;   // 併發防護：快速連點換色時，只採納最後一次預覽

  async function preview(opts) {
    const seq = ++_previewSeq;
    setLoading(true);
    try {
      const pid = lockedPid || $('#product-select').value;
      const { dataUrl, meta } = await fetchComposite(pid, collectParams());
      if (seq !== _previewSeq) return;      // 已有更新的預覽請求 → 丟棄舊圖，避免舊圖蓋新圖
      showImage(dataUrl);
      renderContrastWarnings(meta && meta.warnings);
    } catch (e) {
      console.error(e);
      if (seq === _previewSeq && !(opts && opts.quiet)) {
        alert('抱歉，預覽未能更新，請再試一次；若持續出現，可直接落單，我們會以電郵與你確認設計。 Sorry, we couldn’t update the preview. Please try again — if it keeps happening, just place your order and we’ll confirm the design with you by email.');
      }
    } finally {
      setLoading(false);
    }
  }

  async function autoPreview() {
    if (!currentTemplate) return;
    await preview();
  }

  /* ── 相片上載（MYO 系列）：選圖即時反饋 + 格式/大小校驗 + 自動重繪 ──
     舊問題：客戶選完本機圖片後介面毫無反應（要自己再按「重新繪製」），
     而且 iPhone 的 HEIC 相片會被靜默送上後端失敗。現在：
     1) 選圖立即縮圖＋檔名確認；2) 格式/大小不符即時雙語提示；3) 自動開始重繪。 */
  const PHOTO_MAX_MB = 10;
  const PHOTO_OK_TYPES = /^image\/(jpeg|jpg|png|webp|gif|bmp)$/i;
  const PHOTO_OK_EXT = /\.(jpe?g|png|webp|gif|bmp)$/i;

  /** 校驗相片檔案；不通過返回雙語錯誤文案，通過返回 null。 */
  function validatePhotoFile(file) {
    if (!file) return '請先選擇一張相片。 Please choose a photo first.';
    const typeOk = PHOTO_OK_TYPES.test(file.type || '');
    const extOk = PHOTO_OK_EXT.test(file.name || '');
    if (!typeOk && !extOk) {
      if (/heic|heif/i.test(file.type || '') || /\.hei[cf]$/i.test(file.name || '')) {
        return '此相片是 iPhone 的 HEIC 格式，請在 iPhone「設定 → 相機 → 格式」選「相容性最佳」，或先轉存為 JPG／PNG 再上載。 This photo is in HEIC format — please switch your iPhone to "Most Compatible" camera format, or convert it to JPG/PNG first.';
      }
      return '此檔案不是支援的圖片格式，請用 JPG 或 PNG。 This file is not a supported image — please use JPG or PNG.';
    }
    if (file.size > PHOTO_MAX_MB * 1024 * 1024) {
      return `相片太大（${(file.size / 1024 / 1024).toFixed(1)}MB），上限 ${PHOTO_MAX_MB}MB，請先縮小再上載。 Photo too large (${(file.size / 1024 / 1024).toFixed(1)}MB) — the limit is ${PHOTO_MAX_MB}MB, please shrink it first.`;
    }
    return null;
  }

  /** 上載區即時縮圖 + 檔名，讓客戶知道「相片已選中」。 */
  function showPhotoChosen(file) {
    let box = $('#photo-chosen');
    const sec = $('#artwork-section');
    if (!box && sec) {
      box = document.createElement('div');
      box.id = 'photo-chosen';
      box.className = 'photo-chosen hidden';
      const input = $('#image-input');
      input.parentElement.insertBefore(box, input.nextSibling);
    }
    if (!box) return;
    if (!file) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    const url = URL.createObjectURL(file);
    box.innerHTML = '<img class="photo-chosen__thumb" alt="">'
      + '<span class="photo-chosen__name"></span>'
      + '<span class="photo-chosen__size"></span>';
    box.querySelector('img').src = url;
    box.querySelector('.photo-chosen__name').textContent = file.name || 'photo';
    box.querySelector('.photo-chosen__size').textContent = (file.size / 1024 / 1024).toFixed(1) + 'MB';
    box.classList.remove('hidden');
  }

  /** 綁定 #image-input：選圖 → 校驗 → 縮圖確認 → 自動重繪。 */
  function setupPhotoInput() {
    const input = $('#image-input');
    if (!input || input._lkPhotoBound) return;
    input._lkPhotoBound = true;
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      if (!file) { showPhotoChosen(null); return; }
      const err = validatePhotoFile(file);
      const status = $('#ai-status');
      if (err) {
        // 不通過：清空選擇，讓客戶重選，並給明確原因
        input.value = '';
        showPhotoChosen(null);
        if (status) status.textContent = '⚠️ ' + err;
        return;
      }
      showPhotoChosen(file);
      if (status) status.textContent = '';
      // 手繪匙扣走「識別 + 重排」；其餘產品走 AI 重繪
      const conf = currentArtConf();
      if (conf && conf.force_style === 'sketch') runSketchRecognize();
      else runAiRedraw();
    });
    // 自訂上傳按鈕（彈層美化）：原生 file input 隱藏，點按鈕代觸發；檔名即時顯示
    const btn = $('#image-input-btn');
    if (btn && !btn._lkBound) {
      btn._lkBound = true;
      btn.addEventListener('click', () => input.click());
      input.addEventListener('change', () => {
        const wrap = btn.closest('.file-field');
        const nameEl = $('#image-file-name');
        const f = input.files && input.files[0];
        if (nameEl) nameEl.textContent = f ? f.name : '未選擇 No file chosen';
        if (wrap) wrap.classList.toggle('has-file', !!f);
      });
    }
  }

  /** 當前產品的 artwork 配置（無則 null）。 */
  function currentArtConf() {
    const t = currentTemplate;
    if (!t || !t.components) return null;
    const c = t.components.find(x => x.artwork);
    return c ? c.artwork : null;
  }

  /** 等待中狀態：跳跳毛線球公仔 + 文案（提取／AI 重繪共用）。 */
  function showBusyStatus(text) {
    const el = $('#ai-status');
    if (!el) return;
    el.innerHTML =
      '<span class="lk-buddy-row"><svg class="lk-buddy" viewBox="0 0 40 46" aria-hidden="true">' +
      '<rect x="13" y="38" width="4" height="7" rx="2" fill="#C9553F"/>' +
      '<rect x="23" y="38" width="4" height="7" rx="2" fill="#C9553F"/>' +
      '<circle cx="20" cy="24" r="13" fill="#E8735A"/>' +
      '<path d="M8 22 q6 -7 12 -6 M10 30 q7 5 15 1 M21 11 q7 3 9 10" stroke="#C9553F" fill="none" stroke-width="2.2" stroke-linecap="round"/>' +
      '<circle cx="15.5" cy="22" r="2" fill="#26221E"/><circle cx="24.5" cy="22" r="2" fill="#26221E"/>' +
      '<path d="M17 28 q3 2.6 6 0" stroke="#26221E" fill="none" stroke-width="1.8" stroke-linecap="round"/>' +
      '</svg><span>' + text + '</span></span>';
  }

  /** 手繪匙扣：視覺模型識別紙上手繪 → 自動渲染標準版直接上圖。
      識別不可用時回落「客戶自己填」模式（展開編輯器），流程不中斷。 */
  async function runSketchRecognize() {
    const pid = lockedPid || $('#product-select').value;
    const fileInput = $('#image-input');
    const file = fileInput.files && fileInput.files[0];
    if (!file) {
      $('#ai-status').textContent = '請先選擇一張手繪相片。 Please choose a photo of your drawing first.';
      return;
    }
    const note = $('#sketch-note');
    const bar = $('#sketch-bar');
    if (bar) bar.classList.remove('hidden');
    _sketchLastLine = null;   // 新圖新線稿：舊換色緩存作廢
    setLoading(true);
    showBusyStatus('毛線球正在讀你的畫——約 5 秒… Reading your drawing — a few seconds…');
    try {
      const b64 = await fileToBase64(file);
      const res = await fetch(`/api/product/${pid}/sketch-recognize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: b64 })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const inp = $('#sketch-text');
      if (inp && data.text) inp.value = data.text;
      updateSketchLenHint();   // 識別結果填入後同步長度提示
      if (data.shapes && data.shapes.length) {
        document.querySelectorAll('#sketch-icons button').forEach(btn => {
          btn.classList.toggle('active', data.shapes.includes(btn.dataset.icon));
        });
      }
      updateSketchRead();
      // ---- 路由（2026-11-06）----
      // 文字/词表内图标 → 字模排版：1 秒出图、字是矢量级别清晰（98 针宽下
      //   逐字分明，这是实测唯一能保证可读的路径）。
      // 自由图案（恐龙/人物/logo/复杂插画，超出 12 个图标词表）→ AI 生图：
      //   只有模型画得出来。慢（约 25 秒）且文字会糊，所以只在必要时用。
      // 两者都没有 → 展开编辑器让客户自己填（catch 里已有的回落逻辑）。
      _sketchSubject = data.subject || '';
      _sketchEnglish = data.english || '';
      _sketchKind = (data.shape_kind === 'common' ? 'common' : 'custom');
      // 把識別出的圖案名顯示給客戶並允許修改：文生圖路徑的正確性完全依賴
      // 這個名稱（實測同一張恐龍被認成「烏龜」「昆蟲」），這是唯一的糾正入口。
      const subjRow = $('#sketch-subject-row');
      const subjInp = $('#sketch-subject');
      if (subjRow && subjInp) {
        if (_sketchSubject) {
          subjInp.value = _sketchSubject;
          subjRow.classList.remove('hidden');
        } else {
          subjRow.classList.add('hidden');
        }
      }
      const artwork = data.artwork || (data.shapes && data.shapes.length ? 'icon' : 'none');
      if (artwork === 'free') {
        _lastRoute = 'ai';
        if (note) {
          // 依織片針數給不同預期：小織片（鑰匙扣 1980 針）只能織大塊剪影，
          // 細節一定會掉；大織片（托特包等）則能保留較多層次。
          const sz = (currentTemplate && currentTemplate.size) || {};
          const stitches = (sz.stitch_w || 0) * (sz.stitch_h || 0);
          const small = !stitches || stitches < 4000;
          // 混合场景（有文字 + 有复杂图案）在小织片上是硬冲突：实测 DINO + 恐龙
          // 在 98×22 上只出得来字母、恐龙整个消失（4 个字母已占 55 针）。
          // 这种情况必须劝客户二选一，而不是让他收货后才发现少了一半内容。
          const mixed = !!(data.text && small);
          if (mixed) {
            note.textContent = '⚠️ 你的畫裡同時有文字和圖案，但這款織片只有 '
              + (sz.stitch_w || 98) + '×' + (sz.stitch_h || 22)
              + ' 針（約 ' + (sz.width_cm || 12) + '×' + (sz.height_cm || 3) + 'cm），'
              + '放不下兩者——建議只保留文字（點「黑體版」最清晰），或只保留圖案。'
              + ' 需要「文字＋圖案」請選更大尺寸的產品（如托特包）。';
            // 混合場景不自動跑 AI：98 針寬註定只能二選一，跑 25 秒換來一張
            // 缺圖案的圖沒有意義。先出字模版把文字保住（客戶至少拿到可織的
            // 設計），想試圖案可自己點「AI 重繪」——選擇權交回客戶。
            await runSketchRender();
            if (note) note.textContent += ' 已先保留文字版；想改試圖案請點「AI 重繪」。';
            return;
          } else {
            note.textContent = '🎨 你的畫裡有圖案，我們用 AI 重繪成針織剪影（約 25 秒）。'
              + (small
                  ? ' 提醒：這款織片只有 ' + (sz.stitch_w || 98) + '×' + (sz.stitch_h || 22)
                    + ' 針，複雜圖案會簡化成輪廓剪影、無法保留細節。'
                  : '');
          }
        }
        await runSketchRedraw();
      } else {
        _lastRoute = 'font';
        if (note) {
          note.textContent = data.text
            ? '✍️ 已用最適合織造的窄體字重新排版——放大後逐字都看得清。'
            : '';
        }
        await runSketchRender();
      }
    } catch (e) {
      console.error(e);
      $('#ai-status').textContent = '';
      const ed = $('#sketch-editor');
      if (ed) ed.classList.remove('hidden');   // 回落：展開編輯器讓客戶自己填
      if (note) note.textContent = '⚠️ ' + (e.message || '自動識別不可用——請在下方直接輸入文字、選圖案。');
    } finally {
      setLoading(false);
    }
  }

  /** 織字長度提示：上限按「金屬環留白後的可用寬度」動態計算。
      靠近金屬環要留 2.5cm（約 19 針），可用寬度 = 針數 × (1 - 2.5/13 - 2×0.0667) ≈ 針數 × 0.674。
      中文每字至少要 12 針才不糊（實測 13.2 針清晰、9.4 針黏成一團），
      拉丁字母 5 針/字母仍可分（13 字母已驗證）。 */
  function updateSketchLenHint() {
    const el = $('#sketch-len-hint');
    const inp = $('#sketch-text');
    if (!el || !inp) return;
    const v = (inp.value || '').trim();
    const cjk = (v.match(/[\u3400-\u9FFF\uF900-\uFAFF]/g) || []).length;
    const icons = document.querySelectorAll('#sketch-icons button.active').length;
    // 只数「真正要织的字」——空格只是间隙，不占额度
    // （实测空格外形宽 275，只有字母 H 的 673 的 40%，且不产生针迹）
    const latin = Math.max(0, (v.replace(/\s/g, '')).length - cjk);
    // 針數取模板實際值（2026-11 起 13cm 款為 98 針），換尺寸時文案自動跟著改
    const _sz = (currentTemplate && currentTemplate.size) || {};
    const _sw = _sz.stitch_w || 98;
    // 可用宽 = 1 - 金属环 2.5/13(0.1923) - 左右安全边距 2×0.0667 = 0.674
    const availStitches = _sw * 0.674;
    // 实测上限（98 针）：拉丁 16 字母字高 15 行仍可分，17 字母字高塌到 8 行；
    // 中文 5 字字高 12 行可读，6 字掉到 10 行且笔画开始黏。
    // 按针数等比换算，换尺寸时自动跟着变。
    const _scale = _sw / 98;
    const maxCjk = Math.max(1, Math.round(5 * _scale));
    const maxLatin = Math.max(1, Math.round(16 * _scale));
    // 等价格数：中文/图标算 1，拉丁字母算 0.32（≈5 针 / 16 针）
    const cells = cjk + icons + latin * 0.32;
    const over = cjk > maxCjk || latin > maxLatin || cells > maxCjk + 0.4;
    el.classList.toggle('over', over);
    if (over) {
      el.textContent = '⚠️ 內容偏多（約 ' + Math.ceil(cells) + ' 格）：靠近金屬環要留 2.5cm 空白，'
        + '實際可織寬度約 ' + Math.round(availStitches) + ' 針，'
        + '中文最多 ' + maxCjk + ' 字、英文最多 ' + maxLatin + ' 字母，再多會黏在一起看不清。 '
        + 'Room for a ring guard — up to ' + maxCjk + ' Chinese characters or ' + maxLatin + ' letters.';
    } else {
      el.textContent = '中文 ' + maxCjk + ' 字以內、英文 ' + maxLatin + ' 個字母以內最清楚'
        + '（靠近金屬環留 2.5cm 空白，可織寬約 ' + Math.round(availStitches) + ' 針）。 '
        + 'Up to ' + maxCjk + ' Chinese characters or ' + maxLatin + ' letters.';
    }
  }

  /** 確認條文案：讀到「世一 + 笑脸」。 */
  function updateSketchRead() {
    const el = $('#sketch-read');
    if (!el) return;
    const t = ($('#sketch-text') && $('#sketch-text').value.trim()) || '';
    const s = Array.from(document.querySelectorAll('#sketch-icons button.active')).map(b => b.dataset.icon);
    el.textContent = [t, s.join(' + ')].filter(Boolean).join(' + ') || '—';
  }

  let _skRerenderTimer = null;
  function debounceSketchRerender() {
    updateSketchRead();
    clearTimeout(_skRerenderTimer);
    _skRerenderTimer = setTimeout(() => runSketchRender(), 500);
  }

  /** 手繪匙扣：按確認的文字+圖形渲染針織圖（約 1 秒，即時可重生成）。 */
  async function runSketchRender() {
    const pid = lockedPid || $('#product-select').value;
    const text = ($('#sketch-text') && $('#sketch-text').value.trim()) || '';
    const shapes = Array.from(document.querySelectorAll('#sketch-icons button.active'))
      .map(b => b.dataset.icon);
    if (!text && !shapes.length) {
      $('#ai-status').textContent = '請先輸入文字或選一個圖案。 Please enter text or pick an icon first.';
      return;
    }
    setLoading(true);
    showBusyStatus('毛線球正在排版——1 秒內好… Laying out your design…');
    try {
      const res = await fetch(`/api/product/${pid}/sketch-render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, shapes, ink: getParamColor('ink'), body_color: getParamColor('body') })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      currentDesign = data.design;
      _sketchLastLine = data.line_raw || data.sketch || null;
      sketchOrder = { text: data.text || '', shapes: data.shapes || [], mode: 'standard' };
      const stdBtn = $('#sketch-std');
      if (stdBtn) stdBtn.classList.add('hidden');
      const aiBtn2 = $('#sketch-ai');
      if (aiBtn2) aiBtn2.classList.remove('hidden');
      $('#ai-status').textContent = '完成——記得核對文字無誤。 Done — please double-check the wording.';
      await preview();
    } catch (e) {
      console.error(e);
      $('#ai-status').textContent = '⚠️ ' + (e.message || '生成失敗，請再試一次。 Generation failed — please try again.');
    } finally {
      setLoading(false);
    }
  }

  /** 手繪匙扣 AI 重繪版：手繪原圖 + 識別內容 → seedream 生成精美線稿 → 針織化（約 25 秒）。 */
  /** 直接針織預覽：客戶原圖本地針織化，不調 AI。
      同一張圖每次結果完全相同（確定性），約 20 毫秒出圖。
      用途：讓客戶先看到「忠實於自己筆跡」的版本，再決定要不要 AI 重繪。 */
  async function runSketchDirect() {
    const pid = lockedPid || $('#product-select').value;
    const fileInput = $('#image-input');
    const file = fileInput.files && fileInput.files[0];
    if (!file) {
      $('#ai-status').textContent = '請先選擇手繪相片。 Please choose your drawing photo first.';
      return;
    }
    setLoading(true);
    $('#ai-status').textContent = '正在按你的筆跡針織——約 1 秒… Knitting your strokes — about a second…';
    try {
      const b64 = await fileToBase64(file);
      const res = await fetch(`/api/product/${pid}/sketch-direct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: b64,
          ink: getParamColor('ink'), body_color: getParamColor('body'),
          // B1 本地模式：骨架等宽化 + 空间聚类 + 端点桥接，0 元、约 1 秒、完全确定。
          // 改成 true 会走 AI 去噪（0.30 元/次、40~60 秒、AI 会重画内容、结果不确定）。
          ai_clean: false,
        })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      currentDesign = data.design;
      _sketchLastLine = data.line_raw || data.sketch || null;
      sketchOrder = { text: '', shapes: [], mode: 'direct' };
      const stdBtn = $('#sketch-std');
      if (stdBtn) stdBtn.classList.remove('hidden');
      const aiBtn = $('#sketch-ai');
      if (aiBtn) aiBtn.textContent = '✨ 改用 AI 重繪 Try AI redraw';
      $('#ai-status').textContent = '已按你的原筆跡針織，未做任何改畫（同樣的圖每次結果都一樣）。'
        + '想讓 AI 幫你畫得更乾淨，可點「AI 重繪」。 Knitted exactly from your strokes — same input always gives the same result.';
      await preview();
    } catch (e) {
      console.error(e);
      $('#ai-status').textContent = '⚠️ ' + (e.message || '直接針織失敗，請重拍或改用 AI 重繪。');
    } finally {
      setLoading(false);
    }
  }

  async function runSketchRedraw() {
    const pid = lockedPid || $('#product-select').value;
    const fileInput = $('#image-input');
    const file = fileInput.files && fileInput.files[0];
    if (!file) {
      $('#ai-status').textContent = '請先選擇手繪相片。 Please choose your drawing photo first.';
      return;
    }
    const note = $('#sketch-note');
    const text = ($('#sketch-text') && $('#sketch-text').value.trim()) || '';
    const shapes = Array.from(document.querySelectorAll('#sketch-icons button.active'))
      .map(b => b.dataset.icon);
    // 不再要求「至少要有文字或圖案」：只畫圖不寫字（恐龍、logo）是常見需求，
    // 照片本身就是重繪依據。只要有上傳圖就放行（上面已擋過無圖情況）。
    if (!text && !shapes.length) {
      _redrawImageOnly = true;   // 標記本次為純圖重繪，狀態提示用詞不同
    } else {
      _redrawImageOnly = false;
    }
    setLoading(true);
    // 有文字时后端会走矢量字模（约 1 秒、笔画和孔洞都可控），
    // 只有纯图形才交给 AI。提示文案必须跟着说，否则客户以为要等 25 秒。
    if (text || shapes.length) {
      showBusyStatus('正在用清晰字體排版——約 1 秒… Laying out your text as crisp type — about a second…');
    } else {
      showBusyStatus('毛線球正在 AI 重繪——約 25 秒，別走開… AI redrawing — about 25 seconds…');
    }
    try {
      const b64 = await fileToBase64(file);
      const res = await fetch(`/api/product/${pid}/sketch-redraw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: b64, text, shapes,
          ink: getParamColor('ink'), body_color: getParamColor('body'),
          // 语义字段：后端据此选「文生图标准剪影」或「图生图照原稿描」。
          // subject 一律以输入框当前值为准（客户可能刚改过），不读模块变量——
          // 实测模块变量会被识别回调覆盖，导致改了名字仍发旧值。
          subject: (($('#sketch-subject') && $('#sketch-subject').value.trim()) || _sketchSubject),
          english: _sketchEnglish,
          shape_kind: (($('#sketch-subject') && $('#sketch-subject').value.trim())
            ? 'common' : _sketchKind)
        })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      currentDesign = data.design;
      _sketchLastLine = data.line_raw || data.sketch || null;
      sketchOrder = { text: data.text || '', shapes: data.shapes || [], mode: 'ai' };
      const aiBtn2 = $('#sketch-ai');
      if (aiBtn2) aiBtn2.textContent = '✨ 再畫一次 Redraw again';
      const stdBtn = $('#sketch-std');
      if (stdBtn) stdBtn.classList.remove('hidden');
      $('#ai-status').textContent = 'AI 重繪完成——可再畫一次或切回黑體版。 Done — redraw again or switch back.';
      await preview();
      // SMART YARN COLOURS：AI 重繪出的扁平色塊圖支持逐區域換紗線色（失敗靜默）
      hideRegionPanel();
      setupRegionPanel(pid, data.design).catch(err => console.warn('region panel:', err));
    } catch (e) {
      console.error(e);
      // AI 掛了不能讓客戶卡死：只要有文字，字模排版一定能出圖（1 秒、字清晰），
      // 先保住訂單，再告訴客戶「圖案這次沒畫出來」。純圖案則只能請客戶重試。
      if (text) {
        $('#ai-status').textContent = '⚠️ AI 重繪暫時不可用，已改用清晰字體排版（你的圖案這次沒能畫進去，可再試一次）。';
        try {
          await runSketchRender();
          if (note) note.textContent = '✍️ 已用窄體字重新排版——文字清晰，圖案暫時省略。';
          return;
        } catch (e2) {
          console.error(e2);
        }
      }
      $('#ai-status').textContent = '⚠️ ' + (e.message || (_redrawImageOnly
        ? 'AI 重繪失敗，請再試一次。'
        : 'AI 重繪失敗，請再試一次或用黑體版。 Redraw failed — try again or use Bold font.'));
    } finally {
      setLoading(false);
    }
  }

  async function runAiRedraw() {
    const pid = lockedPid || $('#product-select').value;
    const fileInput = $('#image-input');
    const file = fileInput.files && fileInput.files[0];
    if (!file) {
      $('#ai-status').textContent = '請先選擇一張相片，我們會幫你重繪成針織圖案。 Please choose a photo first, then we’ll redraw it for knitting.';
      return;
    }
    const err = validatePhotoFile(file);
    if (err) {
      $('#ai-status').textContent = '⚠️ ' + err;
      return;
    }
    setLoading(true);
    showBusyStatus('毛線球正在重繪你的相片——一般需時 10–20 秒… Redrawing your photo — this usually takes 10–20 seconds…');
    hideRegionPanel();
    try {
      const b64 = await fileToBase64(fileInput.files[0]);
      const res = await fetch(`/api/product/${pid}/ai-redraw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: b64, style: $('#style-select').value })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      currentDesign = data.design;
      $('#ai-status').textContent = '完成——重繪好的圖案已織上產品。 Done — your redrawn artwork is now on the product.';
      await preview();
      // SMART YARN COLOURS：识别区域，供客户逐块换纱线色（失败静默，不影响主流程）
      setupRegionPanel(pid, data.design).catch(err => console.warn('region panel:', err));
    } catch (e) {
      console.error(e);
      $('#ai-status').textContent = '抱歉，這張相片未能重繪，請換一張試試，或直接沿用原相片。 Sorry, we couldn’t redraw that photo. Try another one, or carry on with your original photo.';
    } finally {
      setLoading(false);
    }
  }

  // ── SMART YARN COLOURS：区域识别 + 指定区域换色 ──────────────────────
  // 换色 = 「区域 → 纱线色」映射替换，区域本身不重算，形状/编号永远稳定。
  // 点图选区：region_index（像素值=区域号，与针织预览同尺寸）+ design_rect
  // （图案在合成图内的摆放矩形）→ 点击坐标直接命中区域，无需服务器重算。
  let _regionState = null;   // { map_id, assignments, index, rect, rows }

  function hideRegionPanel() {
    _regionState = null;
    const p = $('#region-panel');
    if (p) p.classList.add('hidden');
    removeRegionOverlay();
  }

  function _hexRgb(hx) {
    if (!/^#[0-9A-Fa-f]{6}$/.test(hx || '')) return null;
    return [parseInt(hx.slice(1, 3), 16), parseInt(hx.slice(3, 5), 16), parseInt(hx.slice(5, 7), 16)];
  }

  function _nearestYarn(hex, yarns) {
    const rgb = _hexRgb(hex);
    if (!rgb) return yarns[0];
    let best = yarns[0], bd = Infinity;
    yarns.forEach(y => {
      const ry = _hexRgb(y);
      if (!ry) return;
      const d = ry.reduce((s, v, i) => s + (v - rgb[i]) * (v - rgb[i]), 0);
      if (d < bd) { bd = d; best = y; }
    });
    return best;
  }

  function ensureRegionPanel() {
    let p = $('#region-panel');
    if (p) return p;
    p = document.createElement('div');
    p.id = 'region-panel';
    p.className = 'region-panel hidden';
    // 放在右欄「顏色選擇區」下方（語義：換紗線色就屬於選色流程）；
    // 不能插在 #preview 前面——那是預覽卡內部（.img-wrap），會被擠壓截斷。
    const anchor = $('#color-sections');
    if (anchor && anchor.parentNode) {
      anchor.insertAdjacentElement('afterend', p);
    } else {
      const info = document.querySelector('.product-info');
      (info || document.body).appendChild(p);
    }
    return p;
  }

  async function setupRegionPanel(pid, designB64) {
    hideRegionPanel();
    // 仅在模板有纱线调色板（可换色）时启用；单色/文字类产品自动跳过
    const t = currentTemplate;
    if (!t || !t.palette || !Object.keys(t.palette).length) return;
    const res = await fetch('/api/region-analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ design: designB64, product_type: pid, min_pct: 1.0, outline: false })
    });
    const data = await res.json();
    if (data.error || !data.regions || data.regions.length < 2) return;   // 单区域无换色意义
    const yarns = data.yarn_colors || [];
    // 背景区域：合成时会被镂空、由袋身底色呈现（与袋身色 swatch 同职责），
    // 对它换色不会有任何视觉效果 → 不列入面板、点图命中也忽略。
    const bgIds = Array.isArray(data.bg_ids) ? data.bg_ids.map(String) : (data.bg_id ? [String(data.bg_id)] : []);
    // 一鍵還原基準：AI 重繪時的袋身底色（reset 時一併還原）
    const bagList = document.querySelector('.swatch-list[data-key="bag"]');
    const defaultBag = bagList && bagList.querySelector('.swatch.active');
    _regionState = { map_id: data.map_id, assignments: {}, rows: {}, groups: [], selects: {}, defaults: {}, bgIds: bgIds, defaultBag: defaultBag ? defaultBag.dataset.color : null, origDesign: designB64, index: null, rect: data.design_rect || null };
    // 载入区域索引图（点图选区的命中数据源）
    if (data.region_index) {
      try {
        const img = new Image();
        img.src = 'data:image/png;base64,' + data.region_index;
        await img.decode();
        const cv = document.createElement('canvas');
        cv.width = img.naturalWidth; cv.height = img.naturalHeight;
        cv.getContext('2d').drawImage(img, 0, 0);
        _regionState.index = { width: cv.width, height: cv.height, data: cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data };
      } catch (e) { console.warn('region index:', e); }
    }
    const p = ensureRegionPanel();
    p.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'region-panel__title';
    title.textContent = '🧶 SMART YARN COLOURS 智慧換色';
    const note = document.createElement('div');
    note.className = 'region-panel__note';
    note.textContent = '直接點擊圖案入面嘅區域（例如狗狗、草地）揀選佢，再揀毛線色；亦可以用下面嘅下拉選單。 Tap a part of the design — e.g. the dog or the grass — then pick a yarn colour.';
    p.appendChild(title); p.appendChild(note);
    // 一鍵還原：換色後回到 AI 重繪最初的紗線配色（不重算區域，只換映射）
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'region-reset';
    resetBtn.textContent = '↺ 一鍵還原 Reset colours';
    resetBtn.setAttribute('aria-label', '還原所有紗線顏色 Reset all yarn colours');
    resetBtn.addEventListener('click', () => regionReset());
    p.appendChild(resetBtn);
    const rows = document.createElement('div');
    // 同色區域合併成一行：一片草地被主體隔成 3 塊時，客戶心智是「草地」一件事，
    // 不是 3 個碎塊。按代表色分組後每行改色會同時套用到同組所有區域，
    // 點圖命中任一塊也高亮同一行（整片一起換，符合直覺）。
    const groups = [];
    const groupByHex = {};
    data.regions.forEach(r => {
      if (_regionState.bgIds.includes(String(r.id))) return;   // 背景区域不提供换色（镂空后由袋身色呈现）
      const key = (r.hex || '').toUpperCase();
      if (!groupByHex[key]) {
        groupByHex[key] = { hex: key, ids: [], cells: 0 };
        groups.push(groupByHex[key]);
      }
      groupByHex[key].ids.push(String(r.id));
      groupByHex[key].cells += (r.cells || 0);
    });
    groups.forEach(g => {
      const row = document.createElement('div');
      row.className = 'region-row';
      row.dataset.group = g.hex;
      const sw = document.createElement('span');
      sw.className = 'region-swatch';
      sw.style.background = g.hex;
      const current = _nearestYarn(g.hex, yarns);
      g.ids.forEach(rid => {
        _regionState.defaults[rid] = current;   // 一鍵還原的基準：AI 重繪原始配色
        _regionState.rows[rid] = row;           // 同組共用一行
      });
      const applyGroup = (hex) => {
        if (!_regionState) return;
        g.ids.forEach(rid => { _regionState.assignments[rid] = hex; });
        regionRecolor().catch(err => console.warn('recolor:', err));
      };
      // 調色板直接用色塊（不用下拉）：客戶要看到「顏色」而不是 #F5EFE6 這種色號。
      // 23 個毛線色以圓形色塊平鋪，當前色帶描邊高亮，點一下即換色（手機更直覺）。
      const palette = document.createElement('div');
      palette.className = 'region-palette';
      const chips = {};
      const selHex = (hex) => {
        const up = String(hex || '').toUpperCase();
        Object.keys(chips).forEach(k => chips[k].classList.toggle('is-current', k === up));
        sw.style.background = hex;
      };
      yarns.forEach(y => {
        const up = y.toUpperCase();
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'region-chip' + (up === current.toUpperCase() ? ' is-current' : '');
        chip.style.background = y;
        chip.title = up;
        chip.setAttribute('aria-label', '毛線色 ' + up);
        chip.addEventListener('click', (ev) => {
          ev.stopPropagation();
          selHex(y);
          applyGroup(y);
        });
        chips[up] = chip;
        palette.appendChild(chip);
      });
      const cnt = document.createElement('span');
      cnt.className = 'region-count';
      cnt.textContent = g.cells + ' 針 stitches';
      row.appendChild(sw); row.appendChild(cnt);
      row.appendChild(palette);
      (_regionState.groups = _regionState.groups || []).push({
        ids: g.ids, hex: g.hex, defaultYarn: current, setHex: selHex
      });
      rows.appendChild(row);
      row.addEventListener('click', (ev) => {
        if (ev.target.closest('.region-palette') || ev.target.closest('.region-quick') || ev.target.closest('select')) return;
        selectRegion(g.ids[0]);
      });
    });
    p.appendChild(rows);
    p.classList.remove('hidden');
    ensureRegionOverlay();
  }

  // ── 點圖選區：覆蓋層 + 命中測試 + 高亮 ─────────────────────────────

  function ensureRegionOverlay() {
    let cv = document.getElementById('region-hit-layer');
    const wrap = document.getElementById('img-wrap');
    if (!wrap) return null;
    if (!cv) {
      cv = document.createElement('canvas');
      cv.id = 'region-hit-layer';
      wrap.appendChild(cv);
      cv.addEventListener('click', (ev) => {
        const id = regionHitTest(ev);
        if (id) selectRegion(id);
      });
      window.addEventListener('resize', syncRegionOverlay);
    }
    syncRegionOverlay();
    return cv;
  }

  function removeRegionOverlay() {
    const cv = document.getElementById('region-hit-layer');
    if (cv) cv.remove();
  }

  function syncRegionOverlay() {
    const cv = document.getElementById('region-hit-layer');
    const img = $('#preview');
    if (!cv || !img) return;
    const on = !!(_regionState && _regionState.index);
    cv.classList.toggle('is-on', on);
    if (!on) { const c = cv.getContext('2d'); c.clearRect(0, 0, cv.width, cv.height); return; }
    // 對齊 #preview 的實際渲染框（.img-wrap 是 position:relative 的 flex 容器）
    cv.style.left = img.offsetLeft + 'px';
    cv.style.top = img.offsetTop + 'px';
    const w = img.clientWidth, h = img.clientHeight;
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    drawRegionHighlight();
  }

  function regionHitTest(ev) {
    if (!_regionState || !_regionState.index || !_regionState.rect) return null;
    const img = $('#preview');
    if (!img || !img.naturalWidth) return null;
    const r = img.getBoundingClientRect();
    if (!r.width) return null;
    // 顯示坐標 → 合成圖自然像素。注意 design_rect 是「合成原圖」坐標，
    // 而顯示的預覽被 _send_composite 縮過（≤720px）——必須按比例換算，不能直接比較。
    const cx = (ev.clientX - r.left) * (img.naturalWidth / r.width);
    const cy = (ev.clientY - r.top) * (img.naturalHeight / r.height);
    const rect = _regionState.rect;
    const sx = img.naturalWidth / (rect.canvas_w || img.naturalWidth);
    const sy = img.naturalHeight / (rect.canvas_h || img.naturalHeight);
    const rx = rect.x * sx, ry = rect.y * sy, rw = rect.w * sx, rh = rect.h * sy;
    if (cx < rx || cy < ry || cx >= rx + rw || cy >= ry + rh) return null;
    const { width: w, height: h, data: d } = _regionState.index;
    const ix = Math.floor((cx - rx) / rw * w);
    const iy = Math.floor((cy - ry) / rh * h);
    // 容差：命中的像素無效（理論只在索引圖邊界外）就擴大半徑找最近的有效區域
    for (let rad = 0; rad <= 2; rad++) {
      for (let dy = -rad; dy <= rad; dy++) {
        for (let dx = -rad; dx <= rad; dx++) {
          const x = ix + dx, y = iy + dy;
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          const o = (y * w + x) * 4;
          if (d[o + 1] === 255 && d[o] > 0) return d[o];
        }
      }
    }
    return null;
  }

  function selectRegion(id) {
    if (!_regionState) return;
    if (_regionState.bgIds.includes(String(id))) return;   // 背景区域：点图命中也忽略
    // 同色區域共用一行：以行的 group（代表色）作為選中鍵，整片一起高亮/換色
    const row = _regionState.rows[String(id)];
    const key = (row && row.dataset.group) || String(id);
    _regionState.active = (_regionState.active === key) ? null : key;
    _regionState.activeIds = _regionState.active
      ? Object.entries(_regionState.rows || {})
          .filter(([, rw]) => rw.dataset.group === key)
          .map(([rid]) => Number(rid))
      : [];
    Object.entries(_regionState.rows || {}).forEach(([, rw]) => {
      rw.classList.toggle('is-active', _regionState.active !== null && rw.dataset.group === key);
    });
    if (_regionState.active && row && row.scrollIntoView) {
      row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    drawRegionHighlight();
  }

  function drawRegionHighlight() {
    const cv = document.getElementById('region-hit-layer');
    if (!cv || !_regionState || !_regionState.index) return;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    const ids = _regionState.activeIds && _regionState.activeIds.length
      ? new Set(_regionState.activeIds)
      : null;
    if (!ids) return;
    const { width: w, height: h, data: d } = _regionState.index;
    const off = document.createElement('canvas');
    off.width = w; off.height = h;
    const octx = off.getContext('2d');
    const mask = octx.createImageData(w, h);
    for (let i = 0; i < w * h; i++) {
      if (ids.has(d[i * 4]) && d[i * 4 + 1] === 255) {
        mask.data[i * 4] = 255; mask.data[i * 4 + 1] = 199; mask.data[i * 4 + 2] = 44;
        mask.data[i * 4 + 3] = 110;
      }
    }
    octx.putImageData(mask, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, 0, 0, cv.width, cv.height);
  }

  /** 一鍵還原：所有區域回到 AI 重繪時的原始配色，色塊與袋身色同步復位。 */
  function regionReset() {
    if (!_regionState || !_regionState.defaults) return;
    // 還原 = 直接回到 AI 重繪的原始設計圖（100% 與第一次看到的預覽一致），
    // 不走 region-recolor 重渲染，避免任何色差累積。
    _regionState.assignments = {};
    (_regionState.groups || []).forEach(gr => {
      if (gr.setHex) gr.setHex(gr.defaultYarn);   // 色塊高亮復位
    });
    Object.values(_regionState.rows || {}).forEach(row => row.classList.remove('is-active'));
    _regionState.active = null;
    _regionState.activeIds = [];
    if (_regionState.origDesign) {
      currentDesign = _regionState.origDesign;
      preview().catch(err => console.warn('reset preview:', err));
    } else {
      regionRecolor().catch(err => console.warn('recolor:', err));
    }
    // 袋身底色也一併還原到 AI 重繪時的顏色（客戶心智：一鍵回到最初的樣子）
    if (_regionState.defaultBag) {
      const bagList = document.querySelector('.swatch-list[data-key="bag"]');
      const active = bagList && bagList.querySelector('.swatch.active');
      if (active && active.dataset.color !== _regionState.defaultBag) {
        const target = bagList.querySelector('.swatch[data-color="' + _regionState.defaultBag + '"]');
        if (target) target.click();
      }
    }
  }

  async function regionRecolor() {
    if (!_regionState) return;
    const pid = lockedPid || $('#product-select').value;
    const res = await fetch('/api/region-recolor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ map_id: _regionState.map_id, assignments: _regionState.assignments, product_type: pid })
    });
    const d = await res.json();
    if (d.error) { $('#ai-status').textContent = '⚠️ ' + d.error; return; }
    currentDesign = d.design;               // 后续预览/提交沿用换色后的设计
    // 走标准预览流程（fetchComposite 带上客户当前选择的袋身色等参数），
    // 不能直接用 recolor 接口返回的 composite——那是默认袋身色，会丢掉已选底色。
    await preview();
    const ab = $('#ai-status');
    if (ab) ab.textContent = '已換色——圖案已按新紗線色重織。 Colours swapped — design reknitted with new yarn colours.';
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result.split(',')[1]);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  /**
   * 显示预览图。
   * @param {string} dataUrl 完整 dataURL（预览为 image/jpeg，兼容旧 image/png）
   */
  function showImage(dataUrl) {
    const img = $('#preview');
    img.src = dataUrl;
    img.style.display = 'block';
    // 點圖選區覆蓋層要跟著新圖重新對齊（換色後合成圖尺寸可能變）
    if (typeof syncRegionOverlay === 'function') {
      if (img.complete) syncRegionOverlay();
      else img.addEventListener('load', syncRegionOverlay, { once: true });
    }
  }

  let _redrawImageOnly = false;   // 本次 AI 重绘是否为「纯图案、无文字」
  // 识别出的图案语义：决定后端用「文生图标准剪影」还是「图生图照原稿描」。
  // 实测文生图剪影墨量是图生图的 3 倍、形状饱满（173 → 513 针），
  // 但只在「有公认标准造型的常见物体」上成立，自创/logo 必须照原稿描。
  let _sketchSubject = '';
  let _sketchEnglish = '';
  let _sketchKind = 'custom';     // 'common' | 'custom'，默认 custom（保守）
  let _lastRoute = '';            // 'font' | 'ai'：最近一次自动路由走向，供调试与提示

  let _loadingDepth = 0;   // 計數式：並發請求（換色重織 + 合成）不會互相提前解除 loading

  function setLoading(on) {
    _loadingDepth = Math.max(0, _loadingDepth + (on ? 1 : -1));
    const busy = _loadingDepth > 0;
    $('#spinner').classList.toggle('hidden', !busy);
    $('#preview-btn').disabled = busy;
    const ab = $('#ai-btn');
    if (ab) ab.disabled = busy;           // 手繪匙扣（方案 B）已移除 AI 按鈕
    const mk = $('#sketch-make');
    if (mk) mk.disabled = busy;
    const skAi = $('#sketch-ai'), skStd = $('#sketch-std');
    if (skAi) skAi.disabled = busy;
    if (skStd) skStd.disabled = busy;
  }

  // 加入购物车（本地演示：收集定制参数 + 确认 + 下载设计图）
  async function addToCart() {
    const pid = lockedPid || $('#product-select').value;
    if (!pid) { alert('請先揀選產品。 Please pick a product first.'); return; }
    // 顏色數量上限（工廠每件最多 5 種不同紗線色）：超限不允許加購
    const colorInfo = designColors();
    if (!colorInfo.ok) {
      updateColorCount();
      alert('此設計用了 ' + colorInfo.count + ' 種顏色，超出每件上限 ' + colorInfo.max + ' 種。請改用相同顏色後再試。\n'
        + 'This design uses ' + colorInfo.count + ' colours; the limit is ' + colorInfo.max + ' per piece. Please reuse colours.');
      return;
    }
    // 必須先上載圖案（手繪匙扣）：沒有設計圖會織出一條空白織帶
    if (currentTemplate && currentTemplate.artwork_required && !currentDesign) {
      $('#ai-status').textContent = '⚠️ 請先上載你的手繪圖，我們才能織到匙扣上。 Please upload your drawing first — we need it to knit your keychain.';
      $('#artwork-section').scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    setLoading(true);
    try {
      await preview(); // 确保预览为当前定制
      const params = collectParams();
      const dataUrl = $('#preview').src || '';
      const name = (currentTemplate && currentTemplate.name) || pid;
      showCartToast(name, params, dataUrl);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  function showCartToast(name, params, dataUrl) {
    const toast = $('#cart-toast');
    if (!toast) return;
    const opts = [];
    if (isDemo2()) {
      if (demo2State.bagColor) opts.push('袋身顏色 Bag colour: ' + demo2State.bagColor);
      if (demo2State.strapColor) opts.push('肩帶顏色 Strap colour: ' + demo2State.strapColor);
      if (params.text) opts.push('文字 Text: ' + params.text);
      if (demo2State.textColor) opts.push('文字顏色 Text colour: ' + demo2State.textColor);
      if (params.view) opts.push('視圖 View: ' + params.view);
    } else {
      Object.keys(currentTemplate.palette || {}).forEach(k => opts.push(labelFor(k) + ': ' + getParamColor(k)));
      // 文字欄按模板逐欄列出（登機牌有 To/From/航站樓多欄）
      (currentTemplate.text_areas || []).forEach(ta => {
        const v = params[ta.param_key || 'text'];
        if (v) opts.push((ta.label || '文字 Text') + ': ' + v);
      });
      if (params.view) opts.push('視圖 View: ' + params.view);
      if (params.back_panel === 'pattern') opts.push('背面 Back panel: 與正面相同圖案 Same as front');
    }
    toast.innerHTML =
      '<div class="cart-toast__inner">' +
        '<div class="cart-toast__thumb"><img src="' + dataUrl + '" alt=""></div>' +
        '<div class="cart-toast__info">' +
          '<strong>✓ 已加入購物車 Added to cart</strong>' +
          '<div class="cart-toast__name">' + name + '</div>' +
          '<ul>' + opts.map(o => '<li>' + o + '</li>').join('') + '</ul>' +
          '<a class="cart-toast__dl" href="' + dataUrl + '" download="' + (lockedPid || 'design') + '.png">下載設計圖副本 Download a copy of your design</a>' +
        '</div>' +
      '</div>';
    toast.classList.remove('hidden');
    setTimeout(() => toast.classList.add('hidden'), 8000);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 嵌入（Shopify iframe）模式：Confirm design → save-image → parent.postMessage
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * 解析 URL 中的 parent 参数为 postMessage 的 targetOrigin。
   * 非 http(s) 开头的非法值一律回退 '*'（避免 postMessage 直接抛错）。
   * @param {?string} raw 原始（已由 URLSearchParams 解码一次）参数值
   * @returns {string} targetOrigin
   */
  function resolveParentOrigin(raw) {
    if (!raw) return '*';
    let val = '';
    try {
      val = decodeURIComponent(raw);
    } catch (e) {
      val = raw;
    }
    val = String(val || '').trim();
    if (!/^https?:\/\//i.test(val)) {
      console.warn('[LK] invalid ?parent= origin, fallback to "*":', raw);
      return '*';
    }
    return val;
  }

  /**
   * 把后端返回的图片地址兜底成绝对 URL。
   * 后端可能返回相对路径 /api/image/xxx.png，iframe 页面的 origin 即引擎域名。
   * @param {string} url 后端返回的 url
   * @returns {string} 绝对 URL；空输入返回空字符串
   */
  function toAbsoluteUrl(url) {
    if (!url) return '';
    try {
      return new URL(url, window.location.origin).href;
    } catch (e) {
      console.error('[LK] cannot normalize image url:', url, e);
      return String(url);
    }
  }

  /** 嵌入模式下显示「Confirm design」按钮（并隐藏本地演示用的 Add to cart）。 */
  function setupConfirmButton() {
    const btn = $('#confirm-design-btn');
    const atc = $('#add-to-cart-btn');
    if (atc) atc.classList.add('hidden'); // 引擎只产出设计，加购由父页面 Shopify 负责
    if (!btn) return;
    btn.textContent = CONFIRM_LABEL;
    btn.classList.remove('hidden');
    btn.onclick = confirmDesign;
  }

  /**
   * 归一化要回传给父页面的定制参数：null/undefined 转空字符串，
   * 并保证契约要求的 design 字段始终存在（无设计图时为空字符串）。
   * @returns {Object} params
   */
  function buildDesignParams() {
    const raw = collectParams() || {};
    const params = {};
    Object.keys(raw).forEach((k) => {
      const v = raw[k];
      params[k] = (v === null || v === undefined) ? '' : v;
    });
    if (typeof params.design !== 'string') params.design = '';
    return params;
  }

  /** 供 toast 展示的参数字段名（回退到色板标签）。 */
  function paramLabel(key) {
    const map = {
      bag_color: '袋身顏色 Bag colour', strap_color: '肩帶顏色 Strap colour',
      text: '你的文字 Your text', text_color: '文字顏色 Text colour', view: '視圖 View', design: '圖案 Artwork'
    };
    return map[key] || labelFor(String(key).replace(/_color$/, ''));
  }

  /**
   * 保存成品图：POST 成品图 dataURL，返回绝对 URL。
   * 接口候选按序尝试：产品级 /api/product/<pid>/save-image（设计文档口径，
   * 后端上线后优先走）→ legacy /api/save-image（当前服务器实际暴露的接口，
   * 返回 {url, filename}，url 已可绝对化，仍统一过 toAbsoluteUrl 兜底）。
   * 全部失败才抛错，由调用方降级（preview 空串 + console.error + 照常回传）。
   * @param {string} pid 产品 id
   * @param {string} dataUrl 预览图 dataURL
   * @returns {Promise<string>} 成品图绝对 URL
   */
  async function savePreviewImage(pid, dataUrl) {
    if (!dataUrl) throw new Error('empty preview dataURL');
    const candidates = [`/api/product/${pid}/save-image`, '/api/save-image'];
    let lastErr = null;
    for (const url of candidates) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: dataUrl })
        });
        if (!res.ok) throw new Error(`save-image HTTP ${res.status}`);
        const data = await res.json();
        if (!data || data.error || !data.url) {
          throw new Error((data && data.error) || 'save-image returned no url');
        }
        return toAbsoluteUrl(data.url);
      } catch (e) {
        lastErr = e;
      }
    }
    console.warn('[LK] all save-image endpoints failed:', lastErr && lastErr.message);
    throw lastErr || new Error('save-image failed');
  }

  /**
   * 向父页面广播设计完成消息（契约 LK_DESIGN_READY）。
   * @param {string} pid 产品 id
   * @param {Object} params 定制参数
   * @param {string} previewUrl 成品图绝对 URL（失败时为空字符串）
   */
  function postDesignReady(pid, params, previewUrl) {
    const payload = {
      type: LK_MESSAGE_TYPE,
      product: pid,
      params: params,
      preview: previewUrl || '',
      ts: Date.now()
    };
    try {
      parent.postMessage(payload, parentOrigin);
      console.info('[LK] posted', LK_MESSAGE_TYPE, payload);
    } catch (e) {
      console.error('[LK] postMessage failed', e);
    }
  }

  /**
   * 确认设计：保存成品图 → 回传父页面 → 视觉反馈。
   * 保存失败也照常回传（preview 为空字符串），不阻塞下单流程；
   * 不关闭弹窗，由父页面收到消息后自行决定。
   */
  async function confirmDesign() {
    if (confirming) return;
    const btn = $('#confirm-design-btn');
    const pid = lockedPid || ($('#product-select') && $('#product-select').value);
    if (!pid) { alert('請先揀選產品。 Please pick a product first.'); return; }

    // 顏色數量上限（工廠每件最多 5 種不同紗線色）：超限不允許確認
    const colorInfo = designColors();
    if (!colorInfo.ok) {
      updateColorCount();
      const note = $('#color-count-note');
      if (note && note.scrollIntoView) note.scrollIntoView({ block: 'center', behavior: 'smooth' });
      alert('此設計用了 ' + colorInfo.count + ' 種顏色，超出每件上限 ' + colorInfo.max + ' 種。\n請把部分部件改成相同顏色（例如文字用「自動」或與袋身同色）後再確認。\n\n'
        + 'This design uses ' + colorInfo.count + ' colours; the limit is ' + colorInfo.max + ' per piece.\nPlease reuse colours and confirm again.');
      return;
    }
    // 必須先上載圖案（手繪匙扣）：沒有設計圖會織出一條空白織帶
    const t0 = currentTemplate;
    if (t0 && t0.artwork_required && !currentDesign) {
      const st = $('#ai-status');
      if (st) st.textContent = '⚠️ 請先上載你的手繪圖，我們才能織到匙扣上。 Please upload your drawing first — we need it to knit your keychain.';
      const sec = $('#artwork-section');
      if (sec && sec.scrollIntoView) sec.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }

    confirming = true;
    if (btn) {
      btn.disabled = true;
      btn.textContent = CONFIRM_LABEL_LOADING;
      btn.classList.remove('is-saved');
    }

    let previewUrl = '';
    try {
      await preview(); // 刷新可见预览（廉价 JPEG，不用于存档）
      // 成品图单独取全分辨率 PNG（预览是压缩 JPEG，不能拿去存档）：
      // 提交给 /api/save-image 的仍是 PNG dataURL，成品链路画质不变。
      const fullImg = await fetchComposite(pid, collectParams(), { full: true });
      previewUrl = await savePreviewImage(pid, fullImg.dataUrl);
    } catch (e) {
      // 保存失败不卡死：preview 留空字符串，仍然回传定制参数
      previewUrl = '';
      console.error('[LK] save preview image failed:', e);
    }

    const params = buildDesignParams();
    postDesignReady(pid, params, previewUrl);
    showConfirmToast(!!previewUrl, params, previewUrl);

    if (btn) {
      btn.textContent = previewUrl ? CONFIRM_LABEL_DONE : CONFIRM_LABEL;
      if (previewUrl) btn.classList.add('is-saved');
      btn.disabled = false;
    }
    confirming = false;
    // 3s 后恢复初始文案，允许再次确认（修改后重新提交）
    if (btn && previewUrl) {
      setTimeout(() => {
        if (confirming) return;
        btn.classList.remove('is-saved');
        btn.textContent = CONFIRM_LABEL;
      }, 3000);
    }
  }

  /**
   * 确认设计后的视觉反馈（复用 .cart-toast 样式）。
   * @param {boolean} saved 成品图是否保存成功
   * @param {Object} params 已回传的定制参数
   * @param {string} previewUrl 成品图绝对 URL
   */
  function showConfirmToast(saved, params, previewUrl) {
    const toast = $('#cart-toast');
    if (!toast) return;
    const opts = Object.keys(params)
      .filter(k => params[k] !== '' && params[k] !== null && params[k] !== undefined)
      .map(k => paramLabel(k) + ': ' + params[k]);
    const head = saved ? '✓ 設計已儲存 Design saved' : '✓ 設計已送到商店 Design sent to the store';
    const note = saved
      ? '你的設計已加入訂單，可以關閉此視窗。 Your design has been added to your order. You can close this window.'
      : '設計已加入，但預覽圖未能儲存——訂單不受影響，我們會以電郵與你確認設計。 Your design was added, but we couldn’t save the preview image. Your order is not affected — we’ll confirm the design with you by email.';
    toast.innerHTML =
      '<div class="cart-toast__inner">' +
        (saved && previewUrl ? '<div class="cart-toast__thumb"><img src="' + previewUrl + '" alt=""></div>' : '') +
        '<div class="cart-toast__info">' +
          '<strong>' + head + '</strong>' +
          (opts.length ? '<ul>' + opts.map(o => '<li>' + o + '</li>').join('') + '</ul>' : '') +
          '<div>' + note + '</div>' +
        '</div>' +
      '</div>';
    toast.classList.remove('hidden');
    setTimeout(() => toast.classList.add('hidden'), 8000);
  }

  init();
})();
