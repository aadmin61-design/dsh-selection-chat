// 用本机 DSH 自带 Electron Node 检查真实模块与接口；不打开窗口、不新建会话、不调用模型。
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { registerHooks } = require('node:module');
const { pathToFileURL } = require('node:url');
const vm = require('node:vm');

async function main() {
  const runtime = process.argv[2];
  if (!runtime) throw Error('用法：Electron --expose-internals host-check.cjs <resources/app.asar/dsh>');
  const root = path.resolve(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  const hostPackage = name => path.join(runtime, 'node_modules/@deepseek-ai', name);
  const readClient = name => fs.readFileSync(path.join(hostPackage(name), 'lib/client.js'), 'utf8');
  const version = JSON.parse(fs.readFileSync(path.join(hostPackage('dsh-api-session-controller'), 'package.json'))).version;
  // 只接受逐一验证过的精确预发布版本，不能用宽泛范围放行未知宿主。
  const supported = pkg.peerDependencies['@deepseek-ai/dsh-api-session-controller'].split(' || ');
  assert.ok(supported.includes(version), '尚未验证的宿主版本：' + version);
  const sessionVersion = JSON.parse(fs.readFileSync(path.join(hostPackage('dsh-session'), 'package.json'))).version;
  assert.equal(sessionVersion, version, '宿主会话模块版本不一致');
  for (const dependency of pkg.dsh.client.inject) {
    const manifest = path.join(runtime, 'node_modules', dependency, 'package.json');
    assert.ok(fs.existsSync(manifest), '缺少宿主模块：' + dependency);
    assert.equal(JSON.parse(fs.readFileSync(manifest)).version, version, '宿主客户端模块版本混用：' + dependency);
  }
  const conversation = readClient('dsh-client-ui-conversation');
  for (const contract of ['"conversation.input.dock"', '"data-conversation-content"', '"data-conversation-session"', 'captureInsertion:', 'insertText:', 'persistDraft:', '"conversation.content"']) assert.ok(conversation.includes(contract), '缺少输入/会话契约：' + contract);
  for (const contract of ['sinkSerialized(attempt, draft, mode)', 'settleDetachedFailure(attempt, message)', 'this.deps.defaultSink(out.trim(), attachmentIds, mode, attempt.signal)', 'for(actx)', 'this.shellFor(binding)']) assert.ok(conversation.includes(contract), '缺少引用发送适配契约：' + contract);
  // 使用安装包中的真实序列化方法执行轻量契约测试，不启动浏览器或模型。
  const start = conversation.indexOf('sinkSerialized(attempt, draft, mode) {');
  const end = conversation.indexOf('\n\t\t\tnotifySubmission(submission)', start);
  assert.ok(start >= 0 && end > start);
  const method = conversation.slice(start, end);
  const nativeSerialize = vm.runInNewContext('({' + method + '}).sinkSerialized');
  let client;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'client.js'), 'utf8'), {
    window: { __ModuleLoader__: { load: definition => { client = definition.factory(() => ({})); } } }, URL
  });
  for (const mode of ['queue', 'steer']) for (const fail of [false, true]) {
    const cards = client.createQuoteStore(), sent = [], waits = [];
    let release;
    const chip = new Promise((resolve, reject) => { release = () => fail ? reject(Error('chip failed')) : resolve('文件引用'); });
    const shell = {
      sinkSerialized: nativeSerialize,
      settleDetachedFailure() {}, notifySubmission() {}, dead: () => false,
      attachmentIds: ['file-id'], projection: { occurrences: [{ source: 'file', ref: {}, offset: 0, length: 1 }] },
      detachedDrafts: new Map(), failedDetached: new Map(), rev: 1,
      deps: { inputTriggers: () => ({ serializeReference: () => chip }), defaultSink: async (...args) => { sent.push(args); return { kind: 'success' }; } },
      settleSink(attempt, pending) { waits.push(pending); }
    };
    const dispose = client.attachQuoteSender(shell, cards, 'session-test');
    cards.add('session-test', '划词引用');
    const attempt = { seq: 1, signal: new AbortController().signal };
    shell.sinkSerialized(attempt, '@ 问题', mode);
    assert.equal(shell.detachedDrafts.get(1).draft, '@ 问题', '原生失败恢复记录不应含隐藏引用');
    cards.add('session-test', '下一条引用');
    release(); await new Promise(resolve => setImmediate(resolve)); await Promise.all(waits);
    if (fail) {
      assert.equal(sent.length, 0);
      assert.equal(cards.list('session-test')[0].state, 'ready');
    } else {
      assert.equal(sent[0][0], '文件引用 问题' + client.quoteText('划词引用'));
      assert.equal(sent[0][1][0], 'file-id'); assert.equal(sent[0][2], mode); assert.equal(sent[0][3], attempt.signal);
      assert.equal(cards.list('session-test').length, 1); assert.equal(cards.list('session-test')[0].text, '下一条引用');
    }
    dispose();
  }
  // rc.3 新增 keep/append/replace 草稿策略；执行宿主原方法，验证引用适配不接管草稿恢复。
  if (version === '0.2.1-rc.3') {
    const draftStart = conversation.indexOf('requestDraftInitialization(options) {');
    const draftEnd = conversation.indexOf('\n\t\t\tdraftInitializationBlocked()', draftStart);
    assert.ok(draftStart >= 0 && draftEnd > draftStart);
    const initialize = vm.runInNewContext('({' + conversation.slice(draftStart, draftEnd) + '}).requestDraftInitialization');
    const cards = client.createQuoteStore();
    let draft = '原问题', blocked = false;
    const shell = { sinkSerialized: nativeSerialize, settleDetachedFailure() {}, deps: { defaultSink() {} },
      attachmentIds: ['file-id'], snapshot: { draft }, requestDraftInitialization: initialize,
      draftInitializationBlocked: () => blocked,
      setDraft: text => { draft = text; shell.snapshot.draft = text; },
      draftEditor: { appendDraft: text => { draft += '\n' + text; shell.snapshot.draft = draft; } } };
    const off = client.attachQuoteSender(shell, cards, 'draft-session');
    cards.add('draft-session', '选中的原文');
    assert.equal(shell.requestDraftInitialization({}), 'preserved');
    assert.equal(shell.requestDraftInitialization({ prompt: '新任务', whenDraftExists: 'keep' }), 'preserved');
    assert.equal(draft, '原问题');
    assert.equal(shell.requestDraftInitialization({ prompt: '补充', whenDraftExists: 'append' }), 'applied');
    assert.equal(draft, '原问题\n补充');
    blocked = true;
    assert.equal(shell.requestDraftInitialization({ prompt: '不可覆盖', whenDraftExists: 'replace' }), 'blocked');
    assert.equal(draft, '原问题\n补充');
    blocked = false;
    assert.equal(shell.requestDraftInitialization({ prompt: '主动替换', whenDraftExists: 'replace' }), 'applied');
    assert.equal(draft, '主动替换');
    assert.deepEqual(shell.attachmentIds, ['file-id']);
    assert.equal(cards.list('draft-session')[0].text, '选中的原文');
    assert.equal(cards.list('draft-session')[0].state, 'ready');
    off(); assert.equal(shell.requestDraftInitialization, initialize);
  }
  const sessions = readClient('dsh-api-session-controller');
  for (const contract of ['async fork(opts)', 'retain(target, options)', 'allowMigration', 'workspaceAttachSessionId']) assert.ok(sessions.includes(contract), '缺少会话契约：' + contract);
  const sidebar = readClient('dsh-client-ui-sidebar-right');
  assert.ok(sidebar.includes('"sidebar.right.pane.tab"'));
  assert.ok(sidebar.includes('registerCloseHandler(kind, handler)'));
  assert.ok(sidebar.includes('this.closeHandlers.get(tab.kind)?.(sessionId, tab)'));
  const renderer = readClient('dsh-client-ui-renderer');
  assert.ok(renderer.includes('kit["SessionProvider"]'));
  assert.ok(readClient('dsh-client-ui-chat').includes('"data-chat-flow-kind"'));
  const hooks = registerHooks({ resolve(name, context, next) {
    return next(name, name.startsWith('@deepseek-ai/') ? { ...context, parentURL: pathToFileURL(path.join(runtime, 'package.json')).href } : context);
  } });
  const { Context } = await import('@deepseek-ai/cordis');
  const { buildForkSeed } = await import('@deepseek-ai/dsh-session');
  const { default: AgentLoop } = await import('@deepseek-ai/dsh-agent-loop');
  const plugin = await import(pathToFileURL(path.join(root, 'index.mjs')));
  const { createTemporaryManager } = await import(pathToFileURL(path.join(root, 'temporary.mjs')));
  hooks.deregister();
  // 验证真实 AgentLoop 的写句柄入口可以被定向绕过，其他会话仍调用真实方法。
  const writes = [], effects = [], routes = [];
  const loop = Object.create(AgentLoop.prototype);
  loop.runtime = { ctx: { get: name => name === 'sessionPersistence' ? { create: async header => { writes.push(header.id); return { close() {} }; } } : undefined } };
  const observations = new Map();
  const sample = [
    { seq: 0, type: 'turn/start', timestamp: 1, data: { turn: 0, trigger: { kind: 'user' } } },
    { seq: 1, type: 'turn/end', timestamp: 2, data: { turn: 0, status: 'completed' } }
  ];
  const host = {
    effect: fn => { const off = fn(); effects.push(off); return off; },
    connection: { fetch: { register: route => { routes.push(route); return () => {}; } } },
    agentLoop: loop, sessionController: { prompt() {}, agents: { composeAgent: async () => ({ setup() {} }), presetForObservation() {} } },
    sessionQuery: { observeSession: async id => ({ events: sample, header: { id, cwd: 'C:/example' }, [Symbol.dispose]() {} }) },
    workspaceRegistry: { list: () => [] }, agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
    agents: { create: async options => {
      const session = { id: options.sessionId, header: { id: options.sessionId }, inheritedEventCount: options.inheritedEventCount };
      const stored = await loop.createStoredSession(session);
      observations.set(options.sessionId, { options, stored });
      return { agent: { status: 'idle', options: options.agentOptions }, dispose: async () => {} };
    } }, logger: { warn() {} }
  };
  // 原生 buildForkSeed 负责序列化边界，测试中不自行复制 DSH 的实现。
  const manager = createTemporaryManager(host, buildForkSeed);
  const temporary = await manager.create({ sourceId: 'source', requestId: 'host-check-request' });
  assert.equal(observations.get(temporary.id).stored, undefined);
  assert.equal(writes.length, 0);
  const saved = await manager.save(temporary.id);
  assert.deepEqual(writes, [saved.savedId]);
  assert.deepEqual(temporary.hiddenTurns, [0]);
  await manager.close(temporary.id); await manager.dispose();
  plugin.apply(host);
  assert.deepEqual(routes.map(r => r.path).sort(), ['close', 'create', 'info', 'save'].map(op => '/api/selection-chat/' + op).sort());
  for (const off of effects.reverse()) await off?.();
  const ctx = new Context();
  try {
    const fiber = await ctx.plugin(plugin);
    await fiber.dispose();
    console.log(JSON.stringify({ ok: true, plugin: pkg.name, version: pkg.version, dsh: version,
      checks: ['真实 Cordis 加载及认证路由注册和卸载', '安装包中的客户端接口、版本一致性与声明检查', '真实宿主序列化方法：异步芯片、附件、queue/steer、失败恢复及引用快照', ...(version === '0.2.1-rc.3' ? ['rc.3 真实草稿初始化方法：keep/append/replace、阻塞期与附件/引用隔离'] : []), '真实 AgentLoop 写句柄入口：临时跳过，保存恢复持久化；原生 fork seed'],
      limits: ['未执行真实浏览器渲染', '未新建真实会话或发送消息；界面由用户手动验收'] }));
  } finally { await ctx.fiber.dispose(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
