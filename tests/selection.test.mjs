import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
function load(extra = {}) {
  let plugin;
  const sandbox = { window: { __ModuleLoader__: { load: d => { plugin = d.factory(extra.moduleRequire || (() => ({}))); } } }, URL, console, ...extra };
  vm.runInNewContext(source, sandbox); return plugin;
}
const p = load();
test('引用保留换行、代码和超过 6000 字的正文，空白与超长内容明确拒绝', () => {
  const text = '中文\r\n<script>不是 HTML</script>\n' + '长'.repeat(8000);
  const quote = p.quoteText(text);
  assert.ok(quote.includes('> 中文\n> <script>不是 HTML</script>\n> '));
  assert.ok(quote.endsWith('长'.repeat(8000) + '\n\n'));
  assert.throws(() => p.quoteText(' \n'), /先选中/);
  assert.throws(() => p.quoteText('x'.repeat(100001)), /未截断/);
});
test('只接受插件自己的合法会话地址', () => {
  assert.equal(p.parseAddress(p.resourceAddress('session-123')), 'session-123');
  for (const address of ['https://example.com/session/a', 'dsh-resource://subagentchat/session/a', 'dsh-resource://selectionchat/session/', 'dsh-resource://selectionchat/session/a?x=1', 'dsh-resource://selectionchat/session/a%2Fb', 'dsh-resource://selectionchat/session/%zz']) assert.equal(p.parseAddress(address), undefined);
});
test('浮动按钮限制在可视窗口内，靠近顶部改为向下弹出', () => {
  const edge = p.toolbarPosition({ left: 1100, top: 600, bottom: 620 }, 1200, 700);
  assert.equal(edge.left, 892); assert.equal(edge.top, 558);
  assert.equal(p.toolbarPosition({ left: -5, top: 0, bottom: 20 }, 250, 500).top, 28);
});
function selectionFixture({ foreign = false, editable = false, detached = false } = {}) {
  const root = { isConnected: !detached }, other = {};
  const node = foreignNode => ({ nodeType: 1, closest: selector => selector === '[data-conversation-content]' ? foreignNode ? other : root : selector === '[data-chat-flow-kind],[data-chat-group-key]' ? {} : editable ? {} : null });
  const range = { startContainer: node(false), endContainer: node(foreign), getBoundingClientRect: () => ({ left: 100, top: 100, bottom: 120, width: 30, height: 20 }) };
  return { root, selection: { rangeCount: 1, isCollapsed: false, getRangeAt: () => range, toString: () => '选中的文字' } };
}
test('划选绑定具体 Conversation 实例，排除跨会话、编辑器和失效节点', () => {
  const f = selectionFixture(); assert.equal(p.readSelection(f.selection, f.root).text, '选中的文字');
  for (const options of [{ foreign: true }, { editable: true }, { detached: true }]) {
    const f = selectionFixture(options); assert.equal(p.readSelection(f.selection, f.root), undefined);
  }
  f.selection.isCollapsed = true; assert.equal(p.readSelection(f.selection, f.root), undefined);
});
test('引用卡片与草稿分离，支持多条、去重、移除和会话隔离', () => {
  const store = p.createQuoteStore(); let notifications = 0;
  const off = store.subscribe(() => notifications++);
  store.add('a', '引文'); store.add('a', '引文'); store.add('a', '第二条'); store.add('b', '侧栏');
  assert.equal(store.list('a').length, 2); assert.equal(notifications, 3);
  store.remove('a', store.list('a')[0].id);
  assert.equal(store.list('a')[0].text, '第二条'); assert.equal(store.list('b')[0].text, '侧栏'); off();
  store.add('a', '长'.repeat(8000)); assert.equal(store.list('a')[1].text.length, 8000);
  assert.throws(() => store.add('a', '长'.repeat(99999)), /总计超过/);
});

function senderFixture(sink = async () => ({ kind: 'success' })) {
  const store = p.createQuoteStore(), calls = [];
  const shell = {
    deps: { defaultSink: sink },
    sinkSerialized(attempt, text, mode) { calls.push({ attempt, text, mode }); },
    settleDetachedFailure(attempt, message) { calls.push({ failed: attempt, message }); }
  };
  const original = shell.deps.defaultSink, dispose = p.attachQuoteSender(shell, store, 'a');
  return { store, shell, calls, dispose, original };
}

test('普通发送附加卡片一次，原草稿、附件和 queue/steer 参数保持不变', async () => {
  let received;
  const f = senderFixture(async (...args) => { received = args; return { kind: 'success' }; });
  const signal = new AbortController().signal, attachments = ['image', 'file'];
  f.store.add('a', '引文'); f.store.add('b', '另一会话');
  f.shell.sinkSerialized({ signal }, '我的问题', 'steer');
  assert.equal(f.calls[0].text, '我的问题'); assert.equal(f.store.list('a')[0].state, 'sending');
  await f.shell.deps.defaultSink('我的问题', attachments, 'steer', signal);
  assert.equal(received[0], '我的问题' + p.quoteText('引文'));
  assert.equal(received[1], attachments); assert.equal(received[2], 'steer'); assert.equal(received[3], signal);
  assert.equal(f.store.list('a').length, 0); assert.equal(f.store.list('b').length, 1);
  await f.shell.deps.defaultSink('下一题', [], 'queue', new AbortController().signal);
  assert.equal(received[0], '下一题'); f.dispose(); assert.equal(f.shell.deps.defaultSink, f.original);
});

test('异步引用序列化期间新增卡片不混入上一条，乱序完成不重复消费', async () => {
  const received = [];
  const f = senderFixture(async text => { received.push(text); return { kind: 'success' }; });
  const a = { signal: new AbortController().signal }, b = { signal: new AbortController().signal };
  f.store.add('a', '第一条'); f.shell.sinkSerialized(a, '问题一', 'queue');
  f.store.add('a', '第二条'); f.shell.sinkSerialized(b, '问题二', 'queue');
  await f.shell.deps.defaultSink('问题二', [], 'queue', b.signal);
  await f.shell.deps.defaultSink('问题一', [], 'queue', a.signal);
  assert.equal(received[0], '问题二' + p.quoteText('第二条'));
  assert.equal(received[1], '问题一' + p.quoteText('第一条')); assert.equal(f.store.list('a').length, 0);
});

test('空引用快照也固定，发送途中新增引用留到下一次', async () => {
  let received;
  const f = senderFixture(async text => { received = text; return { kind: 'success' }; });
  const attempt = { signal: new AbortController().signal };
  f.shell.sinkSerialized(attempt, '问题', 'queue'); f.store.add('a', '后来添加');
  await f.shell.deps.defaultSink('问题', [], 'queue', attempt.signal);
  assert.equal(received, '问题'); assert.equal(f.store.list('a')[0].state, 'ready');
});

test('原生序列化失败、传输异常和拒绝均恢复卡片，不自动重发', async () => {
  for (const sink of [async () => ({ kind: 'error' }), async () => { throw Error('网络异常'); }]) {
    const f = senderFixture(sink), attempt = { signal: new AbortController().signal };
    f.store.add('a', '引文'); f.shell.sinkSerialized(attempt, '问题', 'queue');
    try { await f.shell.deps.defaultSink('问题', [], 'queue', attempt.signal); } catch (e) { assert.equal(e.message, '网络异常'); }
    f.shell.settleDetachedFailure(attempt, '失败');
    assert.equal(f.store.list('a').length, 1); assert.equal(f.store.list('a')[0].state, 'ready');
    assert.match(f.store.list('a')[0].error, /失败/); assert.equal(f.calls[1].message, '失败');
  }
  const f = senderFixture(), attempt = { signal: new AbortController().signal };
  f.store.add('a', '引文'); f.shell.sinkSerialized(attempt, '问题', 'queue');
  f.shell.settleDetachedFailure(attempt, '引用芯片序列化失败');
  assert.equal(f.store.list('a')[0].state, 'ready');
});

test('仅附件发送可带引用；斜杠命令未进入普通消息通道则不消费', async () => {
  let received;
  const f = senderFixture(async text => { received = text; return { kind: 'success' }; });
  f.store.add('a', '引文'); assert.equal(f.store.list('a')[0].state, 'ready');
  await f.shell.deps.defaultSink('', ['file'], 'queue', new AbortController().signal);
  assert.equal(received, p.quoteText('引文')); assert.equal(f.store.list('a').length, 0);
});

test('刷新恢复卡片，提交途中刷新需人工确认，旧版缓存可迁移', () => {
  const data = new Map([['dsh-selection-chat.pending.v1', JSON.stringify([['a', '旧侧栏引用']])]]);
  const storage = { getItem: k => data.get(k), setItem: (k, v) => data.set(k, v) };
  const store = p.createQuoteStore(storage); assert.equal(store.list('a')[0].text, '旧侧栏引用');
  store.add('b', '新引用'); store.take('a');
  const restored = p.createQuoteStore(storage);
  assert.equal(restored.list('a')[0].state, 'uncertain'); assert.equal(restored.take('a').length, 0);
  assert.equal(restored.list('b')[0].state, 'ready');
  restored.reuse('a', restored.list('a')[0].id); assert.equal(restored.take('a').length, 1);
});

test('卸载保留在途快照直至完成，发送中的引用不可误删', async () => {
  const f = senderFixture(), attempt = { signal: new AbortController().signal };
  f.store.add('a', '引文'); f.shell.sinkSerialized(attempt, '问题', 'queue');
  f.store.remove('a', f.store.list('a')[0].id); assert.equal(f.store.list('a').length, 1);
  f.dispose(); assert.notEqual(f.shell.deps.defaultSink, f.original);
  await f.shell.deps.defaultSink('问题', [], 'queue', attempt.signal);
  assert.equal(f.shell.deps.defaultSink, f.original); assert.equal(f.store.list('a').length, 0);
});

test('宿主接口不兼容时明确拒绝安装发送适配', () => {
  assert.throws(() => p.attachQuoteSender({}, p.createQuoteStore(), 'a'), /不兼容/);
});

test('上方 dock 渲染完整原文卡片及移除操作，不调用输入框写入接口', () => {
  let Dock;
  const text = '<script>纯文字</script>\n' + '长'.repeat(8000);
  const storage = new Map([['dsh-selection-chat.cards.v2', JSON.stringify([['a', [{ text, state: 'ready' }]]])]]);
  const React = { createElement: (type, props, ...children) => ({ type, props, children }), useRef: value => ({ current: value }), useState: value => [value, () => {}], useEffect() {} };
  const plugin = load({ moduleRequire: name => name === 'react' ? React : {},
    document: { createElement: () => ({ dataset: {}, remove() {} }), head: { append() {} } },
    sessionStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v) } });
  plugin.apply({ effect: fn => fn(), slots: { inject: (_, fn) => fn(), register: (options, Component) => { if (options.name === 'conversation.input.dock') Dock = Component; return () => {}; } },
    sessions: { list: { getSnapshot: () => ({ ids: [], byId: {} }) } }, sidebarRight: { registerCloseHandler: () => () => {} },
    resources: { register: () => () => {} }, sidebarRightTabs: { register: () => () => {} } });
  const render = () => Dock({ sessionId: 'a', useInput: fn => fn({ phase: 'plain', draft: '我的问题' }),
    inputActions: { insertText: () => assert.fail('不能修改输入框'), setDraft: () => assert.fail('不能替换草稿') } });
  const tree = render(), nodes = [];
  function visit(n) { if (Array.isArray(n)) return n.forEach(visit); if (!n || typeof n !== 'object') return; nodes.push(n); visit(n.children); }
  visit(tree);
  assert.equal(tree.props['data-selection-chat-dock'], 'a');
  assert.equal(nodes.find(n => n.type === 'blockquote').children[0], text);
  nodes.find(n => n.props?.['aria-label'] === '移除这条引用').props.onClick();
  assert.equal(render().children[0], false);
});
test('资源释放只移除会话引用，关闭侧栏不会取消模型或删除历史', async () => {
  const controller = new AbortController(); let retained = 0, released = 0;
  const sessions = { retain: (id, opts) => { assert.equal(id, 'session-a'); assert.equal(opts.source, 'selectionChat'); retained++; return { release: () => released++ }; } };
  const iterator = p.resourceProvider(sessions).open(p.resourceAddress('session-a'), { signal: controller.signal });
  assert.equal((await iterator.next()).value.value.id, 'session-a');
  const waiting = iterator.next(); controller.abort(); assert.equal((await waiting).done, true);
  assert.equal(retained, 1); assert.equal(released, 1);
  const cancelled = p.resourceProvider(sessions).open(p.resourceAddress('session-a'), { signal: controller.signal });
  assert.equal((await cancelled.next()).done, true); assert.equal(retained, 1);
});
test('快速重复点击只创建一次，打开失败后重试复用既有分支', async () => {
  let forks = 0, opens = 0, remembered = 0;
  const op = p.createBranchOp(async (action, opts) => { forks++; assert.equal(action, 'create'); assert.equal(opts.sourceId, 'main'); return { id: 'child' }; }, async () => { if (++opens === 1) throw Error('暂不可打开'); }, () => remembered++, () => 'request-1');
  const input = { sessionId: 'main', text: '引文', isCurrent: () => true };
  const first = op(input), duplicate = op(input); assert.equal(first, duplicate);
  await assert.rejects(first, /暂不可打开/); assert.equal(await op(input), 'child');
  assert.equal(forks, 1); assert.equal(opens, 2); assert.equal(remembered, 1);
});
test('切换会话或卸载后不会抢开侧栏，未展示的临时会话自动清理', async () => {
  let remembered, closed;
  const op = p.createBranchOp(async (action, input) => { if (action === 'close') closed = input.id; return { id: 'child' }; }, () => assert.fail('不应打开'), (...args) => { remembered = args; }, () => 'request-2');
  assert.equal(await op({ sessionId: 'main', text: '引文', isCurrent: () => false }), 'child');
  assert.equal(remembered, undefined); assert.equal(closed, 'child');
});
test('网络结果不明时用同一个请求标识重试，由后端复用同一会话', async () => {
  const keys = [];
  const unknown = p.createBranchOp(async (_action, input) => { keys.push(input.requestId); if (keys.length === 1) throw Error('网络断开'); return { id: 'child' }; }, () => {}, () => {}, () => 'request-3');
  const input = { sessionId: 'main', text: '引文', isCurrent: () => true };
  await assert.rejects(unknown(input), /网络断开/); assert.equal(await unknown(input), 'child');
  assert.deepEqual(keys, ['request-3', 'request-3']);
});
test('没有已完成轮次时保留宿主拒绝，不偷偷创建无上下文会话', async () => {
  const op = p.createBranchOp(async () => { throw Error('没有已完成轮次'); }, () => assert.fail(), () => assert.fail(), () => 'request-4');
  await assert.rejects(op({ sessionId: 'main', text: '引文', isCurrent: () => true }), /没有已完成轮次/);
});
test('插件独立注册与卸载，未调用 Codex、模型或修改主会话', () => {
  const effects = [], registrations = [], removed = [], storage = new Map();
  const plugin = load({ document: { createElement: () => ({ dataset: {}, remove: () => removed.push('style') }), head: { append() {} } },
    sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) } });
  plugin.apply({ effect: fn => { const dispose = fn(); effects.push(dispose); return dispose; },
    slots: { inject: (_, fn) => fn(), register: (options, Component) => { registrations.push({ options, Component }); return () => removed.push(options.name); } },
    sessions: { list: { getSnapshot: () => ({ ids: [], byId: {} }) } }, sidebarRight: { registerCloseHandler: () => () => removed.push('close') },
    resources: { register: provider => { assert.equal(provider.protocol, 'selectionchat'); return () => removed.push('resource'); } },
    sidebarRightTabs: { register: definition => { assert.equal(definition.kind, 'selectionchat'); return () => removed.push('tab'); } } });
  assert.equal(registrations.length, 3);
  assert.ok(registrations.some(r => r.options.name === 'conversation.input.dock'));
  effects.reverse().forEach(f => f?.()); assert.equal(removed.length, 7);
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)));
  assert.equal(pkg.name, '@local/dsh-selection-chat');
  assert.ok(!JSON.stringify(pkg).includes('codex-dots'));
});

test('临时会话不进入左侧目录，保存后的普通会话仍可见且保留 cwd 元数据', () => {
  const snapshot = { ids: ['main', 'selectionchat-temp-123', 'session-saved'], byId: { 'selectionchat-temp-123': { cwd: '/project' } } };
  const source = { getSnapshot: () => snapshot }, original = source.getSnapshot;
  const dispose = p.hideTemporarySessions(source);
  assert.deepEqual([...source.getSnapshot().ids], ['main', 'session-saved']);
  assert.equal(source.getSnapshot(), source.getSnapshot());
  assert.equal(source.getSnapshot().byId['selectionchat-temp-123'].cwd, '/project');
  dispose(); assert.equal(source.getSnapshot, original);
});

test('历史隐藏只作用于当前侧栏及继承轮次，不隐藏新轮次或主对话', () => {
  const css = p.inheritedHistoryCss('selectionchat-temp-123', [0, 1, '2', -1, '<script>']);
  assert.ok(css.includes('[data-selection-chat-session="selectionchat-temp-123"] [data-chat-turn="0"]'));
  assert.ok(!css.includes('turn="2"')); assert.ok(!css.includes('<script>'));
  assert.equal(p.inheritedHistoryCss('" onclick=', [0]), '');
  assert.ok(!source.includes('侧边分支已准备，填写问题后手动发送。'));
});
