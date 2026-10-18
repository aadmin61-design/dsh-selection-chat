// 无构建客户端模块：复用宿主 React、草稿编辑器、会话分支及侧栏。
window.__ModuleLoader__.load({ id: '@local/dsh-selection-chat', factory: require => {
  const React = require('react');
  const { createPortal } = require('react-dom');
  const { createElement: h, useState, useRef, useEffect } = React;
  const ID = '@local/dsh-selection-chat', SLOT = 'selection-chat.conversation';
  const PREFIX = 'dsh-resource://selectionchat/session/';
  const MAX_QUOTE = 100000;
  const TEMP_PREFIX = 'selectionchat-temp-';
  async function temporaryApi(operation, input) {
    const transport = globalThis.__DSH_TRANSPORT__;
    const send = transport?.fetch ? transport.fetch.bind(transport) : globalThis.fetch.bind(globalThis);
    const response = await send('/api/selection-chat/' + operation, { method: 'POST', credentials: 'same-origin', signal: AbortSignal.timeout(30000),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || '侧边聊天操作失败。');
    return result;
  }
  // 只从左侧目录的可见 ID 序列排除临时会话；保留 byId，供原生文件路径、模型与权限解析。
  function hideTemporarySessions(source) {
    const original = source.getSnapshot, cache = new WeakMap();
    const read = () => {
      const snapshot = original.call(source);
      if (!cache.has(snapshot)) cache.set(snapshot, { ...snapshot, ids: snapshot.ids.filter(id => !id.startsWith(TEMP_PREFIX)) });
      return cache.get(snapshot);
    };
    source.getSnapshot = read;
    return () => { if (source.getSnapshot === read) source.getSnapshot = original; };
  }
  function inheritedHistoryCss(id, turns) {
    if (!/^[a-zA-Z0-9-]+$/.test(id)) return '';
    // Turn 是宿主整数身份，只生成有边界的选择器，不把选中文本写进 CSS。
    const selectors = [...new Set(turns)].filter(n => Number.isSafeInteger(n) && n >= 0)
      .map(n => `[data-selection-chat-session="${id}"] [data-chat-turn="${n}"]`);
    if (!selectors.length) return '';
    selectors.push(`[data-selection-chat-session="${id}"] nav[aria-label="轮次导航"]`, `[data-selection-chat-session="${id}"] nav[aria-label="Turn navigation"]`);
    return selectors.join(',') + '{display:none!important}';
  }

  function quoteText(text) {
    if (typeof text !== 'string' || !text.trim()) throw Error('请先选中一段对话正文。');
    if (text.length > MAX_QUOTE) throw Error('选中内容超过 100000 字符，请缩小范围；未截断或发送内容。');
    return '\n\n引用当前对话中的内容（作为讨论材料）：\n' + text.replace(/\r\n?/g, '\n').split('\n').map(line => '> ' + line).join('\n') + '\n\n';
  }
  function resourceAddress(id) { return PREFIX + encodeURIComponent(id); }
  function parseAddress(address) {
    try {
      const url = new URL(address), parts = url.pathname.split('/');
      if (url.protocol !== 'dsh-resource:' || url.hostname !== 'selectionchat' || url.search || url.hash || parts.length !== 3 || parts[1] !== 'session') return;
      const id = decodeURIComponent(parts[2]);
      if (!id || /[\s/\\\x00-\x1f]/.test(id)) return;
      return id;
    } catch { return; }
  }
  function toolbarPosition(rect, width, height) {
    const boxWidth = Math.min(300, Math.max(0, width - 16));
    return { left: Math.max(8, Math.min(rect.left, width - boxWidth - 8)), top: Math.max(8, Math.min(rect.top >= 48 ? rect.top - 42 : rect.bottom + 8, height - 48)), maxWidth: boxWidth };
  }
  const elementOf = node => node?.nodeType === 1 ? node : node?.parentElement;
  function readSelection(selection, root) {
    if (!root?.isConnected || !selection || selection.isCollapsed || selection.rangeCount !== 1) return;
    const range = selection.getRangeAt(0), start = elementOf(range.startContainer), end = elementOf(range.endContainer);
    // 每个输入栏只处理自身 Conversation 内的正文，禁止跨会话、输入框或菜单取词。
    const excluded = 'input,textarea,button,select,[contenteditable="true"],[role="textbox"],[data-conversation-region="composer"],[data-selection-chat-toolbar]';
    if (!start || !end || start.closest(excluded) || end.closest(excluded)) return;
    if (start.closest('[data-conversation-content]') !== root || end.closest('[data-conversation-content]') !== root) return;
    if (!start.closest('[data-chat-flow-kind],[data-chat-group-key]') || !end.closest('[data-chat-flow-kind],[data-chat-group-key]')) return;
    const text = selection.toString();
    if (!text.trim()) return;
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) return;
    return { text, rect };
  }
  function createQuoteStore(storage) {
    const key = 'dsh-selection-chat.cards.v2', rows = new Map(), listeners = new Set();
    let serial = 0;
    const valid = (id, text) => typeof id === 'string' && parseAddress(resourceAddress(id)) === id && typeof text === 'string' && text.trim() && text.length <= MAX_QUOTE;
    try {
      const saved = storage?.getItem(key);
      if (saved) {
        for (const [id, cards] of JSON.parse(saved)) {
          if (!Array.isArray(cards)) continue;
          const accepted = cards.filter(c => valid(id, c?.text)).map(c => ({ ...c, id: ++serial, state: c.state === 'sending' ? 'uncertain' : c.state === 'uncertain' ? 'uncertain' : 'ready' }));
          if (accepted.length) rows.set(id, accepted);
        }
      } else {
        for (const [id, text] of JSON.parse(storage?.getItem('dsh-selection-chat.pending.v1') || '[]')) {
          if (valid(id, text)) rows.set(id, [{ id: ++serial, text, state: 'ready' }]);
        }
      }
    } catch { /* 损坏的本地缓存不会阻止宿主输入框加载。 */ }
    const publish = () => {
      try { storage?.setItem(key, JSON.stringify([...rows])); } catch { /* 存储受限时仍保留当前窗口内的卡片。 */ }
      for (const listener of listeners) listener();
    };
    publish();
    return {
      list: id => rows.get(id) || [],
      subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
      add(id, text) {
        quoteText(text);
        if (!valid(id, text)) throw Error('引用缺少有效的会话标识。');
        const cards = rows.get(id) || [];
        if (cards.some(c => c.text === text && c.state === 'ready')) return;
        if (cards.reduce((n, c) => n + c.text.length, text.length) > MAX_QUOTE) throw Error('本会话待发送引用总计超过 100000 字符，请先移除部分引用。');
        rows.set(id, [...cards, { id: ++serial, text, state: 'ready' }]); publish();
      },
      remove(id, cardId) {
        const cards = (rows.get(id) || []).filter(c => c.id !== cardId || c.state === 'sending');
        if (cards.length) rows.set(id, cards); else rows.delete(id);
        publish();
      },
      clear(id) { rows.delete(id); publish(); },
      move(from, to) {
        rows.set(to, [...(rows.get(to) || []), ...(rows.get(from) || [])]); rows.delete(from); publish();
      },
      reuse(id, cardId) {
        rows.set(id, (rows.get(id) || []).map(c => c.id === cardId && c.state === 'uncertain' ? { ...c, state: 'ready', error: undefined } : c)); publish();
      },
      take(id) {
        const cards = rows.get(id) || [], batch = cards.filter(c => c.state === 'ready');
        if (batch.length) { rows.set(id, cards.map(c => batch.includes(c) ? { ...c, state: 'sending', error: undefined } : c)); publish(); }
        return batch;
      },
      finish(id, batch, ok) {
        const ids = new Set(batch.map(c => c.id));
        const cards = (rows.get(id) || []).flatMap(c => !ids.has(c.id) ? [c] : ok ? [] : [{ ...c, state: 'ready', error: '发送失败，引用已恢复。请检查原问题后重试。' }]);
        if (cards.length) rows.set(id, cards); else rows.delete(id);
        if (batch.length) publish();
      }
    };
  }

  // 0.2.1-rc.2 适配边界：在普通消息进入原生序列化时固定引用快照。
  // 不拦截按键、不改编辑器草稿；保留附件、引用芯片、queue/steer 和宿主失败恢复。
  function attachQuoteSender(shell, store, sessionId) {
    if (typeof shell?.sinkSerialized !== 'function' || typeof shell?.settleDetachedFailure !== 'function' || typeof shell?.deps?.defaultSink !== 'function') throw Error('当前 DSH 的发送接口不兼容，请更新插件；引用未写入输入框。');
    const flights = new Map(), patches = [];
    let active = true;
    const patch = (target, key, wrapped) => {
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      Object.defineProperty(target, key, { configurable: true, writable: true, value: wrapped });
      patches.push(() => {
        if (Object.getOwnPropertyDescriptor(target, key)?.value !== wrapped) return;
        if (descriptor) Object.defineProperty(target, key, descriptor); else delete target[key];
      });
    };
    const cleanup = () => { if (!active && flights.size === 0) patches.splice(0).reverse().forEach(off => off()); };
    const begin = signal => { if (!flights.has(signal)) flights.set(signal, active ? store.take(sessionId) : []); return flights.get(signal); };
    const finish = (signal, ok) => {
      const batch = flights.get(signal);
      if (batch) { flights.delete(signal); store.finish(sessionId, batch, ok); }
      cleanup();
    };
    const serialized = shell.sinkSerialized, failure = shell.settleDetachedFailure, sink = shell.deps.defaultSink;
    patch(shell, 'sinkSerialized', function(attempt, ...args) {
      begin(attempt.signal);
      try { return serialized.call(this, attempt, ...args); }
      catch (error) { finish(attempt.signal, false); throw error; }
    });
    patch(shell, 'settleDetachedFailure', function(attempt, ...args) {
      finish(attempt.signal, false);
      return failure.call(this, attempt, ...args);
    });
    patch(shell.deps, 'defaultSink', async function(text, attachments, mode, signal) {
      // 仅附件提交跳过 sinkSerialized，因此在这里同步领取其引用快照。
      const batch = begin(signal);
      try {
        const outgoing = text + batch.map(c => quoteText(c.text)).join('');
        const result = await sink.call(this, outgoing, attachments, mode, signal);
        finish(signal, result?.kind === 'success');
        return result;
      } catch (error) { finish(signal, false); throw error; }
    });
    // 卸载后不领取新引用，已获授权的在途发送仍完成原生生命周期。
    return () => { active = false; cleanup(); };
  }
  function resourceProvider(sessions, metadata = async () => undefined) {
    return { protocol: 'selectionchat', async *open(address, { signal }) {
      const id = parseAddress(address);
      if (!id) throw Error('无效的侧边聊天地址。');
      if (signal.aborted) return;
      const meta = await metadata(id);
      if (signal.aborted) return;
      const reference = sessions.retain(id, { source: 'selectionChat', signal });
      try {
        yield { ok: true, value: { id, reference, meta } };
        if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      } finally { reference.release(); }
    } };
  }
  // 一次点击对应一个分支；打开侧栏失败后的重试复用已创建的会话，绝不重复派发。
  function createBranchOp(api, open, remember, mint = () => crypto.randomUUID()) {
    let task, child, requestId, remembered = false;
    return source => {
      if (task) return task;
      task = (async () => {
        quoteText(source.text);
        if (!child) {
          requestId ||= mint();
          child = await api('create', { sourceId: source.sessionId, requestId });
        }
        if (source.isCurrent()) {
          if (!remembered) { remember(child, source.text); remembered = true; }
          await open(resourceAddress(child.id));
        }
        else await api('close', { id: child.id });
        return child.id;
      })().finally(() => { task = undefined; });
      return task;
    };
  }

  function apply(ctx) {
    let storage;
    try { storage = sessionStorage; } catch { /* 隐私模式允许内存工作。 */ }
    const cards = createQuoteStore(storage), senders = new Map();
    const metadata = new Map(), metaListeners = new Set(), cleanupQueue = new Set(), cleanupErrors = new Map(), closing = new Set();
    const timers = new Set();
    let disposed = false;
    try {
      for (const [id, value] of JSON.parse(storage?.getItem('dsh-selection-chat.sessions.v1') || '[]')) metadata.set(id, value);
      for (const id of JSON.parse(storage?.getItem('dsh-selection-chat.cleanup.v1') || '[]')) if (typeof id === 'string' && id.startsWith(TEMP_PREFIX)) cleanupQueue.add(id);
    } catch { /* 不从损坏缓存推断删除目标。 */ }
    const publishMeta = () => {
      try { storage?.setItem('dsh-selection-chat.sessions.v1', JSON.stringify([...metadata])); } catch { /* 当前窗口仍可继续。 */ }
      for (const listener of metaListeners) listener();
    };
    const clean = async (id, attempt = 0) => {
      if (disposed || closing.has(id)) return;
      closing.add(id);
      try {
        await temporaryApi('close', { id });
        cleanupQueue.delete(id); cleanupErrors.delete(id); metadata.delete(id); cards.clear(id);
        storage?.setItem('dsh-selection-chat.cleanup.v1', JSON.stringify([...cleanupQueue]));
      } catch (error) {
        cleanupErrors.set(id, error.message);
        if (attempt < 2 && !disposed) {
          const timer = setTimeout(() => { timers.delete(timer); void clean(id, attempt + 1); }, 1000 * (attempt + 1));
          timers.add(timer);
        }
      } finally { closing.delete(id); publishMeta(); }
    };
    const queueClose = id => {
      if (!id?.startsWith(TEMP_PREFIX)) return;
      cleanupQueue.add(id);
      // 关闭标签前先登记清理任务。导航、折叠、资源卸载不会触发这个入口。
      storage?.setItem('dsh-selection-chat.cleanup.v1', JSON.stringify([...cleanupQueue]));
      void clean(id);
    };
    const getMetadata = async id => {
      if (id.startsWith(TEMP_PREFIX)) {
        const info = await temporaryApi('info', { id });
        if (['closed', 'closing', 'close-failed'].includes(info.state)) throw Error('此临时聊天已关闭，请重新划词打开。');
        metadata.set(id, info); publishMeta(); return info;
      }
      if (!metadata.has(id)) { metadata.set(id, await temporaryApi('info', { id })); publishMeta(); }
      return metadata.get(id);
    };
    const remember = (id, text) => cards.add(id, text);
    const ensureSender = id => {
      const binding = ctx.sessions.binding(id);
      if (!binding) throw Error('当前会话尚未就绪，请稍后重新添加引用。');
      const shell = ctx.conversation.input.for(binding.ctx);
      if (!senders.has(shell)) senders.set(shell, attachQuoteSender(shell, cards, id));
    };
    const bind = (name, options, Component) => ctx.effect(() => ctx.slots.inject(name, () => ctx.slots.register({ name, ...options }, Component)));
    ctx.effect(() => {
      const style = document.createElement('style'); style.dataset.plugin = ID;
      style.textContent = `.dsh-sc-toolbar{position:fixed;z-index:10000;display:flex;flex-wrap:wrap;align-items:center;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#222);border:1px solid #8883;border-radius:10px;box-shadow:0 4px 16px #0002;font:13px/1.5 system-ui,sans-serif;padding:3px}.dsh-sc-toolbar button{font:inherit;color:inherit;background:transparent;border:0;border-radius:6px;padding:7px 10px;cursor:pointer}.dsh-sc-toolbar button:hover,.dsh-sc-toolbar button:focus-visible{background:#81858d20}.dsh-sc-toolbar button:disabled{opacity:.5;cursor:wait}.dsh-sc-notice{font:13px/1.6 system-ui,sans-serif;white-space:pre-wrap;overflow-wrap:anywhere;padding:8px 12px;border:1px solid #8883;border-radius:8px;margin:6px 0}.dsh-sc-notice button{margin-left:8px;cursor:pointer}.dsh-sc-panel{display:flex;flex-direction:column;flex:1;min-height:0;height:100%;overflow:hidden}.dsh-sc-panel>header{padding:8px 12px;border-bottom:1px solid #8883;font:12px/1.6 system-ui,sans-serif;color:var(--dsw-alias-label-secondary,#777)}.dsh-sc-panel>div:last-child{flex:1;min-height:0;display:flex;flex-direction:column}.dsh-sc-panel [data-slot="selection-chat.conversation"]{flex:1;min-height:0;display:flex;flex-direction:column}`;
      document.head.append(style);
      style.textContent += `.dsh-sc-cards{width:100%;box-sizing:border-box;max-height:240px;overflow:auto;margin:0 0 8px;padding:0 4px;display:flex;flex-direction:column;gap:6px}.dsh-sc-card{border:1px solid var(--dsw-alias-border-l1,#8883);border-left:3px solid var(--dsw-alias-state-business-primary,#4d7bea);border-radius:10px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#222);padding:9px 12px;font:13px/1.55 system-ui,sans-serif;min-width:0}.dsh-sc-card header{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary,#777)}.dsh-sc-card header span{flex:1}.dsh-sc-card button{border:0;background:transparent;color:inherit;cursor:pointer;border-radius:4px;padding:2px 6px}.dsh-sc-card button:hover{background:#81858d20}.dsh-sc-card button:disabled{opacity:.5;cursor:wait}.dsh-sc-card blockquote{margin:5px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;max-height:70px;overflow:hidden}.dsh-sc-card[data-expanded="true"] blockquote{max-height:none}.dsh-sc-card p{margin:4px 0 0;color:var(--dsw-alias-label-secondary,#777);font-size:12px}`;
      return () => { disposed = true; style.remove(); for (const off of senders.values()) off(); senders.clear(); };
    });
    ctx.effect(() => hideTemporarySessions(ctx.sessions.list));
    ctx.effect(() => ctx.sidebarRight.registerCloseHandler('selectionchat', (_owner, tab) => queueClose(parseAddress(tab.contentId))));
    ctx.effect(() => {
      for (const id of cleanupQueue) void clean(id);
      return () => { for (const timer of timers) clearTimeout(timer); timers.clear(); };
    });

    function SelectionDock({ sessionId, useInput }) {
      const anchor = useRef(null), toolbar = useRef(null), alive = useRef(false), busyRef = useRef(false), retry = useRef(null);
      const [pick, setPick] = useState(null), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
      const [, refresh] = useState(0), [expanded, setExpanded] = useState({});
      const input = useInput(s => s);
      const root = () => anchor.current?.closest('[data-conversation-content]');
      const current = () => {
        const view = root(), bounds = view?.getBoundingClientRect();
        // 缓存但隐藏的会话也不得在异步 fork 完成后抢走当前用户的侧栏。
        return alive.current && !disposed && view?.isConnected && view.getAttribute('data-conversation-session') === sessionId && bounds.width > 0 && bounds.height > 0;
      };

      useEffect(() => {
        alive.current = true;
        let timer, dragging = false;
        const update = () => {
          if (dragging || busyRef.current || toolbar.current?.contains(document.activeElement)) return;
          const found = readSelection(window.getSelection(), root());
          setPick(found ? { ...found, sessionId, branch: null } : null);
        };
        const schedule = () => { clearTimeout(timer); timer = setTimeout(update, 70); };
        const down = event => {
          if (event.target?.closest?.('[data-selection-chat-toolbar]')) return;
          dragging = true; setPick(null);
        };
        const up = () => { dragging = false; schedule(); };
        const hide = () => { clearTimeout(timer); if (!busyRef.current) setPick(null); };
        const key = event => {
          if (event.key === 'Escape') { clearTimeout(timer); setPick(null); return; }
          if (event.altKey && event.shiftKey && event.code === 'KeyQ') { update(); setTimeout(() => toolbar.current?.querySelector('button')?.focus(), 0); }
          else schedule();
        };
        document.addEventListener('selectionchange', schedule);
        document.addEventListener('pointerdown', down);
        document.addEventListener('pointerup', up);
        document.addEventListener('keyup', key);
        document.addEventListener('scroll', hide, true);
        window.addEventListener('resize', hide);
        return () => {
          alive.current = false; clearTimeout(timer);
          document.removeEventListener('selectionchange', schedule);
          document.removeEventListener('pointerdown', down);
          document.removeEventListener('pointerup', up);
          document.removeEventListener('keyup', key);
          document.removeEventListener('scroll', hide, true);
          window.removeEventListener('resize', hide);
        };
      }, [sessionId]);

      useEffect(() => {
        const off = cards.subscribe(() => refresh(n => n + 1));
        const listener = () => refresh(n => n + 1); metaListeners.add(listener);
        try { ensureSender(sessionId); } catch (e) { setNotice(e.message); }
        refresh(n => n + 1);
        return () => { off(); metaListeners.delete(listener); };
      }, [sessionId]);

      const append = text => {
        if (!current()) return;
        try {
          ensureSender(sessionId);
          remember(sessionId, text);
          setPick(null); window.getSelection()?.removeAllRanges();
          setNotice('');
          root()?.querySelector('[contenteditable="true"]')?.focus({ preventScroll: true });
        } catch (e) { setNotice(e.message); }
      };
      const ask = async selection => {
        if (!current() || busyRef.current || selection.sessionId !== sessionId) return;
        busyRef.current = true; setBusy(true); setNotice('');
        if (!selection.branch) selection.branch = createBranchOp(temporaryApi, address => ctx.sidebarRight.openResource(address), (info, text) => {
          metadata.set(info.id, info); publishMeta(); remember(info.id, text);
        });
        retry.current = selection;
        try {
          const child = await selection.branch({ sessionId, text: selection.text, isCurrent: current });
          if (current()) { setPick(null); setNotice(''); }
          return child;
        } catch (e) {
          if (current()) setNotice('无法打开侧边聊天：' + e.message + '。可重试打开；如已创建分支将复用它。');
        } finally { busyRef.current = false; if (alive.current) setBusy(false); }
      };
      const disabled = busy || ['adjudicating', 'submitting'].includes(input.phase);
      return h('div', { ref: anchor, 'data-selection-chat-dock': sessionId },
        cleanupErrors.size > 0 && h('div', { className: 'dsh-sc-notice', role: 'alert' }, '临时侧边聊天清理失败：' + [...cleanupErrors.values()].join('；'),
          h('button', { onClick: () => { for (const id of cleanupErrors.keys()) void clean(id); } }, '重试清理')),
        cards.list(sessionId).length > 0 && h('div', { className: 'dsh-sc-cards', 'aria-label': '待发送引用' },
          cards.list(sessionId).map(card => h('section', { key: card.id, className: 'dsh-sc-card', 'data-expanded': !!expanded[card.id] },
            h('header', null, h('span', null, card.state === 'sending' ? '引用 · 正在提交…' : '引用当前对话'),
              h('button', { 'aria-expanded': !!expanded[card.id], onClick: () => setExpanded(v => ({ ...v, [card.id]: !v[card.id] })) }, expanded[card.id] ? '收起' : '展开'),
              h('button', { 'aria-label': '移除这条引用', disabled: card.state === 'sending', onClick: () => cards.remove(sessionId, card.id) }, '×')),
            h('blockquote', null, card.text),
            card.error && h('p', { role: 'status' }, card.error),
            card.state === 'uncertain' && h('p', null, '上次发送结果未确认。请先检查历史；此引用不会自动附加。',
              h('button', { onClick: () => cards.reuse(sessionId, card.id) }, '确认重新使用'))))),
        notice && h('div', { className: 'dsh-sc-notice', role: 'status' }, notice,
          retry.current && notice.startsWith('无法') && h('button', { onClick: () => ask(retry.current), disabled }, '重试打开'),
          h('button', { onClick: () => setNotice('') }, '关闭提示')),
        pick && createPortal(h('div', { ref: toolbar, className: 'dsh-sc-toolbar', role: 'toolbar', 'aria-label': '划选文字操作', 'data-selection-chat-toolbar': '',
          style: toolbarPosition(pick.rect, window.innerWidth, window.innerHeight), onPointerDown: event => event.preventDefault() },
          h('button', { disabled, onClick: () => append(pick.text) }, '添加到对话'),
          h('button', { disabled, onClick: () => ask(pick) }, busy ? '正在打开…' : '在侧边聊天中提问')), document.body));
    }
    function FixedChat(props) { return props.renderSlot('conversation.session', { view: 'chat' }); }
    function Conversation({ useSession, useConversation, renderFactorySlot }) {
      const session = useSession(s => s), conversation = useConversation(s => s);
      const active = conversation.activeTargets.size > 0 || !session.blank && !session.awaitingFirstTurn || session.running;
      const hero = !active && session.openState === 'open';
      if (session.openError) return h('div', { role: 'alert', className: 'dsh-sc-notice' }, '会话加载失败：' + (session.openError.message || String(session.openError)));
      return renderFactorySlot('conversation.content', { variant: 'embedded', phase: active ? 'active' : hero ? 'hero' : 'settling', hero }, { slots: { views: FixedChat } });
    }
    function SideTab({ useResource, useTabInfo, SessionProvider, renderSlot }) {
      const { tab } = useTabInfo(), resource = useResource(tab.contentId);
      const panel = useRef(null);
      const [saving, setSaving] = useState(false), [error, setError] = useState('');
      const id = resource.value?.id, meta = metadata.get(id) || resource.value?.meta;
      const temporary = !!id?.startsWith(TEMP_PREFIX);
      useEffect(() => {
        const root = panel.current, hidden = new Set(meta?.hiddenTurns || []), owned = new Set();
        if (!root || hidden.size === 0) return;
        // 同步 hidden 属性，让宿主滚动/间距计算也排除继承行，而不只在视觉上覆盖。
        const update = () => {
          for (const row of root.querySelectorAll('[data-chat-turn]')) {
            const raw = row.getAttribute('data-chat-turn'), hide = raw !== '' && hidden.has(Number(raw));
            if (hide && !row.hidden) { row.hidden = true; owned.add(row); }
            else if (!hide && owned.delete(row)) row.hidden = false;
          }
        };
        const observer = new MutationObserver(update);
        observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-chat-turn', 'hidden'] });
        update();
        return () => { observer.disconnect(); for (const row of owned) row.hidden = false; };
      }, [id, meta]);
      const save = async () => {
        if (saving || !id) return;
        setSaving(true); setError('');
        try {
          if (cards.list(id).some(c => c.state === 'sending')) throw Error('请等待当前消息提交完成后保存。');
          const info = await temporaryApi('save', { id });
          metadata.set(id, info);
          metadata.set(info.savedId, { ...info, id: info.savedId, state: 'saved' });
          cards.move(id, info.savedId); publishMeta();
          // 原生标签替换绑定原主会话，切换主会话期间也不会保存到错误的目录。
          await tab.actions.openResource(resourceAddress(info.savedId), { replaceTab: true });
        } catch (e) { setError(e.message); } finally { setSaving(false); }
      };
      return h('section', { ref: panel, className: 'dsh-sc-panel', 'aria-label': '划词侧边聊天', 'data-selection-chat-session': id },
        h('style', null, inheritedHistoryCss(id || '', meta?.hiddenTurns || [])),
        h('header', { style: { display: 'flex', alignItems: 'center', gap: 8 } }, h('span', null, temporary ? '临时聊天' : '已保存'),
          temporary && h('button', { onClick: save, disabled: saving, style: { marginLeft: 'auto', cursor: 'pointer' } }, saving ? '正在保存…' : meta?.savedId ? '打开已保存会话' : '保存')),
        error && h('div', { role: 'alert', className: 'dsh-sc-notice' }, error),
        resource.error && h('div', { role: 'alert', className: 'dsh-sc-notice' }, '侧边会话加载失败：' + (resource.error.message || String(resource.error))),
        h('div', null, resource.value ? h(SessionProvider, { session: resource.value.reference }, renderSlot(SLOT, {})) : h('p', null, '正在加载侧边会话…')));
    }
    ctx.effect(() => ctx.resources.register(resourceProvider(ctx.sessions, getMetadata)));
    ctx.effect(() => ctx.sidebarRightTabs.register({ id: ID, kind: 'selectionchat', patterns: [PREFIX + '**'], priority: 'extension', canOpen: address => !!parseAddress(address), title: address => '侧边聊天 · ' + (parseAddress(address)?.slice(-6) || '') }));
    bind('sidebar.right.pane.tab', { key: ID, children: { [SLOT]: { kind: 'single', scope: 'session' } } }, SideTab);
    bind(SLOT, {}, Conversation);
    bind('conversation.input.dock', { id: ID, order: 80 }, SelectionDock);
  }
  return { apply, inject: ['slots', 'sessions', 'resources', 'conversation', 'uiSession', 'uiConversation', 'sidebarRight', 'sidebarRightTabs'],
    // 纯函数与生命周期边界导出供离线测试，不调用模型、不操作用户窗口。
    quoteText, parseAddress, resourceAddress, toolbarPosition, readSelection, createQuoteStore, attachQuoteSender, resourceProvider, createBranchOp,
    hideTemporarySessions, inheritedHistoryCss };
} });
