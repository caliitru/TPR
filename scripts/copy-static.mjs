import { cp } from 'node:fs/promises';
for (const path of ['fixtures', 'migrations', 'apps/admin'])
  await cp(path, `dist/${path}`, { recursive: true });
