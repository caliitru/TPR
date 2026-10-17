import { vi } from 'vitest';
import https from 'node:https';
import http from 'node:http';
// All tests use injection and local PostgreSQL, never HTTP source traffic.
vi.stubGlobal(
  'fetch',
  vi.fn(() => {
    throw new Error('Outbound network disabled in tests');
  }),
);
vi.spyOn(https, 'request').mockImplementation(() => {
  throw new Error('Outbound HTTPS disabled in tests');
});
vi.spyOn(http, 'request').mockImplementation(() => {
  throw new Error('Outbound HTTP disabled in tests');
});
