export const localDatabase =
  'postgresql://tpr_dev:tpr_dev_fixture_only@127.0.0.1:55432/tpr_ingestion_dev';
export function config(env: NodeJS.ProcessEnv = process.env) {
  for (const key of [
    'NETWORK_ENABLED',
    'CONNECTOR_ENABLED',
    'PRODUCTION_EXPORT_ENABLED',
  ]) {
    if (env[key] && env[key] !== 'false')
      throw new Error(`${key} must remain false in fixture mode`);
  }
  for (const key of Object.keys(env)) {
    if (
      key !== 'PRODUCTION_EXPORT_ENABLED' &&
      /PROD|SUPABASE|SERVICE_ROLE/i.test(key) &&
      env[key]
    )
      throw new Error(`Forbidden production binding: ${key}`);
  }
  if (env.NODE_ENV === 'production')
    throw new Error('Production mode is not supported');
  const url = new URL(env.DATABASE_URL || localDatabase);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    !/^\/tpr_ingestion_(dev|test)$/.test(url.pathname) ||
    url.search ||
    url.hash ||
    url.username !== 'tpr_dev'
  ) {
    throw new Error(
      'Only isolated loopback tpr_ingestion_dev/test databases with tpr_dev role are permitted',
    );
  }
  return { databaseUrl: url.href };
}
