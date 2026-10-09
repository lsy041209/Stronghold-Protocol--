// 游戏内「联机」面板（PC 桌面版）—— 对应安卓端的
// `.workbuddy/android/app-standalone/java/com/stronghold/protocol/sa/HostOverlay.java`。
//
// 为什么要有它。此前 PC 端把"开房"和"加入"做成了两个 .bat：用户得先想清楚该双击哪个，还得和
// 一个控制台窗口相处。而这两件事本质上不是"选择题"——想单机玩的人不该先被问一个地址，想加入
// 别人的人也不该被问两遍。所以入口收进游戏里，和房间界面放密钥的地方是同一个地方。
//
// 为什么用游戏自己的组件（Modal / Button / TextField / Icon / toast）而不是写一套新 CSS：
// 面板要看起来是游戏的一部分，而不是贴上去的一块。配色也直接取 `css/theme.css` 的令牌
// （`--mint-500` 恰好就是安卓端 `COLOR_ACCENT` 的 #4ed8af）。
//
// 三个角色，和安卓版一一对应：
//   · 药丸 —— 常显，可拖动（游戏自己的邀请框也在右上角，没有哪个角落对所有界面都空着）；
//   · 面板 —— 地址、邀请文案、加入别人的房间；
//   · 桥的消费方 —— 游戏通过 `window.Android` 上报房号与索取邀请地址（见 preload.js）。
//
// 只有桌面外壳（`window.desktop`）存在时才渲染；纯浏览器里本模块什么都不做，保持原样。

import { html, Fragment, Button, Icon, Modal, TextField } from './components.js';
import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { toast } from './toasts.js';
import { parseInvite, goToServer, currentServer } from './serverLink.js';

const cx = (...parts) => parts.flat().filter(Boolean).join(' ');

/** 拖动位置记忆的键。切换服务器会整页重载，不记的话每次都得重新拖。 */
const POS_KEY = 'sp.lanPill.pos';

/** 桌面外壳对象，纯浏览器里为 null。 */
function shell() {
  try {
    return typeof globalThis !== 'undefined' && globalThis.desktop ? globalThis.desktop : null;
  } catch {
    return null;
  }
}

/** 是否运行在桌面外壳里。ui/serverLink.js 用它决定要不要显示"你在好友服务器上"那条提示。 */
export function desktopShellPresent() {
  return !!shell();
}

/** 订阅外壳状态：先取一次快照，再持续接收推送。 */
function useShellState() {
  const [state, setState] = useState(null);
  useEffect(() => {
    const d = shell();
    if (!d) return undefined;
    let alive = true;
    d.state().then((s) => { if (alive && s) setState(s); }).catch(() => {});
    const off = d.onState((s) => setState(s));
    return () => { alive = false; try { off?.(); } catch { /* 忽略 */ } };
  }, []);
  return state;
}

// ---- 药丸 -------------------------------------------------------------------------------------

function loadPos() {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    return Number.isFinite(p?.x) && Number.isFinite(p?.y) ? p : null;
  } catch {
    return null;
  }
}

function savePos(x, y) {
  try { localStorage.setItem(POS_KEY, JSON.stringify({ x, y })); } catch { /* 隐私模式等，忽略 */ }
}

/**
 * 右上角的小药丸。常显、可拖动。
 *
 * 容器是 `pointer-events:none`、只有按钮本身收事件 —— 和安卓版"外层 FrameLayout 必须让触摸
 * 穿透到游戏"同一个道理，否则屏幕右上角会有一片点不到的死区。
 */
function LanPill({ room, onOpen }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(() => loadPos());
  const drag = useRef(null);

  useEffect(() => {
    if (!pos || !ref.current) return;
    const clamp = () => {
      const el = ref.current;
      if (!el) return;
      const maxX = Math.max(0, window.innerWidth - el.offsetWidth - 4);
      const maxY = Math.max(0, window.innerHeight - el.offsetHeight - 4);
      setPos((p) => (p ? { x: Math.min(p.x, maxX), y: Math.min(p.y, maxY) } : p));
    };
    clamp();
    window.addEventListener('resize', clamp);
    return () => window.removeEventListener('resize', clamp);
  }, [pos === null]);

  const onPointerDown = (e) => {
    const el = ref.current;
    if (!el) return;
    drag.current = { id: e.pointerId, startX: e.clientX, startY: e.clientY, baseX: el.offsetLeft, baseY: el.offsetTop, moved: false };
    el.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e) => {
    const d = drag.current;
    const el = ref.current;
    if (!d || !el || d.id !== e.pointerId) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    // 10px 以内仍算点击（和安卓版的判定阈值一致）。
    if (!d.moved && Math.hypot(dx, dy) < 10) return;
    d.moved = true;
    const maxX = Math.max(0, window.innerWidth - el.offsetWidth - 4);
    const maxY = Math.max(0, window.innerHeight - el.offsetHeight - 4);
    setPos({ x: Math.min(Math.max(0, d.baseX + dx), maxX), y: Math.min(Math.max(0, d.baseY + dy), maxY) });
  };

  const onPointerUp = (e) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.id !== e.pointerId) return;
    if (d.moved) {
      if (pos) savePos(pos.x, pos.y);
      return;
    }
    onOpen();
  };

  const style = pos
    ? `left:${pos.x}px; top:${pos.y}px; right:auto; bottom:auto;`
    : '';

  return html`<div class="lan-pill-wrap">
    <button ref=${ref} type="button" class="lan-pill${room ? ' lan-pill--live' : ''}" style=${style}
      title="联机：开房间 / 加入朋友的房间"
      onPointerDown=${onPointerDown} onPointerMove=${onPointerMove}
      onPointerUp=${onPointerUp} onPointerCancel=${onPointerUp}>
      <${Icon} name="signal" class="lan-pill__icon" />
      <span>${room ? `联机 · ${room}` : '联机'}</span>
    </button>
  </div>`;
}

// ---- 面板 -------------------------------------------------------------------------------------

/**
 * 「联机」面板本体。
 *
 * 住在这里的原因（照抄安卓版的结论）：托管、游玩、加入不是三选一。想单机玩的人不该先被问地址，
 * 想加入别人的人不该回答两遍同一个问题。所以启动器只管把服务器拉起来并进游戏，两个方向都由
 * 这个面板在**房间真正所在的地方**提供。
 */
export function LanPanel() {
  const st = useShellState();
  const [open, setOpen] = useState(false);
  const [joinValue, setJoinValue] = useState('');
  const [busy, setBusy] = useState('');

  if (!desktopShellPresent()) return null;

  const room = st?.room || null;
  const publicUrl = st?.publicUrl || null;
  const lanUrl = st?.lanUrl || null;
  const pending = !!st?.tunnelPending;
  const error = st?.tunnelError || null;
  const local = !currentServer();

  const copy = async (text, what) => {
    if (!text) return;
    const ok = await shell().copy(text);
    if (ok) toast(`已复制${what}`, 'success');
    else toast('复制失败，请手动复制', 'warn');
  };

  const toggleTunnel = async () => {
    if (busy) return;
    setBusy('tunnel');
    try { await shell().tunnel(publicUrl || pending ? 'stop' : 'start'); } catch { /* 状态由推送更新 */ }
    setBusy('');
  };

  /** 复制邀请：密钥 + 两条链接 + 给朋友看的说明。 */
  const inviteText = () => {
    const lines = ['【卫戍协议：盟约】同盟邀请'];
    if (room) lines.push(`同盟密钥：${room}`);
    if (publicUrl) {
      lines.push('手机装了本游戏，点链接直接进房：', inviteUrl(publicUrl));
      lines.push('电脑上用浏览器打开同一个链接也能进：第一次会看到一个提醒页，把页面上显示的那串 IP 填进去即可（每台设备只需一次）。');
      lines.push('电脑上也装了本游戏：打开「卫戍协议」，点右上角「联机」，把这条链接粘进去 —— 最流畅，素材不用重新下载。');
    } else if (pending) {
      lines.push('（外网地址还在生成，这条现在只对同一个 Wi-Fi 有效；几秒后再复制一次。）');
    }
    if (lanUrl) lines.push(`同一个 Wi-Fi 更快：${inviteUrl(lanUrl)}`);
    lines.push('地址每次重开游戏都会变，所以开房后再发给朋友。');
    return lines.join('\n');
  };

  const inviteUrl = (base) => `${base.replace(/\/+$/, '')}/${room ? `?room=${room}` : ''}`;

  /**
   * 加入朋友的服务器。接受聊天软件可能产生的一切形态：完整链接、裸主机名、带端口的主机名，
   * 或一整段把链接包在中间的邀请文字。
   */
  const connect = async (raw) => {
    const target = parseInvite(raw);
    if (!target) {
      toast('没找到可用的地址。请把朋友发来的整条邀请链接粘进来（形如 https://xxxx.trycloudflare.com/?room=ABCD）', 'warn');
      return;
    }
    // 现在是访客了，本机不再扮演房主，把隧道收掉。
    try { await shell().tunnel('stop'); } catch { /* 尽力而为 */ }
    setOpen(false);
    goToServer(target.server, target.room);
  };

  const pasteAndJoin = async () => {
    let text = '';
    try { text = await shell().paste(); } catch { /* 忽略 */ }
    if (!text || !text.trim()) {
      toast('剪贴板里没有内容。请先复制朋友发来的邀请链接。', 'warn');
      return;
    }
    setJoinValue(text.trim());
    await connect(text);
  };

  // ---- 状态文案（与安卓版 refresh() 的措辞保持一致） ----
  const keyText = room
    ? `同盟密钥：${room}（和游戏里房间界面上的一致）`
    : '还没创建房间。在游戏里选「同盟模拟」→「创建同盟」后，这里会显示密钥和链接。';

  const statusLines = [];
  if (!room) statusLines.push('想到外地朋友时才需要外网地址；只在本机玩不用管。');
  if (pending) statusLines.push('正在向中继服务器申请地址，通常几秒…');
  else if (publicUrl) statusLines.push('外网地址已就绪，可以复制邀请发给朋友了。');
  else if (error) statusLines.push(`外网地址创建失败：${error}`, '本机和同一个 Wi-Fi 的朋友仍然可以正常玩。');
  else statusLines.push('点「创建外网地址」可以拿到一个外地朋友能用的链接。');
  if (!local) statusLines.push('当前在朋友的服务器上。想玩自己的存档就点「回到本机服务器」。');

  return html`<${Fragment}>
    <${LanPill} room=${room} onOpen=${() => setOpen(true)} />

    <${Modal} open=${open} tone="mint" title="联机" micro="CO-OP / LAN" class="lan-sheet"
      onClose=${() => setOpen(false)}
      actions=${html`<${Button} variant="secondary" size="md" onClick=${() => setOpen(false)}>关闭<//>`}>

      <p class=${cx('lan-key', !room && 'lan-key--idle')}>${keyText}</p>

      <p class="lan-hint">外网链接（外地朋友用这个；对方装了本游戏，点开即进）：</p>
      <div class="lan-row">
        <span class=${cx('lan-addr', publicUrl && 'lan-addr--hot')}>${publicUrl || (pending ? '正在获取地址…' : '尚未创建')}</span>
        <${Button} size="sm" icon="copy" disabled=${!publicUrl} onClick=${() => copy(publicUrl, '外网链接')}>复制<//>
      </div>

      <p class="lan-hint">局域网链接（同一个 Wi-Fi 用这个，最快、不花流量）：</p>
      <div class="lan-row">
        <span class="lan-addr">${lanUrl || '未检测到可用的内网地址'}</span>
        <${Button} size="sm" icon="copy" disabled=${!lanUrl} onClick=${() => copy(lanUrl, '局域网链接')}>复制<//>
      </div>

      <p class="lan-status">${statusLines.map((t, i) => html`<span key=${i}>${t}</span>`)}</p>

      <${Button} variant="primary" block=${true} icon="link" disabled=${!room}
        onClick=${() => copy(inviteText(), room ? '邀请（链接 + 密钥）' : '邀请')}>
        ${room ? '复制邀请（链接 + 密钥）' : '复制邀请（先在游戏里创建同盟）'}
      <//>

      <${Button} block=${true} icon=${publicUrl || pending ? 'close' : 'signal'} loading=${busy === 'tunnel'}
        disabled=${!st?.port}
        onClick=${toggleTunnel}>
        ${publicUrl || pending ? '关闭外网地址' : '创建外网地址'}
      <//>

      <div class="lan-divider"></div>

      <p class="lan-hint">加入别人的房间：把朋友发来的邀请链接粘进来（密钥已经含在链接里）：</p>
      <div class="lan-join">
        <${TextField} value=${joinValue} onInput=${setJoinValue} onEnter=${() => connect(joinValue)}
          placeholder="https://xxxx.trycloudflare.com/?room=ABCD" icon="link" size="sm" />
        <${Button} size="sm" variant="primary" onClick=${() => connect(joinValue)}>连接<//>
      </div>

      <${Button} block=${true} icon="copy" onClick=${pasteAndJoin}>从剪贴板粘贴链接并进入<//>

      ${local ? null : html`<${Button} block=${true} icon="chevronLeft" onClick=${() => shell().home()}>回到本机服务器（我自己的游戏）<//>`}
    <//>
  <//>`;
}
