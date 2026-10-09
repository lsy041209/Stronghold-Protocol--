// Guest mode for the browser build: play on someone else's server while every asset stays on THIS disk.
//
// The problem this solves. A friend hands you an invite link; it points at *their* machine, usually
// through a free tunnel (`https://something.loca.lt/?room=ABCD`). Opening that link in a browser is a
// dead end: free tunnels answer a real browser with a 511 "Tunnel website ahead!" splash that demands
// you type the host's public IP before a single asset loads - and the ~330 MB of art and audio would
// then have to crawl across a cross-border relay. And that splash is keyed on the visitor's UA string,
// so it cannot be avoided by adding a query parameter.
//
// The way out. Keep the page where it is (the local server, which already has every file) and open only
// the game socket to the host. That is exactly what `?server=<host>` means to js/net.js
// (serverOverride -> defaultWsUrl), and `?room=<CODE>` is a deep link js/main.js already auto-joins
// once the player is in. Neither needs the host's page, so the splash page is never involved.
//
// Parity. The Android build already offers this from its native 联机 panel; this module is the same
// capability for the browser build and stays out of the way where that panel exists - see
// `nativeOverlayPresent()`.
//
// Nothing here is a new screen: the lobby's existing 加入同盟 field is the input, and the only chrome
// added is a strip that appears when you ARE on someone else's server (a state from which you would
// otherwise have no way back).

import { html, Button, Icon } from './components.js';

/** A host that could plausibly be addressed: has a dot (dotted name / IPv4), or carries an explicit port. */
const HAS_DOT = /\./;

/**
 * Recognise a guest address out of whatever the player pasted.
 *
 * Deliberately mirrors `.workbuddy/tools/join-friend.mjs` `parseInvite()` so the browser and the
 * desktop shortcut agree on what counts as an invite. Accepts a full link, a bare host, `host:port`,
 * or a whole invite paragraph (the link is picked out of it). A bare 4-character alliance key is NOT
 * an address and returns null, which is what tells the caller to do an ordinary local join.
 *
 * @param {string} raw
 * @returns {{server: string, room: string|null}|null}
 */
export function parseInvite(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;

  const found = text.match(/https?:\/\/[^\s"'<>，。）]+/);
  const candidate = found ? found[0] : text.replace(/\s+/g, '');

  let host = '';
  let port = '';
  let room = null;
  if (/^https?:\/\//i.test(candidate)) {
    let url;
    try {
      url = new URL(candidate);
    } catch {
      return null;
    }
    host = url.hostname;
    port = url.port;
    room = url.searchParams.get('room');
  } else {
    const m = candidate.match(/^([^/:?#]+)(?::(\d+))?/);
    if (!m) return null;
    host = m[1];
    port = m[2] || '';
    const q = candidate.match(/[?&]room=([A-Za-z0-9]+)/);
    room = q ? q[1] : null;
  }

  // A bare word (an alliance key, say) is not an address.
  if (!host || (!HAS_DOT.test(host) && !port)) return null;
  if (room) room = room.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);

  // A port means a LAN / plain-ws host; a bare name is assumed to be a TLS tunnel
  // (js/net.js serverOverride() decides the scheme from exactly this distinction).
  return { server: port ? `${host}:${port}` : host, room: room || null };
}

/**
 * The server this page is playing on, '' when it is the local one.
 * @returns {string}
 */
export function currentServer() {
  try {
    return String(new URLSearchParams(location.search).get('server') || '').trim();
  } catch {
    return '';
  }
}

/**
 * Reload onto another server - or back to the local one when `server` is empty - optionally
 * deep-linking a room. A reload is the mechanism on purpose: js/net.js reads `?server=` once, when it
 * builds the socket, and js/main.js reads `?room=` once, at boot. Both are cheap here: the page and
 * every asset are already on this disk (served from the local server / browser cache).
 *
 * @param {string} server host, `host:port`, or '' for the local server
 * @param {string|null} [room]
 */
export function goToServer(server, room) {
  const url = new URL(location.href);
  url.searchParams.delete('server');
  url.searchParams.delete('room');
  if (server) url.searchParams.set('server', server);
  if (room) url.searchParams.set('room', room);
  const query = url.searchParams.toString();
  location.href = url.pathname + (query ? `?${query}` : '') + url.hash;
}

/**
 * Whether a host shell is driving this page and already offers "join someone's room" itself.
 *
 * Two shells qualify: the Android app (`window.Android`, see HostOverlay.java) and the PC desktop
 * app (which exposes the same `window.Android` contract *plus* `window.desktop` — see
 * .workbuddy/desktop/preload.js). Both give the page a 联机 panel, so the strip below would only
 * duplicate it — and two ways back to the local server is worse than one.
 * @returns {boolean}
 */
export function nativeOverlayPresent() {
  try {
    if (globalThis.desktop) return true;
    return !!globalThis.Android && typeof globalThis.Android.hosting === 'function';
  } catch {
    return false;
  }
}

/**
 * Strip shown only while playing on someone else's server: which one, and the way back. Reuses the
 * game's own `.conn-banner` chrome so it reads as part of the interface rather than an addition to it.
 */
export function ServerLinkStrip() {
  const server = currentServer();
  if (!server || nativeOverlayPresent()) return null;
  return html`<div class="conn-banner conn-banner--server" role="status">
    <${Icon} name="link" />
    <span>正在好友的服务器上：<span class="num">${server}</span></span>
    <${Button} size="sm" variant="secondary" icon="chevronLeft" onClick=${() => goToServer('', '')}>回到本机服务器<//>
  </div>`;
}
