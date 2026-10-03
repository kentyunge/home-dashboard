import { createServer as createHttp } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { readFileSync } from 'node:fs';
import { loadConfig } from './config.js';
import { HomeAssistant } from './ha.js';
import { MockHomeAssistant } from './mock.js';
import { Store } from './store.js';
import { createApp } from './app.js';

const config = loadConfig();
const source = config.mock
  ? new MockHomeAssistant(config)
  : new HomeAssistant({ url: config.haUrl, token: config.haToken });
const store = new Store(config, source);

const handler = createApp({ config, store });
const server = config.tlsCert && config.tlsKey
  ? createHttps({ cert: readFileSync(config.tlsCert), key: readFileSync(config.tlsKey) }, handler)
  : createHttp(handler);

server.listen(config.port, config.host, () => {
  const scheme = config.tlsCert ? 'https' : 'http';
  console.log(`Home dashboard on ${scheme}://${config.host}:${config.port}`);
  console.log(config.mock ? 'Using MOCK data (set HA_URL + HA_TOKEN for real data)' : `Home Assistant: ${config.haUrl}`);
  if (config.configSource) console.log(`Config: ${config.configSource}`);
});

store.start().catch((err) => console.error('Initial load failed:', err));

function shutdown() {
  store.stop();
  source.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
