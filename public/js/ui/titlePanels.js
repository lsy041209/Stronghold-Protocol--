// 登录页右侧的两个可点开面板 —— 「更新公告」与「特别鸣谢」（用户 2026-10-06 指定，C 的口径见
// 协作/C-特别鸣谢-服务器与B站-2026-10-06.md §三）。它们填的正是 title screen 右侧那块空白。
//
// 三条硬约束（判据，不是偏好）：
//   ① **每行的链接必须是真 `<a>` 且新窗口打开**（`target="_blank"` + `rel="noopener noreferrer"`）——
//      把游戏页面顶掉就毁了这一局；
//   ② **离线/无网也不报错** ⇒ 本模块**不发任何请求**（公告是生成好的 JS 模块，不是 fetch 来的 JSON，
//      所以断网、直开文件、CDN 挂了都照常能开）；
//   ③ **窄屏（720P / 450px）不溢出** ⇒ 侧栏在窄屏收成一行、面板本体是固定层且自身可滚。
//
// ⚠️ **名字与链接不许凭印象写**：这张表逐条来自上面那份 C 的实测文档。没有链接的条目（如 B 站名）
// 就**渲染成纯文本**，不要替它编一个 URL —— `link: null` 是刻意留的，不是漏了。
//
// 公告正文来自 `./announcementData.js`，**由 `tools/build-announcements.mjs` 从仓库根的 `CHANGELOG.md`
// 生成**（单一事实源；发了新版本就重跑那个工具，别手改生成物）。

import { useEffect, useState } from '../../vendor/hooks.module.js';
import { html, Icon, MicroLabel } from './components.js';
import { ANNOUNCEMENTS } from './announcementData.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');

/** 两个面板（顺序即右侧出现顺序）。 */
export const PANELS = [
  { id: 'news', label: '更新公告', micro: 'PATCH NOTES' },
  { id: 'credits', label: '特别鸣谢', micro: 'CREDITS' },
];

/**
 * 置顶两位（用户 00:2x 定的顺序）：**原作者**在最上，其次**纸鸢安好**（本项目的皮肤/语音/安卓适配来源）。
 * @type {{name: string, bili: string|null, role: string, links: {label: string|null, url: string}[], note?: string}[]}
 */
export const CREDITS_TOP = [
  {
    name: 'Ausevay',
    bili: null,
    role: '原作者',
    links: [],
    note: '上游本体《卫戍协议：盟约》的作者。',
  },
  {
    name: '纸鸢安好',
    bili: '纸鸢安好',
    role: '一键部署包作者',
    links: [
      { label: '一服', url: 'http://106.55.191.70:3000' },
      { label: '二服', url: 'http://101.37.150.107:3000' },
    ],
    note: '本项目的皮肤系统、干员语音与安卓适配来自他（已获授权）。',
  },
];

/** 「学习参考」的服务器（同样附名字与链接）。`down: true` = 已知暂时不可用，照常留名并标注。 */
export const CREDITS_REFS = [
  { name: '临夏俨然', bili: '临夏俨然', links: [{ label: null, url: 'https://wei.linxia.dev' }], note: '预载资源 + Redis 缓存，闪断更新也能回溯对局。' },
  { name: '鹿可可 Official', bili: '鹿可可 Official', links: [{ label: null, url: 'https://game.xiaolubao.com' }], note: '标注为「目前最热门服务器」。' },
  { name: '雨方_', bili: '雨方_', links: [{ label: null, url: 'https://game.rainya.me/' }], note: '部署在阿里云，点开就玩。' },
  { name: 'd星空之下', bili: 'd星空之下', links: [{ label: null, url: 'http://183.66.27.19:20522' }], note: '野排功能开发加载完毕。' },
  { name: 'Stardust_减', bili: 'Stardust_减', links: [{ label: null, url: 'https://ark-proto.stardust.matce.cn' }], note: '人数 1000+（该地址需要密钥才能进）。' },
  { name: 'Crane_paul', bili: 'Crane_paul', links: [{ label: null, url: 'https://game.craneapaul.dpdns.org/' }], note: '做过电脑与安卓的全屏适配。', down: true },
  { name: '涂涂小弟047', bili: '涂涂小弟047', links: [], note: '无公开网址（NAT 转接）· Q 群 421345512，进群后按群公告转接。' },
  { name: '各位服务器作者', bili: null, links: [{ label: 'simpfun', url: 'http://play.simpfun.cn:14517' }], note: '参考其外援 / 助战数据（该作者未公开名字，按「各位服务器作者」署名）。' },
];

/** 截图里那句可作说明句的原话。 */
export const CREDITS_LINE = '本页网站均可匹配，且较热门匹配快。';

/**
 * A row's links. Every entry with a URL is a **real anchor opening a new tab**; entries without one are plain text,
 * so a name we cannot link is never turned into a guessed URL.
 * @param {{links: {label: string|null, url: string}[]}} entry
 */
export function CreditLinks({ links }) {
  if (!links || !links.length) return null;
  return html`<span class="tpanel__links">
    ${links.map((l, i) => html`<a key=${i} class="tpanel__link" href=${l.url} target="_blank" rel="noopener noreferrer">
      <${Icon} name="link" /><span class="tpanel__linktext">${l.label ? `${l.label} · ` : ''}${l.url.replace(/^https?:\/\//, '')}</span>
    </a>`)}
  </span>`;
}

/** One credit row: name (+ B 站名) / links / one line of explanation. */
export function CreditRow({ e }) {
  return html`<li class=${cx('tpanel__credit', e.down && 'is-down')}>
    <div class="tpanel__credithead">
      <b class="tpanel__creditname">${e.name}</b>
      ${e.role ? html`<span class="tpanel__role">${e.role}</span>` : null}
      ${e.bili ? html`<span class="tpanel__bili">B 站 · ${e.bili}</span>` : null}
      ${e.down ? html`<span class="tpanel__down">（暂不可用）</span>` : null}
    </div>
    <${CreditLinks} links=${e.links} />
    ${e.note ? html`<p class="tpanel__creditnote">${e.note}</p>` : null}
  </li>`;
}

/** 特别鸣谢 面板正文。 */
export function CreditsBody() {
  return html`<div class="tpanel__credits">
    <section class="tpanel__group">
      <${MicroLabel} tone="hi">置顶 · 原作者与整合来源<//>
      <ul class="tpanel__list">${CREDITS_TOP.map((e) => html`<${CreditRow} e=${e} />`)}</ul>
    </section>
    <section class="tpanel__group">
      <${MicroLabel}>学习参考的服务器<//>
      <ul class="tpanel__list">${CREDITS_REFS.map((e) => html`<${CreditRow} e=${e} />`)}</ul>
      <p class="tpanel__line">${CREDITS_LINE}</p>
    </section>
  </div>`;
}

/** 更新公告 面板正文（数据来自 CHANGELOG.md 的生成物）。 */
export function NewsBody() {
  if (!ANNOUNCEMENTS || !ANNOUNCEMENTS.length) {
    return html`<p class="tpanel__empty">暂无可显示的更新公告。</p>`;
  }
  return html`<div class="tpanel__news">
    ${ANNOUNCEMENTS.map((v, i) => html`<section key=${v.version || i} class="tpanel__ver">
      <header class="tpanel__verhead">
        <b class="tpanel__vertag">v${v.version}</b>
        ${v.date ? html`<span class="tpanel__verdate">${v.date}</span>` : null}
      </header>
      ${(v.sections || []).map((s, j) => html`<div key=${j} class="tpanel__sec">
        ${s.name ? html`<h4 class="tpanel__secname">${s.name}</h4>` : null}
        <ul class="tpanel__items">${(s.items || []).map((it, k) => html`<li key=${k} class="tpanel__item">${it}</li>`)}</ul>
      </div>`)}
    </section>`)}
  </div>`;
}

/**
 * 登录页右侧的「更新公告 / 特别鸣谢」：侧栏按钮 + 一个可关闭的浮层。
 * 浮层只在打开时渲染，关闭走三条路（× 按钮、Esc、点背景）——「面板可关闭」是判据之一。
 */
export function TitlePanels() {
  const [open, setOpen] = useState(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(null); } };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open]);

  const cur = PANELS.find((p) => p.id === open) || null;
  return html`<div class="title-side" data-testid="title-panels">
    <div class="title-side__btns">
      ${PANELS.map((p) => html`<button key=${p.id} type="button" class=${cx('title-side__btn', open === p.id && 'is-on')}
        data-panel=${p.id} aria-haspopup="dialog" aria-expanded=${open === p.id ? 'true' : 'false'}
        title=${p.label} onClick=${() => setOpen(open === p.id ? null : p.id)}>
        <${Icon} name=${p.id === 'news' ? 'book' : 'users'} />
        <span class="title-side__label">${p.label}</span>
        <span class="title-side__micro">${p.micro}</span>
      </button>`)}
    </div>

    ${cur ? html`<div class="tpanel" role="presentation" data-testid="title-panel"
        onMouseDown=${(e) => { if (e.target === e.currentTarget) setOpen(null); }}>
      <div class="tpanel__box brackets" role="dialog" aria-modal="true" aria-label=${cur.label}
        data-panel=${cur.id} tabindex="-1">
        <header class="tpanel__head">
          <div>
            <${MicroLabel} tone="hi">${cur.micro}<//><br />
            <h2 class="tpanel__title">${cur.label}</h2>
          </div>
          <button type="button" class="tpanel__close" aria-label="关闭" title="关闭 (Esc)" onClick=${() => setOpen(null)}>
            <${Icon} name="close" />
          </button>
        </header>
        <div class="tpanel__body">${cur.id === 'news' ? html`<${NewsBody} />` : html`<${CreditsBody} />`}</div>
      </div>
    </div>` : null}
  </div>`;
}
