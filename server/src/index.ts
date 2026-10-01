import Fastify from 'fastify';

const app = Fastify({ logger: true });
app.get('/health', async () => ({ ok: true, service: 'carrel-server' }));

if (process.env.NODE_ENV !== 'test') {
  app.listen({ port: Number(process.env.PORT ?? 3001), host: '0.0.0.0' }).catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
}

export default app;
