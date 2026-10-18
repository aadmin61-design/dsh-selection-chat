import { buildForkSeed } from '@deepseek-ai/dsh-session';
import { createTemporaryManager } from './temporary.mjs';

export const inject = ['connection', 'agents', 'agentLoop', 'sessions', 'sessionQuery', 'sessionController', 'workspaceRegistry', 'agentDefaultModel'];
export function apply(ctx) {
  const manager = createTemporaryManager(ctx, buildForkSeed);
  ctx.effect(() => () => manager.dispose());
  // 复用 DSH 认证传输，不额外监听端口；所有变更仅接受本插件拥有的临时 ID。
  for (const operation of ['create', 'info', 'save', 'close']) {
    ctx.effect(() => ctx.connection.fetch.register({ path: '/api/selection-chat/' + operation,
      methods: ['POST'], requestBody: 'buffered', async fetch(request) {
        try {
          const input = await request.json();
          const result = await manager[operation](operation === 'create' ? input : input.id);
          return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
        } catch (error) { return Response.json({ error: error.message }, { status: 400, headers: { 'Cache-Control': 'no-store' } }); }
      } }));
  }
}
