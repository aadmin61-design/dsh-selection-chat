import test from 'node:test';
import assert from 'node:assert/strict';
import { createTemporaryManager, completedBoundary } from '../temporary.mjs';

function fixture() {
  const agents = new Map(), persisted = [], attached = [], disposed = [], calls = [];
  const events = [ { seq: 0, type: 'turn/start', data: { turn: 0 } }, { seq: 1, type: 'turn/end', data: { turn: 0 } } ];
  const workspace = { id: 'workspace-a', sessionIds: ['main'], async attachSession(id) { attached.push(id); } };
  const ctx = {
    agentLoop: { async createStoredSession(session) { persisted.push(session.id); return {}; } },
    sessionController: { async prompt(request) { calls.push(request); }, agents: { presetForObservation: () => 'preset-a', composeAgent: async () => ({ agentPreset: 'preset-a', setup() {} }) } },
    sessionQuery: { async observeSession(id) { return { events: agents.get(id)?.events || events, header: { id, cwd: '/project-a' }, [Symbol.dispose]() {} }; } },
    workspaceRegistry: { list: () => [workspace] }, agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'test' }) }, logger: { warn() {} },
    agents: { async create(options) {
      const session = { id: options.sessionId };
      await ctx.agentLoop.createStoredSession(session);
      const agent = { session, status: 'idle', options: options.agentOptions, events: options.seed };
      agents.set(options.sessionId, agent);
      return { agent, async dispose() { disposed.push(options.sessionId); agents.delete(options.sessionId); } };
    } }
  };
  const original = ctx.agentLoop.createStoredSession;
  const manager = createTemporaryManager(ctx, (events, boundary) => events.slice(0, boundary + 1));
  return { ctx, manager, agents, persisted, attached, disposed, workspace, original, calls };
}
test('临时创建不获取磁盘写句柄，不归入左侧目录；普通会话仍按原生方式持久化', async () => {
  const f = fixture();
  const info = await f.manager.create({ sourceId: 'main', requestId: 'request-123' });
  assert.match(info.id, /^selectionchat-temp-/); assert.deepEqual(info.hiddenTurns, [0]);
  assert.equal(info.workspaceId, 'workspace-a'); assert.equal(info.cwd, '/project-a');
  assert.equal(f.persisted.length, 0); assert.equal(f.attached.length, 0);
  await f.ctx.agentLoop.createStoredSession({ id: 'ordinary' }); assert.deepEqual(f.persisted, ['ordinary']);
  await f.manager.dispose(); assert.equal(f.ctx.agentLoop.createStoredSession, f.original);
});
test('关闭仅销毁拥有的临时会话，重复关闭幂等，禁止删除主对话或旧版分支', async () => {
  const f = fixture(), info = await f.manager.create({ sourceId: 'main', requestId: 'request-123' });
  await f.manager.close(info.id); await f.manager.close(info.id);
  assert.deepEqual(f.disposed, [info.id]); assert.equal(f.manager.info(info.id).state, 'closed');
  await assert.rejects(f.manager.close('main'), /拒绝/); await assert.rejects(f.manager.close('legacy-child'), /拒绝/);
  await f.manager.dispose();
});
test('重复创建请求复用同一临时会话并拒绝换来源', async () => {
  const f = fixture();
  const [a, b] = await Promise.all([f.manager.create({ sourceId: 'main', requestId: 'request-123' }), f.manager.create({ sourceId: 'main', requestId: 'request-123' })]);
  assert.equal(a.id, b.id); assert.equal(f.agents.size, 1);
  await assert.rejects(f.manager.create({ sourceId: 'other', requestId: 'request-123' }), /来源不一致/); await f.manager.dispose();
});
test('保存只创建一个长期副本，保留原目录；关闭临时标签不删除保存结果', async () => {
  const f = fixture(), info = await f.manager.create({ sourceId: 'main', requestId: 'request-123' });
  const [a, b] = await Promise.all([f.manager.save(info.id), f.manager.save(info.id)]);
  assert.equal(a.savedId, b.savedId); assert.match(a.savedId, /^session-/);
  assert.deepEqual(f.persisted, [a.savedId]); assert.deepEqual(f.attached, [a.savedId]);
  await f.manager.close(info.id); assert.ok(f.agents.has(a.savedId)); assert.deepEqual(f.disposed, [info.id]);
  await f.manager.dispose();
});
test('保存失败可重试同一副本，禁止失败期间继续写临时会话而丢失消息', async () => {
  const f = fixture(), info = await f.manager.create({ sourceId: 'main', requestId: 'request-123' });
  f.workspace.attachSession = async () => { throw Error('目录不可用'); };
  await assert.rejects(f.manager.save(info.id), /目录不可用/); const savedId = f.manager.info(info.id).savedId;
  assert.equal(f.manager.info(info.id).state, 'save-failed');
  assert.throws(() => f.ctx.sessionController.prompt({ sessionId: info.id }), /正在保存/);
  f.workspace.attachSession = async id => f.attached.push(id);
  assert.equal((await f.manager.save(info.id)).savedId, savedId); assert.equal(f.persisted.length, 1);
  await f.manager.dispose();
});
test('运行中的临时聊天禁止保存；保存与关闭并发也保留长期副本', async () => {
  const f = fixture(), info = await f.manager.create({ sourceId: 'main', requestId: 'request-123' });
  f.agents.get(info.id).status = 'running'; await assert.rejects(f.manager.save(info.id), /等待回答/);
  f.agents.get(info.id).status = 'idle';
  const saved = f.manager.save(info.id), closed = f.manager.close(info.id);
  const result = await saved; await closed; assert.ok(f.agents.has(result.savedId));
  await f.manager.dispose();
});
test('来源目录已删除时保存失败，不擅自存入默认目录', async () => {
  const f = fixture(), info = await f.manager.create({ sourceId: 'main', requestId: 'request-123' });
  f.ctx.workspaceRegistry.list = () => [];
  await assert.rejects(f.manager.save(info.id), /原文件目录/); assert.equal(f.persisted.length, 0);
  await f.manager.dispose();
});
test('完成边界排除未完成的新轮次', () => {
  assert.equal(completedBoundary([{ seq: 0, type: 'turn/end' }, { seq: 1, type: 'context' }, { seq: 2, type: 'turn/start' }]), 1);
  assert.throws(() => completedBoundary([{ seq: 0, type: 'turn/start' }]), /至少一轮/);
});

test('消息接纳窗口和待执行队列阻止保存，避免保存副本漏消息', async () => {
  const f = fixture(); await f.manager.dispose();
  let release;
  f.ctx.sessionController.prompt = () => new Promise(resolve => { release = resolve; });
  const manager = createTemporaryManager(f.ctx, (events, boundary) => events.slice(0, boundary + 1));
  const info = await manager.create({ sourceId: 'main', requestId: 'request-admission' });
  const admission = f.ctx.sessionController.prompt({ sessionId: info.id });
  await assert.rejects(manager.save(info.id), /消息提交/);
  release(); await admission;
  f.agents.get(info.id).inbox = { hasPending: true };
  await assert.rejects(manager.save(info.id), /消息提交/);
  f.agents.get(info.id).inbox.hasPending = false;
  assert.ok((await manager.save(info.id)).savedId); await manager.dispose();
});

test('清理失败保留身份以便重试，不误报已关闭', async () => {
  const f = fixture(), originalCreate = f.ctx.agents.create;
  let attempts = 0;
  f.ctx.agents.create = async options => {
    const handle = await originalCreate(options), dispose = handle.dispose;
    handle.dispose = async () => { if (++attempts === 1) throw Error('暂时不能清理'); await dispose(); };
    return handle;
  };
  const info = await f.manager.create({ sourceId: 'main', requestId: 'request-close' });
  await assert.rejects(f.manager.close(info.id), /暂时不能清理/);
  assert.equal(f.manager.info(info.id).state, 'close-failed');
  await f.manager.close(info.id); assert.equal(f.manager.info(info.id).state, 'closed'); await f.manager.dispose();
});

test('旧版长期分支只读恢复历史边界，不被登记为临时会话', async () => {
  const f = fixture();
  f.ctx.sessionQuery.observeSession = async id => ({ header: { id, cwd: '/project-a' },
    events: [{ seq: 0, type: 'turn/start', data: { turn: 0 } }, { seq: 1, type: 'session/end-seed', data: { inherited: true } }, { seq: 2, type: 'turn/start', data: { turn: 1 } }], [Symbol.dispose]() {} });
  const info = await f.manager.info('legacy-child'); assert.deepEqual(info.hiddenTurns, [0]); assert.equal(info.state, 'saved');
  await assert.rejects(f.manager.close('legacy-child'), /拒绝/); await f.manager.dispose();
});
