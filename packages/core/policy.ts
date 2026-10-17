export interface Policy {
  status: string;
  enabled: boolean;
  expires_at: Date | string;
  allowed_operations: Record<string, boolean>;
}
export function assertPolicy(
  p: Policy,
  operation:
    | 'derived_insights'
    | 'export_analysis'
    | 'export_ratings' = 'derived_insights',
  now = new Date(),
) {
  if (
    !p.enabled ||
    p.status !== 'approved' ||
    new Date(p.expires_at) <= now ||
    !p.allowed_operations[operation]
  )
    throw new Error('Source policy denies operation');
}
